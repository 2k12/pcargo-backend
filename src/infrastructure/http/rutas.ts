import { Router, type RequestHandler } from "express";
import type { LimitadorTasa } from "../../application/ports/cache.js";
import type { CasosDeUso } from "../container.js";
import {
  actualizarCiudadSchema,
  actualizarPerfilSchema,
  cambiarContrasenaSchema,
  evidenciaSchema,
  actualizarClienteSchema,
  actualizarRutaSchema,
  cambioEstadoSchema,
  cotizacionSchema,
  crearCiudadSchema,
  crearClienteSchema,
  crearEnvioSchema,
  crearRutaSchema,
  actualizarIntegracionSchema,
  crearApiKeySchema,
  crearIntegracionSchema,
  filtroEntregasSchema,
  webhookSchema,
  filtroEnviosSchema,
  filtroResumenSchema,
  idNumerico,
  idUuid,
  loginSchema,
  paginacionSchema,
} from "./esquemas.js";
import { actorDe, autenticar } from "./middlewares/auth.js";
import { limitarTasa, REGLAS } from "./middlewares/limitarTasa.js";
import { bytesSubidos, subirArchivo } from "./middlewares/subirArchivo.js";

export interface OpcionesRouter {
  /** Sin limitador no se aplican límites de tasa (tests). */
  limitador?: LimitadorTasa;
}

/** Adaptador de entrada HTTP: traduce peticiones a llamadas de casos de uso. */
export function crearRouter(c: CasosDeUso, opciones: OpcionesRouter = {}): Router {
  const publico = Router();
  const privado = Router();

  publico.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  publico.post("/auth/login", async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    res.json(await c.login.ejecutar(email, password));
  });

  publico.get("/seguimiento/:numeroGuia", async (req, res) => {
    res.json(await c.seguimiento.ejecutar(req.params.numeroGuia));
  });

  // Web pública (landing): catálogo de servicios/tarifas y cotizador sin sesión.
  publico.get("/publico/catalogo", async (_req, res) => {
    res.json(await c.catalogoPublico.ejecutar());
  });

  publico.post("/publico/cotizar", async (req, res) => {
    res.json(await c.cotizar.ejecutar(cotizacionSchema.parse(req.body)));
  });

  privado.use(autenticar(c.tokens));

  privado.get("/auth/me", async (_req, res) => {
    res.json(await c.perfil.ejecutar(actorDe(res)));
  });

  privado.patch("/auth/me", async (req, res) => {
    res.json(await c.actualizarPerfil.ejecutar(actorDe(res), actualizarPerfilSchema.parse(req.body)));
  });

  // Límite por usuario: se aplica después de autenticar para contar por id y no por IP.
  const limiteContrasena: RequestHandler[] = opciones.limitador
    ? [limitarTasa(opciones.limitador, REGLAS.contrasena)]
    : [];
  privado.put("/auth/me/password", ...limiteContrasena, async (req, res) => {
    await c.cambiarContrasena.ejecutar(actorDe(res), cambiarContrasenaSchema.parse(req.body));
    res.status(204).end();
  });

  privado.get("/ciudades", async (req, res) => {
    const activa = req.query.activa === undefined ? undefined : req.query.activa === "true";
    res.json(await c.listarCiudades.ejecutar({ activa }));
  });

  privado.post("/ciudades", async (req, res) => {
    const { nombre } = crearCiudadSchema.parse(req.body);
    res.status(201).json(await c.crearCiudad.ejecutar(actorDe(res), nombre));
  });

  privado.patch("/ciudades/:id", async (req, res) => {
    const id = idNumerico.parse(req.params.id);
    res.json(await c.actualizarCiudad.ejecutar(actorDe(res), id, actualizarCiudadSchema.parse(req.body)));
  });

  privado.delete("/ciudades/:id", async (req, res) => {
    await c.eliminarCiudad.ejecutar(actorDe(res), idNumerico.parse(req.params.id));
    res.status(204).end();
  });

  privado.get("/tipos-carga", async (_req, res) => {
    res.json(await c.listarTiposCarga.ejecutar());
  });

  privado.get("/rutas", async (req, res) => {
    const activa = req.query.activa === undefined ? undefined : req.query.activa === "true";
    res.json(await c.listarRutas.ejecutar({ activa }));
  });

  privado.post("/rutas", async (req, res) => {
    res.status(201).json(await c.crearRuta.ejecutar(actorDe(res), crearRutaSchema.parse(req.body)));
  });

  privado.patch("/rutas/:id", async (req, res) => {
    const id = idNumerico.parse(req.params.id);
    res.json(await c.actualizarRuta.ejecutar(actorDe(res), id, actualizarRutaSchema.parse(req.body)));
  });

  privado.get("/clientes", async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    res.json(await c.listarClientes.ejecutar({ q }));
  });

  privado.post("/clientes", async (req, res) => {
    res.status(201).json(await c.crearCliente.ejecutar(crearClienteSchema.parse(req.body)));
  });

  privado.patch("/clientes/:id", async (req, res) => {
    const id = idUuid.parse(req.params.id);
    res.json(await c.actualizarCliente.ejecutar(id, actualizarClienteSchema.parse(req.body)));
  });

  privado.delete("/clientes/:id", async (req, res) => {
    await c.eliminarCliente.ejecutar(idUuid.parse(req.params.id));
    res.status(204).end();
  });

  privado.post("/envios/cotizar", async (req, res) => {
    res.json(await c.cotizar.ejecutar(cotizacionSchema.parse(req.body)));
  });

  privado.get("/envios", async (req, res) => {
    res.json(await c.listarEnvios.ejecutar(filtroEnviosSchema.parse(req.query), paginacionSchema.parse(req.query)));
  });

  privado.post("/envios", async (req, res) => {
    res.status(201).json(await c.crearEnvio.ejecutar(actorDe(res), crearEnvioSchema.parse(req.body)));
  });

  privado.get("/envios/:id", async (req, res) => {
    res.json(await c.obtenerEnvio.ejecutar(idUuid.parse(req.params.id)));
  });

  privado.patch("/envios/:id/estado", async (req, res) => {
    const { estado, nota } = cambioEstadoSchema.parse(req.body);
    res.json(await c.cambiarEstado.ejecutar(actorDe(res), idUuid.parse(req.params.id), estado, nota));
  });

  privado.post("/envios/:id/evidencia", subirArchivo("foto"), async (req, res) => {
    const id = idUuid.parse(req.params.id);
    const { recibidoPor } = evidenciaSchema.parse(req.body ?? {});
    res.json(await c.subirEvidencia.ejecutar(actorDe(res), id, { foto: bytesSubidos(req), recibidoPor }));
  });

  // Foto privada: solo con token y sin caché en navegador ni proxies.
  privado.get("/envios/:id/evidencia", async (req, res) => {
    const { bytes, tipo } = await c.obtenerEvidencia.ejecutar(idUuid.parse(req.params.id));
    res
      .status(200)
      .set({ "Content-Type": tipo, "Cache-Control": "private, no-store", "Content-Disposition": "inline" })
      .end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length));
  });

  privado.get("/dashboard/resumen", async (req, res) => {
    res.json(await c.resumen.ejecutar(filtroResumenSchema.parse(req.query)));
  });

  // ── Integraciones con empresas (solo ADMIN; lo exige cada caso de uso) ──
  privado.get("/integraciones", async (_req, res) => {
    res.json(await c.listarIntegraciones.ejecutar(actorDe(res)));
  });

  privado.post("/integraciones", async (req, res) => {
    res.status(201).json(await c.crearIntegracion.ejecutar(actorDe(res), crearIntegracionSchema.parse(req.body)));
  });

  privado.get("/integraciones/:id", async (req, res) => {
    res.json(await c.obtenerIntegracion.ejecutar(actorDe(res), idUuid.parse(req.params.id)));
  });

  privado.patch("/integraciones/:id", async (req, res) => {
    const id = idUuid.parse(req.params.id);
    res.json(await c.actualizarIntegracion.ejecutar(actorDe(res), id, actualizarIntegracionSchema.parse(req.body)));
  });

  privado.delete("/integraciones/:id", async (req, res) => {
    await c.eliminarIntegracion.ejecutar(actorDe(res), idUuid.parse(req.params.id));
    res.status(204).end();
  });

  // La key completa solo viaja en esta respuesta: que nadie (navegador ni proxy) la guarde.
  privado.post("/integraciones/:id/keys", async (req, res) => {
    const id = idUuid.parse(req.params.id);
    const r = await c.crearApiKey.ejecutar(actorDe(res), id, crearApiKeySchema.parse(req.body));
    res.status(201).set("Cache-Control", "no-store").json(r);
  });

  privado.delete("/integraciones/:id/keys/:keyId", async (req, res) => {
    await c.revocarApiKey.ejecutar(actorDe(res), idUuid.parse(req.params.id), idUuid.parse(req.params.keyId));
    res.status(204).end();
  });

  privado.put("/integraciones/:id/webhook", async (req, res) => {
    const id = idUuid.parse(req.params.id);
    const r = await c.configurarWebhook.ejecutar(actorDe(res), id, webhookSchema.parse(req.body));
    res.set("Cache-Control", "no-store").json(r);
  });

  privado.post("/integraciones/:id/webhook/rotar-secreto", async (req, res) => {
    const r = await c.rotarSecretoWebhook.ejecutar(actorDe(res), idUuid.parse(req.params.id));
    res.set("Cache-Control", "no-store").json(r);
  });

  privado.delete("/integraciones/:id/webhook", async (req, res) => {
    await c.eliminarWebhook.ejecutar(actorDe(res), idUuid.parse(req.params.id));
    res.status(204).end();
  });

  privado.post("/integraciones/:id/webhook/prueba", async (req, res) => {
    res.json(await c.enviarWebhookPrueba.ejecutar(actorDe(res), idUuid.parse(req.params.id)));
  });

  privado.get("/integraciones/:id/webhook/entregas", async (req, res) => {
    const id = idUuid.parse(req.params.id);
    res.json(
      await c.listarEntregasWebhook.ejecutar(
        actorDe(res),
        id,
        filtroEntregasSchema.parse(req.query),
        paginacionSchema.parse(req.query),
      ),
    );
  });

  privado.post("/integraciones/:id/webhook/entregas/:entregaId/reintentar", async (req, res) => {
    const id = idUuid.parse(req.params.id);
    res.json(await c.reintentarEntregaWebhook.ejecutar(actorDe(res), id, idUuid.parse(req.params.entregaId)));
  });

  privado.get("/integraciones/:id/solicitudes", async (req, res) => {
    const id = idUuid.parse(req.params.id);
    res.json(await c.listarSolicitudesApi.ejecutar(actorDe(res), id, paginacionSchema.parse(req.query)));
  });

  return Router().use(publico).use(privado);
}
