import type { Express } from "express";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adaptadoresEnMemoria, adaptadoresPostgres, crearCasosDeUso, type Adaptadores } from "../../../src/infrastructure/container.js";
import { crearApp } from "../../../src/infrastructure/http/app.js";
import { fechaLocalEC, sumarDiasEC } from "../../../src/domain/shared/FechaEcuador.js";
import { migrar } from "../../../src/infrastructure/persistence/postgres/migrar.js";
import { crearPool, type Db } from "../../../src/infrastructure/persistence/postgres/pool.js";
import { sembrar } from "../../../src/infrastructure/persistence/postgres/sembrar.js";
import { JWT_SECRET_TEST, solicitudEnvio } from "../../helpers/fakes.js";

// Contrato v20: talonarios de guías en blanco sobre la pila HTTP completa. En memoria siempre y en Postgres si hay
// TEST_DATABASE_URL (BD propia <bd>_talonarios), donde las reservas y los consecutivos simultáneos son concurrentes.

interface Entorno {
  adaptadores: Adaptadores;
  cerrar: () => Promise<void>;
}

async function entornoMemoria(): Promise<Entorno> {
  return { adaptadores: await adaptadoresEnMemoria({ jwtSecret: JWT_SECRET_TEST, rondasBcrypt: 4 }), cerrar: async () => {} };
}

async function entornoPostgres(url: string): Promise<Entorno> {
  const u = new URL(url);
  const nombreBd = `${u.pathname.slice(1)}_talonarios`;
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

interface GuiaTalonario {
  numeroGuia: number;
  estado: string;
  envioId: string | null;
}

function suite(nombre: string, crearEntorno: () => Promise<Entorno>): void {
  describe(`Talonarios de guías en blanco v20 (${nombre})`, () => {
    let entorno: Entorno;
    let app: Express;
    let admin: string;
    let operador: string;
    let repartidor: string;
    let portal: string;
    let hoy: string;

    const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
    const items = [{ tipoCarga: "SOBRE", cantidad: 1, pesoKg: 0.2 }];
    const crearEnvio = (extra: Record<string, unknown> = {}, t = operador) =>
      request(app)
        .post("/api/envios")
        .set(auth(t))
        .send(solicitudEnvio({ items, formaPago: "CONTRATO", ...extra }));
    const crearTalonario = (body: Record<string, unknown>, t = operador) =>
      request(app).post("/api/talonarios").set(auth(t)).send(body);

    beforeAll(async () => {
      entorno = await crearEntorno();
      app = crearApp(crearCasosDeUso(entorno.adaptadores));
      const login = async (email: string, password: string) =>
        (await request(app).post("/api/auth/login").send({ email, password }).expect(200)).body.token as string;
      admin = await login("admin@pcargo.ec", "Admin123!");
      operador = await login("operador@pcargo.ec", "Operador123!");
      repartidor = await login("repartidor@pcargo.ec", "Repartidor123!");
      portal = await login("portal@pcargo.ec", "Portal123!");
      hoy = fechaLocalEC(new Date());
    });

    afterAll(async () => {
      await entorno?.cerrar();
    });

    it("solo ADMIN y OPERADOR: REPARTIDOR y CLIENTE → 403; sin token → 401", async () => {
      for (const t of [repartidor, portal]) {
        expect((await crearTalonario({ cantidad: 1 }, t).expect(403)).body.error.code).toBe("PROHIBIDO");
        await request(app).get("/api/talonarios").set(auth(t)).expect(403);
        await request(app).get("/api/talonarios/guia/1").set(auth(t)).expect(403);
        await request(app).get("/api/talonarios/00000000-0000-4000-a000-000000000001").set(auth(t)).expect(403);
        await request(app)
          .post("/api/talonarios/00000000-0000-4000-a000-000000000001/anular")
          .set(auth(t))
          .send({ numeroGuia: 1, motivo: "Dañada" })
          .expect(403);
      }
      await request(app).get("/api/talonarios").expect(401);
    });

    it.each([
      ["cantidad 0", { cantidad: 0 }],
      ["cantidad 51", { cantidad: 51 }],
      ["cantidad decimal", { cantidad: 2.5 }],
      ["cantidad texto", { cantidad: "5" }],
      ["sin cantidad", {}],
      ["nota de 121 caracteres", { cantidad: 1, nota: "x".repeat(121) }],
      ["campo extra", { cantidad: 1, desde: 5 }],
    ])("POST /talonarios con %s → 400 VALIDACION", async (_caso, body) => {
      expect((await crearTalonario(body).expect(400)).body.error.code).toBe("VALIDACION");
    });

    it("reserva consecutivos tras el último envío; el consecutivo automático los salta; ADMIN también puede", async () => {
      const previo = (await crearEnvio().expect(201)).body.numeroGuia as number;
      const t = (await crearTalonario({ cantidad: 3, nota: "  Camión Quito – sábado " }).expect(201)).body;
      expect(t).toMatchObject({
        desde: previo + 1,
        hasta: previo + 3,
        cantidad: 3,
        nota: "Camión Quito – sábado",
        creadoPor: "Operador Ibarra",
        disponibles: 3,
        usadas: 0,
        anuladas: 0,
      });
      expect(Number.isNaN(Date.parse(t.creadoEn))).toBe(false);
      expect(t.guias).toEqual(
        [0, 1, 2].map((i) => ({ numeroGuia: previo + 1 + i, estado: "DISPONIBLE", envioId: null, motivo: null, actualizadoEn: null })),
      );
      expect((await crearEnvio().expect(201)).body.numeroGuia).toBe(previo + 4);
      const t2 = (await crearTalonario({ cantidad: 1 }, admin).expect(201)).body;
      expect([t2.desde, t2.nota, t2.creadoPor]).toEqual([previo + 5, null, "Administrador PCargo"]);
    });

    it("registrar guía DISPONIBLE → 201 y USADA; repetida → 409; ANULADA → 422 GUIA_ANULADA; fecha anterior al talonario → 400", async () => {
      const t = (await crearTalonario({ cantidad: 4 }).expect(201)).body;
      const [a, b, c, d] = t.guias.map((g: GuiaTalonario) => g.numeroGuia) as [number, number, number, number];

      // con ceros a la izquierda y fecha de la guía del día del talonario (hoy)
      const e = (await crearEnvio({ numeroGuia: `00${a}`, fechaGuia: hoy }).expect(201)).body;
      expect([e.numeroGuia, e.fechaGuia]).toEqual([a, hoy]);
      const guia = (await request(app).get(`/api/talonarios/guia/0${a}`).set(auth(operador)).expect(200)).body;
      expect(guia).toMatchObject({ numeroGuia: a, estado: "USADA", envioId: e.id, motivo: null, talonarioId: t.id });
      expect(Number.isNaN(Date.parse(guia.actualizadoEn))).toBe(false);
      expect((await crearEnvio({ numeroGuia: a }).expect(409)).body.error.code).toBe("CONFLICTO");

      // anular: USADA → 422; motivo corto → 400; número de otro talonario → 404
      const anular = (id: string, body: Record<string, unknown>) =>
        request(app).post(`/api/talonarios/${id}/anular`).set(auth(operador)).send(body);
      expect((await anular(t.id, { numeroGuia: a, motivo: "Dañada" }).expect(422)).body.error.code).toBe("ESTADO_INVALIDO");
      expect((await anular(t.id, { numeroGuia: b, motivo: "no" }).expect(400)).body.error.code).toBe("VALIDACION");
      expect((await anular(t.id, { numeroGuia: b }).expect(400)).body.error.code).toBe("VALIDACION");
      expect((await anular(t.id, { numeroGuia: a - 1, motivo: "Dañada" }).expect(404)).body.error.code).toBe("NO_ENCONTRADO");
      await anular("00000000-0000-4000-a000-0000000000ff", { numeroGuia: b, motivo: "Dañada" }).expect(404);
      const anulado = (await anular(t.id, { numeroGuia: String(b), motivo: "Se mojó en el camión" }).expect(200)).body;
      expect(anulado.guias[1]).toMatchObject({ numeroGuia: b, estado: "ANULADA", envioId: null, motivo: "Se mojó en el camión" });
      expect([anulado.disponibles, anulado.usadas, anulado.anuladas]).toEqual([2, 1, 1]);

      // guía anulada → 422 sin crear el envío
      const r = await crearEnvio({ numeroGuia: b }).expect(422);
      expect(r.body.error.code).toBe("GUIA_ANULADA");
      const lista = (await request(app).get("/api/envios?porPagina=100").set(auth(operador)).expect(200)).body;
      expect(lista.datos.some((x: { numeroGuia: number }) => x.numeroGuia === b)).toBe(false);

      // fecha de la guía: antes del día del talonario → 400; hasta hoy + 90 sí; la guía sigue DISPONIBLE si falla
      const ayer = sumarDiasEC(hoy, -1);
      expect((await crearEnvio({ numeroGuia: c, fechaGuia: ayer }).expect(400)).body.error.code).toBe("VALIDACION");
      expect((await crearEnvio({ numeroGuia: c, fechaGuia: sumarDiasEC(hoy, 91) }).expect(400)).body.error.code).toBe("VALIDACION");
      expect((await request(app).get(`/api/talonarios/guia/${c}`).set(auth(operador)).expect(200)).body.estado).toBe("DISPONIBLE");
      expect((await crearEnvio({ numeroGuia: c, fechaGuia: sumarDiasEC(hoy, 90) }).expect(201)).body.numeroGuia).toBe(c);

      const leido = (await request(app).get(`/api/talonarios/${t.id}`).set(auth(operador)).expect(200)).body;
      expect(leido.guias.map((g: GuiaTalonario) => g.estado)).toEqual(["USADA", "ANULADA", "USADA", "DISPONIBLE"]);
      expect(leido.guias[3].numeroGuia).toBe(d);
    });

    it("GET /talonarios/guia/:n → 404 si no es de ningún talonario; formato inválido → 400; id inválido → 400", async () => {
      const e = (await crearEnvio().expect(201)).body;
      await request(app).get(`/api/talonarios/guia/${e.numeroGuia}`).set(auth(operador)).expect(404);
      expect((await request(app).get("/api/talonarios/guia/12a").set(auth(operador)).expect(400)).body.error.code).toBe("VALIDACION");
      await request(app).get("/api/talonarios/no-es-uuid").set(auth(operador)).expect(400);
      await request(app).get("/api/talonarios/00000000-0000-4000-a000-0000000000ff").set(auth(operador)).expect(404);
    });

    it("GET /talonarios: abiertos por defecto, todos, paginado; estado inválido → 400", async () => {
      const cerrado = (await crearTalonario({ cantidad: 1, nota: "Para cerrar" }).expect(201)).body;
      await crearEnvio({ numeroGuia: cerrado.desde }).expect(201);
      const abierto = (await crearTalonario({ cantidad: 2, nota: "Abierto" }).expect(201)).body;
      const abiertos = (await request(app).get("/api/talonarios?porPagina=100").set(auth(operador)).expect(200)).body;
      const ids = abiertos.datos.map((t: { id: string }) => t.id);
      expect(ids[0]).toBe(abierto.id);
      expect(ids).not.toContain(cerrado.id);
      expect(abiertos.datos[0]).not.toHaveProperty("guias");
      expect(abiertos.datos.every((t: { disponibles: number }) => t.disponibles > 0)).toBe(true);
      const todos = (await request(app).get("/api/talonarios?estado=todos&porPagina=1&pagina=2").set(auth(operador)).expect(200)).body;
      expect(todos).toMatchObject({ pagina: 2, porPagina: 1 });
      expect(todos.total).toBeGreaterThan(abiertos.total);
      expect(todos.datos.map((t: { id: string }) => t.id)).toEqual([cerrado.id]);
      await request(app).get("/api/talonarios?estado=cerrados").set(auth(operador)).expect(400);
    });

    it("reservas y envíos automáticos (panel y portal) simultáneos nunca comparten números", async () => {
      const [talonarios, envios] = await Promise.all([
        Promise.all(Array.from({ length: 5 }, (_, k) => crearTalonario({ cantidad: k + 2 }).expect(201))),
        Promise.all(
          Array.from({ length: 6 }, (_, k) =>
            k % 2 === 0
              ? crearEnvio().expect(201)
              : request(app)
                  .post("/api/portal/envios")
                  .set(auth(portal))
                  .send({
                    destinatario: { nombre: "Ana", telefono: "0987654321", direccion: "Quito" },
                    rutaId: 11,
                    items,
                  })
                  .expect(201),
          ),
        ),
      ]);
      const reservados = talonarios.flatMap((r) => r.body.guias.map((g: GuiaTalonario) => g.numeroGuia) as number[]);
      const numeros = [...reservados, ...envios.map((r) => r.body.numeroGuia as number)].sort((x, y) => x - y);
      expect(new Set(numeros).size).toBe(numeros.length);
      expect(numeros.at(-1)! - numeros[0]! + 1).toBe(numeros.length);
    });
  });
}

suite("memoria", entornoMemoria);

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("PostgreSQL", () => {
  suite("postgres", () => entornoPostgres(url!));
});
