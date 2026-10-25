import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { adaptadoresEnMemoria, crearCasosDeUso } from "../../../src/infrastructure/container.js";
import { crearApp } from "../../../src/infrastructure/http/app.js";
import { AlmacenMemoria } from "../../../src/infrastructure/storage/AlmacenMemoria.js";
import { IMAGENES, JWT_SECRET_TEST, solicitudEnvio } from "../../helpers/fakes.js";

// Contrato v19: evidencia de entrega por partes (foto, nombre o ambos; al menos uno) en el panel y la app del repartidor.

let app: Express;
let almacen: AlmacenMemoria;
let tokenOperador: string;
let tokenRepartidor: string;

const REPARTIDOR_ID = "00000000-0000-4000-8000-000000000003";
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const login = async (email: string, password: string) =>
  (await request(app).post("/api/auth/login").send({ email, password }).expect(200)).body.token as string;

beforeEach(async () => {
  almacen = new AlmacenMemoria();
  const adaptadores = await adaptadoresEnMemoria({ jwtSecret: JWT_SECRET_TEST, rondasBcrypt: 4, almacen });
  app = crearApp(crearCasosDeUso(adaptadores));
  [tokenOperador, tokenRepartidor] = await Promise.all([
    login("operador@pcargo.ec", "Operador123!"),
    login("repartidor@pcargo.ec", "Repartidor123!"),
  ]);
});

const crearEnvio = async () =>
  (await request(app).post("/api/envios").set(auth(tokenOperador)).send(solicitudEnvio()).expect(201)).body as { id: string };

/** Crea un envío y lo lleva a ENTREGADO por el panel, sin evidencia. */
async function envioEntregado(): Promise<string> {
  const { id } = await crearEnvio();
  for (const estado of ["EN_TRANSITO", "EN_REPARTO", "ENTREGADO"]) {
    await request(app).patch(`/api/envios/${id}/estado`).set(auth(tokenOperador)).send({ estado }).expect(200);
  }
  return id;
}

const subir = (base: string, id: string, token: string, partes: { foto?: Buffer; recibidoPor?: string }) => {
  const req = request(app).post(`/api${base}/envios/${id}/evidencia`).set(auth(token));
  if (partes.recibidoPor !== undefined) req.field("recibidoPor", partes.recibidoPor);
  if (partes.foto) req.attach("foto", partes.foto, { filename: "guia.jpg", contentType: "image/jpeg" });
  return req;
};
const panel = (id: string, partes: { foto?: Buffer; recibidoPor?: string }) => subir("", id, tokenOperador, partes);
const fotoGet = (id: string) => request(app).get(`/api/envios/${id}/evidencia`).set(auth(tokenOperador));

describe("POST /envios/:id/evidencia por partes (v19)", () => {
  it("marcar ENTREGADO no exige evidencia", async () => {
    const id = await envioEntregado();
    const r = await request(app).get(`/api/envios/${id}`).set(auth(tokenOperador)).expect(200);
    expect(r.body).toMatchObject({ estado: "ENTREGADO", evidencia: null });
  });

  it("solo nombre → 200 con tipo/bytes null; GET de la foto → 404", async () => {
    const id = await envioEntregado();
    const r = await panel(id, { recibidoPor: "Rosa Vera" }).expect(200);
    expect(r.body.evidencia).toEqual({
      recibidoPor: "Rosa Vera",
      tipo: null,
      bytes: null,
      subidaEn: expect.any(String),
      subidaPor: "Operador Ibarra",
    });
    expect(r.body.historial).toHaveLength(4);
    expect(almacen.claves()).toEqual([]);
    const g = await fotoGet(id).expect(404);
    expect(g.body.error.code).toBe("NO_ENCONTRADO");
  });

  it("solo foto → recibidoPor null; después solo nombre conserva la foto", async () => {
    const id = await envioEntregado();
    const r = await panel(id, { foto: IMAGENES.png }).expect(200);
    expect(r.body.evidencia).toMatchObject({ recibidoPor: null, tipo: "image/png", bytes: IMAGENES.png.length });
    const [clave] = almacen.claves();
    const n = await panel(id, { recibidoPor: "Luis Andrade" }).expect(200);
    expect(n.body.evidencia).toMatchObject({ recibidoPor: "Luis Andrade", tipo: "image/png", bytes: IMAGENES.png.length });
    expect(almacen.claves()).toEqual([clave]);
    expect((await fotoGet(id).expect(200)).headers["content-type"]).toBe("image/png");
  });

  it("nombre primero y foto después: conserva el nombre y la foto se puede reemplazar (borra la anterior)", async () => {
    const id = await envioEntregado();
    await panel(id, { recibidoPor: "Rosa Vera" }).expect(200);
    const f1 = await panel(id, { foto: IMAGENES.jpeg }).expect(200);
    expect(f1.body.evidencia).toMatchObject({ recibidoPor: "Rosa Vera", tipo: "image/jpeg" });
    const [primera] = almacen.claves();
    const f2 = await panel(id, { foto: IMAGENES.webp }).expect(200);
    expect(f2.body.evidencia).toMatchObject({ recibidoPor: "Rosa Vera", tipo: "image/webp" });
    expect(almacen.claves()).toHaveLength(1);
    expect(almacen.claves()[0]).not.toBe(primera);
    expect((await fotoGet(id).expect(200)).headers["content-type"]).toBe("image/webp");
  });

  it("ambos → los dos", async () => {
    const id = await envioEntregado();
    const r = await panel(id, { foto: IMAGENES.jpeg, recibidoPor: "Rosa Vera" }).expect(200);
    expect(r.body.evidencia).toMatchObject({ recibidoPor: "Rosa Vera", tipo: "image/jpeg" });
  });

  it("ninguno → 400 VALIDACION y no cambia nada", async () => {
    const id = await envioEntregado();
    const r = await panel(id, {}).expect(400);
    expect(r.body.error.code).toBe("VALIDACION");
    expect((await panel(id, { recibidoPor: "" }).expect(400)).body.error.code).toBe("VALIDACION");
    expect((await request(app).get(`/api/envios/${id}`).set(auth(tokenOperador))).body.evidencia).toBeNull();
  });

  it("solo nombre en un envío no ENTREGADO → 422 ESTADO_INVALIDO", async () => {
    const { id } = await crearEnvio();
    const r = await panel(id, { recibidoPor: "Rosa Vera" }).expect(422);
    expect(r.body.error.code).toBe("ESTADO_INVALIDO");
  });
});

describe("POST /repartidor/envios/:id/evidencia por partes (v19)", () => {
  async function asignadoEntregado(): Promise<string> {
    const { id } = await crearEnvio();
    await request(app).post("/api/envios/asignar").set(auth(tokenOperador)).send({ envioIds: [id], repartidorId: REPARTIDOR_ID }).expect(200);
    await request(app).patch(`/api/envios/${id}/estado`).set(auth(tokenOperador)).send({ estado: "EN_TRANSITO" }).expect(200);
    const marcar = (estado: string) =>
      request(app).patch(`/api/repartidor/envios/${id}/estado`).set(auth(tokenRepartidor)).send({ estado }).expect(200);
    await marcar("EN_REPARTO");
    // el repartidor marca ENTREGADO sin nombre ni foto
    expect((await marcar("ENTREGADO")).body).toMatchObject({ estado: "ENTREGADO", evidencia: null });
    return id;
  }
  const rep = (id: string, partes: { foto?: Buffer; recibidoPor?: string }) => subir("/repartidor", id, tokenRepartidor, partes);

  it("solo nombre, luego solo foto (conserva el nombre), luego otro nombre (conserva la foto)", async () => {
    const id = await asignadoEntregado();
    const n = await rep(id, { recibidoPor: "Rosa Vera" }).expect(200);
    expect(n.body.evidencia).toEqual({ recibidoPor: "Rosa Vera", conFoto: false, subidaEn: expect.any(String) });
    await fotoGet(id).expect(404);
    const f = await rep(id, { foto: IMAGENES.png }).expect(200);
    expect(f.body.evidencia).toMatchObject({ recibidoPor: "Rosa Vera", conFoto: true });
    expect((await fotoGet(id).expect(200)).headers["content-type"]).toBe("image/png");
    await rep(id, { recibidoPor: "Luis Andrade" }).expect(200);
    const detalle = (await request(app).get(`/api/envios/${id}`).set(auth(tokenOperador))).body;
    expect(detalle.evidencia).toMatchObject({ recibidoPor: "Luis Andrade", tipo: "image/png", subidaPor: "Repartidor Ibarra" });
  });

  it("solo foto → recibidoPor null", async () => {
    const id = await asignadoEntregado();
    const r = await rep(id, { foto: IMAGENES.jpeg }).expect(200);
    expect(r.body.evidencia).toEqual({ recibidoPor: null, conFoto: true, subidaEn: expect.any(String) });
  });

  it("ninguno → 400; envío ajeno (no asignado) → 404; no ENTREGADO → 422", async () => {
    const id = await asignadoEntregado();
    expect((await rep(id, {}).expect(400)).body.error.code).toBe("VALIDACION");
    const ajeno = await envioEntregado();
    expect((await rep(ajeno, { recibidoPor: "Rosa Vera" }).expect(404)).body.error.code).toBe("NO_ENCONTRADO");
    expect((await rep(ajeno, { foto: IMAGENES.jpeg }).expect(404)).body.error.code).toBe("NO_ENCONTRADO");
    expect(almacen.claves()).toEqual([]);

    const { id: enCurso } = await crearEnvio();
    await request(app).post("/api/envios/asignar").set(auth(tokenOperador)).send({ envioIds: [enCurso], repartidorId: REPARTIDOR_ID }).expect(200);
    expect((await rep(enCurso, { recibidoPor: "Rosa Vera" }).expect(422)).body.error.code).toBe("ESTADO_INVALIDO");
  });
});
