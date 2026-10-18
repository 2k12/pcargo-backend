import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { adaptadoresEnMemoria, crearCasosDeUso, type Adaptadores } from "../../../src/infrastructure/container.js";
import { crearApp } from "../../../src/infrastructure/http/app.js";
import { CLIENTES_SEED } from "../../../src/infrastructure/persistence/seed-data.js";
import { AlmacenMemoria } from "../../../src/infrastructure/storage/AlmacenMemoria.js";
import { IMAGENES, JWT_SECRET_TEST, solicitudEnvio } from "../../helpers/fakes.js";

// Contrato v12 sobre la pila HTTP completa (express + bcrypt/JWT reales) en memoria: roles, usuarios, reparto,
// caja, datos personales y portal. App nueva por test (los usuarios y la caja cambian).

let app: Express;
let adaptadores: Adaptadores;
let almacen: AlmacenMemoria;
let tokenAdmin: string;
let tokenOperador: string;
let tokenRepartidor: string;
let tokenPortal: string;

const TEXTILES = CLIENTES_SEED[0]!.id;
const ID_INEXISTENTE = "00000000-0000-4000-8000-0000000000ff";
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const login = async (email: string, password: string) =>
  (await request(app).post("/api/auth/login").send({ email, password }).expect(200)).body.token as string;

beforeEach(async () => {
  almacen = new AlmacenMemoria();
  adaptadores = await adaptadoresEnMemoria({ jwtSecret: JWT_SECRET_TEST, rondasBcrypt: 4, almacen });
  app = crearApp(crearCasosDeUso(adaptadores));
  [tokenAdmin, tokenOperador, tokenRepartidor, tokenPortal] = await Promise.all([
    login("admin@pcargo.ec", "Admin123!"),
    login("operador@pcargo.ec", "Operador123!"),
    login("repartidor@pcargo.ec", "Repartidor123!"),
    login("portal@pcargo.ec", "Portal123!"),
  ]);
});

const crearEnvio = async (sobre: Record<string, unknown> = {}) =>
  (await request(app).post("/api/envios").set(auth(tokenOperador)).send(solicitudEnvio(sobre)).expect(201)).body;
const estado = (id: string, e: string, nota?: string) =>
  request(app).patch(`/api/envios/${id}/estado`).set(auth(tokenOperador)).send({ estado: e, nota }).expect(200);

describe("Roles (v12)", () => {
  it("login y /auth/me de los roles nuevos (con clienteId)", async () => {
    const r = await request(app).post("/api/auth/login").send({ email: "portal@pcargo.ec", password: "Portal123!" }).expect(200);
    expect(r.body.usuario).toEqual({
      id: "00000000-0000-4000-8000-000000000004",
      nombre: "Portal Textiles Atuntaqui",
      email: "portal@pcargo.ec",
      rol: "CLIENTE",
      clienteId: TEXTILES,
    });
    expect((await request(app).get("/api/auth/me").set(auth(tokenRepartidor)).expect(200)).body).toMatchObject({ rol: "REPARTIDOR", clienteId: null });
    // el perfil propio sirve para todos los roles
    await request(app).patch("/api/auth/me").set(auth(tokenPortal)).send({ nombre: "Compras Textiles" }).expect(200);
  });

  it("REPARTIDOR y CLIENTE reciben 403 PROHIBIDO en las rutas del panel", async () => {
    const rutas: [string, string][] = [
      ["get", "/api/ciudades"],
      ["get", "/api/rutas"],
      ["get", "/api/tipos-carga"],
      ["get", "/api/clientes"],
      ["get", "/api/envios"],
      ["post", "/api/envios"],
      ["post", "/api/envios/cotizar"],
      ["get", `/api/envios/${ID_INEXISTENTE}`],
      ["get", "/api/dashboard/resumen"],
      ["get", "/api/integraciones"],
      ["get", "/api/articulos-restringidos"],
      ["get", "/api/usuarios/repartidores"],
      ["post", "/api/envios/asignar"],
      ["get", "/api/caja/pendientes"],
      ["get", "/api/datos-personales/politica"],
    ];
    for (const token of [tokenRepartidor, tokenPortal]) {
      for (const [metodo, ruta] of rutas) {
        const r = await (request(app) as unknown as Record<string, (u: string) => request.Test>)[metodo]!(ruta).set(auth(token)).send({});
        expect([ruta, r.status, r.body.error?.code]).toEqual([ruta, 403, "PROHIBIDO"]);
      }
    }
  });

  it("el panel no entra a /repartidor ni /portal; cada rol solo a su espacio", async () => {
    for (const token of [tokenAdmin, tokenOperador, tokenPortal]) {
      expect((await request(app).get("/api/repartidor/envios").set(auth(token))).status).toBe(403);
    }
    for (const token of [tokenAdmin, tokenOperador, tokenRepartidor]) {
      expect((await request(app).get("/api/portal/envios").set(auth(token))).status).toBe(403);
    }
    await request(app).get("/api/repartidor/envios").expect(401);
    await request(app).get("/api/portal/envios").expect(401);
  });

  it("OPERADOR no administra usuarios, accesos ni datos personales (403)", async () => {
    for (const ruta of ["/api/usuarios", `/api/clientes/${TEXTILES}/accesos`, "/api/datos-personales/politica", "/api/datos-personales/solicitudes"]) {
      expect((await request(app).get(ruta).set(auth(tokenOperador))).status).toBe(403);
    }
    // pero sí lista repartidores y usa la caja
    await request(app).get("/api/usuarios/repartidores").set(auth(tokenOperador)).expect(200);
    await request(app).get("/api/caja/pendientes").set(auth(tokenOperador)).expect(200);
  });
});

describe("Usuarios (v12)", () => {
  it("CRUD del ADMIN con validaciones", async () => {
    const nuevo = { nombre: "Carlos Pérez", email: "Carlos@PCargo.ec", password: "Reparto2026", rol: "REPARTIDOR" };
    const r = await request(app).post("/api/usuarios").set(auth(tokenAdmin)).send(nuevo).expect(201);
    expect(r.body).toMatchObject({ email: "carlos@pcargo.ec", rol: "REPARTIDOR", activo: true, clienteId: null, cliente: null });
    expect(Object.keys(r.body).sort()).toEqual(["activo", "cliente", "clienteId", "creadoEn", "email", "id", "nombre", "rol"]);
    expect((await request(app).post("/api/usuarios").set(auth(tokenAdmin)).send(nuevo)).status).toBe(409);
    const malos: [Record<string, unknown>, number][] = [
      [{ ...nuevo, email: "a@pcargo.ec", clienteId: TEXTILES }, 400],
      [{ ...nuevo, email: "a@pcargo.ec", rol: "CLIENTE" }, 400],
      [{ ...nuevo, email: "a@pcargo.ec", rol: "CLIENTE", clienteId: ID_INEXISTENTE }, 422],
      [{ ...nuevo, email: "a@pcargo.ec", password: "corta" }, 400],
      [{ ...nuevo, email: "a@pcargo.ec", rol: "JEFE" }, 400],
      [{ ...nuevo, email: "a@pcargo.ec", extra: 1 }, 400],
    ];
    for (const [body, status] of malos) {
      const res = await request(app).post("/api/usuarios").set(auth(tokenAdmin)).send(body);
      expect([body, res.status, res.body.error.code]).toEqual([body, status, "VALIDACION"]);
    }
    const lista = await request(app).get("/api/usuarios?rol=REPARTIDOR&activo=true").set(auth(tokenAdmin)).expect(200);
    expect(lista.body.map((u: { nombre: string }) => u.nombre)).toEqual(["Carlos Pérez", "Repartidor Ibarra"]);
    expect((await request(app).get("/api/usuarios?rol=JEFE").set(auth(tokenAdmin))).status).toBe(400);

    await request(app).patch(`/api/usuarios/${r.body.id}`).set(auth(tokenAdmin)).send({ clienteId: TEXTILES }).expect(400);
    await request(app).patch(`/api/usuarios/${r.body.id}`).set(auth(tokenAdmin)).send({}).expect(400);
    expect((await request(app).patch(`/api/usuarios/${r.body.id}`).set(auth(tokenAdmin)).send({ rol: "CLIENTE" })).status).toBe(422);
    expect((await request(app).patch("/api/usuarios/00000000-0000-4000-8000-000000000001").set(auth(tokenAdmin)).send({ activo: false })).status).toBe(422);
    expect((await request(app).patch(`/api/usuarios/${ID_INEXISTENTE}`).set(auth(tokenAdmin)).send({ activo: false })).status).toBe(404);
    const cambiado = await request(app).patch(`/api/usuarios/${r.body.id}`).set(auth(tokenAdmin)).send({ password: "Nueva2026x", nombre: "Carlos P." }).expect(200);
    expect(cambiado.body.nombre).toBe("Carlos P.");
    await login("carlos@pcargo.ec", "Nueva2026x");
    expect((await request(app).get("/api/usuarios/repartidores").set(auth(tokenOperador)).expect(200)).body).toEqual([
      { id: r.body.id, nombre: "Carlos P." },
      { id: "00000000-0000-4000-8000-000000000003", nombre: "Repartidor Ibarra" },
    ]);
  });

  it("desactivar: el login falla como credenciales inválidas y el token deja de valer (401 NO_AUTENTICADO)", async () => {
    await request(app).get("/api/envios").set(auth(tokenOperador)).expect(200);
    await request(app).patch("/api/usuarios/00000000-0000-4000-8000-000000000002").set(auth(tokenAdmin)).send({ activo: false }).expect(200);
    const r = await request(app).get("/api/envios").set(auth(tokenOperador)).expect(401);
    expect(r.body.error.code).toBe("NO_AUTENTICADO");
    const l = await request(app).post("/api/auth/login").send({ email: "operador@pcargo.ec", password: "Operador123!" }).expect(401);
    expect(l.body.error.code).toBe("CREDENCIALES_INVALIDAS");
  });

  it("accesos al portal desde Clientes: contraseña temporal sin caché; baja al eliminar el cliente", async () => {
    const r = await request(app)
      .post(`/api/clientes/${TEXTILES}/accesos`)
      .set(auth(tokenAdmin))
      .send({ nombre: "Compras Textiles", email: "compras@textiles.ec" })
      .expect(201);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.body.passwordTemporal).toMatch(/^[A-Za-z0-9]{12}$/);
    expect(r.body.usuario).toMatchObject({ rol: "CLIENTE", clienteId: TEXTILES, cliente: "Textiles Atuntaqui" });
    const token = await login("compras@textiles.ec", r.body.passwordTemporal);
    await request(app).get("/api/portal/resumen").set(auth(token)).expect(200);
    const accesos = await request(app).get(`/api/clientes/${TEXTILES}/accesos`).set(auth(tokenAdmin)).expect(200);
    expect(accesos.body.map((u: { email: string }) => u.email)).toEqual(["compras@textiles.ec", "portal@pcargo.ec"]);
    const clientes = await request(app).get("/api/clientes?q=textiles").set(auth(tokenOperador)).expect(200);
    expect(clientes.body[0].accesosPortal).toBe(2);
    expect((await request(app).post(`/api/clientes/${ID_INEXISTENTE}/accesos`).set(auth(tokenAdmin)).send({ nombre: "X Y", email: "x@y.ec" })).status).toBe(404);

    await request(app).delete(`/api/clientes/${TEXTILES}`).set(auth(tokenOperador)).expect(204);
    await request(app).get("/api/portal/resumen").set(auth(token)).expect(401);
    const usuarios = await request(app).get("/api/usuarios?rol=CLIENTE").set(auth(tokenAdmin)).expect(200);
    expect(usuarios.body.map((u: { activo: boolean; clienteId: string | null }) => [u.activo, u.clienteId])).toEqual([
      [false, null],
      [false, null],
    ]);
  });
});

describe("Asignación y app del repartidor (v12)", () => {
  it("asigna desde el panel, filtra por repartidor y el repartidor entrega con evidencia y cobro", async () => {
    const e = await crearEnvio({ formaPago: "AL_COBRO", numeroGuia: 40425 });
    const otro = await crearEnvio();
    const repartidorId = "00000000-0000-4000-8000-000000000003";
    expect((await request(app).post("/api/envios/asignar").set(auth(tokenOperador)).send({ envioIds: [e.id, e.id], repartidorId })).status).toBe(400);
    expect((await request(app).post("/api/envios/asignar").set(auth(tokenOperador)).send({ envioIds: [], repartidorId })).status).toBe(400);
    expect((await request(app).post("/api/envios/asignar").set(auth(tokenOperador)).send({ envioIds: [e.id], repartidorId: "00000000-0000-4000-8000-000000000002" })).status).toBe(422);
    expect((await request(app).post("/api/envios/asignar").set(auth(tokenOperador)).send({ envioIds: [ID_INEXISTENTE], repartidorId })).status).toBe(404);
    await request(app).post("/api/envios/asignar").set(auth(tokenOperador)).send({ envioIds: [e.id], repartidorId }).expect(200, { asignados: 1 });

    const asignados = await request(app).get(`/api/envios?repartidorId=${repartidorId}`).set(auth(tokenOperador)).expect(200);
    expect(asignados.body.datos.map((x: { id: string }) => x.id)).toEqual([e.id]);
    expect(asignados.body.datos[0]).toMatchObject({ repartidor: { id: repartidorId, nombre: "Repartidor Ibarra" }, anonimizadoEn: null });
    const sinAsignar = await request(app).get("/api/envios?repartidorId=ninguno").set(auth(tokenOperador)).expect(200);
    expect(sinAsignar.body.datos.map((x: { id: string }) => x.id)).toEqual([otro.id]);
    expect(sinAsignar.body.datos[0]).toMatchObject({ repartidor: null, asignadoEn: null });
    await request(app).get("/api/envios?repartidorId=juan").set(auth(tokenOperador)).expect(400);

    const lista = await request(app).get("/api/repartidor/envios").set(auth(tokenRepartidor)).expect(200);
    expect(lista.body).toHaveLength(1);
    expect(lista.body[0]).toMatchObject({ id: e.id, numeroGuia: 40425, porCobrar: 3, formaPago: "AL_COBRO", destinatario: { telefono: "0987654321" } });
    expect(lista.body[0]).not.toHaveProperty("historial");
    await request(app).get("/api/repartidor/envios?vista=semana").set(auth(tokenRepartidor)).expect(400);
    await request(app).get("/api/repartidor/envios/guia/0040425").set(auth(tokenRepartidor)).expect(200);
    await request(app).get(`/api/repartidor/envios/guia/${otro.numeroGuia}`).set(auth(tokenRepartidor)).expect(404);
    await request(app).get("/api/repartidor/envios/guia/abc").set(auth(tokenRepartidor)).expect(400);

    const marcar = (id: string, body: object) => request(app).patch(`/api/repartidor/envios/${id}/estado`).set(auth(tokenRepartidor)).send(body);
    expect((await marcar(e.id, { estado: "CANCELADO" })).status).toBe(400);
    expect((await marcar(otro.id, { estado: "EN_REPARTO" })).status).toBe(404);
    expect((await marcar(e.id, { estado: "EN_REPARTO" })).status).toBe(422);
    await estado(e.id, "EN_TRANSITO");
    await marcar(e.id, { estado: "EN_REPARTO" }).expect(200);
    expect((await marcar(e.id, { estado: "NOVEDAD" })).status).toBe(400);
    const entregado = await marcar(e.id, { estado: "ENTREGADO" }).expect(200);
    expect(entregado.body).toMatchObject({ estado: "ENTREGADO", porCobrar: 0, entrega: { resultado: "ENTREGADO", operador: "Repartidor Ibarra" } });

    const foto = await request(app)
      .post(`/api/repartidor/envios/${e.id}/evidencia`)
      .set(auth(tokenRepartidor))
      .field("recibidoPor", "Rosa Vera")
      .attach("foto", IMAGENES.png, { filename: "guia.png", contentType: "image/png" })
      .expect(200);
    expect(foto.body.evidencia).toMatchObject({ recibidoPor: "Rosa Vera" });
    expect(Object.keys(foto.body.evidencia).sort()).toEqual(["recibidoPor", "subidaEn"]);
    expect((await request(app).get(`/api/envios/${e.id}/evidencia`).set(auth(tokenOperador)).expect(200)).headers["content-type"]).toBe("image/png");

    expect((await request(app).get("/api/repartidor/envios?vista=hoy").set(auth(tokenRepartidor)).expect(200)).body.map((x: { id: string }) => x.id)).toEqual([e.id]);
    const caja = await request(app).get("/api/repartidor/caja").set(auth(tokenRepartidor)).expect(200);
    expect(caja.body).toMatchObject({
      usuario: { id: repartidorId, nombre: "Repartidor Ibarra", rol: "REPARTIDOR" },
      total: 3,
      cantidad: 1,
      cobros: [{ tipo: "CONTRA_ENTREGA", monto: 3, envioId: e.id, numeroGuia: 40425, formaPago: "AL_COBRO", cierreId: null }],
    });
    // un envío entregado ya no se asigna
    expect((await request(app).post("/api/envios/asignar").set(auth(tokenOperador)).send({ envioIds: [e.id, otro.id], repartidorId: null })).body.error.code).toBe("ESTADO_INVALIDO");
  });
});

describe("Caja (v12)", () => {
  it("pendientes, cierre con diferencia, SIN_COBROS, listado con fechas y detalle", async () => {
    await crearEnvio();
    await crearEnvio({ items: [{ tipoCarga: "PLUMON_GRANDE", cantidad: 1, pesoKg: 2 }] });
    const pendientes = await request(app).get("/api/caja/pendientes").set(auth(tokenOperador)).expect(200);
    expect(pendientes.body).toEqual([
      {
        usuario: { id: "00000000-0000-4000-8000-000000000002", nombre: "Operador Ibarra", rol: "OPERADOR" },
        total: 7,
        cantidad: 2,
        porTipo: [
          { tipo: "ORIGEN", cantidad: 2, monto: 7 },
          { tipo: "CONTRA_ENTREGA", cantidad: 0, monto: 0 },
          { tipo: "DEVOLUCION", cantidad: 0, monto: 0 },
        ],
        desde: expect.any(String),
      },
    ]);
    const detalle = await request(app).get("/api/caja/pendientes/00000000-0000-4000-8000-000000000002").set(auth(tokenOperador)).expect(200);
    expect(detalle.body.cobros).toHaveLength(2);
    expect((await request(app).get("/api/caja/pendientes/00000000-0000-4000-8000-000000000003").set(auth(tokenOperador)).expect(200)).body).toMatchObject({ total: 0, cobros: [] });
    await request(app).get(`/api/caja/pendientes/${ID_INEXISTENTE}`).set(auth(tokenOperador)).expect(404);

    const cerrar = (body: object, token = tokenAdmin) => request(app).post("/api/caja/cierres").set(auth(token)).send(body);
    const usuarioId = "00000000-0000-4000-8000-000000000002";
    expect((await cerrar({ usuarioId, montoEntregado: 6.5 })).status).toBe(422);
    expect((await cerrar({ usuarioId, montoEntregado: 6.555, nota: "x" })).status).toBe(400);
    expect((await cerrar({ usuarioId, montoEntregado: -1, nota: "x" })).status).toBe(400);
    const cierre = await cerrar({ usuarioId, montoEntregado: 6.5, nota: "Faltan 50 centavos" }).expect(201);
    expect(cierre.body).toMatchObject({ esperado: 7, entregado: 6.5, diferencia: -0.5, cantidad: 2, recibidoPor: { nombre: "Administrador PCargo" } });
    expect(cierre.body).not.toHaveProperty("cobros");
    const sin = await cerrar({ usuarioId, montoEntregado: 0 }).expect(422);
    expect(sin.body.error.code).toBe("SIN_COBROS");
    expect((await cerrar({ usuarioId: ID_INEXISTENTE, montoEntregado: 0 })).status).toBe(404);

    const hoy = new Date(Date.now() - 5 * 3600_000).toISOString().slice(0, 10);
    const lista = await request(app).get(`/api/caja/cierres?usuarioId=${usuarioId}&desde=${hoy}&hasta=${hoy}`).set(auth(tokenOperador)).expect(200);
    expect(lista.body).toMatchObject({ total: 1, pagina: 1, porPagina: 20, totalPaginas: 1, datos: [{ id: cierre.body.id }] });
    expect((await request(app).get("/api/caja/cierres?desde=2020-01-01&hasta=2020-01-02").set(auth(tokenOperador)).expect(200)).body.total).toBe(0);
    await request(app).get("/api/caja/cierres?desde=ayer").set(auth(tokenOperador)).expect(400);
    await request(app).get("/api/caja/cierres?porPagina=500").set(auth(tokenOperador)).expect(400);
    const uno = await request(app).get(`/api/caja/cierres/${cierre.body.id}`).set(auth(tokenOperador)).expect(200);
    expect(uno.body.cobros.map((x: { cierreId: string }) => x.cierreId)).toEqual([cierre.body.id, cierre.body.id]);
    await request(app).get(`/api/caja/cierres/${ID_INEXISTENTE}`).set(auth(tokenOperador)).expect(404);
  });
});

describe("Datos personales (v12)", () => {
  it("política, depuración simulada, consulta del titular y solicitudes de eliminación", async () => {
    expect((await request(app).get("/api/datos-personales/politica").set(auth(tokenAdmin)).expect(200)).body).toEqual({
      mesesRetencion: 12,
      ultimaDepuracion: null,
      pendientes: { envios: 0, clientes: 0 },
    });
    await request(app).put("/api/datos-personales/politica").set(auth(tokenAdmin)).send({ mesesRetencion: 11 }).expect(400);
    await request(app).put("/api/datos-personales/politica").set(auth(tokenAdmin)).send({ mesesRetencion: 121 }).expect(400);
    expect((await request(app).put("/api/datos-personales/politica").set(auth(tokenAdmin)).send({ mesesRetencion: 24 }).expect(200)).body.mesesRetencion).toBe(24);
    const sim = await request(app).post("/api/datos-personales/depurar").set(auth(tokenAdmin)).send({ simular: true }).expect(200);
    expect(sim.body).toMatchObject({ simulado: true, envios: 0, clientes: 0, evidencias: 0, fechaCorte: expect.any(String) });
    await request(app).post("/api/datos-personales/depurar").set(auth(tokenAdmin)).send({ simular: "si" }).expect(400);
    const real = await request(app).post("/api/datos-personales/depurar").set(auth(tokenAdmin)).send({}).expect(200);
    expect(real.body.simulado).toBe(false);
    expect((await request(app).get("/api/datos-personales/politica").set(auth(tokenAdmin))).body.ultimaDepuracion).toMatchObject({ envios: 0 });

    const e = await crearEnvio();
    await estado(e.id, "EN_TRANSITO", "Sale en el bus");
    await estado(e.id, "EN_REPARTO");
    await estado(e.id, "ENTREGADO");
    await request(app).post(`/api/envios/${e.id}/evidencia`).set(auth(tokenOperador)).field("recibidoPor", "Juan").attach("foto", IMAGENES.jpeg, "g.jpg").expect(200);
    await crearEnvio({ destinatario: { nombre: "María", telefono: "0991234567", direccion: "Quito" }, remitente: { nombre: "Luis", telefono: "0981112222" } });

    const titular = await request(app).get("/api/datos-personales/titular?telefono=099-123-4567").set(auth(tokenAdmin)).expect(200);
    expect(titular.headers["cache-control"]).toBe("no-store");
    expect(titular.body).toEqual({ telefono: "099-123-4567", cliente: null, envios: { total: 2, terminados: 1, enCurso: 1, anonimizados: 0 } });
    await request(app).get("/api/datos-personales/titular").set(auth(tokenAdmin)).expect(400);
    await request(app).get("/api/datos-personales/titular?telefono=12").set(auth(tokenAdmin)).expect(400);

    await request(app).post("/api/datos-personales/solicitudes").set(auth(tokenAdmin)).send({ telefono: "0991234567", nombreTitular: "María", canal: "FAX" }).expect(400);
    const sol = await request(app)
      .post("/api/datos-personales/solicitudes")
      .set(auth(tokenAdmin))
      .send({ telefono: "0991234567", nombreTitular: "María Pérez", canal: "PRESENCIAL" })
      .expect(201);
    expect(sol.body).toMatchObject({
      tipo: "ELIMINACION",
      telefonoFinal: "…4567",
      canal: "PRESENCIAL",
      nota: null,
      atendidaPor: "Administrador PCargo",
      resultado: { envios: 1, clientes: 0, evidencias: 1, usuariosDesactivados: 0, enCurso: 1 },
    });
    const anon = await request(app).get(`/api/envios/${e.id}`).set(auth(tokenOperador)).expect(200);
    expect(anon.body).toMatchObject({ remitente: { nombre: "Anonimizado" }, evidencia: null, anonimizadoEn: expect.any(String) });
    expect(anon.body.historial.every((h: { nota: string | null }) => h.nota === null)).toBe(true);
    expect(almacen.claves().length).toBe(0);
    await request(app).get(`/api/envios/${e.id}/evidencia`).set(auth(tokenOperador)).expect(404);
    const pagina = await request(app).get("/api/datos-personales/solicitudes?porPagina=1").set(auth(tokenAdmin)).expect(200);
    expect(pagina.body).toMatchObject({ total: 1, porPagina: 1, totalPaginas: 1, datos: [{ id: sol.body.id }] });
  });
});

describe("Portal de clientes (v12)", () => {
  const nuevo = (sobre: Record<string, unknown> = {}) => ({
    destinatario: { nombre: "Ana Torres", telefono: "0987654321", direccion: "Av. Amazonas, Quito" },
    rutaId: 11,
    items: [{ tipoCarga: "PAQUETE", cantidad: 2, pesoKg: 3 }],
    ...sobre,
  });

  it("catálogo, cotización, registro, lista, detalle y resumen; solo lo de su cliente", async () => {
    const catalogo = await request(app).get("/api/portal/catalogo").set(auth(tokenPortal)).expect(200);
    expect(Object.keys(catalogo.body).sort()).toEqual(["ciudades", "rutas", "tiposCarga"]);
    expect((await request(app).post("/api/portal/cotizar").set(auth(tokenPortal)).send(nuevo()).expect(200)).body.costo).toBe(6);

    for (const malo of [nuevo({ remitente: { nombre: "X", telefono: "0990000000" } }), nuevo({ formaPago: "PAGADO" }), nuevo({ numeroGuia: 5 }), nuevo({ clienteId: TEXTILES })]) {
      expect((await request(app).post("/api/portal/envios").set(auth(tokenPortal)).send(malo)).status).toBe(400);
    }
    const creado = await request(app).post("/api/portal/envios").set(auth(tokenPortal)).send(nuevo({ formaPago: "AL_COBRO" })).expect(201);
    expect(creado.body).toMatchObject({ formaPago: "AL_COBRO", costo: 6, estado: "REGISTRADO", referenciaExterna: null });
    expect(creado.body).not.toHaveProperty("remitente");
    expect(creado.body.historial).toEqual([
      { estado: "REGISTRADO", nota: "Registrado desde el portal de clientes", fecha: expect.any(String), usuario: null },
    ]);
    const enPanel = await request(app).get(`/api/envios/${creado.body.id}`).set(auth(tokenOperador)).expect(200);
    expect(enPanel.body).toMatchObject({ clienteId: TEXTILES, remitente: { nombre: "Textiles Atuntaqui" }, origen: { canal: "PANEL" } });

    const ajeno = await crearEnvio();
    const lista = await request(app).get("/api/portal/envios").set(auth(tokenPortal)).expect(200);
    expect(lista.body).toMatchObject({ total: 1, datos: [{ id: creado.body.id }] });
    await request(app).get(`/api/portal/envios/${ajeno.id}`).set(auth(tokenPortal)).expect(404);
    await request(app).get(`/api/portal/envios?estado=PERDIDO`).set(auth(tokenPortal)).expect(400);
    const detalle = await request(app).get(`/api/portal/envios/${creado.body.id}`).set(auth(tokenPortal)).expect(200);
    expect(detalle.body.historial).toHaveLength(1);

    const resumen = await request(app).get("/api/portal/resumen").set(auth(tokenPortal)).expect(200);
    expect(resumen.body).toMatchObject({ cliente: { id: TEXTILES, nombre: "Textiles Atuntaqui" }, envios: 1, monto: 6, enCurso: 1, porCobrar: 6 });
    expect(resumen.body.desde).toMatch(/^\d{4}-\d{2}-01$/);
    await request(app).get("/api/portal/resumen?desde=2026-13-01").set(auth(tokenPortal)).expect(400);
  });

  it("un CLIENTE sin cliente vinculado recibe 403", async () => {
    await adaptadores.usuarios.crear({
      id: "00000000-0000-4000-8000-0000000000aa",
      nombre: "Huérfano",
      email: "huerfano@pcargo.ec",
      rol: "CLIENTE",
      clienteId: null,
      activo: true,
      creadoEn: new Date(),
      passwordHash: await adaptadores.hasher.hash("Huerfano123"),
    });
    const token = await login("huerfano@pcargo.ec", "Huerfano123");
    const r = await request(app).get("/api/portal/envios").set(auth(token)).expect(403);
    expect(r.body.error.code).toBe("PROHIBIDO");
  });
});
