import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryLimitadorTasa } from "../../../src/infrastructure/cache/memoria.js";
import { adaptadoresEnMemoria, crearCasosDeUso } from "../../../src/infrastructure/container.js";
import { crearApp } from "../../../src/infrastructure/http/app.js";
import { JWT_SECRET_TEST } from "../../helpers/fakes.js";

// Contrato v17: código único de acceso. App nueva por test (los códigos cambian).

let app: Express;
let tokenAdmin: string;
let tokenOperador: string;

const OPERADOR_ID = "00000000-0000-4000-8000-000000000002";
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const login = async (email: string, password: string) =>
  (await request(app).post("/api/auth/login").send({ email, password })).body.token as string;
const activar = (token: string, codigo: string, password: string) =>
  request(app).put("/api/auth/me/codigo").set(auth(token)).send({ password, codigo });
const entrarConCodigo = (codigo: string) => request(app).post("/api/auth/login/codigo").send({ codigo });

beforeEach(async () => {
  const adaptadores = await adaptadoresEnMemoria({ jwtSecret: JWT_SECRET_TEST, rondasBcrypt: 4 });
  app = crearApp(crearCasosDeUso(adaptadores), { limitador: new MemoryLimitadorTasa() });
  tokenAdmin = await login("admin@pcargo.ec", "Admin123!");
  tokenOperador = await login("operador@pcargo.ec", "Operador123!");
});

describe("código único de acceso", () => {
  it("sin activar: GET /auth/me/codigo → inactivo y el login con código falla", async () => {
    const r = await request(app).get("/api/auth/me/codigo").set(auth(tokenOperador)).expect(200);
    expect(r.body).toEqual({ activo: false, actualizadoEn: null });
    const e = await entrarConCodigo("cualquier-cosa").expect(401);
    expect(e.body.error.code).toBe("CREDENCIALES_INVALIDAS");
  });

  it("activa un código con símbolos y entra solo con él (mismo { token, usuario } que el login)", async () => {
    const r = await activar(tokenOperador, "#Pc-24*ñ", "Operador123!").expect(200);
    expect(r.body).toEqual({ activo: true, actualizadoEn: expect.any(String) });
    const estado = await request(app).get("/api/auth/me/codigo").set(auth(tokenOperador)).expect(200);
    expect(estado.body).toEqual({ activo: true, actualizadoEn: r.body.actualizadoEn });

    const s = await entrarConCodigo("#Pc-24*ñ").expect(200);
    expect(Object.keys(s.body).sort()).toEqual(["token", "usuario"]);
    expect(s.body.usuario).toEqual({
      id: OPERADOR_ID,
      nombre: "Operador Ibarra",
      email: "operador@pcargo.ec",
      rol: "OPERADOR",
      clienteId: null,
    });
    await request(app).get("/api/auth/me").set(auth(s.body.token)).expect(200);
    // distingue mayúsculas
    await entrarConCodigo("#PC-24*Ñ").expect(401);
  });

  it("acepta solo números y cambiar el código invalida el anterior", async () => {
    await activar(tokenOperador, "482913", "Operador123!").expect(200);
    await activar(tokenOperador, "Abc!2026", "Operador123!").expect(200);
    await entrarConCodigo("482913").expect(401);
    await entrarConCodigo("Abc!2026").expect(200);
  });

  it("volver a guardar el mismo código propio no es conflicto", async () => {
    await activar(tokenOperador, "482913", "Operador123!").expect(200);
    await activar(tokenOperador, "482913", "Operador123!").expect(200);
    await entrarConCodigo("482913").expect(200);
  });

  it("valida el código: largo, espacios e igual a la contraseña → 400 VALIDACION", async () => {
    for (const codigo of ["12345", "x".repeat(33), "12 3456", "Operador123!"]) {
      const r = await activar(tokenOperador, codigo, "Operador123!").expect(400);
      expect(r.body.error.code).toBe("VALIDACION");
    }
  });

  it("contraseña actual incorrecta → 422 CONTRASENA_INCORRECTA (la sesión sigue)", async () => {
    const r = await activar(tokenOperador, "482913", "otra-clave-1").expect(422);
    expect(r.body.error.code).toBe("CONTRASENA_INCORRECTA");
    await request(app).get("/api/auth/me").set(auth(tokenOperador)).expect(200);
    await entrarConCodigo("482913").expect(401);
  });

  it("código de otro usuario → 409 CONFLICTO y el del otro se desactiva", async () => {
    await activar(tokenAdmin, "Gerencia#1", "Admin123!").expect(200);
    const r = await activar(tokenOperador, "Gerencia#1", "Operador123!").expect(409);
    expect(r.body.error.code).toBe("CONFLICTO");
    // nadie entra con el código adivinado
    await entrarConCodigo("Gerencia#1").expect(401);
    const admin = await request(app).get("/api/auth/me/codigo").set(auth(tokenAdmin)).expect(200);
    expect(admin.body.activo).toBe(false);
    const op = await request(app).get("/api/auth/me/codigo").set(auth(tokenOperador)).expect(200);
    expect(op.body.activo).toBe(false);
  });

  it("DELETE /auth/me/codigo lo desactiva (idempotente)", async () => {
    await activar(tokenOperador, "482913", "Operador123!").expect(200);
    await request(app).delete("/api/auth/me/codigo").set(auth(tokenOperador)).expect(204);
    await request(app).delete("/api/auth/me/codigo").set(auth(tokenOperador)).expect(204);
    await entrarConCodigo("482913").expect(401);
  });

  it("un usuario desactivado no entra con su código", async () => {
    await activar(tokenOperador, "482913", "Operador123!").expect(200);
    await request(app).patch(`/api/usuarios/${OPERADOR_ID}`).set(auth(tokenAdmin)).send({ activo: false }).expect(200);
    await entrarConCodigo("482913").expect(401);
  });

  it("sirve para todos los roles (repartidor y portal)", async () => {
    const tokenRepartidor = await login("repartidor@pcargo.ec", "Repartidor123!");
    await activar(tokenRepartidor, "moto-777", "Repartidor123!").expect(200);
    expect((await entrarConCodigo("moto-777").expect(200)).body.usuario.rol).toBe("REPARTIDOR");
  });

  it("los endpoints del perfil exigen sesión", async () => {
    await request(app).get("/api/auth/me/codigo").expect(401);
    await request(app).put("/api/auth/me/codigo").send({ password: "x", codigo: "482913" }).expect(401);
    await request(app).delete("/api/auth/me/codigo").expect(401);
  });

  it("body inválido en el login con código → 400", async () => {
    await request(app).post("/api/auth/login/codigo").send({}).expect(400);
    await request(app).post("/api/auth/login/codigo").send({ codigo: 123456 }).expect(400);
  });

  it("limita el login con código a 20 intentos / 15 min por IP", async () => {
    for (let i = 0; i < 20; i++) await entrarConCodigo(`intento-${i}`).expect(401);
    const r = await entrarConCodigo("intento-final").expect(429);
    expect(r.body.error.code).toBe("DEMASIADAS_SOLICITUDES");
    expect(r.headers["retry-after"]).toBeDefined();
  });
});
