import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { RutaRepository } from "../../../src/application/ports/repositories.js";
import type { Ruta } from "../../../src/domain/ruta/Ruta.js";
import {
  claveGuia,
  conCache,
  invalidaTras,
  RutaRepositoryEnCache,
} from "../../../src/infrastructure/cache/decoradores.js";
import { MemoryCache, MemoryLimitadorTasa, SinCache } from "../../../src/infrastructure/cache/memoria.js";
import { limitarTasa } from "../../../src/infrastructure/http/middlewares/limitarTasa.js";
import { FakeClock } from "../../helpers/fakes.js";

const reloj = () => new FakeClock(new Date("2026-10-07T12:00:00Z"));

describe("MemoryCache", () => {
  it("guarda copias JSON y expira tras el TTL", async () => {
    const r = reloj();
    const cache = new MemoryCache(r);
    const valor = { a: 1 };
    await cache.guardar("k", valor, 120);
    valor.a = 2;
    r.avanzar(1);
    expect(await cache.obtener("k")).toEqual({ a: 1 });
    r.avanzar(1);
    expect(await cache.obtener("k")).toBeUndefined();
  });

  it("invalida por prefijo sin tocar otros espacios", async () => {
    const cache = new MemoryCache();
    await cache.guardar("catalogo:rutas", [1], 60);
    await cache.guardar("catalogo:ciudades", [2], 60);
    await cache.guardar("dashboard:resumen", 3, 60);
    await cache.invalidar("catalogo:");
    expect(await cache.obtener("catalogo:rutas")).toBeUndefined();
    expect(await cache.obtener("catalogo:ciudades")).toBeUndefined();
    expect(await cache.obtener("dashboard:resumen")).toBe(3);
  });

  it("SinCache nunca devuelve nada", async () => {
    const cache = new SinCache();
    await cache.guardar("k", 1, 60);
    expect(await cache.obtener("k")).toBeUndefined();
  });
});

describe("conCache / invalidaTras", () => {
  it("la segunda lectura sale de la caché hasta que una escritura invalida", async () => {
    const cache = new MemoryCache();
    const leer = { ejecutar: vi.fn(async (n: number) => ({ n, calculado: true })) };
    const escribir = { ejecutar: vi.fn(async () => "ok") };
    const lectura = conCache(leer, cache, { clave: (n) => `dashboard:${n}`, ttlSeg: 60 });
    const escritura = invalidaTras(escribir, cache, ["dashboard:"]);

    expect(await lectura.ejecutar(1)).toEqual({ n: 1, calculado: true });
    await lectura.ejecutar(1);
    expect(leer.ejecutar).toHaveBeenCalledTimes(1);
    await lectura.ejecutar(2);
    expect(leer.ejecutar).toHaveBeenCalledTimes(2);

    expect(await escritura.ejecutar()).toBe("ok");
    await lectura.ejecutar(1);
    expect(leer.ejecutar).toHaveBeenCalledTimes(3);
  });

  it("no cachea errores ni invalida si la escritura falla", async () => {
    const cache = new MemoryCache();
    await cache.guardar("dashboard:x", 1, 60);
    const falla = { ejecutar: vi.fn(async (): Promise<number> => Promise.reject(new Error("no encontrado"))) };
    await expect(conCache(falla, cache, { clave: () => "seguimiento:9", ttlSeg: 60 }).ejecutar()).rejects.toThrow();
    expect(await cache.obtener("seguimiento:9")).toBeUndefined();
    await expect(invalidaTras(falla, cache, ["dashboard:"]).ejecutar()).rejects.toThrow();
    expect(await cache.obtener("dashboard:x")).toBe(1);
  });

  it("claveGuia ignora espacios y ceros a la izquierda", () => {
    expect(claveGuia("0040425")).toBe("40425");
    expect(claveGuia(" 40 425 ")).toBe("40425");
    expect(claveGuia("0")).toBe("0");
  });
});

describe("RutaRepositoryEnCache", () => {
  const ciudad = { id: 1, nombre: "Ibarra", activa: true };
  const ruta: Ruta = { id: 7, origen: ciudad, destino: ciudad, tarifaBase: 2, tiempoEstimadoMin: 30, activa: true };
  const interno = (): RutaRepository => ({
    listar: vi.fn(async () => [ruta]),
    buscarPorId: vi.fn(async () => ruta),
    existe: vi.fn(async () => false),
    usaCiudad: vi.fn(async () => true),
    crear: vi.fn(async () => ruta),
    actualizar: vi.fn(async () => ({ ...ruta, tarifaBase: 3 })),
  });

  it("resuelve listar y buscarPorId desde un único listado cacheado", async () => {
    const repo = interno();
    const enCache = new RutaRepositoryEnCache(repo, new MemoryCache());
    expect(await enCache.listar()).toEqual([ruta]);
    expect(await enCache.buscarPorId(7)).toEqual(ruta);
    expect(await enCache.buscarPorId(99)).toBeNull();
    expect(repo.listar).toHaveBeenCalledTimes(1);
    expect(repo.buscarPorId).not.toHaveBeenCalled();
  });

  it("crear y actualizar invalidan el catálogo", async () => {
    const repo = interno();
    const cache = new MemoryCache();
    await cache.guardar("catalogo:publico", { viejo: true }, 60);
    const enCache = new RutaRepositoryEnCache(repo, cache);
    await enCache.listar();
    await enCache.actualizar(7, { tarifaBase: 3 });
    await enCache.listar();
    expect(repo.listar).toHaveBeenCalledTimes(2);
    expect(await cache.obtener("catalogo:publico")).toBeUndefined();
  });
});

describe("Límite de tasa", () => {
  it("MemoryLimitadorTasa cuenta por ventana fija y la reinicia", async () => {
    const r = reloj();
    const lim = new MemoryLimitadorTasa(r);
    // FakeClock avanza en minutos: ventana de 10 min.
    expect(await lim.consumir("ip", 2, 600)).toEqual({ permitido: true, restantes: 1, reintentarEnSeg: 600 });
    expect((await lim.consumir("ip", 2, 600)).permitido).toBe(true);
    r.avanzar(4);
    expect(await lim.consumir("ip", 2, 600)).toEqual({ permitido: false, restantes: 0, reintentarEnSeg: 360 });
    expect((await lim.consumir("otra-ip", 2, 600)).permitido).toBe(true);
    r.avanzar(6);
    expect((await lim.consumir("ip", 2, 600)).permitido).toBe(true);
  });

  it("el middleware responde 429 DEMASIADAS_SOLICITUDES con Retry-After", async () => {
    const app = express();
    app.get("/x", limitarTasa(new MemoryLimitadorTasa(), { nombre: "t", limite: 2, ventanaSeg: 60 }), (_q, s) => {
      s.json({ ok: true });
    });
    await request(app).get("/x").expect(200).expect("RateLimit-Remaining", "1");
    await request(app).get("/x").expect(200).expect("RateLimit-Remaining", "0");
    const r = await request(app).get("/x").expect(429);
    expect(r.body.error.code).toBe("DEMASIADAS_SOLICITUDES");
    expect(Number(r.headers["retry-after"])).toBeGreaterThan(0);
  });
});
