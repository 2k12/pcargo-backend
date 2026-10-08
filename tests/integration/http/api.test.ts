import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { adaptadoresEnMemoria, crearCasosDeUso } from "../../../src/infrastructure/container.js";
import { crearApp } from "../../../src/infrastructure/http/app.js";
import { item, JWT_SECRET_TEST, solicitudEnvio } from "../../helpers/fakes.js";

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
    expect(ciudades.body.map((c: { nombre: string }) => c.nombre)).toEqual(["Atuntaqui", "Ibarra", "Otavalo", "Quito"]);
    const tipos = await request(app).get("/api/tipos-carga").set(auth(tokenOperador)).expect(200);
    expect(tipos.body.map((t: { codigo: string }) => t.codigo)).toEqual(["SOBRE", "PAQUETE", "CARTON", "VALIJA"]);
    const rutas = await request(app).get("/api/rutas?activa=true").set(auth(tokenOperador)).expect(200);
    expect(rutas.body).toHaveLength(16);
  });
});

describe("Web pública (sin sesión)", () => {
  it("GET /publico/catalogo devuelve ciudades, tipos de carga y solo rutas activas", async () => {
    const app2 = crearApp(crearCasosDeUso(await adaptadoresEnMemoria({ jwtSecret: JWT_SECRET_TEST, rondasBcrypt: 4 })));
    const admin = (await request(app2).post("/api/auth/login").send({ email: "admin@pcargo.ec", password: "Admin123!" })).body.token;
    await request(app2).patch("/api/rutas/3").set(auth(admin)).send({ activa: false }).expect(200);

    const r = await request(app2).get("/api/publico/catalogo").expect(200);
    expect(r.body.ciudades).toHaveLength(4);
    expect(r.body.tiposCarga.map((t: { codigo: string }) => t.codigo)).toEqual(["SOBRE", "PAQUETE", "CARTON", "VALIJA"]);
    expect(r.body.rutas).toHaveLength(15);
    expect(r.body.rutas.every((x: { activa: boolean }) => x.activa)).toBe(true);
  });

  it("POST /publico/cotizar cotiza sin token y valida la entrada", async () => {
    const r = await request(app).post("/api/publico/cotizar").send({ rutaId: 11, ...item("SOBRE", 0.3) }).expect(200);
    expect(r.body.costo).toBe(6);
    await request(app).post("/api/publico/cotizar").send({ rutaId: 11 }).expect(400);
  });

  it("los endpoints públicos no exponen la gestión", async () => {
    await request(app).post("/api/publico/rutas").send({}).expect(401);
  });
});

describe("Ciudades de cobertura (ADMIN)", () => {
  it("crea, renombra, desactiva y elimina; OPERADOR recibe 403", async () => {
    await request(app).post("/api/ciudades").set(auth(tokenOperador)).send({ nombre: "Cayambe" }).expect(403);

    const creada = await request(app).post("/api/ciudades").set(auth(tokenAdmin)).send({ nombre: "Cayambe" }).expect(201);
    expect(creada.body).toMatchObject({ nombre: "Cayambe", activa: true });
    const id = creada.body.id;

    await request(app).post("/api/ciudades").set(auth(tokenAdmin)).send({ nombre: "cayambe" }).expect(409);
    const ren = await request(app).patch(`/api/ciudades/${id}`).set(auth(tokenAdmin)).send({ nombre: "Cayambe Centro" }).expect(200);
    expect(ren.body.nombre).toBe("Cayambe Centro");
    await request(app).patch(`/api/ciudades/${id}`).set(auth(tokenAdmin)).send({}).expect(400);

    const activas = await request(app).get("/api/ciudades?activa=true").set(auth(tokenOperador)).expect(200);
    expect(activas.body.map((c: { nombre: string }) => c.nombre)).toContain("Cayambe Centro");

    await request(app).delete(`/api/ciudades/${id}`).set(auth(tokenOperador)).expect(403);
    await request(app).delete(`/api/ciudades/${id}`).set(auth(tokenAdmin)).expect(204);
    await request(app).delete(`/api/ciudades/${id}`).set(auth(tokenAdmin)).expect(404);
  });

  it("no elimina una ciudad con rutas (409) y al desactivarla sus rutas dejan de ser operativas", async () => {
    const r = await request(app).delete("/api/ciudades/3").set(auth(tokenAdmin)).expect(409);
    expect(r.body.error.message).toMatch(/desactívela/);

    await request(app).patch("/api/ciudades/3").set(auth(tokenAdmin)).send({ activa: false }).expect(200);
    const rutas = await request(app).get("/api/rutas").set(auth(tokenOperador)).expect(200);
    const haciaOtavalo = rutas.body.filter((x: { destino: { id: number } }) => x.destino.id === 3);
    expect(haciaOtavalo.length).toBeGreaterThan(0);
    expect(haciaOtavalo.every((x: { operativa: boolean }) => !x.operativa)).toBe(true);
    await request(app).post("/api/envios/cotizar").set(auth(tokenOperador)).send({ rutaId: 7, ...item("SOBRE", 0.1) }).expect(422);
    const publico = await request(app).get("/api/publico/catalogo").expect(200);
    expect(publico.body.ciudades.map((c: { nombre: string }) => c.nombre)).not.toContain("Otavalo");

    await request(app).patch("/api/ciudades/3").set(auth(tokenAdmin)).send({ activa: true }).expect(200);
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
      .send({ rutaId: 11, ...item("CARTON", 5, 3) })
      .expect(200);
    expect(cot.body).toEqual({
      costo: 33.3,
      tarifaBase: 6,
      totalPiezas: 3,
      pesoTotalKg: 15,
      items: [{ tipoCarga: "CARTON", cantidad: 3, pesoKg: 5, factor: 1.6, recargoPeso: 1.5, costoUnitario: 11.1, subtotal: 33.3 }],
    });

    const creado = await request(app)
      .post("/api/envios")
      .set(auth(tokenOperador))
      .send(solicitudEnvio({ ...item("CARTON", 5, 3), formaPago: "AL_COBRO" }))
      .expect(201);
    expect(creado.body).toMatchObject({
      estado: "REGISTRADO",
      costo: 33.3,
      totalPiezas: 3,
      pesoTotalKg: 15,
      formaPago: "AL_COBRO",
      items: [{ tipoCarga: "CARTON", cantidad: 3, pesoKg: 5, costoUnitario: 11.1, subtotal: 33.3 }],
      registro: { operador: "Operador Ibarra" },
      entrega: null,
    });
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

    const p = await request(app).post("/api/envios").set(auth(tokenOperador)).send(solicitudEnvio(item("SOBRE", 2))).expect(422);
    expect(p.body.error.code).toBe("PESO_INVALIDO");

    const i = await request(app).post("/api/envios/cotizar").set(auth(tokenOperador)).send({ rutaId: 2, ...item("SOBRE", 0.1) }).expect(422);
    expect(i.body.error.code).toBe("RUTA_INACTIVA");
  });

  it("no entregado exige motivo (400) y la gestión de entrega queda con fecha y operador", async () => {
    const { body } = await request(app).post("/api/envios").set(auth(tokenOperador)).send(solicitudEnvio({ formaPago: "SEGURO" })).expect(201);
    for (const estado of ["EN_TRANSITO", "EN_REPARTO"]) {
      await request(app).patch(`/api/envios/${body.id}/estado`).set(auth(tokenOperador)).send({ estado }).expect(200);
    }
    const sinMotivo = await request(app).patch(`/api/envios/${body.id}/estado`).set(auth(tokenOperador)).send({ estado: "NO_ENTREGADO" }).expect(400);
    expect(sinMotivo.body.error.message).toMatch(/motivo/);

    const r = await request(app)
      .patch(`/api/envios/${body.id}/estado`)
      .set(auth(tokenAdmin))
      .send({ estado: "NO_ENTREGADO", nota: "Dirección no existe" })
      .expect(200);
    expect(r.body.entrega).toMatchObject({ resultado: "NO_ENTREGADO", operador: "Administrador PCargo", nota: "Dirección no existe" });
    expect(Date.parse(r.body.entrega.fecha)).not.toBeNaN();

    const seguros = await request(app).get("/api/envios?formaPago=SEGURO").set(auth(tokenOperador)).expect(200);
    expect(seguros.body.map((e: { id: string }) => e.id)).toEqual([body.id]);
    await request(app).get("/api/envios?formaPago=TARJETA").set(auth(tokenOperador)).expect(400);
    await request(app).post("/api/envios").set(auth(tokenOperador)).send(solicitudEnvio({ formaPago: undefined })).expect(400);
  });

  it("validaciones de forma → 400; recursos inexistentes → 404", async () => {
    await request(app).post("/api/envios").set(auth(tokenOperador)).send({ rutaId: 11 }).expect(400);
    await request(app).get("/api/envios/no-uuid").set(auth(tokenOperador)).expect(400);
    await request(app).get("/api/envios/00000000-0000-4000-8000-00000000ffff").set(auth(tokenOperador)).expect(404);
    await request(app).get("/api/seguimiento/PC-NOEXISTE").expect(404);
  });
});
