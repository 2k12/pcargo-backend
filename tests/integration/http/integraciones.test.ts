import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adaptadoresEnMemoria,
  adaptadoresPostgres,
  crearCasosDeUso,
  type Adaptadores,
  type CasosDeUso,
} from "../../../src/infrastructure/container.js";
import { MemoryLimitadorTasa } from "../../../src/infrastructure/cache/memoria.js";
import { crearApp } from "../../../src/infrastructure/http/app.js";
import { migrar } from "../../../src/infrastructure/persistence/postgres/migrar.js";
import { crearPool, type Db } from "../../../src/infrastructure/persistence/postgres/pool.js";
import { sembrar } from "../../../src/infrastructure/persistence/postgres/sembrar.js";
import { verificarFirmaWebhook } from "../../../src/infrastructure/security/firmaWebhook.js";
import { JWT_SECRET_TEST } from "../../helpers/fakes.js";

// Flujo completo de la API para empresas (contrato v10) sobre la pila HTTP real. Se ejecuta en memoria siempre
// y contra Postgres si hay TEST_DATABASE_URL (en una BD propia, <bd>_integraciones, para no chocar con otras suites).

const CLAVE_CIFRADO = Buffer.alloc(32, 3).toString("base64");
const BASE = "/api/v1/integraciones";

/** Servidor HTTP local que hace de "empresa" y recibe los webhooks. */
class ReceptorWebhooks {
  recibidos: { headers: IncomingHttpHeaders; cuerpo: string }[] = [];
  status = 204;
  private servidor!: Server;
  url = "";

  async iniciar(): Promise<void> {
    this.servidor = createServer((req, res) => {
      let cuerpo = "";
      req.on("data", (c) => (cuerpo += c));
      req.on("end", () => {
        this.recibidos.push({ headers: req.headers, cuerpo });
        res.writeHead(this.status).end();
      });
    });
    await new Promise<void>((r) => this.servidor.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.servidor.address() as AddressInfo).port}/pcargo/webhooks`;
  }

  detener(): Promise<void> {
    return new Promise((r) => this.servidor.close(() => r()));
  }
}

interface Entorno {
  adaptadores: Adaptadores;
  cerrar: () => Promise<void>;
}

async function entornoMemoria(): Promise<Entorno> {
  const adaptadores = await adaptadoresEnMemoria({ jwtSecret: JWT_SECRET_TEST, rondasBcrypt: 4, webhooksPermitirHttp: true });
  return { adaptadores, cerrar: async () => {} };
}

async function entornoPostgres(url: string): Promise<Entorno> {
  const u = new URL(url);
  const nombreBd = `${u.pathname.slice(1)}_integraciones`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  const existe = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [nombreBd]);
  if (!existe.rowCount) await admin.query(`CREATE DATABASE "${nombreBd}"`);
  await admin.end();
  u.pathname = `/${nombreBd}`;
  const db: Db = crearPool(u.toString());
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrar(db, () => {});
  await sembrar(db, 4);
  const adaptadores = adaptadoresPostgres(db, {
    JWT_SECRET: JWT_SECRET_TEST,
    JWT_EXPIRES_IN: "1h",
    INTEGRACIONES_CLAVE_CIFRADO: CLAVE_CIFRADO,
    WEBHOOKS_PERMITIR_HTTP: true,
  });
  return { adaptadores, cerrar: () => db.end() };
}

function suite(nombre: string, crearEntorno: () => Promise<Entorno>): void {
  describe(`API para empresas (${nombre})`, () => {
    let entorno: Entorno;
    let casos: CasosDeUso;
    let app: Express;
    let tokenAdmin: string;
    let tokenOperador: string;
    let integracionId: string;
    let keyLive: string;
    let keyId: string;
    const receptor = new ReceptorWebhooks();

    const panel = (t: string) => ({ Authorization: `Bearer ${t}` });
    const conKey = (k: string) => ({ Authorization: `Bearer ${k}` });
    const nuevo = (ref: string, sobre: Record<string, unknown> = {}) => ({
      referenciaExterna: ref,
      destinatario: { nombre: "Rosa Cevallos", telefono: "0991234567", direccion: "Av. Amazonas N24-56", ciudad: "Quito" },
      items: [{ tipoCarga: "PAQUETE", cantidad: 2, pesoKg: 3 }],
      ...sobre,
    });
    const crearKey = async (id: string, modo: "live" | "test", alcances: string[]) =>
      (
        await request(app)
          .post(`/api/integraciones/${id}/keys`)
          .set(panel(tokenAdmin))
          .send({ nombre: `Key ${modo}`, modo, alcances })
          .expect(201)
      ).body as { key: string; apiKey: { id: string; prefijo: string } };

    beforeAll(async () => {
      entorno = await crearEntorno();
      await receptor.iniciar();
      casos = crearCasosDeUso(entorno.adaptadores, undefined, { publicUrl: "https://pcargo.example", webhooksPermitirHttp: true });
      app = crearApp(casos);
      const login = async (email: string, password: string) =>
        (await request(app).post("/api/auth/login").send({ email, password })).body.token as string;
      tokenAdmin = await login("admin@pcargo.ec", "Admin123!");
      tokenOperador = await login("operador@pcargo.ec", "Operador123!");
    });

    afterAll(async () => {
      await receptor.detener();
      await entorno?.cerrar();
    });

    it("el ADMIN crea la integración y una key (el OPERADOR no puede)", async () => {
      const datos = {
        nombre: "Tienda Andina",
        remitente: { nombre: "Tienda Andina S.A.", telefono: "062600100", direccion: "Bolívar 1-23, Ibarra" },
        ciudadOrigenId: 1,
        ipsPermitidas: [],
      };
      await request(app).post("/api/integraciones").set(panel(tokenOperador)).send(datos).expect(403);
      await request(app).post("/api/integraciones").set(panel(tokenAdmin)).send({ ...datos, extra: 1 }).expect(400);
      await request(app).post("/api/integraciones").set(panel(tokenAdmin)).send({ ...datos, ipsPermitidas: ["10.0.0.0/33"] }).expect(400);
      const r = await request(app).post("/api/integraciones").set(panel(tokenAdmin)).send(datos).expect(201);
      expect(r.body).toMatchObject({ nombre: "Tienda Andina", ciudadOrigen: "Ibarra", formaPagoPorDefecto: "CONTRATO", keys: [], envios: 0 });
      integracionId = r.body.id;
      await request(app).post("/api/integraciones").set(panel(tokenAdmin)).send({ ...datos, nombre: "tienda andina" }).expect(409);

      const k = await request(app)
        .post(`/api/integraciones/${integracionId}/keys`)
        .set(panel(tokenAdmin))
        .send({ nombre: "Producción", modo: "live", alcances: ["envios:crear", "envios:leer", "cotizar"] })
        .expect(201);
      expect(k.headers["cache-control"]).toBe("no-store");
      expect(k.body.key).toMatch(/^pc_live_[0-9A-Za-z]{8}_[0-9A-Za-z]{32}$/);
      keyLive = k.body.key;
      keyId = k.body.apiKey.id;
      const lista = await request(app).get("/api/integraciones").set(panel(tokenAdmin)).expect(200);
      expect(JSON.stringify(lista.body)).not.toContain(keyLive.slice(17));
      expect(lista.body[0].keys[0]).toMatchObject({ id: keyId, prefijo: keyLive.slice(0, 16), revocadaEn: null });
    });

    it("OpenAPI 3.1 pública con todos los endpoints, seguridad bearer, Idempotency-Key y webhooks", async () => {
      const r = await request(app).get(`${BASE}/openapi.json`).expect(200);
      expect(r.body.openapi).toBe("3.1.0");
      expect(Object.keys(r.body.paths).sort()).toEqual(["/cobertura", "/cotizar", "/envios", "/envios/lote", "/envios/{referenciaExterna}", "/openapi.json"]);
      expect(r.body.components.securitySchemes.apiKey).toMatchObject({ type: "http", scheme: "bearer" });
      expect(r.body.components.parameters.IdempotencyKey).toMatchObject({ in: "header", required: true });
      expect(Object.keys(r.body.webhooks)).toEqual(["envio.creado", "envio.estado_actualizado", "envio.evidencia_registrada"]);
      expect(r.body.info.description).toMatch(/HMAC-SHA256/);
    });

    it("autenticación: sin key, JWT del panel o key falsa → 401 API_KEY_INVALIDA (mismo mensaje); la key no sirve en el panel", async () => {
      const respuestas = [
        await request(app).get(`${BASE}/cobertura`),
        await request(app).get(`${BASE}/cobertura`).set(panel(tokenAdmin)),
        await request(app).get(`${BASE}/cobertura`).set(conKey(`${keyLive.slice(0, 17)}${"x".repeat(32)}`)),
        await request(app).get(`${BASE}/cobertura`).set({ Authorization: `Basic ${keyLive}` }),
      ];
      for (const r of respuestas) {
        expect(r.status).toBe(401);
        expect(r.body).toEqual({ error: { code: "API_KEY_INVALIDA", message: "API key inválida o revocada" } });
        expect(r.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
      }
      const enPanel = await request(app).get("/api/envios").set(conKey(keyLive)).expect(401);
      expect(enPanel.body.error.code).toBe("NO_AUTENTICADO");
      // rutas desconocidas de la API para empresas no caen en el panel
      await request(app).get(`${BASE}/nada`).set(conKey(keyLive)).expect(404);
    });

    it("cobertura y cotización (sin distinguir mayúsculas ni tildes)", async () => {
      const cob = await request(app).get(`${BASE}/cobertura`).set(conKey(keyLive)).expect(200);
      expect(cob.body.origen).toBe("Ibarra");
      expect(cob.body.destinos).toContainEqual({ ciudad: "Quito", tiempoEstimadoMin: 180 });
      const cot = await request(app)
        .post(`${BASE}/cotizar`)
        .set(conKey(keyLive))
        .send({ destino: { ciudad: "OTÁVALO" }, items: [{ tipoCarga: "TELA", cantidad: 10, pesoKg: 2 }], zona: "RURAL" })
        .expect(200);
      expect(cot.body).toMatchObject({ costo: 15, zona: "RURAL", totalPiezas: 10 });
      const sinRuta = await request(app)
        .post(`${BASE}/cotizar`)
        .set(conKey(keyLive))
        .send({ destino: { ciudad: "Lima" }, items: [{ tipoCarga: "SOBRE", cantidad: 1, pesoKg: 0.1 }] })
        .expect(422);
      expect(sinRuta.body.error.code).toBe("RUTA_NO_DISPONIBLE");
    });

    let envioId: string;
    let numeroGuia: number;

    it("crea un envío con idempotencia: replay idéntico, conflicto con otro cuerpo, referencia repetida 409", async () => {
      await request(app).post(`${BASE}/envios`).set(conKey(keyLive)).send(nuevo("PED-1001")).expect(400); // sin Idempotency-Key
      const desconocido = await request(app)
        .post(`${BASE}/envios`)
        .set(conKey(keyLive))
        .set("Idempotency-Key", "k-0")
        .send({ ...nuevo("PED-1001"), remitente: { nombre: "Intruso" } })
        .expect(400);
      expect(desconocido.body.error.code).toBe("VALIDACION");

      const r = await request(app).post(`${BASE}/envios`).set(conKey(keyLive)).set("Idempotency-Key", "k-1").send(nuevo("PED-1001")).expect(201);
      expect(r.headers["idempotent-replayed"]).toBeUndefined();
      expect(r.body).toMatchObject({
        referenciaExterna: "PED-1001",
        prueba: false,
        estado: "REGISTRADO",
        origen: "Ibarra",
        destino: "Quito",
        costo: 6,
        formaPago: "CONTRATO",
        seguimientoUrl: `https://pcargo.example/seguimiento/${r.body.numeroGuia}`,
      });
      envioId = r.body.id;
      numeroGuia = r.body.numeroGuia;

      // mismo cuerpo con las claves en otro orden: misma respuesta, sin crear otro envío
      const { items, ...resto } = nuevo("PED-1001");
      const replay = await request(app).post(`${BASE}/envios`).set(conKey(keyLive)).set("Idempotency-Key", "k-1").send({ items, ...resto }).expect(201);
      expect(replay.headers["idempotent-replayed"]).toBe("true");
      expect(replay.body).toEqual(r.body);

      const conflicto = await request(app).post(`${BASE}/envios`).set(conKey(keyLive)).set("Idempotency-Key", "k-1").send(nuevo("PED-1002")).expect(422);
      expect(conflicto.body.error.code).toBe("IDEMPOTENCIA_CONFLICTO");

      const repetida = await request(app).post(`${BASE}/envios`).set(conKey(keyLive)).set("Idempotency-Key", "k-2").send(nuevo("PED-1001")).expect(409);
      expect(repetida.body.error).toMatchObject({ code: "CONFLICTO", envio: { numeroGuia, referenciaExterna: "PED-1001" } });
      // la respuesta de error también se reproduce
      const repetida2 = await request(app).post(`${BASE}/envios`).set(conKey(keyLive)).set("Idempotency-Key", "k-2").send(nuevo("PED-1001")).expect(409);
      expect(repetida2.headers["idempotent-replayed"]).toBe("true");

      const lista = await request(app).get("/api/envios?canal=API").set(panel(tokenOperador)).expect(200);
      expect(lista.body.total).toBe(1);
      expect(lista.body.datos[0]).toMatchObject({
        id: envioId,
        referenciaExterna: "PED-1001",
        origen: { canal: "API", integracionId, integracion: "Tienda Andina" },
        remitente: { nombre: "Tienda Andina S.A.", telefono: "062600100", direccion: "Bolívar 1-23, Ibarra" },
        registro: { operador: null },
      });
      expect((await request(app).get("/api/envios?q=ped-100").set(panel(tokenOperador))).body.total).toBe(1);
      expect((await request(app).get(`/api/envios?integracionId=${integracionId}`).set(panel(tokenOperador))).body.total).toBe(1);
      expect((await request(app).get("/api/envios?canal=PANEL").set(panel(tokenOperador))).body.total).toBe(0);
      await request(app).get("/api/envios?canal=OTRO").set(panel(tokenOperador)).expect(400);
    });

    it("consulta por referencia propia (con historial y sin operadores) y 404 con referencia ajena", async () => {
      const r = await request(app).get(`${BASE}/envios/PED-1001`).set(conKey(keyLive)).expect(200);
      expect(r.body).toMatchObject({ id: envioId, numeroGuia, historial: [{ estado: "REGISTRADO", nota: "Ingresado por API: Tienda Andina" }] });
      expect(r.body.historial[0]).not.toHaveProperty("usuario");
      expect(r.body).not.toHaveProperty("remitente");

      const otra = await request(app)
        .post("/api/integraciones")
        .set(panel(tokenAdmin))
        .send({ nombre: "Distribuidora Norte", remitente: { nombre: "Norte", telefono: "062999000", direccion: "Sucre 5-10" }, ciudadOrigenId: 1 })
        .expect(201);
      const { key } = await crearKey(otra.body.id, "live", ["envios:leer"]);
      await request(app).get(`${BASE}/envios/PED-1001`).set(conKey(key)).expect(404);
    });

    it("alcance insuficiente → 403; modo prueba no persiste; lote mixto", async () => {
      const soloCotizar = await crearKey(integracionId, "live", ["cotizar"]);
      const r = await request(app).post(`${BASE}/envios`).set(conKey(soloCotizar.key)).set("Idempotency-Key", "a-1").send(nuevo("PED-2")).expect(403);
      expect(r.body.error.code).toBe("ALCANCE_INSUFICIENTE");
      // sin alcance: 403 aunque el body o el header sean inválidos
      await request(app).post(`${BASE}/envios/lote`).set(conKey(soloCotizar.key)).send({}).expect(403);
      await request(app).get(`${BASE}/envios/PED-1001`).set(conKey(soloCotizar.key)).expect(403);

      const prueba = await crearKey(integracionId, "test", ["envios:crear", "envios:leer"]);
      const p = await request(app).post(`${BASE}/envios`).set(conKey(prueba.key)).set("Idempotency-Key", "k-1").send(nuevo("PED-T1")).expect(201);
      expect(p.body).toMatchObject({ prueba: true, numeroGuia: 0, id: expect.stringMatching(/^prueba_/), costo: 6 });
      // la idempotencia también funciona en modo prueba (y no se mezcla con la de las keys reales)
      const pr = await request(app).post(`${BASE}/envios`).set(conKey(prueba.key)).set("Idempotency-Key", "k-1").send(nuevo("PED-T1")).expect(201);
      expect(pr.headers["idempotent-replayed"]).toBe("true");
      expect(pr.body).toEqual(p.body);
      await request(app).get(`${BASE}/envios/PED-T1`).set(conKey(prueba.key)).expect(404);
      expect((await request(app).get("/api/envios?canal=API").set(panel(tokenOperador))).body.total).toBe(1);

      const lote = await request(app)
        .post(`${BASE}/envios/lote`)
        .set(conKey(keyLive))
        .set("Idempotency-Key", "lote-1")
        .send({
          envios: [
            nuevo("L-1"),
            { referenciaExterna: "L-2" },
            nuevo("PED-1001"),
            nuevo("L-4", { destinatario: { nombre: "Ana", telefono: "0991112233", direccion: "Centro", ciudad: "Cuenca" } }),
            nuevo("L-5", { items: [{ tipoCarga: "VALIJA", cantidad: 1, pesoKg: 5 }], formaPago: "AL_COBRO" }),
          ],
        })
        .expect(200);
      expect(lote.body).toMatchObject({ creados: 2, fallidos: 3 });
      expect(lote.body.resultados.map((x: { indice: number; ok: boolean; error?: { code: string } }) => [x.indice, x.ok ? "ok" : x.error!.code])).toEqual([
        [0, "ok"],
        [1, "VALIDACION"],
        [2, "CONFLICTO"],
        [3, "RUTA_NO_DISPONIBLE"],
        [4, "ok"],
      ]);
      expect(lote.body.resultados[4].envio).toMatchObject({ formaPago: "AL_COBRO", costo: 3 });
      await request(app).post(`${BASE}/envios/lote`).set(conKey(keyLive)).set("Idempotency-Key", "lote-2").send({ envios: [] }).expect(400);
    });

    it("el envío aparece en el resumen por canal y filtra por integración", async () => {
      const r = await request(app).get("/api/dashboard/resumen").set(panel(tokenOperador)).expect(200);
      // PED-1001 (6.00) + L-1 (6.00) + L-5 (3.00); el envío de prueba no cuenta
      expect(r.body.porCanal).toEqual([{ canal: "API", integracionId, nombre: "Tienda Andina", envios: 3, monto: 15 }]);
      const filtrado = await request(app).get(`/api/dashboard/resumen?canal=API&integracionId=${integracionId}`).set(panel(tokenOperador)).expect(200);
      expect(filtrado.body.totalEnvios).toBe(3);
      expect((await request(app).get("/api/dashboard/resumen?canal=PANEL").set(panel(tokenOperador))).body.totalEnvios).toBe(0);
    });

    it("un cambio de estado desde el panel encola el webhook y el despachador lo entrega firmado; reintento tras fallo", async () => {
      const cfg = await request(app)
        .put(`/api/integraciones/${integracionId}/webhook`)
        .set(panel(tokenAdmin))
        .send({ url: receptor.url, eventos: ["envio.estado_actualizado", "envio.creado"], activo: true })
        .expect(200);
      const secreto: string = cfg.body.secreto;
      expect(secreto).toMatch(/^whsec_/);
      expect(cfg.body.integracion.webhook).toMatchObject({ url: receptor.url, activo: true, secretoPrefijo: secreto.slice(0, 10) });

      await request(app).patch(`/api/envios/${envioId}/estado`).set(panel(tokenOperador)).send({ estado: "EN_TRANSITO" }).expect(200);
      const pendientes = await request(app).get(`/api/integraciones/${integracionId}/webhook/entregas?estado=PENDIENTE`).set(panel(tokenAdmin)).expect(200);
      expect(pendientes.body.total).toBe(1);
      expect(pendientes.body.datos[0]).toMatchObject({ evento: "envio.estado_actualizado", envioId, numeroGuia, intentos: 0 });

      expect(await casos.despacharWebhooks.ejecutar()).toBe(1);
      const recibido = receptor.recibidos.at(-1)!;
      expect(
        verificarFirmaWebhook(
          secreto,
          { id: String(recibido.headers["webhook-id"]), timestamp: String(recibido.headers["webhook-timestamp"]), firma: String(recibido.headers["webhook-signature"]) },
          recibido.cuerpo,
        ),
      ).toBe(true);
      const cuerpo = JSON.parse(recibido.cuerpo);
      expect(cuerpo).toMatchObject({ type: "envio.estado_actualizado", data: { id: envioId, referenciaExterna: "PED-1001", estado: "EN_TRANSITO" } });
      expect(recibido.cuerpo).not.toContain("operador");
      const entregadas = await request(app).get(`/api/integraciones/${integracionId}/webhook/entregas?estado=ENTREGADO`).set(panel(tokenAdmin)).expect(200);
      expect(entregadas.body.datos[0]).toMatchObject({ estado: "ENTREGADO", intentos: 1, ultimoStatus: 204 });

      // la empresa falla: queda pendiente con reintento programado; luego se reintenta a mano
      receptor.status = 500;
      await request(app).patch(`/api/envios/${envioId}/estado`).set(panel(tokenOperador)).send({ estado: "EN_REPARTO" }).expect(200);
      await casos.despacharWebhooks.ejecutar();
      const fallo = (await request(app).get(`/api/integraciones/${integracionId}/webhook/entregas?estado=PENDIENTE`).set(panel(tokenAdmin))).body.datos[0];
      expect(fallo).toMatchObject({ intentos: 1, ultimoStatus: 500, ultimoError: "HTTP 500" });
      expect(new Date(fallo.proximoIntentoEn).getTime()).toBeGreaterThan(Date.now() + 50_000);
      receptor.status = 200;
      const reintento = await request(app)
        .post(`/api/integraciones/${integracionId}/webhook/entregas/${fallo.id}/reintentar`)
        .set(panel(tokenAdmin))
        .expect(200);
      expect(reintento.body).toMatchObject({ estado: "ENTREGADO", intentos: 2, ultimoStatus: 200 });
      const ids = receptor.recibidos.slice(-2).map((x) => x.headers["webhook-id"]);
      expect(ids[0]).toBe(ids[1]); // mismo webhook-id en el reintento

      const prueba = await request(app).post(`/api/integraciones/${integracionId}/webhook/prueba`).set(panel(tokenAdmin)).expect(200);
      expect(prueba.body).toMatchObject({ estado: "ENTREGADO", envioId: null });
      expect(JSON.parse(receptor.recibidos.at(-1)!.cuerpo).data.prueba).toBe(true);

      // un envío nuevo dispara envio.creado
      await request(app).post(`${BASE}/envios`).set(conKey(keyLive)).set("Idempotency-Key", "k-9").send(nuevo("PED-9")).expect(201);
      await casos.despacharWebhooks.ejecutar();
      expect(JSON.parse(receptor.recibidos.at(-1)!.cuerpo)).toMatchObject({ type: "envio.creado", data: { referenciaExterna: "PED-9" } });
    });

    it("IP no permitida → 403; integración inactiva → 403; key revocada → 401", async () => {
      await request(app).patch(`/api/integraciones/${integracionId}`).set(panel(tokenAdmin)).send({ ipsPermitidas: ["203.0.113.0/24"] }).expect(200);
      const ip = await request(app).get(`${BASE}/cobertura`).set(conKey(keyLive)).expect(403);
      expect(ip.body.error.code).toBe("IP_NO_PERMITIDA");
      await request(app).patch(`/api/integraciones/${integracionId}`).set(panel(tokenAdmin)).send({ ipsPermitidas: ["127.0.0.0/8", "::1"] }).expect(200);
      await request(app).get(`${BASE}/cobertura`).set(conKey(keyLive)).expect(200);

      // detrás de un proxy de confianza se usa la IP real del cliente (TRUST_PROXY)
      const conProxy = crearApp(casos, { trustProxy: 1 });
      await request(conProxy).get(`${BASE}/cobertura`).set(conKey(keyLive)).set("X-Forwarded-For", "198.51.100.7").expect(403);
      await request(app).patch(`/api/integraciones/${integracionId}`).set(panel(tokenAdmin)).send({ ipsPermitidas: [] }).expect(200);

      await request(app).patch(`/api/integraciones/${integracionId}`).set(panel(tokenAdmin)).send({ activa: false }).expect(200);
      const inactiva = await request(app).get(`${BASE}/cobertura`).set(conKey(keyLive)).expect(403);
      expect(inactiva.body.error.code).toBe("INTEGRACION_INACTIVA");
      await request(app).patch(`/api/integraciones/${integracionId}`).set(panel(tokenAdmin)).send({ activa: true }).expect(200);

      await request(app).delete(`/api/integraciones/${integracionId}/keys/${keyId}`).set(panel(tokenAdmin)).expect(204);
      const revocada = await request(app).get(`${BASE}/cobertura`).set(conKey(keyLive)).expect(401);
      expect(revocada.body.error.code).toBe("API_KEY_INVALIDA");
      const detalle = await request(app).get(`/api/integraciones/${integracionId}`).set(panel(tokenAdmin)).expect(200);
      expect(detalle.body.keys.find((k: { id: string }) => k.id === keyId).revocadaEn).not.toBeNull();
      expect(detalle.body).toMatchObject({ envios: 4 });
    });

    it("auditoría sin key ni body, con el X-Request-Id; no se elimina una integración con envíos", async () => {
      const r = await request(app).get(`/api/integraciones/${integracionId}/solicitudes?porPagina=100`).set(panel(tokenAdmin)).expect(200);
      expect(r.body.total).toBeGreaterThan(10);
      const texto = JSON.stringify(r.body);
      expect(texto).not.toContain(keyLive.slice(17));
      expect(texto).not.toContain("Rosa Cevallos");
      const creacion = r.body.datos.find(
        (s: { ruta: string; status: number; referenciaExterna: string }) =>
          s.ruta === `${BASE}/envios` && s.status === 201 && s.referenciaExterna === "PED-1001",
      );
      expect(creacion).toMatchObject({ metodo: "POST", idempotencyKey: "k-1", keyPrefijo: keyLive.slice(0, 16), ip: expect.any(String) });
      expect(creacion.requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(r.body.datos.some((s: { status: number }) => s.status === 403)).toBe(true); // también las rechazadas tras autenticar

      await request(app).delete(`/api/integraciones/${integracionId}`).set(panel(tokenAdmin)).expect(409);
    });

    it("body JSON de hasta 1 MB (más que el límite del panel); mayor → 400", async () => {
      const k = await crearKey(integracionId, "live", ["envios:crear"]);
      const grande = { envios: [nuevo("G-1", { descripcion: "x".repeat(150_000) })] };
      const r = await request(app).post(`${BASE}/envios/lote`).set(conKey(k.key)).set("Idempotency-Key", "g-1").send(grande).expect(200);
      expect(r.body.resultados[0]).toMatchObject({ ok: false, error: { code: "VALIDACION" } }); // pasó el parser; falla la descripción (> 500)
      const enorme = await request(app)
        .post(`${BASE}/envios`)
        .set(conKey(k.key))
        .set("Idempotency-Key", "g-2")
        .send(nuevo("G-2", { descripcion: "x".repeat(1_100_000) }))
        .expect(400);
      expect(enorme.body.error.code).toBe("VALIDACION");
    });
  });
}

suite("memoria", entornoMemoria);

const url = process.env.TEST_DATABASE_URL;
if (url) suite("postgres", () => entornoPostgres(url));

describe("Límite de tasa de la API para empresas", () => {
  it("120 solicitudes / min por integración, con cabeceras RateLimit-*", async () => {
    const adaptadores = await adaptadoresEnMemoria({ jwtSecret: JWT_SECRET_TEST, rondasBcrypt: 4 });
    const casos = crearCasosDeUso(adaptadores);
    const app = crearApp(casos, { limitador: new MemoryLimitadorTasa() });
    const admin = (await casos.login.ejecutar("admin@pcargo.ec", "Admin123!")).usuario;
    const actor = { id: admin.id, nombre: admin.nombre, rol: admin.rol };
    const i = await casos.crearIntegracion.ejecutar(actor, {
      nombre: "Tienda",
      remitente: { nombre: "Tienda", telefono: "062600100", direccion: "Centro" },
      ciudadOrigenId: 1,
    });
    const { key } = await casos.crearApiKey.ejecutar(actor, i.id, { nombre: "Principal", modo: "live", alcances: ["cotizar"] });
    const primera = await request(app).get(`${BASE}/cobertura`).set({ Authorization: `Bearer ${key}` }).expect(200);
    expect(primera.headers["ratelimit-limit"]).toBe("120");
    expect(primera.headers["ratelimit-remaining"]).toBe("119");
    for (let n = 2; n <= 120; n++) await request(app).get(`${BASE}/cobertura`).set({ Authorization: `Bearer ${key}` }).expect(200);
    const r = await request(app).get(`${BASE}/cobertura`).set({ Authorization: `Bearer ${key}` }).expect(429);
    expect(r.body.error.code).toBe("DEMASIADAS_SOLICITUDES");
    expect(r.headers["retry-after"]).toBeDefined();
  });
});
