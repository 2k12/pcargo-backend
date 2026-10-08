import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { adaptadoresEnMemoria, crearCasosDeUso } from "../../../src/infrastructure/container.js";
import { crearApp } from "../../../src/infrastructure/http/app.js";
import { JWT_SECRET_TEST, solicitudEnvio } from "../../helpers/fakes.js";

// Pila HTTP completa (express + casos de uso + bcrypt/JWT reales) sobre adaptadores en memoria.

let app: Express;
let tokenAdmin: string;
let tokenOperador: string;

const login = async (email: string, password: string) =>
  (await request(app).post("/api/auth/login").send({ email, password })).body.token as string;

beforeAll(async () => {
  app = crearApp(crearCasosDeUso(await adaptadoresEnMemoria({ jwtSecret: JWT_SECRET_TEST, rondasBcrypt: 4 })));
  tokenAdmin = await login("admin@pcargo.ec", "Admin123!");
  tokenOperador = await login("operador@pcargo.ec", "Operador123!");
});

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe("Autenticación", () => {
  it("GET /health es público", async () => {
    await request(app).get("/api/health").expect(200, { status: "ok" });
  });

  it("login correcto devuelve token y perfil", async () => {
    const r = await request(app).post("/api/auth/login").send({ email: "admin@pcargo.ec", password: "Admin123!" }).expect(200);
    expect(r.body.usuario).toMatchObject({ email: "admin@pcargo.ec", rol: "ADMIN" });
    expect(r.body.usuario).not.toHaveProperty("passwordHash");
  });

  it("login incorrecto → 401 CREDENCIALES_INVALIDAS", async () => {
    const r = await request(app).post("/api/auth/login").send({ email: "admin@pcargo.ec", password: "x" }).expect(401);
    expect(r.body.error.code).toBe("CREDENCIALES_INVALIDAS");
  });

  it("body inválido → 400 VALIDACION", async () => {
    const r = await request(app).post("/api/auth/login").send({ email: "no-es-correo" }).expect(400);
    expect(r.body.error.code).toBe("VALIDACION");
  });

  it("rutas protegidas exigen token válido", async () => {
    await request(app).get("/api/envios").expect(401);
    await request(app).get("/api/envios").set(auth("token-falso")).expect(401);
    const me = await request(app).get("/api/auth/me").set(auth(tokenOperador)).expect(200);
    expect(me.body.rol).toBe("OPERADOR");
  });
});

describe("Catálogos", () => {
  it("lista ciudades, tipos de carga y rutas", async () => {
    const ciudades = await request(app).get("/api/ciudades").set(auth(tokenOperador)).expect(200);
    expect(ciudades.body.map((c: { nombre: string }) => c.nombre)).toEqual(["Ibarra", "Atuntaqui", "Otavalo", "Quito"]);
    const tipos = await request(app).get("/api/tipos-carga").set(auth(tokenOperador)).expect(200);
    expect(tipos.body.map((t: { codigo: string }) => t.codigo)).toEqual(["SOBRE", "PAQUETE", "CARTON", "VALIJA"]);
    const rutas = await request(app).get("/api/rutas?activa=true").set(auth(tokenOperador)).expect(200);
    expect(rutas.body).toHaveLength(16);
  });
});

describe("Gestión de rutas (ADMIN)", () => {
  it("OPERADOR recibe 403 al modificar rutas", async () => {
    await request(app).patch("/api/rutas/1").set(auth(tokenOperador)).send({ tarifaBase: 9 }).expect(403);
  });

  it("ADMIN actualiza tarifa y estado", async () => {
    const r = await request(app).patch("/api/rutas/2").set(auth(tokenAdmin)).send({ tarifaBase: 1.9, activa: false }).expect(200);
    expect(r.body).toMatchObject({ id: 2, tarifaBase: 1.9, activa: false });
  });

  it("ADMIN no puede duplicar una ruta → 409", async () => {
    await request(app)
      .post("/api/rutas")
      .set(auth(tokenAdmin))
      .send({ origenId: 1, destinoId: 2, tarifaBase: 3, tiempoEstimadoMin: 30 })
      .expect(409);
  });

  it("PATCH vacío → 400", async () => {
    await request(app).patch("/api/rutas/1").set(auth(tokenAdmin)).send({}).expect(400);
  });
});

describe("Flujo de un envío", () => {
  it("cotiza, crea, avanza estados y se rastrea públicamente", async () => {
    const cot = await request(app)
      .post("/api/envios/cotizar")
      .set(auth(tokenOperador))
      .send({ rutaId: 11, tipoCarga: "CARTON", pesoKg: 5 })
      .expect(200);
    expect(cot.body).toEqual({ costo: 11.1, tarifaBase: 6, factor: 1.6, recargoPeso: 1.5 });

    const creado = await request(app)
      .post("/api/envios")
      .set(auth(tokenOperador))
      .send(solicitudEnvio({ tipoCarga: "CARTON", pesoKg: 5 }))
      .expect(201);
    expect(creado.body).toMatchObject({ estado: "REGISTRADO", costo: 11.1, tipoCarga: "CARTON" });
    expect(creado.body.codigo).toMatch(/^PC-[A-Z0-9]{8}$/);
    const { id, codigo } = creado.body;

    for (const estado of ["EN_TRANSITO", "EN_REPARTO", "ENTREGADO"]) {
      await request(app).patch(`/api/envios/${id}/estado`).set(auth(tokenOperador)).send({ estado }).expect(200);
    }

    const detalle = await request(app).get(`/api/envios/${id}`).set(auth(tokenOperador)).expect(200);
    expect(detalle.body.historial.map((h: { estado: string }) => h.estado)).toEqual([
      "REGISTRADO", "EN_TRANSITO", "EN_REPARTO", "ENTREGADO",
    ]);

    const seg = await request(app).get(`/api/seguimiento/${codigo}`).expect(200);
    expect(seg.body).toMatchObject({ codigo, estado: "ENTREGADO", origen: "Ibarra", destino: "Quito" });
    expect(seg.body).not.toHaveProperty("destinatario");

    const lista = await request(app).get("/api/envios?estado=ENTREGADO").set(auth(tokenOperador)).expect(200);
    expect(lista.body.map((e: { id: string }) => e.id)).toContain(id);

    const resumen = await request(app).get("/api/dashboard/resumen").set(auth(tokenOperador)).expect(200);
    expect(resumen.body.porEstado.ENTREGADO).toBeGreaterThanOrEqual(1);
  });

  it("transición inválida → 422; peso excedido → 422; ruta inactiva → 422", async () => {
    const { body } = await request(app).post("/api/envios").set(auth(tokenOperador)).send(solicitudEnvio()).expect(201);
    const r = await request(app).patch(`/api/envios/${body.id}/estado`).set(auth(tokenOperador)).send({ estado: "ENTREGADO" }).expect(422);
    expect(r.body.error.code).toBe("TRANSICION_INVALIDA");

    const p = await request(app).post("/api/envios").set(auth(tokenOperador)).send(solicitudEnvio({ tipoCarga: "SOBRE", pesoKg: 2 })).expect(422);
    expect(p.body.error.code).toBe("PESO_INVALIDO");

    const i = await request(app).post("/api/envios/cotizar").set(auth(tokenOperador)).send({ rutaId: 2, tipoCarga: "SOBRE", pesoKg: 0.1 }).expect(422);
    expect(i.body.error.code).toBe("RUTA_INACTIVA");
  });

  it("validaciones de forma → 400; recursos inexistentes → 404", async () => {
    await request(app).post("/api/envios").set(auth(tokenOperador)).send({ rutaId: 11 }).expect(400);
    await request(app).get("/api/envios/no-uuid").set(auth(tokenOperador)).expect(400);
    await request(app).get("/api/envios/00000000-0000-4000-8000-00000000ffff").set(auth(tokenOperador)).expect(404);
    await request(app).get("/api/seguimiento/PC-NOEXISTE").expect(404);
  });
});
