import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryLimitadorTasa } from "../../../src/infrastructure/cache/memoria.js";
import { adaptadoresEnMemoria, crearCasosDeUso } from "../../../src/infrastructure/container.js";
import { crearApp } from "../../../src/infrastructure/http/app.js";
import { AlmacenMemoria } from "../../../src/infrastructure/storage/AlmacenMemoria.js";
import { IMAGENES, JWT_SECRET_TEST, solicitudEnvio } from "../../helpers/fakes.js";

// Contrato v9: perfil propio, dirección del remitente y evidencia de entrega. App nueva por test (los perfiles cambian).

let app: Express;
let almacen: AlmacenMemoria;
let tokenAdmin: string;
let tokenOperador: string;

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const login = async (email: string, password: string) =>
  (await request(app).post("/api/auth/login").send({ email, password })).body.token as string;

beforeEach(async () => {
  almacen = new AlmacenMemoria();
  const adaptadores = await adaptadoresEnMemoria({ jwtSecret: JWT_SECRET_TEST, rondasBcrypt: 4, almacen });
  app = crearApp(crearCasosDeUso(adaptadores), { limitador: new MemoryLimitadorTasa() });
  tokenAdmin = await login("admin@pcargo.ec", "Admin123!");
  tokenOperador = await login("operador@pcargo.ec", "Operador123!");
});

describe("PATCH /auth/me", () => {
  it("actualiza nombre y correo (en minúsculas) y devuelve { token, usuario } con el nombre nuevo", async () => {
    const r = await request(app)
      .patch("/api/auth/me")
      .set(auth(tokenOperador))
      .send({ nombre: "Paola Ruiz", email: "Paola.Ruiz@PCargo.ec" })
      .expect(200);
    expect(Object.keys(r.body).sort()).toEqual(["token", "usuario"]);
    expect(r.body.usuario).toEqual({
      id: "00000000-0000-4000-8000-000000000002",
      nombre: "Paola Ruiz",
      email: "paola.ruiz@pcargo.ec",
      rol: "OPERADOR",
      clienteId: null,
    });
    // el token nuevo funciona y su nombre queda como operador de los envíos que registra
    const creado = await request(app).post("/api/envios").set(auth(r.body.token)).send(solicitudEnvio()).expect(201);
    expect(creado.body.registro.operador).toBe("Paola Ruiz");
    expect(creado.body.historial[0].usuario).toBe("Paola Ruiz");
    const me = await request(app).get("/api/auth/me").set(auth(r.body.token)).expect(200);
    expect(me.body.email).toBe("paola.ruiz@pcargo.ec");
    // se inicia sesión con el correo nuevo
    await request(app).post("/api/auth/login").send({ email: "paola.ruiz@pcargo.ec", password: "Operador123!" }).expect(200);
  });

  it("acepta un solo campo", async () => {
    const r = await request(app).patch("/api/auth/me").set(auth(tokenAdmin)).send({ nombre: "Gerencia PCargo" }).expect(200);
    expect(r.body.usuario).toMatchObject({ nombre: "Gerencia PCargo", email: "admin@pcargo.ec", rol: "ADMIN" });
  });

  it("correo de otro usuario → 409 CONFLICTO", async () => {
    const r = await request(app).patch("/api/auth/me").set(auth(tokenOperador)).send({ email: "ADMIN@pcargo.ec" }).expect(409);
    expect(r.body.error.code).toBe("CONFLICTO");
  });

  it.each([
    ["body vacío", {}],
    ["otros campos (rol)", { nombre: "Paola Ruiz", rol: "ADMIN" }],
    ["solo rol", { rol: "ADMIN" }],
    ["nombre corto", { nombre: "P" }],
    ["nombre largo", { nombre: "x".repeat(81) }],
    ["correo inválido", { email: "no-es-correo" }],
    ["tipos incorrectos", { nombre: 123 }],
  ])("%s → 400 VALIDACION", async (_caso, body) => {
    const r = await request(app).patch("/api/auth/me").set(auth(tokenOperador)).send(body).expect(400);
    expect(r.body.error.code).toBe("VALIDACION");
    expect((await request(app).get("/api/auth/me").set(auth(tokenOperador))).body.rol).toBe("OPERADOR");
  });

  it("exige token", async () => {
    await request(app).patch("/api/auth/me").send({ nombre: "Paola" }).expect(401);
  });
});

describe("PUT /auth/me/password", () => {
  it("cambia la contraseña → 204; la nueva sirve para entrar y la vieja no", async () => {
    await request(app)
      .put("/api/auth/me/password")
      .set(auth(tokenOperador))
      .send({ actual: "Operador123!", nueva: "Ibarra2026" })
      .expect(204, "");
    await request(app).post("/api/auth/login").send({ email: "operador@pcargo.ec", password: "Ibarra2026" }).expect(200);
    await request(app).post("/api/auth/login").send({ email: "operador@pcargo.ec", password: "Operador123!" }).expect(401);
  });

  it("actual incorrecta → 422 CONTRASENA_INCORRECTA (no 401)", async () => {
    const r = await request(app)
      .put("/api/auth/me/password")
      .set(auth(tokenOperador))
      .send({ actual: "equivocada", nueva: "Ibarra2026" })
      .expect(422);
    expect(r.body.error.code).toBe("CONTRASENA_INCORRECTA");
  });

  it.each([
    ["menos de 8", "Abc1234"],
    ["más de 72", "a".repeat(72) + "1"],
    ["sin número", "SoloLetras"],
    ["sin letra", "12345678"],
    ["igual a la actual", "Operador123!"],
  ])("nueva %s → 400 VALIDACION", async (_caso, nueva) => {
    const r = await request(app)
      .put("/api/auth/me/password")
      .set(auth(tokenOperador))
      .send({ actual: "Operador123!", nueva })
      .expect(400);
    expect(r.body.error.code).toBe("VALIDACION");
  });

  it("body incompleto → 400 VALIDACION", async () => {
    await request(app).put("/api/auth/me/password").set(auth(tokenOperador)).send({ nueva: "Ibarra2026" }).expect(400);
  });

  it("límite de tasa: 10 solicitudes / 15 min por usuario → 429 con Retry-After", async () => {
    const intento = (token: string) =>
      request(app).put("/api/auth/me/password").set(auth(token)).send({ actual: "equivocada", nueva: "Ibarra2026" });
    for (let i = 0; i < 10; i++) {
      const r = await intento(tokenOperador);
      expect(r.status).toBe(422);
      expect(r.headers["ratelimit-limit"]).toBe("10");
    }
    const bloqueado = await intento(tokenOperador).expect(429);
    expect(bloqueado.body.error.code).toBe("DEMASIADAS_SOLICITUDES");
    expect(Number(bloqueado.headers["retry-after"])).toBeGreaterThan(0);
    // otro usuario (misma IP) no comparte el límite
    expect((await intento(tokenAdmin)).status).toBe(422);
  });
});

describe("Dirección del remitente", () => {
  it("POST /envios acepta remitente.direccion opcional (0–200); vacía → null", async () => {
    const con = await request(app)
      .post("/api/envios")
      .set(auth(tokenOperador))
      .send(solicitudEnvio({ remitente: { nombre: "María Pérez", telefono: "0991234567", direccion: "Sucre 4-56, Ibarra" } }))
      .expect(201);
    expect(con.body.remitente).toEqual({ nombre: "María Pérez", telefono: "0991234567", direccion: "Sucre 4-56, Ibarra" });
    const detalle = await request(app).get(`/api/envios/${con.body.id}`).set(auth(tokenOperador)).expect(200);
    expect(detalle.body.remitente.direccion).toBe("Sucre 4-56, Ibarra");

    for (const direccion of ["", "   ", null, undefined]) {
      const r = await request(app)
        .post("/api/envios")
        .set(auth(tokenOperador))
        .send(solicitudEnvio({ remitente: { nombre: "Ana", telefono: "0991112233", direccion } }))
        .expect(201);
      expect(r.body.remitente.direccion).toBeNull();
    }
    const lista = await request(app).get("/api/envios").set(auth(tokenOperador)).expect(200);
    expect(lista.body.datos.every((e: { remitente: object }) => "direccion" in e.remitente)).toBe(true);
  });

  it("más de 200 caracteres → 400 VALIDACION", async () => {
    const r = await request(app)
      .post("/api/envios")
      .set(auth(tokenOperador))
      .send(solicitudEnvio({ remitente: { nombre: "Ana", telefono: "0991112233", direccion: "x".repeat(201) } }))
      .expect(400);
    expect(r.body.error.code).toBe("VALIDACION");
  });
});

/** Crea un envío por la API y lo lleva a ENTREGADO. */
async function envioEntregado(): Promise<{ id: string; numeroGuia: number }> {
  const e = (await request(app).post("/api/envios").set(auth(tokenOperador)).send(solicitudEnvio()).expect(201)).body;
  for (const estado of ["EN_TRANSITO", "EN_REPARTO", "ENTREGADO"]) {
    await request(app).patch(`/api/envios/${e.id}/estado`).set(auth(tokenOperador)).send({ estado }).expect(200);
  }
  return e;
}

const subir = (id: string, foto: Buffer | null, recibidoPor?: string, nombreArchivo = "guia.jpg", token = tokenOperador) => {
  const req = request(app).post(`/api/envios/${id}/evidencia`).set(auth(token));
  if (recibidoPor !== undefined) req.field("recibidoPor", recibidoPor);
  if (foto) req.attach("foto", foto, { filename: nombreArchivo, contentType: "image/jpeg" });
  return req;
};

describe("Evidencia de entrega", () => {
  it("todo envío trae evidencia: null mientras no se suba", async () => {
    const e = await envioEntregado();
    const detalle = await request(app).get(`/api/envios/${e.id}`).set(auth(tokenOperador)).expect(200);
    expect(detalle.body.evidencia).toBeNull();
    const lista = await request(app).get("/api/envios").set(auth(tokenOperador)).expect(200);
    expect(lista.body.datos[0]).toHaveProperty("evidencia", null);
    await request(app).get(`/api/envios/${e.id}/evidencia`).set(auth(tokenOperador)).expect(404);
  });

  it("POST sube la foto (multipart) y responde Envio con historial y evidencia; GET la devuelve privada", async () => {
    const e = await envioEntregado();
    const r = await subir(e.id, IMAGENES.png, "Rosa Cevallos", "guia.png").expect(200);
    expect(r.body.id).toBe(e.id);
    expect(r.body.historial).toHaveLength(4);
    expect(r.body.evidencia).toEqual({
      recibidoPor: "Rosa Cevallos",
      tipo: "image/png",
      bytes: IMAGENES.png.length,
      subidaEn: expect.any(String),
      subidaPor: "Operador Ibarra",
    });
    expect(JSON.stringify(r.body)).not.toMatch(/evidencias\/|clave/);

    const foto = await request(app)
      .get(`/api/envios/${e.id}/evidencia`)
      .set(auth(tokenAdmin))
      .buffer(true)
      .parse((res, cb) => {
        const partes: Buffer[] = [];
        res.on("data", (c: Buffer) => partes.push(c));
        res.on("end", () => cb(null, Buffer.concat(partes)));
      })
      .expect(200);
    expect(foto.headers["content-type"]).toBe("image/png");
    expect(foto.headers["cache-control"]).toBe("private, no-store");
    expect((foto.body as Buffer).equals(IMAGENES.png)).toBe(true);

    // la evidencia aparece en el detalle y en el listado
    expect((await request(app).get(`/api/envios/${e.id}`).set(auth(tokenOperador))).body.evidencia.recibidoPor).toBe("Rosa Cevallos");
    expect((await request(app).get("/api/envios").set(auth(tokenOperador))).body.datos[0].evidencia.tipo).toBe("image/png");
  });

  it("el tipo se toma del contenido, no de la cabecera del archivo", async () => {
    const e = await envioEntregado();
    // WebP declarado como image/jpeg y con nombre .jpg
    const r = await subir(e.id, IMAGENES.webp, "Rosa", "foto.jpg").expect(200);
    expect(r.body.evidencia.tipo).toBe("image/webp");
    const g = await request(app).get(`/api/envios/${e.id}/evidencia`).set(auth(tokenOperador)).expect(200);
    expect(g.headers["content-type"]).toBe("image/webp");
  });

  it("reemplaza la evidencia y borra la foto anterior del almacén", async () => {
    const e = await envioEntregado();
    await subir(e.id, IMAGENES.jpeg, "Rosa").expect(200);
    const [primera] = almacen.claves();
    expect(primera).toMatch(new RegExp(`^evidencias/${e.id}/[0-9a-f-]{36}\\.jpg$`));
    const r = await subir(e.id, IMAGENES.png, "Luis Andrade", "x.png", tokenAdmin).expect(200);
    expect(r.body.evidencia).toMatchObject({ recibidoPor: "Luis Andrade", tipo: "image/png", subidaPor: "Administrador PCargo" });
    expect(almacen.claves()).toHaveLength(1);
    expect(almacen.claves()[0]).not.toBe(primera);
  });

  it("envío no ENTREGADO → 422 ESTADO_INVALIDO", async () => {
    const e = (await request(app).post("/api/envios").set(auth(tokenOperador)).send(solicitudEnvio()).expect(201)).body;
    const r = await subir(e.id, IMAGENES.jpeg, "Rosa").expect(422);
    expect(r.body.error.code).toBe("ESTADO_INVALIDO");
    expect(almacen.claves()).toEqual([]);
  });

  it.each([
    ["sin foto", null, "Rosa"],
    ["archivo que no es imagen", IMAGENES.falsa, "Rosa"],
    ["sin recibidoPor", IMAGENES.jpeg, undefined],
    ["recibidoPor corto", IMAGENES.jpeg, "R"],
    ["recibidoPor largo", IMAGENES.jpeg, "x".repeat(121)],
  ])("%s → 400 VALIDACION", async (_caso, foto, recibidoPor) => {
    const e = await envioEntregado();
    const r = await subir(e.id, foto, recibidoPor).expect(400);
    expect(r.body.error.code).toBe("VALIDACION");
    expect(almacen.claves()).toEqual([]);
  });

  it("foto de más de 5 MB → 400 VALIDACION (no 413) con el formato de error uniforme", async () => {
    const e = await envioEntregado();
    const grande = Buffer.concat([IMAGENES.jpeg, Buffer.alloc(5 * 1024 * 1024)]);
    const r = await subir(e.id, grande, "Rosa").expect(400);
    expect(r.body).toEqual({ error: { code: "VALIDACION", message: expect.stringContaining("5 MB") } });
  });

  it("campo de archivo con otro nombre → 400; JSON sin archivo → 400", async () => {
    const e = await envioEntregado();
    const r = await request(app)
      .post(`/api/envios/${e.id}/evidencia`)
      .set(auth(tokenOperador))
      .field("recibidoPor", "Rosa")
      .attach("imagen", IMAGENES.jpeg, "guia.jpg")
      .expect(400);
    expect(r.body.error.code).toBe("VALIDACION");
    await request(app).post(`/api/envios/${e.id}/evidencia`).set(auth(tokenOperador)).send({ recibidoPor: "Rosa" }).expect(400);
  });

  it("multipart mal formado → 400 VALIDACION", async () => {
    const e = await envioEntregado();
    const r = await request(app)
      .post(`/api/envios/${e.id}/evidencia`)
      .set(auth(tokenOperador))
      .set("Content-Type", "multipart/form-data; boundary=XYZ")
      .send("--XYZ\r\nContent-Disposition: form-data; name=\"foto\"; filename=\"a.jpg\"\r\n\r\nsin cierre")
      .expect(400);
    expect(r.body.error.code).toBe("VALIDACION");
  });

  it("id inválido → 400; envío inexistente → 404; sin token → 401", async () => {
    await subir("no-es-uuid", IMAGENES.jpeg, "Rosa").expect(400);
    await subir("00000000-0000-4000-a000-0000000fffff", IMAGENES.jpeg, "Rosa").expect(404);
    await request(app).get("/api/envios/00000000-0000-4000-a000-0000000fffff/evidencia").set(auth(tokenOperador)).expect(404);
    await request(app).get("/api/envios/no-es-uuid/evidencia").set(auth(tokenOperador)).expect(400);
    const e = await envioEntregado();
    await request(app).post(`/api/envios/${e.id}/evidencia`).attach("foto", IMAGENES.jpeg, "a.jpg").expect(401);
    await request(app).get(`/api/envios/${e.id}/evidencia`).expect(401);
  });

  it("el seguimiento público no expone la evidencia ni el nombre de quien recibió", async () => {
    const e = await envioEntregado();
    await subir(e.id, IMAGENES.jpeg, "Rosa Cevallos").expect(200);
    const s = await request(app).get(`/api/seguimiento/${e.numeroGuia}`).expect(200);
    expect(s.body).not.toHaveProperty("evidencia");
    expect(JSON.stringify(s.body)).not.toContain("Rosa");
  });
});
