import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Redis } from "ioredis";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Cache, LimitadorTasa } from "../../../src/application/ports/cache.js";
import { MemoryCache, MemoryLimitadorTasa } from "../../../src/infrastructure/cache/memoria.js";
import { crearClienteRedis, esperarRedis, RedisCache, RedisLimitadorTasa } from "../../../src/infrastructure/cache/redis.js";
import { adaptadoresEnMemoria, crearCasosDeUso } from "../../../src/infrastructure/container.js";
import { crearApp } from "../../../src/infrastructure/http/app.js";
import { JWT_SECRET_TEST, solicitudEnvio } from "../../helpers/fakes.js";

// La caché nunca debe servir datos viejos tras una escritura: se prueba la pila HTTP completa con
// caché en memoria y, si hay TEST_REDIS_URL (p. ej. redis://localhost:6380), también con Redis real.

// Mismo orden que crearContenedor: se espera la conexión antes de servir peticiones.
interface Almacen {
  cache: Cache;
  limitador: LimitadorTasa;
  cerrar: () => Promise<void>;
}

const almacenes: [string, () => Promise<Almacen>][] = [
  ["memoria", async () => ({ cache: new MemoryCache(), limitador: new MemoryLimitadorTasa(), cerrar: async () => {} })],
];
const urlRedis = process.env.TEST_REDIS_URL;
if (urlRedis) {
  almacenes.push([
    "redis",
    async () => {
      const redis: Redis = crearClienteRedis(urlRedis);
      expect(await esperarRedis(redis)).toBe(true);
      const espacio = `pcargo-test:${randomUUID()}:`; // aislado de otros tests y del entorno de desarrollo
      const cache = new RedisCache(redis, espacio);
      return {
        cache,
        limitador: new RedisLimitadorTasa(redis, `${espacio}tasa:`),
        cerrar: async () => {
          await cache.invalidar("");
          await redis.quit();
        },
      };
    },
  ]);
}

describe.each(almacenes)("Caché y límite de tasa (%s)", (_nombre, crearAlmacen) => {
  let app: Express;
  let token: string;
  let tokenAdmin: string;
  let almacen: Almacen;

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    almacen = await crearAlmacen();
    const casos = crearCasosDeUso(await adaptadoresEnMemoria({ jwtSecret: JWT_SECRET_TEST, rondasBcrypt: 4 }), almacen.cache);
    app = crearApp(casos, { limitador: almacen.limitador });
    const login = async (email: string, password: string) =>
      (await request(app).post("/api/auth/login").send({ email, password }).expect(200)).body.token as string;
    token = await login("operador@pcargo.ec", "Operador123!");
    tokenAdmin = await login("admin@pcargo.ec", "Admin123!");
  });

  afterAll(async () => {
    await almacen.cerrar();
  });

  it("el resumen del dashboard se invalida al crear un envío y al cambiar su estado", async () => {
    const antes = (await request(app).get("/api/dashboard/resumen").set(auth(token)).expect(200)).body;
    await request(app).get("/api/dashboard/resumen").set(auth(token)).expect(200); // ahora sale de la caché
    const { body: envio } = await request(app).post("/api/envios").set(auth(token)).send(solicitudEnvio()).expect(201);
    const despues = (await request(app).get("/api/dashboard/resumen").set(auth(token)).expect(200)).body;
    expect(despues.totalEnvios).toBe(antes.totalEnvios + 1);

    await request(app).patch(`/api/envios/${envio.id}/estado`).set(auth(token)).send({ estado: "CANCELADO" }).expect(200);
    const tras = (await request(app).get("/api/dashboard/resumen").set(auth(token)).expect(200)).body;
    expect(tras.porEstado.CANCELADO).toBe(despues.porEstado.CANCELADO + 1);
  });

  it("el rastreo público refleja el nuevo estado (con o sin ceros a la izquierda)", async () => {
    const { body: envio } = await request(app).post("/api/envios").set(auth(token)).send(solicitudEnvio()).expect(201);
    const guia = envio.numeroGuia as number;
    expect((await request(app).get(`/api/seguimiento/${guia}`).expect(200)).body.estado).toBe("REGISTRADO");
    expect((await request(app).get(`/api/seguimiento/000${guia}`).expect(200)).body.estado).toBe("REGISTRADO");
    await request(app).patch(`/api/envios/${envio.id}/estado`).set(auth(token)).send({ estado: "EN_TRANSITO" }).expect(200);
    expect((await request(app).get(`/api/seguimiento/000${guia}`).expect(200)).body.estado).toBe("EN_TRANSITO");
  });

  it("renombrar una ciudad se ve al instante en el catálogo público, las rutas y los envíos", async () => {
    await request(app).get("/api/publico/catalogo").expect(200);
    await request(app).get("/api/rutas").set(auth(token)).expect(200);
    await request(app).patch("/api/ciudades/2").set(auth(tokenAdmin)).send({ nombre: "Atuntaqui Centro" }).expect(200);

    const catalogo = (await request(app).get("/api/publico/catalogo").expect(200)).body;
    expect(catalogo.ciudades.map((c: { nombre: string }) => c.nombre)).toContain("Atuntaqui Centro");
    const rutas = (await request(app).get("/api/rutas").set(auth(token)).expect(200)).body;
    expect(rutas.some((r: { origen: { nombre: string } }) => r.origen.nombre === "Atuntaqui Centro")).toBe(true);

    await request(app).patch("/api/ciudades/2").set(auth(tokenAdmin)).send({ nombre: "Atuntaqui" }).expect(200);
  });

  it("no sirve entradas del catálogo con la forma de v7 (tipos con factor, rutas con tarifaBase)", async () => {
    const tiposV7 = [{ codigo: "SOBRE", nombre: "Sobre", factor: 1, pesoIncluidoKg: 0.5, pesoMaxKg: 0.5 }];
    await almacen.cache.guardar("catalogo:publico", { ciudades: [], tiposCarga: tiposV7, rutas: [] }, 300);
    await almacen.cache.guardar("catalogo:tipos-carga", tiposV7, 300);
    await almacen.cache.guardar("catalogo:repo-rutas:todas", [{ id: 1, tarifaBase: 2 }], 300);

    const publico = (await request(app).get("/api/publico/catalogo").expect(200)).body;
    expect(publico.tiposCarga).toHaveLength(7);
    expect(publico.tiposCarga[0]).toEqual({ codigo: "SOBRE", nombre: "Sobre", precio: 3, precioRural: null, mayoreo: null, pesoMaxKg: 0.5 });
    expect(publico.rutas.some((r: object) => "tarifaBase" in r)).toBe(false);
    const tipos = (await request(app).get("/api/tipos-carga").set(auth(token)).expect(200)).body;
    expect(tipos.map((t: { codigo: string }) => t.codigo)).toContain("PLUMON_GRANDE");
    const rutas = (await request(app).get("/api/rutas").set(auth(token)).expect(200)).body;
    expect(rutas.length).toBeGreaterThan(1);
    // la cotización no se cachea: siempre usa el precio por tipo vigente
    const cot = (await request(app).post("/api/publico/cotizar").send({ rutaId: 11, zona: "RURAL", items: [{ tipoCarga: "TELA", cantidad: 2, pesoKg: 1 }] }).expect(200)).body;
    expect(cot).toMatchObject({ zona: "RURAL", costo: 3 });
  });

  it("v12: el repartidor, el portal y la eliminación de datos personales invalidan seguimiento y dashboard", async () => {
    const entrar = async (email: string, password: string) =>
      (await request(app).post("/api/auth/login").send({ email, password }).expect(200)).body.token as string;
    const tokenRepartidor = await entrar("repartidor@pcargo.ec", "Repartidor123!");
    const tokenPortal = await entrar("portal@pcargo.ec", "Portal123!");
    const { body: envio } = await request(app).post("/api/envios").set(auth(token)).send(solicitudEnvio()).expect(201);
    await request(app).patch(`/api/envios/${envio.id}/estado`).set(auth(token)).send({ estado: "EN_TRANSITO", nota: "Bus de las 10" }).expect(200);
    await request(app)
      .post("/api/envios/asignar")
      .set(auth(token))
      .send({ envioIds: [envio.id], repartidorId: "00000000-0000-4000-8000-000000000003" })
      .expect(200);
    const guia = `/api/seguimiento/${envio.numeroGuia}`;
    expect((await request(app).get(guia).expect(200)).body.estado).toBe("EN_TRANSITO"); // queda en caché
    await request(app).patch(`/api/repartidor/envios/${envio.id}/estado`).set(auth(tokenRepartidor)).send({ estado: "EN_REPARTO" }).expect(200);
    expect((await request(app).get(guia).expect(200)).body.estado).toBe("EN_REPARTO");

    const antes = (await request(app).get("/api/dashboard/resumen").set(auth(token)).expect(200)).body.totalEnvios;
    await request(app)
      .post("/api/portal/envios")
      .set(auth(tokenPortal))
      .send({ destinatario: { nombre: "Ana", telefono: "0987654321", direccion: "Quito" }, rutaId: 11, items: [{ tipoCarga: "SOBRE", cantidad: 1, pesoKg: 0.1 }] })
      .expect(201);
    expect((await request(app).get("/api/dashboard/resumen").set(auth(token)).expect(200)).body.totalEnvios).toBe(antes + 1);

    await request(app).patch(`/api/repartidor/envios/${envio.id}/estado`).set(auth(tokenRepartidor)).send({ estado: "ENTREGADO" }).expect(200);
    expect((await request(app).get(guia).expect(200)).body.historial[1].nota).toBe("Bus de las 10");
    await request(app)
      .post("/api/datos-personales/solicitudes")
      .set(auth(tokenAdmin))
      .send({ telefono: solicitudEnvio().remitente.telefono, nombreTitular: "María Pérez", canal: "PRESENCIAL" })
      .expect(201);
    expect((await request(app).get(guia).expect(200)).body.historial.every((h: { nota: string | null }) => h.nota === null)).toBe(true);
  });

  it("limita los intentos de login por IP y correo con 429 DEMASIADAS_SOLICITUDES", async () => {
    const intento = () => request(app).post("/api/auth/login").send({ email: "nadie@pcargo.ec", password: "x" });
    for (let i = 0; i < 10; i++) await intento().expect(401);
    const r = await intento().expect(429);
    expect(r.body.error.code).toBe("DEMASIADAS_SOLICITUDES");
    expect(Number(r.headers["retry-after"])).toBeGreaterThan(0);
    // Otro correo desde la misma IP no queda bloqueado.
    await request(app).post("/api/auth/login").send({ email: "otro@pcargo.ec", password: "x" }).expect(401);
  });
});

describe.runIf(urlRedis)("Adaptadores Redis", () => {
  let redis: Redis;
  const espacio = `pcargo-test:${randomUUID()}:`;

  beforeAll(async () => {
    redis = crearClienteRedis(urlRedis!);
    expect(await esperarRedis(redis)).toBe(true);
  });

  afterAll(async () => {
    await new RedisCache(redis, espacio).invalidar("");
    await redis.quit();
  });

  it("guarda con TTL, lee e invalida solo el prefijo pedido", async () => {
    const cache = new RedisCache(redis, espacio);
    await cache.guardar("catalogo:rutas", [{ id: 1 }], 300);
    await cache.guardar("dashboard:resumen", { total: 3 }, 60);
    expect(await redis.ttl(`${espacio}catalogo:rutas`)).toBeGreaterThan(290);
    expect(await cache.obtener("catalogo:rutas")).toEqual([{ id: 1 }]);
    await cache.invalidar("catalogo:");
    expect(await redis.exists(`${espacio}catalogo:rutas`)).toBe(0);
    expect(await cache.obtener("dashboard:resumen")).toEqual({ total: 3 });
  });

  it("el limitador comparte la cuenta y fija la expiración de la ventana", async () => {
    const lim = new RedisLimitadorTasa(redis, `${espacio}tasa:`);
    expect(await lim.consumir("ip", 2, 60)).toMatchObject({ permitido: true, restantes: 1 });
    expect(await lim.consumir("ip", 2, 60)).toMatchObject({ permitido: true, restantes: 0 });
    const r = await lim.consumir("ip", 2, 60);
    expect(r.permitido).toBe(false);
    expect(r.reintentarEnSeg).toBeGreaterThan(55);
    expect(await redis.pttl(`${espacio}tasa:ip`)).toBeGreaterThan(55_000);
  });

  it("falla abierto si Redis no responde", async () => {
    const caido = crearClienteRedis("redis://localhost:1");
    expect(await esperarRedis(caido, 300)).toBe(false);
    const cache = new RedisCache(caido, espacio);
    await cache.guardar("x", 1, 60);
    expect(await cache.obtener("x")).toBeUndefined();
    expect((await new RedisLimitadorTasa(caido).consumir("ip", 1, 60)).permitido).toBe(true);
    caido.disconnect();
  });
});
