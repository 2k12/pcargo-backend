import type { Express } from "express";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adaptadoresEnMemoria, adaptadoresPostgres, crearCasosDeUso, type Adaptadores } from "../../../src/infrastructure/container.js";
import { crearApp } from "../../../src/infrastructure/http/app.js";
import { nuevoEnvioApiSchema } from "../../../src/infrastructure/http/integraciones/esquemasApi.js";
import { migrar } from "../../../src/infrastructure/persistence/postgres/migrar.js";
import { crearPool, type Db } from "../../../src/infrastructure/persistence/postgres/pool.js";
import { sembrar } from "../../../src/infrastructure/persistence/postgres/sembrar.js";
import { USUARIOS_SEED } from "../../../src/infrastructure/persistence/seed-data.js";
import { JWT_SECRET_TEST, solicitudEnvio } from "../../helpers/fakes.js";

// Contrato v21: número del sistema (consecutivo corto) y guía física antigua separados, sobre la pila HTTP completa.
// En memoria siempre y en Postgres si hay TEST_DATABASE_URL (BD propia <bd>_guia_fisica), donde las altas simultáneas
// son concurrentes de verdad.

interface Entorno {
  adaptadores: Adaptadores;
  cerrar: () => Promise<void>;
}

async function entornoMemoria(): Promise<Entorno> {
  return { adaptadores: await adaptadoresEnMemoria({ jwtSecret: JWT_SECRET_TEST, rondasBcrypt: 4 }), cerrar: async () => {} };
}

async function entornoPostgres(url: string): Promise<Entorno> {
  const u = new URL(url);
  const nombreBd = `${u.pathname.slice(1)}_guia_fisica`;
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
  return { adaptadores: adaptadoresPostgres(db, { JWT_SECRET: JWT_SECRET_TEST, JWT_EXPIRES_IN: "1h" }), cerrar: () => db.end() };
}

const REPARTIDOR_ID = USUARIOS_SEED.find((u) => u.rol === "REPARTIDOR")!.id;

interface EnvioRespuesta {
  id: string;
  numeroGuia: number;
  guiaFisica: number | null;
}

function suite(nombre: string, crearEntorno: () => Promise<Entorno>): void {
  describe(`Guía física y consecutivo corto v21 (${nombre})`, () => {
    let entorno: Entorno;
    let app: Express;
    let operador: string;
    let repartidor: string;
    let portal: string;

    const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
    const items = [{ tipoCarga: "SOBRE", cantidad: 1, pesoKg: 0.2 }];
    const crearEnvio = (extra: Record<string, unknown> = {}) =>
      request(app)
        .post("/api/envios")
        .set(auth(operador))
        .send(solicitudEnvio({ items, formaPago: "CONTRATO", ...extra }));
    const buscarGuia = (numero: string | number, t = operador) =>
      request(app).get(`/api/envios/buscar-guia/${numero}`).set(auth(t));

    beforeAll(async () => {
      entorno = await crearEntorno();
      app = crearApp(crearCasosDeUso(entorno.adaptadores));
      const login = async (email: string, password: string) =>
        (await request(app).post("/api/auth/login").send({ email, password }).expect(200)).body.token as string;
      operador = await login("operador@pcargo.ec", "Operador123!");
      repartidor = await login("repartidor@pcargo.ec", "Repartidor123!");
      portal = await login("portal@pcargo.ec", "Portal123!");
    });

    afterAll(async () => {
      await entorno?.cerrar();
    });

    it("el consecutivo arranca en 1 y salta los números ocupados por guías indicadas", async () => {
      expect((await crearEnvio().expect(201)).body).toMatchObject({ numeroGuia: 1, guiaFisica: null });
      await crearEnvio({ numeroGuia: "0002" }).expect(201); // ocupa el 2
      expect((await crearEnvio().expect(201)).body.numeroGuia).toBe(3);
    });

    it("guiaFisica: se normaliza, se guarda y se devuelve; repetida (con o sin ceros) → 409; formato inválido → 400", async () => {
      const e = (await crearEnvio({ guiaFisica: " 0040425 " }).expect(201)).body as EnvioRespuesta;
      expect(e.guiaFisica).toBe(40425);
      expect(e.numeroGuia).toBeLessThan(100); // el número del sistema sigue siendo corto
      const leido = (await request(app).get(`/api/envios/${e.id}`).set(auth(operador)).expect(200)).body;
      expect(leido).toMatchObject({ numeroGuia: e.numeroGuia, guiaFisica: 40425 });

      for (const repetida of [40425, "40425", "000040425"]) {
        const r = await crearEnvio({ guiaFisica: repetida }).expect(409);
        expect(r.body.error).toMatchObject({ code: "CONFLICTO" });
        expect(r.body.error.message).toMatch(/40425/);
      }
      for (const invalida of ["40-425", "abc", "1234567890123", 0, -5, 1.5]) {
        expect((await crearEnvio({ guiaFisica: invalida }).expect(400)).body.error.code).toBe("VALIDACION");
      }
      expect((await crearEnvio({ guiaFisica: "  " }).expect(201)).body.guiaFisica).toBeNull();
      expect((await crearEnvio({ guiaFisica: null }).expect(201)).body.guiaFisica).toBeNull();
    });

    it("dos altas simultáneas con la misma guía física: una 201 y la otra 409", async () => {
      const respuestas = await Promise.all(Array.from({ length: 4 }, () => crearEnvio({ guiaFisica: 777001 })));
      const estados = respuestas.map((r) => r.status).sort();
      expect(estados).toEqual([201, 409, 409, 409]);
    });

    it("la guía física puede coincidir con el numeroGuia de otro envío; buscar-guia, ?q= y seguimiento encuentran ambos", async () => {
      const a = (await crearEnvio().expect(201)).body as EnvioRespuesta;
      const b = (await crearEnvio({ guiaFisica: a.numeroGuia }).expect(201)).body as EnvioRespuesta;
      const c = (await crearEnvio({ guiaFisica: 90000123 }).expect(201)).body as EnvioRespuesta;

      // búsqueda rápida: primero el que coincide por numeroGuia; acepta ceros a la izquierda
      const ambos = (await buscarGuia(`000${a.numeroGuia}`).expect(200)).body as EnvioRespuesta[];
      expect(ambos.map((e) => e.id)).toEqual([a.id, b.id]);
      expect(ambos[1]).toMatchObject({ guiaFisica: a.numeroGuia });
      expect(((await buscarGuia("090000123").expect(200)).body as EnvioRespuesta[]).map((e) => e.id)).toEqual([c.id]);
      expect((await buscarGuia(987654321012).expect(200)).body).toEqual([]);
      expect((await buscarGuia("12a").expect(400)).body.error.code).toBe("VALIDACION");
      await buscarGuia(1, repartidor).expect(403);
      await buscarGuia(1, portal).expect(403);
      await request(app).get("/api/envios/buscar-guia/1").expect(401);

      // ?q= con dígitos: numeroGuia o guiaFisica exactos
      const lista = (await request(app).get(`/api/envios?q=0${a.numeroGuia}&porPagina=100`).set(auth(operador)).expect(200)).body;
      expect(lista.datos.map((e: EnvioRespuesta) => e.id).sort()).toEqual([a.id, b.id].sort());
      const porFisica = (await request(app).get("/api/envios?q=90000123").set(auth(operador)).expect(200)).body;
      expect(porFisica.datos.map((e: EnvioRespuesta) => e.id)).toEqual([c.id]);

      // seguimiento público: primero por numeroGuia; si no hay, por guía física
      expect((await request(app).get(`/api/seguimiento/${a.numeroGuia}`).expect(200)).body.numeroGuia).toBe(a.numeroGuia);
      expect((await request(app).get("/api/seguimiento/0090000123").expect(200)).body.numeroGuia).toBe(c.numeroGuia);
      await request(app).get("/api/seguimiento/90000124").expect(404);
    });

    it("el repartidor encuentra por guía física solo los envíos asignados a él", async () => {
      const asignado = (await crearEnvio({ guiaFisica: 5550001 }).expect(201)).body as EnvioRespuesta;
      const ajeno = (await crearEnvio({ guiaFisica: 5550002 }).expect(201)).body as EnvioRespuesta;
      await request(app)
        .post("/api/envios/asignar")
        .set(auth(operador))
        .send({ envioIds: [asignado.id], repartidorId: REPARTIDOR_ID })
        .expect(200);
      const r = (await request(app).get("/api/repartidor/envios/guia/005550001").set(auth(repartidor)).expect(200)).body;
      expect(r).toMatchObject({ id: asignado.id, numeroGuia: asignado.numeroGuia, guiaFisica: 5550001 });
      await request(app).get("/api/repartidor/envios/guia/5550002").set(auth(repartidor)).expect(404);
      await request(app).get(`/api/repartidor/envios/guia/${asignado.numeroGuia}`).set(auth(repartidor)).expect(200);
      expect(ajeno.guiaFisica).toBe(5550002);
    });

    it("el portal ignora guiaFisica (el envío queda sin guía física)", async () => {
      const r = await request(app)
        .post("/api/portal/envios")
        .set(auth(portal))
        .send({
          destinatario: { nombre: "Ana", telefono: "0987654321", direccion: "Quito" },
          rutaId: 11,
          items,
          guiaFisica: 3330001,
        })
        .expect(201);
      const leido = (await request(app).get(`/api/envios/${r.body.id}`).set(auth(operador)).expect(200)).body;
      expect(leido.guiaFisica).toBeNull();
      expect((await buscarGuia(3330001).expect(200)).body).toEqual([]);
    });
  });
}

describe("API de empresas (v21)", () => {
  it("el esquema acepta guiaFisica sin error (el caso de uso no la pasa al registrar el envío)", () => {
    const d = nuevoEnvioApiSchema.parse({
      referenciaExterna: "PED-1",
      destinatario: { nombre: "Ana", telefono: "0987654321", direccion: "Quito", ciudad: "Quito" },
      items: [{ tipoCarga: "SOBRE", cantidad: 1, pesoKg: 0.2 }],
      guiaFisica: 123,
    });
    expect(d.referenciaExterna).toBe("PED-1");
  });
});

suite("memoria", entornoMemoria);

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("PostgreSQL", () => {
  suite("postgres", () => entornoPostgres(url!));
});
