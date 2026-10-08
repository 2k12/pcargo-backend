import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { adaptadoresEnMemoria, crearCasosDeUso, type Adaptadores } from "../../../src/infrastructure/container.js";
import { crearApp } from "../../../src/infrastructure/http/app.js";
import { item, JWT_SECRET_TEST, solicitudEnvio } from "../../helpers/fakes.js";

// Pila HTTP completa (express + casos de uso + bcrypt/JWT reales) sobre adaptadores en memoria.

let app: Express;
let adaptadores: Adaptadores;
let tokenAdmin: string;
let tokenOperador: string;

const login = async (email: string, password: string) =>
  (await request(app).post("/api/auth/login").send({ email, password })).body.token as string;

beforeAll(async () => {
  adaptadores = await adaptadoresEnMemoria({ jwtSecret: JWT_SECRET_TEST, rondasBcrypt: 4 });
  app = crearApp(crearCasosDeUso(adaptadores));
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

describe("Número de guía", () => {
  it("se registra desde la guía física, rechaza duplicados con o sin ceros y busca ignorando ceros", async () => {
    const r = await request(app).post("/api/envios").set(auth(tokenOperador)).send(solicitudEnvio({ numeroGuia: "0050001" })).expect(201);
    expect(r.body.numeroGuia).toBe(50001);
    const dup = await request(app).post("/api/envios").set(auth(tokenOperador)).send(solicitudEnvio({ numeroGuia: 50001 })).expect(409);
    expect(dup.body.error.message).toMatch(/50001/);
    await request(app).post("/api/envios").set(auth(tokenOperador)).send(solicitudEnvio({ numeroGuia: "50-001" })).expect(400);

    const lista = await request(app).get("/api/envios?q=0000050001").set(auth(tokenOperador)).expect(200);
    expect(lista.body.datos.map((e: { numeroGuia: number }) => e.numeroGuia)).toEqual([50001]);
    await request(app).get("/api/seguimiento/050001").expect(200);

    const auto = await request(app).post("/api/envios").set(auth(tokenOperador)).send(solicitudEnvio()).expect(201);
    expect(auto.body.numeroGuia).toBe(50002);
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
    const { id, numeroGuia } = creado.body;
    expect(numeroGuia).toBeGreaterThan(0);

    for (const estado of ["EN_TRANSITO", "EN_REPARTO", "ENTREGADO"]) {
      await request(app).patch(`/api/envios/${id}/estado`).set(auth(tokenOperador)).send({ estado }).expect(200);
    }

    const detalle = await request(app).get(`/api/envios/${id}`).set(auth(tokenOperador)).expect(200);
    expect(detalle.body.historial.map((h: { estado: string }) => h.estado)).toEqual([
      "REGISTRADO", "EN_TRANSITO", "EN_REPARTO", "ENTREGADO",
    ]);

    // con ceros a la izquierda es la misma guía
    const seg = await request(app).get(`/api/seguimiento/00${numeroGuia}`).expect(200);
    expect(seg.body).toMatchObject({ numeroGuia, estado: "ENTREGADO", origen: "Ibarra", destino: "Quito" });
    expect(seg.body).not.toHaveProperty("destinatario");

    const lista = await request(app).get("/api/envios?estado=ENTREGADO").set(auth(tokenOperador)).expect(200);
    expect(lista.body.datos.map((e: { id: string }) => e.id)).toContain(id);

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
    expect(seguros.body.datos.map((e: { id: string }) => e.id)).toEqual([body.id]);
    await request(app).get("/api/envios?formaPago=TARJETA").set(auth(tokenOperador)).expect(400);

    const pagina = await request(app).get("/api/envios?pagina=1&porPagina=1").set(auth(tokenOperador)).expect(200);
    expect(pagina.body).toMatchObject({ pagina: 1, porPagina: 1 });
    expect(pagina.body.datos).toHaveLength(1);
    expect(pagina.body.totalPaginas).toBe(pagina.body.total);
    await request(app).get("/api/envios?porPagina=101").set(auth(tokenOperador)).expect(400);
    await request(app).get("/api/envios?pagina=0").set(auth(tokenOperador)).expect(400);
    await request(app).post("/api/envios").set(auth(tokenOperador)).send(solicitudEnvio({ formaPago: undefined })).expect(400);
  });

  it("validaciones de forma → 400; recursos inexistentes → 404", async () => {
    await request(app).post("/api/envios").set(auth(tokenOperador)).send({ rutaId: 11 }).expect(400);
    await request(app).get("/api/envios/no-uuid").set(auth(tokenOperador)).expect(400);
    await request(app).get("/api/envios/00000000-0000-4000-8000-00000000ffff").set(auth(tokenOperador)).expect(404);
    await request(app).get("/api/seguimiento/987654321").expect(404);
    await request(app).get("/api/seguimiento/PC-NOEXISTE").expect(400);
  });

  it("CRUD de clientes, envío con cliente y resumen filtrado por cliente", async () => {
    await request(app).get("/api/clientes").expect(401);
    const creado = await request(app)
      .post("/api/clientes")
      .set(auth(tokenOperador))
      .send({ nombre: "Comercial Otavalo", telefono: "062 920 333", direccion: "Sucre y Calderón", consentimiento: true })
      .expect(201);
    expect(creado.body).toMatchObject({ nombre: "Comercial Otavalo", envios: 0, monto: 0, ultimoEnvio: null });
    const id = creado.body.id as string;
    const dup = await request(app)
      .post("/api/clientes")
      .set(auth(tokenOperador))
      .send({ nombre: "Otro", telefono: "062920333", consentimiento: true })
      .expect(409);
    expect(dup.body.error.code).toBe("CONFLICTO");
    await request(app).post("/api/clientes").set(auth(tokenOperador)).send({ nombre: "Sin tel" }).expect(400);

    const envio = await request(app)
      .post("/api/envios")
      .set(auth(tokenOperador))
      .send(solicitudEnvio({ clienteId: id }))
      .expect(201);
    expect(envio.body.clienteId).toBe(id);

    const lista = await request(app).get("/api/clientes?q=otavalo").set(auth(tokenOperador)).expect(200);
    expect(lista.body).toHaveLength(1);
    expect(lista.body[0]).toMatchObject({ envios: 1, monto: envio.body.costo });

    const porCliente = await request(app).get(`/api/envios?clienteId=${id}`).set(auth(tokenOperador)).expect(200);
    expect(porCliente.body.datos.map((e: { id: string }) => e.id)).toEqual([envio.body.id]);

    const resumen = await request(app).get(`/api/dashboard/resumen?clienteId=${id}`).set(auth(tokenOperador)).expect(200);
    expect(resumen.body).toMatchObject({ totalEnvios: 1, ingresos: envio.body.costo });
    expect(resumen.body.porCliente[0]).toMatchObject({ clienteId: id, nombre: "Comercial Otavalo" });
    await request(app).get("/api/dashboard/resumen?clienteId=no-uuid").set(auth(tokenOperador)).expect(400);
    await request(app).get("/api/dashboard/resumen?desde=ayer").set(auth(tokenOperador)).expect(400);

    const editado = await request(app)
      .patch(`/api/clientes/${id}`)
      .set(auth(tokenOperador))
      .send({ notas: "Mayorista" })
      .expect(200);
    expect(editado.body).toMatchObject({ notas: "Mayorista", envios: 1 });
    await request(app).patch(`/api/clientes/${id}`).set(auth(tokenOperador)).send({}).expect(400);

    await request(app).delete(`/api/clientes/${id}`).set(auth(tokenOperador)).expect(204);
    await request(app).delete(`/api/clientes/${id}`).set(auth(tokenOperador)).expect(404);
    await request(app).get(`/api/envios/${envio.body.id}`).set(auth(tokenOperador)).expect(200);
  });
});

describe("Consentimiento de datos personales (LOPDP)", () => {
  const MENSAJE = "Se necesita el consentimiento del cliente para guardar sus datos";
  const ESTEBAN = { nombre: "Esteban Ruiz", telefono: "0985550101" };

  it("POST /clientes sin consentimiento true → 422 VALIDACION; con él fija consentimientoEn", async () => {
    for (const extra of [{}, { consentimiento: false }, { consentimiento: "true" }, { consentimiento: null }]) {
      const r = await request(app).post("/api/clientes").set(auth(tokenOperador)).send({ ...ESTEBAN, ...extra }).expect(422);
      expect(r.body.error).toEqual({ code: "VALIDACION", message: MENSAJE });
    }
    const antes = Date.now();
    const r = await request(app)
      .post("/api/clientes")
      .set(auth(tokenOperador))
      .send({ ...ESTEBAN, consentimiento: true })
      .expect(201);
    expect(r.body.consentimientoEn).toEqual(r.body.creadoEn);
    expect(new Date(r.body.consentimientoEn).getTime()).toBeGreaterThanOrEqual(antes - 1000);
    expect(r.body).not.toHaveProperty("consentimiento");

    const lista = await request(app).get("/api/clientes?q=esteban").set(auth(tokenOperador)).expect(200);
    expect(lista.body[0].consentimientoEn).toBe(r.body.consentimientoEn);
    await request(app).delete(`/api/clientes/${r.body.id}`).set(auth(tokenOperador)).expect(204);
  });

  it("PATCH /clientes/:id registra el consentimiento de un cliente antiguo y conserva la fecha original", async () => {
    const id = "00000000-0000-4000-8000-0000000000a1";
    const original = new Date("2026-09-01T10:00:00Z");
    await adaptadores.clientes.crear({
      id, nombre: "Rosa Cevallos", telefono: "0985550202", direccion: null, notas: null,
      creadoEn: original, consentimientoEn: null,
    });
    const viejo = await request(app).get("/api/clientes?q=rosa").set(auth(tokenOperador)).expect(200);
    expect(viejo.body[0].consentimientoEn).toBeNull();

    // valores distintos de true → 422 sin tocar el cliente
    for (const consentimiento of [false, null, "si"]) {
      const r = await request(app)
        .patch(`/api/clientes/${id}`)
        .set(auth(tokenOperador))
        .send({ notas: "x", consentimiento })
        .expect(422);
      expect(r.body.error.code).toBe("VALIDACION");
    }

    // solo `consentimiento: true` cuenta como "al menos un campo"
    const registrado = await request(app)
      .patch(`/api/clientes/${id}`)
      .set(auth(tokenOperador))
      .send({ consentimiento: true })
      .expect(200);
    expect(registrado.body).toMatchObject({ nombre: "Rosa Cevallos", notas: null });
    const fecha = registrado.body.consentimientoEn as string;
    expect(fecha).not.toBeNull();

    const otraVez = await request(app)
      .patch(`/api/clientes/${id}`)
      .set(auth(tokenOperador))
      .send({ notas: "Llamar antes", consentimiento: true })
      .expect(200);
    expect(otraVez.body).toMatchObject({ notas: "Llamar antes", consentimientoEn: fecha });
    await request(app).delete(`/api/clientes/${id}`).set(auth(tokenOperador)).expect(204);
  });

  it("POST /envios con guardarCliente exige consentimientoCliente: true → 422; sin guardarCliente se ignora", async () => {
    const remitente = { nombre: "Gloria Paredes", telefono: "0985550303" };
    for (const extra of [{}, { consentimientoCliente: false }]) {
      const r = await request(app)
        .post("/api/envios")
        .set(auth(tokenOperador))
        .send(solicitudEnvio({ remitente, guardarCliente: true, ...extra }))
        .expect(422);
      expect(r.body.error).toEqual({ code: "VALIDACION", message: MENSAJE });
    }
    const sinGuardar = await request(app)
      .post("/api/envios")
      .set(auth(tokenOperador))
      .send(solicitudEnvio({ remitente, consentimientoCliente: "cualquiera" }))
      .expect(201);
    expect(sinGuardar.body.clienteId).toBeNull();
    expect((await request(app).get("/api/clientes?q=gloria").set(auth(tokenOperador))).body).toEqual([]);

    const guardado = await request(app)
      .post("/api/envios")
      .set(auth(tokenOperador))
      .send(solicitudEnvio({ remitente, guardarCliente: true, consentimientoCliente: true }))
      .expect(201);
    const lista = await request(app).get("/api/clientes?q=gloria").set(auth(tokenOperador)).expect(200);
    expect(lista.body).toHaveLength(1);
    expect(lista.body[0]).toMatchObject({ id: guardado.body.clienteId });
    expect(lista.body[0].consentimientoEn).not.toBeNull();
    await request(app).delete(`/api/clientes/${guardado.body.clienteId}`).set(auth(tokenOperador)).expect(204);
  });

  it("POST /envios con guardarCliente reutiliza un cliente sin consentimiento y lo registra", async () => {
    const id = "00000000-0000-4000-8000-0000000000a2";
    await adaptadores.clientes.crear({
      id, nombre: "Hugo Benítez", telefono: "098 555 0404", direccion: null, notas: null,
      creadoEn: new Date("2026-09-01T10:00:00Z"), consentimientoEn: null,
    });
    const remitente = { nombre: "Hugo Benítez", telefono: "0985550404" };
    const e = await request(app)
      .post("/api/envios")
      .set(auth(tokenOperador))
      .send(solicitudEnvio({ remitente, guardarCliente: true, consentimientoCliente: true }))
      .expect(201);
    expect(e.body.clienteId).toBe(id);
    const [cliente] = (await request(app).get("/api/clientes?q=hugo").set(auth(tokenOperador)).expect(200)).body;
    expect(cliente.consentimientoEn).not.toBeNull();

    // un segundo envío no cambia la fecha registrada
    await request(app)
      .post("/api/envios")
      .set(auth(tokenOperador))
      .send(solicitudEnvio({ remitente, guardarCliente: true, consentimientoCliente: true }))
      .expect(201);
    const [despues] = (await request(app).get("/api/clientes?q=hugo").set(auth(tokenOperador))).body;
    expect(despues).toMatchObject({ consentimientoEn: cliente.consentimientoEn, envios: 2 });
    await request(app).delete(`/api/clientes/${id}`).set(auth(tokenOperador)).expect(204);
  });
});
