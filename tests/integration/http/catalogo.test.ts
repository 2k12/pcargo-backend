import type { Express } from "express";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryCache } from "../../../src/infrastructure/cache/memoria.js";
import { adaptadoresEnMemoria, adaptadoresPostgres, crearCasosDeUso, type Adaptadores } from "../../../src/infrastructure/container.js";
import { crearApp } from "../../../src/infrastructure/http/app.js";
import { migrar } from "../../../src/infrastructure/persistence/postgres/migrar.js";
import { crearPool, type Db } from "../../../src/infrastructure/persistence/postgres/pool.js";
import { sembrar } from "../../../src/infrastructure/persistence/postgres/sembrar.js";
import { ARTICULOS_SEED } from "../../../src/infrastructure/persistence/seed-data.js";
import { JWT_SECRET_TEST, solicitudEnvio } from "../../helpers/fakes.js";

// Catálogo configurable (contrato v11) sobre la pila HTTP completa CON caché: cada escritura debe verse en la
// siguiente lectura (panel, /publico/*, cotizador y API de empresas). En memoria siempre y en Postgres si hay
// TEST_DATABASE_URL (BD propia <bd>_catalogo).

interface Entorno {
  adaptadores: Adaptadores;
  cerrar: () => Promise<void>;
}

async function entornoMemoria(): Promise<Entorno> {
  return { adaptadores: await adaptadoresEnMemoria({ jwtSecret: JWT_SECRET_TEST, rondasBcrypt: 4 }), cerrar: async () => {} };
}

async function entornoPostgres(url: string): Promise<Entorno> {
  const u = new URL(url);
  const nombreBd = `${u.pathname.slice(1)}_catalogo`;
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

const BASE_API = "/api/v1/integraciones";

function suite(nombre: string, crearEntorno: () => Promise<Entorno>): void {
  describe(`Catálogo configurable v11 (${nombre})`, () => {
    let entorno: Entorno;
    let app: Express;
    let admin: string;
    let operador: string;
    let key: string;
    let keyPrueba: string;
    let idem = 0;

    const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
    const api = (k = key) => ({ Authorization: `Bearer ${k}`, "Idempotency-Key": `idem-${++idem}` });
    const tipos = async (t = operador, q = "") => (await request(app).get(`/api/tipos-carga${q}`).set(auth(t)).expect(200)).body;
    const publico = async () => (await request(app).get("/api/publico/catalogo").expect(200)).body;
    const patchTipo = (codigo: string, body: object, t = admin) => request(app).patch(`/api/tipos-carga/${codigo}`).set(auth(t)).send(body);

    beforeAll(async () => {
      entorno = await crearEntorno();
      app = crearApp(crearCasosDeUso(entorno.adaptadores, new MemoryCache()));
      const login = async (email: string, password: string) =>
        (await request(app).post("/api/auth/login").send({ email, password }).expect(200)).body.token as string;
      admin = await login("admin@pcargo.ec", "Admin123!");
      operador = await login("operador@pcargo.ec", "Operador123!");
      const integracion = (
        await request(app)
          .post("/api/integraciones")
          .set(auth(admin))
          .send({
            nombre: "Tienda Catálogo",
            remitente: { nombre: "Tienda Catálogo", telefono: "062600200", direccion: "Bolívar 1-23, Ibarra" },
            ciudadOrigenId: 1,
          })
          .expect(201)
      ).body;
      const crearKey = async (modo: string) =>
        (
          await request(app)
            .post(`/api/integraciones/${integracion.id}/keys`)
            .set(auth(admin))
            .send({ nombre: modo, modo, alcances: ["cotizar", "envios:crear"] })
            .expect(201)
        ).body.key as string;
      key = await crearKey("live");
      keyPrueba = await crearKey("test");
    });

    afterAll(async () => {
      await entorno?.cerrar();
    });

    it("GET /tipos-carga: activos para todos; ?todos=true solo ADMIN (403 al OPERADOR)", async () => {
      const lista = await tipos();
      expect(lista).toHaveLength(7);
      expect(lista[0]).toEqual({
        codigo: "SOBRE", nombre: "Sobre", precio: 3, precioRural: null, mayoreo: null, pesoMaxKg: 0.5,
        activo: true, orden: 1, actualizadoEn: null, actualizadoPor: null,
      });
      const r = await request(app).get("/api/tipos-carga?todos=true").set(auth(operador)).expect(403);
      expect(r.body.error.code).toBe("PROHIBIDO");
      expect(await tipos(admin, "?todos=true")).toHaveLength(7);
      await request(app).get("/api/tipos-carga?todos=si").set(auth(admin)).expect(400);
    });

    it("POST /tipos-carga: 201 con orden al final; 403 OPERADOR; 400 forma o reglas; 409 código/nombre repetido", async () => {
      const caja = { codigo: "CAJA_HTTP", nombre: "Caja HTTP", precio: 5.5, precioRural: 6.25, mayoreo: { minimoExclusivo: 10, precio: 4.75 }, pesoMaxKg: 40 };
      await request(app).post("/api/tipos-carga").set(auth(operador)).send(caja).expect(403);
      const creado = (await request(app).post("/api/tipos-carga").set(auth(admin)).send(caja).expect(201)).body;
      expect(creado).toMatchObject({ ...caja, activo: true, orden: 8, actualizadoPor: "Administrador PCargo" });
      expect(typeof creado.actualizadoEn).toBe("string");

      for (const [cuerpo, status] of [
        [{ ...caja }, 409],
        [{ ...caja, codigo: "CAJA_HTTP2", nombre: "caja http" }, 409],
        [{ ...caja, codigo: "caja" }, 400],
        [{ ...caja, codigo: "CAJA_X", precio: 1.255 }, 400],
        [{ ...caja, codigo: "CAJA_X", precio: 0 }, 400],
        [{ ...caja, codigo: "CAJA_X", precio: 1001 }, 400],
        [{ ...caja, codigo: "CAJA_X", pesoMaxKg: 1000.5 }, 400],
        [{ ...caja, codigo: "CAJA_X", mayoreo: { minimoExclusivo: 10, precio: 5.5 } }, 400],
        [{ ...caja, codigo: "CAJA_X", mayoreo: { minimoExclusivo: 0, precio: 1 } }, 400],
        [{ ...caja, codigo: "CAJA_X", nombre: "X" }, 400],
        [{ ...caja, codigo: "CAJA_X", precio: "5" }, 400],
        [{ ...caja, codigo: "CAJA_X", extra: true }, 400],
      ] as const) {
        const r = await request(app).post("/api/tipos-carga").set(auth(admin)).send(cuerpo);
        expect([r.status, r.body.error.code]).toEqual([status, status === 409 ? "CONFLICTO" : "VALIDACION"]);
      }
      // sin precioRural ni mayoreo → null
      const simple = (await request(app).post("/api/tipos-carga").set(auth(admin)).send({ codigo: "BULTO_HTTP", nombre: "Bulto HTTP", precio: 2, pesoMaxKg: 10 }).expect(201)).body;
      expect(simple).toMatchObject({ precioRural: null, mayoreo: null, orden: 9 });
    });

    it("tipo nuevo usado en un envío (precio y mayoreo); el envío conserva su costo tras cambiar la tarifa", async () => {
      const items = [{ tipoCarga: "CAJA_HTTP", cantidad: 6, pesoKg: 20 }, { tipoCarga: "CAJA_HTTP", cantidad: 5, pesoKg: 20 }];
      const cot = (await request(app).post("/api/publico/cotizar").send({ rutaId: 11, items }).expect(200)).body;
      expect(cot).toMatchObject({ costo: 52.25, items: [{ costoUnitario: 4.75, mayoreo: true }, { costoUnitario: 4.75, mayoreo: true }] });
      const envio = (await request(app).post("/api/envios").set(auth(operador)).send(solicitudEnvio({ items: [{ tipoCarga: "CAJA_HTTP", cantidad: 2, pesoKg: 20 }], zona: "RURAL" })).expect(201)).body;
      expect(envio).toMatchObject({ costo: 12.5, items: [{ tipoCarga: "CAJA_HTTP", costoUnitario: 6.25, subtotal: 12.5 }] });

      await patchTipo("CAJA_HTTP", { precioRural: 7, pesoMaxKg: 15 }).expect(200);
      const leido = (await request(app).get(`/api/envios/${envio.id}`).set(auth(operador)).expect(200)).body;
      expect(leido).toMatchObject({ costo: 12.5, items: [{ costoUnitario: 6.25, subtotal: 12.5, pesoKg: 20 }] });
      const r = await request(app).post("/api/envios/cotizar").set(auth(operador)).send({ rutaId: 11, zona: "RURAL", items: [{ tipoCarga: "CAJA_HTTP", cantidad: 2, pesoKg: 15 }] }).expect(200);
      expect(r.body.costo).toBe(14);
      await request(app).post("/api/envios/cotizar").set(auth(operador)).send({ rutaId: 11, items: [{ tipoCarga: "CAJA_HTTP", cantidad: 1, pesoKg: 20 }] }).expect(422);

      // con envíos no se elimina (409); el bulto sin envíos sí (204)
      const del = await request(app).delete("/api/tipos-carga/CAJA_HTTP").set(auth(admin)).expect(409);
      expect(del.body.error.code).toBe("CONFLICTO");
      await request(app).delete("/api/tipos-carga/BULTO_HTTP").set(auth(operador)).expect(403);
      await request(app).delete("/api/tipos-carga/BULTO_HTTP").set(auth(admin)).expect(204);
      await request(app).delete("/api/tipos-carga/BULTO_HTTP").set(auth(admin)).expect(404);
    });

    it("PATCH /tipos-carga/:codigo: 400 sin campos o con codigo; 404 inexistente; 403 OPERADOR", async () => {
      await patchTipo("SOBRE", {}).expect(400);
      await patchTipo("SOBRE", { codigo: "OTRO" }).expect(400);
      await patchTipo("SOBRE", { precio: 3.333 }).expect(400);
      await patchTipo("TELA", { precio: 0.99 }).expect(400); // por debajo del mayoreo (1.00)
      await patchTipo("TELA", { nombre: "PAQUETE" }).expect(409);
      await patchTipo("NO_EXISTE", { precio: 2 }).expect(404);
      await patchTipo("sobre", { precio: 2 }).expect(400);
      await patchTipo("SOBRE", { precio: 2 }, operador).expect(403);
    });

    it("tipo inactivo: no se ofrece y da 422 TIPO_CARGA_INACTIVO (panel, público y API, incluido lote y modo prueba)", async () => {
      await patchTipo("VALIJA", { activo: false }).expect(200);
      const valija = [{ tipoCarga: "VALIJA", cantidad: 1, pesoKg: 2 }];
      const esperar422 = (r: request.Response, code = "TIPO_CARGA_INACTIVO") => expect([r.status, r.body.error?.code]).toEqual([422, code]);

      esperar422(await request(app).post("/api/publico/cotizar").send({ rutaId: 11, items: valija }));
      esperar422(await request(app).post("/api/envios/cotizar").set(auth(operador)).send({ rutaId: 11, items: valija }));
      esperar422(await request(app).post("/api/envios").set(auth(operador)).send(solicitudEnvio({ items: valija })));
      esperar422(await request(app).post(`${BASE_API}/cotizar`).set(api()).send({ destino: { ciudad: "Quito" }, items: valija }));
      const nuevoApi = (ref: string, items: object[]) => ({
        referenciaExterna: ref,
        destinatario: { nombre: "Rosa", telefono: "0991234567", direccion: "Av. Amazonas", ciudad: "Quito" },
        items,
      });
      esperar422(await request(app).post(`${BASE_API}/envios`).set(api()).send(nuevoApi("V-1", valija)));
      esperar422(await request(app).post(`${BASE_API}/envios`).set(api(keyPrueba)).send(nuevoApi("V-1", valija)));
      const lote = (
        await request(app)
          .post(`${BASE_API}/envios/lote`)
          .set(api())
          .send({ envios: [nuevoApi("V-2", valija), nuevoApi("V-3", [{ tipoCarga: "PAQUETE", cantidad: 1, pesoKg: 1 }])] })
          .expect(200)
      ).body;
      expect(lote.resultados.map((r: { ok: boolean; error?: { code: string } }) => (r.ok ? "ok" : r.error!.code))).toEqual(["TIPO_CARGA_INACTIVO", "ok"]);

      // inexistente → 422 VALIDACION; mal formado → 400
      esperar422(await request(app).post("/api/publico/cotizar").send({ rutaId: 11, items: [{ tipoCarga: "PIANO", cantidad: 1, pesoKg: 1 }] }), "VALIDACION");
      esperar422(await request(app).post(`${BASE_API}/cotizar`).set(api()).send({ destino: { ciudad: "Quito" }, items: [{ tipoCarga: "PIANO", cantidad: 1, pesoKg: 1 }] }), "VALIDACION");
      await request(app).post("/api/publico/cotizar").send({ rutaId: 11, items: [{ tipoCarga: "piano", cantidad: 1, pesoKg: 1 }] }).expect(400);

      // no se ofrece en el panel, la landing ni la cobertura de la API; sí con ?todos=true
      expect((await tipos()).map((t: { codigo: string }) => t.codigo)).not.toContain("VALIJA");
      expect((await publico()).tiposCarga.map((t: { codigo: string }) => t.codigo)).not.toContain("VALIJA");
      const cobertura = (await request(app).get(`${BASE_API}/cobertura`).set(auth(key)).expect(200)).body;
      expect(cobertura.tiposCarga.map((t: { codigo: string }) => t.codigo)).not.toContain("VALIJA");
      expect(Object.keys(cobertura.tiposCarga[0]).sort()).toEqual(["codigo", "mayoreo", "nombre", "pesoMaxKg", "precio", "precioRural"]);
      expect((await tipos(admin, "?todos=true")).find((t: { codigo: string }) => t.codigo === "VALIJA")).toMatchObject({ activo: false });

      await patchTipo("VALIJA", { activo: true }).expect(200);
      await request(app).post("/api/publico/cotizar").send({ rutaId: 11, items: valija }).expect(200);
    });

    it("caché: tras un PATCH la siguiente lectura (panel, /publico/catalogo, cobertura) ya ve el cambio", async () => {
      // se calientan las cachés
      expect((await publico()).tiposCarga.find((t: { codigo: string }) => t.codigo === "PAQUETE").precio).toBe(3);
      expect((await tipos()).find((t: { codigo: string }) => t.codigo === "PAQUETE").precio).toBe(3);
      await publico();
      await patchTipo("PAQUETE", { precio: 3.75 }).expect(200);
      expect((await publico()).tiposCarga.find((t: { codigo: string }) => t.codigo === "PAQUETE").precio).toBe(3.75);
      expect((await tipos()).find((t: { codigo: string }) => t.codigo === "PAQUETE")).toMatchObject({ precio: 3.75, actualizadoPor: "Administrador PCargo" });
      const cob = (await request(app).get(`${BASE_API}/cobertura`).set(auth(key)).expect(200)).body;
      expect(cob.tiposCarga.find((t: { codigo: string }) => t.codigo === "PAQUETE").precio).toBe(3.75);
      expect((await request(app).post("/api/publico/cotizar").send({ rutaId: 11, items: [{ tipoCarga: "PAQUETE", cantidad: 2, pesoKg: 1 }] }).expect(200)).body.costo).toBe(7.5);
      // el catálogo público no expone quién cambió el tipo
      expect(Object.keys((await publico()).tiposCarga[0]).sort()).toEqual(["codigo", "mayoreo", "nombre", "pesoMaxKg", "precio", "precioRural"]);
      await patchTipo("PAQUETE", { precio: 3 }).expect(200);
    });

    it("PUT /tipos-carga/orden y GET /tipos-carga/historial (paginado, con diff y usuario)", async () => {
      const codigos = (await tipos(admin, "?todos=true")).map((t: { codigo: string }) => t.codigo);
      await request(app).put("/api/tipos-carga/orden").set(auth(admin)).send({ codigos: [...codigos, codigos[0]] }).expect(400);
      expect((await request(app).put("/api/tipos-carga/orden").set(auth(admin)).send({ codigos: codigos.slice(1) }).expect(422)).body.error.code).toBe("VALIDACION");
      await request(app).put("/api/tipos-carga/orden").set(auth(operador)).send({ codigos }).expect(403);
      await tipos(); // caché caliente
      const invertido = [...codigos].reverse();
      const r = (await request(app).put("/api/tipos-carga/orden").set(auth(admin)).send({ codigos: invertido }).expect(200)).body;
      expect(r.map((t: { codigo: string; orden: number }) => [t.codigo, t.orden])).toEqual(invertido.map((c, i) => [c, i + 1]));
      expect((await tipos()).map((t: { codigo: string }) => t.codigo)).toEqual(invertido);
      expect((await publico()).tiposCarga.map((t: { codigo: string }) => t.codigo)).toEqual(invertido);

      await request(app).get("/api/tipos-carga/historial").set(auth(operador)).expect(403);
      const h = (await request(app).get("/api/tipos-carga/historial?codigo=PAQUETE&porPagina=2").set(auth(admin)).expect(200)).body;
      expect(h).toMatchObject({ pagina: 1, porPagina: 2 });
      expect(h.total).toBeGreaterThanOrEqual(3);
      expect(h.datos[0]).toMatchObject({ codigo: "PAQUETE", accion: "MODIFICADO", usuario: "Administrador PCargo", cambios: [{ campo: "orden" }] });
      const todos = (await request(app).get("/api/tipos-carga/historial?porPagina=100").set(auth(admin)).expect(200)).body;
      const fechas = todos.datos.map((d: { fecha: string }) => d.fecha);
      expect([...fechas].sort().reverse()).toEqual(fechas);
      expect(todos.datos.map((d: { accion: string }) => d.accion)).toEqual(expect.arrayContaining(["CREADO", "MODIFICADO", "DESACTIVADO", "ACTIVADO", "ELIMINADO"]));
      const precio = todos.datos.find((d: { codigo: string; cambios: { campo: string }[] }) => d.codigo === "PAQUETE" && d.cambios[0]!.campo === "precio");
      expect(precio.cambios).toEqual([{ campo: "precio", antes: 3.75, despues: 3 }]);
      await request(app).get("/api/tipos-carga/historial?porPagina=101").set(auth(admin)).expect(400);
      await request(app).put("/api/tipos-carga/orden").set(auth(admin)).send({ codigos }).expect(200);
    });

    it("artículos: público solo activos y ordenados; CRUD y orden ADMIN (403 OPERADOR); la caché se invalida", async () => {
      const pub = async () => (await request(app).get("/api/publico/articulos-restringidos").expect(200)).body;
      const inicial = await pub();
      expect(inicial.map((a: { id: string }) => a.id)).toEqual(ARTICULOS_SEED.map((a) => a.id));
      expect(inicial[12]).toMatchObject({ categoria: "NOTA", icono: null, titulo: "Declara siempre el contenido real de tu envío." });

      await request(app).get("/api/articulos-restringidos").set(auth(operador)).expect(403);
      await request(app).post("/api/articulos-restringidos").set(auth(operador)).send({ categoria: "NOTA", titulo: "Hola" }).expect(403);
      await request(app).post("/api/articulos-restringidos").set(auth(admin)).send({ categoria: "OTRA", titulo: "Hola" }).expect(400);
      await request(app).post("/api/articulos-restringidos").set(auth(admin)).send({ categoria: "PROHIBIDO", titulo: "Hola", icono: "cohete" }).expect(400);
      await request(app).post("/api/articulos-restringidos").set(auth(admin)).send({ categoria: "PROHIBIDO", titulo: "x".repeat(81) }).expect(400);

      const creado = (
        await request(app).post("/api/articulos-restringidos").set(auth(admin)).send({ categoria: "PROHIBIDO", titulo: "Baterías de litio", icono: "bateria" }).expect(201)
      ).body;
      expect(creado).toMatchObject({ categoria: "PROHIBIDO", detalle: "", icono: "bateria", activo: true, orden: 10, actualizadoPor: "Administrador PCargo" });
      const tras = await pub();
      expect(tras[9].id).toBe(creado.id); // último prohibido, antes de los condicionados

      const nota = (await request(app).patch(`/api/articulos-restringidos/${creado.id}`).set(auth(admin)).send({ categoria: "NOTA" }).expect(200)).body;
      expect(nota).toMatchObject({ categoria: "NOTA", icono: null, orden: 3 });
      await request(app).patch(`/api/articulos-restringidos/${creado.id}`).set(auth(admin)).send({ activo: false }).expect(200);
      expect((await pub()).map((a: { id: string }) => a.id)).not.toContain(creado.id);
      expect((await request(app).get("/api/articulos-restringidos").set(auth(admin)).expect(200)).body).toHaveLength(15);
      await request(app).patch(`/api/articulos-restringidos/${creado.id}`).set(auth(admin)).send({}).expect(400);
      await request(app).patch("/api/articulos-restringidos/no-es-uuid").set(auth(admin)).send({ activo: true }).expect(400);

      const condicionados = ARTICULOS_SEED.filter((a) => a.categoria === "CONDICIONADO").map((a) => a.id).reverse();
      await request(app).put("/api/articulos-restringidos/orden").set(auth(admin)).send({ categoria: "CONDICIONADO", ids: condicionados.slice(1) }).expect(422);
      const orden = (await request(app).put("/api/articulos-restringidos/orden").set(auth(admin)).send({ categoria: "CONDICIONADO", ids: condicionados }).expect(200)).body;
      expect(orden.map((a: { id: string; orden: number }) => [a.id, a.orden])).toEqual(condicionados.map((id, i) => [id, i + 1]));
      expect((await pub()).filter((a: { categoria: string }) => a.categoria === "CONDICIONADO").map((a: { id: string }) => a.id)).toEqual(condicionados);

      await request(app).delete(`/api/articulos-restringidos/${creado.id}`).set(auth(operador)).expect(403);
      await request(app).delete(`/api/articulos-restringidos/${creado.id}`).set(auth(admin)).expect(204);
      await request(app).delete(`/api/articulos-restringidos/${creado.id}`).set(auth(admin)).expect(404);
    });

    it("OpenAPI de la API de empresas: tipoCarga es texto con patrón y remite a /cobertura", async () => {
      const spec = (await request(app).get(`${BASE_API}/openapi.json`).expect(200)).body;
      const tipo = spec.components.schemas.ItemSolicitud.properties.tipoCarga;
      expect(tipo).toMatchObject({ type: "string", pattern: "^[A-Z][A-Z0-9_]{1,29}$" });
      expect(tipo).not.toHaveProperty("enum");
      expect(tipo.description).toContain("/cobertura");
      expect(spec.components.schemas.Cobertura.required).toContain("tiposCarga");
      expect(JSON.stringify(spec)).toContain("TIPO_CARGA_INACTIVO");
    });
  });
}

suite("memoria", entornoMemoria);
const url = process.env.TEST_DATABASE_URL;
if (url) suite("postgres", () => entornoPostgres(url));
