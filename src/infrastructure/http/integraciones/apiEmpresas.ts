import { randomUUID } from "node:crypto";
import express, { Router, type NextFunction, type Request, type Response } from "express";
import type { ZodError } from "zod";
import type { LimitadorTasa } from "../../../application/ports/cache.js";
import type { ContextoApi, ElementoLote } from "../../../application/use-cases/integraciones/ApiEmpresas.js";
import { validarReferenciaExterna } from "../../../domain/integracion/EnvioExterno.js";
import { jsonCanonico, validarClaveIdempotencia } from "../../../domain/integracion/Idempotencia.js";
import { exigirAlcance, type Alcance } from "../../../domain/integracion/Integracion.js";
import { DomainError } from "../../../domain/shared/DomainError.js";
import type { CasosDeUso } from "../../container.js";
import { sha256Hex } from "../../security/apiKeys.js";
import { ipPermitida } from "../../security/redes.js";
import { manejarErrores, respuestaDeError } from "../middlewares/errores.js";
import { limitarTasa, type ReglaTasa } from "../middlewares/limitarTasa.js";
import { cotizarApiSchema, loteApiSchema, nuevoEnvioApiSchema } from "./esquemasApi.js";
import { especificacionOpenApi } from "./openapi.js";

/** Base de la API para empresas. */
export const BASE_API_EMPRESAS = "/api/v1/integraciones";

/** Límites de tasa: 120/min por integración (contrato) y un tope por IP antes de autenticar (frena floods). */
export const REGLAS_API_EMPRESAS = {
  integracion: {
    nombre: "api-empresas",
    limite: 120,
    ventanaSeg: 60,
    clave: (_req: Request, res: Response) => contexto(res).integracion.id,
  },
  ip: { nombre: "api-empresas-ip", limite: 600, ventanaSeg: 60 },
} satisfies Record<string, ReglaTasa>;

interface Locales {
  api?: ContextoApi;
  requestId: string;
  referenciaExterna?: string | null;
}

const locales = (res: Response): Locales => res.locals as Locales;

const contexto = (res: Response): ContextoApi => {
  const ctx = locales(res).api;
  if (!ctx) throw new DomainError("API_KEY_INVALIDA", "API key inválida o revocada");
  return ctx;
};

const MAX_TEXTO_AUDITORIA = 300;
const recortar = (s: string | undefined | null): string | null => (s ? s.slice(0, MAX_TEXTO_AUDITORIA) : null);

export interface OpcionesApiEmpresas {
  limitador?: LimitadorTasa;
}

/**
 * Adaptador HTTP de la API para empresas. Orden: X-Request-Id y auditoría → OpenAPI (pública) → límite por IP →
 * API key → IP permitida → límite por integración → JSON (≤ 1 MB) → endpoints. Se monta ANTES del parser JSON
 * global (100 kB) del panel, y no deja pasar ninguna solicitud al router del panel (JWT).
 */
export function crearRouterApiEmpresas(c: CasosDeUso, opciones: OpcionesApiEmpresas = {}): Router {
  const r = Router();

  r.use((req: Request, res: Response, next: NextFunction) => {
    const inicio = Date.now();
    const requestId = randomUUID();
    locales(res).requestId = requestId;
    res.setHeader("X-Request-Id", requestId);
    res.setHeader("Cache-Control", "no-store");
    res.on("finish", () => {
      if (req.path === "/openapi.json") return;
      const ctx = locales(res).api;
      void c.registrarSolicitudApi
        .ejecutar({
          integracionId: ctx?.integracion.id ?? null,
          fecha: new Date(inicio),
          metodo: req.method,
          ruta: recortar(req.originalUrl.split("?")[0]) ?? "",
          status: res.statusCode,
          ip: req.ip ?? "",
          keyPrefijo: ctx?.key.prefijo ?? null,
          idempotencyKey: recortar(req.get("Idempotency-Key")),
          referenciaExterna: locales(res).referenciaExterna ?? null,
          duracionMs: Date.now() - inicio,
          requestId,
        })
        .catch((e) => console.error("No se pudo registrar la auditoría de la API para empresas", e));
    });
    next();
  });

  r.get("/openapi.json", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(especificacionOpenApi());
  });

  if (opciones.limitador) r.use(limitarTasa(opciones.limitador, REGLAS_API_EMPRESAS.ip));

  r.use(async (req: Request, res: Response, next: NextFunction) => {
    const [tipo, key, ...resto] = (req.get("Authorization") ?? "").split(" ");
    const ctx = await c.autenticarApiKey.ejecutar(tipo === "Bearer" && resto.length === 0 ? key : undefined);
    locales(res).api = ctx; // también para auditar los rechazos por IP en la integración
    if (!ipPermitida(req.ip, ctx.integracion.ipsPermitidas)) {
      throw new DomainError("IP_NO_PERMITIDA", "La IP de origen no está autorizada para esta integración");
    }
    next();
  });

  if (opciones.limitador) r.use(limitarTasa(opciones.limitador, REGLAS_API_EMPRESAS.integracion));

  r.use(express.json({ limit: "1mb" }));

  /** POST idempotente: exige Idempotency-Key y guarda/reproduce la respuesta (también las de error de negocio). */
  async function responderIdempotente(
    req: Request,
    res: Response,
    procesar: () => Promise<{ status: number; body: unknown }>,
  ): Promise<void> {
    const ctx = contexto(res);
    const clave = validarClaveIdempotencia(req.get("Idempotency-Key"));
    const huella = sha256Hex(jsonCanonico(req.body ?? null));
    const { respuesta, repetida } = await c.ejecutarIdempotente.ejecutar(
      { integracionId: ctx.integracion.id, modo: ctx.key.modo, clave },
      huella,
      async () => {
        try {
          const r = await procesar();
          return { status: r.status, cuerpo: JSON.stringify(r.body) };
        } catch (e) {
          const conocido = respuestaDeError(e);
          if (!conocido) throw e; // inesperado (500): no se guarda; se puede reintentar con la misma clave
          return { status: conocido.status, cuerpo: JSON.stringify(conocido.body) };
        }
      },
    );
    if (repetida) res.setHeader("Idempotent-Replayed", "true");
    res.status(respuesta.status).type("application/json").send(respuesta.cuerpo);
  }

  /** El alcance se comprueba antes de validar el body: una key sin permiso recibe 403, no 400. */
  const alcance =
    (a: Alcance) =>
    (_req: Request, res: Response, next: NextFunction): void => {
      exigirAlcance(contexto(res).key, a);
      next();
    };

  r.get("/cobertura", async (_req, res) => {
    res.json(await c.coberturaApi.ejecutar(contexto(res)));
  });

  r.post("/cotizar", alcance("cotizar"), async (req, res) => {
    const ctx = contexto(res);
    res.json(await c.cotizarApi.ejecutar(ctx, cotizarApiSchema.parse(req.body)));
  });

  r.post("/envios", alcance("envios:crear"), async (req, res) => {
    const ctx = contexto(res);
    const ref = (req.body as { referenciaExterna?: unknown } | undefined)?.referenciaExterna;
    locales(res).referenciaExterna = typeof ref === "string" ? recortar(ref) : null;
    validarClaveIdempotencia(req.get("Idempotency-Key"));
    const datos = nuevoEnvioApiSchema.parse(req.body);
    await responderIdempotente(req, res, async () => ({ status: 201, body: await c.crearEnvioApi.ejecutar(ctx, datos) }));
  });

  r.post("/envios/lote", alcance("envios:crear"), async (req, res) => {
    const ctx = contexto(res);
    validarClaveIdempotencia(req.get("Idempotency-Key"));
    const { envios } = loteApiSchema.parse(req.body);
    const elementos: ElementoLote[] = envios.map((e) => {
      const v = nuevoEnvioApiSchema.safeParse(e);
      return v.success ? { ok: true, datos: v.data } : { ok: false, error: errorValidacion(v.error) };
    });
    await responderIdempotente(req, res, async () => ({ status: 200, body: await c.crearLoteApi.ejecutar(ctx, elementos) }));
  });

  r.get("/envios/:referenciaExterna", alcance("envios:leer"), async (req, res) => {
    const ctx = contexto(res);
    const ref = validarReferenciaExterna(req.params.referenciaExterna);
    locales(res).referenciaExterna = ref;
    res.json(await c.consultarEnvioApi.ejecutar(ctx, ref));
  });

  r.use((_req, res) => {
    res.status(404).json({ error: { code: "NO_ENCONTRADO", message: "Recurso no encontrado" } });
  });
  r.use(manejarErrores);
  return r;
}

function errorValidacion(e: ZodError): { code: string; message: string } {
  return { code: "VALIDACION", message: e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") };
}
