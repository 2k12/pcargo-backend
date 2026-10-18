import { beforeEach, describe, expect, it } from "vitest";
import {
  adaptadoresEnMemoria,
  crearCasosDeUso,
  type Adaptadores,
  type CasosDeUso,
} from "../../../src/infrastructure/container.js";
import { CLIENTES_SEED } from "../../../src/infrastructure/persistence/seed-data.js";
import { AlmacenMemoria } from "../../../src/infrastructure/storage/AlmacenMemoria.js";
import {
  ADMIN,
  FakeClock,
  hasherFalso,
  IMAGENES,
  JWT_SECRET_TEST,
  OPERADOR,
  PORTAL,
  SecuenciaIds,
  solicitudEnvio,
} from "../../helpers/fakes.js";

// Contrato v12 (casos de uso en memoria): retención y eliminación de datos personales, y portal de clientes empresa.

let c: CasosDeUso;
let a: Adaptadores;
let clock: FakeClock;
let almacen: AlmacenMemoria;

beforeEach(async () => {
  clock = new FakeClock(new Date("2026-10-15T15:00:00Z"));
  almacen = new AlmacenMemoria();
  a = await adaptadoresEnMemoria({ jwtSecret: JWT_SECRET_TEST, hasher: hasherFalso, clock, ids: new SecuenciaIds(), almacen });
  c = crearCasosDeUso(a);
});

const TEXTILES = CLIENTES_SEED[0]!.id;
const MES_MIN = 31 * 24 * 60;
const crearEnvio = (sobre: Record<string, unknown> = {}) => c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio(sobre));
const entregar = async (id: string, conFoto = false) => {
  await c.cambiarEstado.ejecutar(OPERADOR, id, "EN_TRANSITO", "Sale en el bus de las 10");
  await c.cambiarEstado.ejecutar(OPERADOR, id, "EN_REPARTO");
  await c.cambiarEstado.ejecutar(OPERADOR, id, "ENTREGADO", "Recibió la vecina");
  if (conFoto) await c.subirEvidencia.ejecutar(OPERADOR, id, { foto: IMAGENES.jpeg, recibidoPor: "Rosa Vera" });
};

describe("Política de retención", () => {
  it("12 meses por defecto, configurable entre 12 y 120, con lo pendiente de la próxima depuración", async () => {
    expect(await c.obtenerPoliticaDatos.ejecutar(ADMIN)).toEqual({
      mesesRetencion: 12,
      ultimaDepuracion: null,
      pendientes: { envios: 0, clientes: 0 },
    });
    const e = await crearEnvio();
    await entregar(e.id);
    clock.avanzar(13 * MES_MIN);
    expect((await c.obtenerPoliticaDatos.ejecutar(ADMIN)).pendientes.envios).toBe(1);
    expect(await c.actualizarPoliticaDatos.ejecutar(ADMIN, 24)).toMatchObject({ mesesRetencion: 24, pendientes: { envios: 0 } });
    await expect(c.actualizarPoliticaDatos.ejecutar(ADMIN, 11)).rejects.toMatchObject({ code: "VALIDACION" });
    await expect(c.actualizarPoliticaDatos.ejecutar(ADMIN, 121)).rejects.toMatchObject({ code: "VALIDACION" });
    await expect(c.obtenerPoliticaDatos.ejecutar(OPERADOR)).rejects.toMatchObject({ code: "PROHIBIDO" });
  });
});

describe("Depuración", () => {
  it("simula y luego anonimiza los envíos terminados fuera de plazo (con su foto y notas) y elimina clientes inactivos", async () => {
    const viejo = await crearEnvio({ guardarCliente: true, consentimientoCliente: true });
    await entregar(viejo.id, true);
    const cancelado = await crearEnvio({ remitente: { nombre: "Luis", telefono: "0981112222" } });
    await c.cambiarEstado.ejecutar(OPERADOR, cancelado.id, "CANCELADO", "Desistió");
    const enCursoViejo = await crearEnvio({ remitente: { nombre: "Pedro", telefono: "0983334444" }, guardarCliente: true, consentimientoCliente: true });
    const claveFoto = (await a.envios.buscarPorId(viejo.id))!.evidencia!.clave;
    expect(await almacen.obtener(claveFoto)).not.toBeNull();

    clock.avanzar(13 * MES_MIN);
    const reciente = await crearEnvio({ remitente: { nombre: "Eva", telefono: "0985556666" } });
    await entregar(reciente.id);

    const simulado = await c.depurarDatos.ejecutar(ADMIN, { simular: true });
    expect(simulado).toEqual({ simulado: true, envios: 2, clientes: 1, evidencias: 1, fechaCorte: "2026-11-22T15:00:00.000Z" });
    expect((await c.obtenerEnvio.ejecutar(viejo.id)).anonimizadoEn).toBeNull();

    const real = await c.depurarDatos.ejecutar(ADMIN);
    expect(real).toMatchObject({ simulado: false, envios: 2, clientes: 1, evidencias: 1 });
    const anon = await c.obtenerEnvio.ejecutar(viejo.id);
    expect(anon).toMatchObject({
      remitente: { nombre: "Anonimizado", telefono: "", direccion: null },
      destinatario: { nombre: "Anonimizado", telefono: "", direccion: "Anonimizado" },
      descripcion: null,
      evidencia: null,
      estado: "ENTREGADO",
      costo: 3,
      anonimizadoEn: clock.ahora().toISOString(),
    });
    expect(anon.historial!.every((h) => h.nota === null)).toBe(true);
    expect(await almacen.obtener(claveFoto)).toBeNull();
    // el seguimiento público tampoco muestra ya las notas
    expect((await c.seguimiento.ejecutar(String(viejo.numeroGuia))).historial.every((h) => h.nota === null)).toBe(true);
    // el cliente de «María» (solo envíos viejos terminados) se eliminó; el de Pedro (envío en curso) y Textiles
    // (usuario del portal activo) se conservan; los envíos en curso y recientes no se tocan
    expect((await c.listarClientes.ejecutar()).map((x) => x.nombre)).toEqual(["Pedro", "Textiles Atuntaqui"]);
    expect((await c.obtenerEnvio.ejecutar(enCursoViejo.id)).anonimizadoEn).toBeNull();
    expect((await c.obtenerEnvio.ejecutar(reciente.id)).remitente.nombre).toBe("Eva");

    expect(await c.obtenerPoliticaDatos.ejecutar(ADMIN)).toMatchObject({
      ultimaDepuracion: { fecha: clock.ahora().toISOString(), envios: 2, clientes: 1, evidencias: 1 },
      pendientes: { envios: 0, clientes: 0 },
    });
    // la ejecución diaria (sin actor) es idempotente
    expect(await c.depurarDatos.ejecutar(null)).toMatchObject({ envios: 0, clientes: 0 });
  });

  it("no elimina clientes con integraciones ni creados dentro del plazo", async () => {
    const cliente = await c.crearCliente.ejecutar({ nombre: "Tienda Andina", telefono: "062600100", consentimiento: true });
    await c.crearIntegracion.ejecutar(ADMIN, {
      nombre: "Tienda Andina",
      remitente: { nombre: "Tienda Andina", telefono: "062600100", direccion: "Centro" },
      ciudadOrigenId: 1,
      clienteId: cliente.id,
    });
    clock.avanzar(13 * MES_MIN);
    await c.crearCliente.ejecutar({ nombre: "Nuevo", telefono: "062600200", consentimiento: true });
    expect(await c.depurarDatos.ejecutar(ADMIN, { simular: true })).toMatchObject({ clientes: 0 });
  });
});

describe("Solicitudes del titular", () => {
  it("consulta por dígitos del teléfono (remitente, destinatario o cliente) y atiende la eliminación", async () => {
    const terminado = await crearEnvio({ guardarCliente: true, consentimientoCliente: true });
    await entregar(terminado.id, true);
    const comoDestinatario = await crearEnvio({
      remitente: { nombre: "Luis", telefono: "0981112222" },
      destinatario: { nombre: "María Pérez", telefono: "099 123 4567", direccion: "Quito" },
    });
    await c.cambiarEstado.ejecutar(OPERADOR, comoDestinatario.id, "CANCELADO");
    const enCurso = await crearEnvio();
    await crearEnvio({ remitente: { nombre: "Otro", telefono: "0980000000" } });
    const cliente = (await c.listarClientes.ejecutar({ q: "María" }))[0]!;
    await c.crearAccesoPortal.ejecutar(ADMIN, cliente.id, { nombre: "María Pérez", email: "maria@correo.ec" });

    expect(await c.consultarTitular.ejecutar(ADMIN, "099-123-4567")).toEqual({
      telefono: "099-123-4567",
      cliente: { id: cliente.id, nombre: "María Pérez", accesosPortal: 1 },
      envios: { total: 3, terminados: 2, enCurso: 1, anonimizados: 0 },
    });

    const solicitud = await c.atenderSolicitudDatos.ejecutar(ADMIN, {
      telefono: "0991234567",
      nombreTitular: "María Pérez",
      canal: "CORREO",
      nota: "Pidió por correo el 14/10",
    });
    expect(solicitud).toMatchObject({
      tipo: "ELIMINACION",
      nombreTitular: "María Pérez",
      telefonoFinal: "…4567",
      canal: "CORREO",
      atendidaPor: ADMIN.nombre,
      fecha: clock.ahora().toISOString(),
      resultado: { envios: 2, clientes: 1, evidencias: 1, usuariosDesactivados: 1, enCurso: 1 },
    });
    expect(JSON.stringify(solicitud)).not.toContain("0991234567");
    expect((await c.obtenerEnvio.ejecutar(comoDestinatario.id)).destinatario.nombre).toBe("Anonimizado");
    expect((await c.obtenerEnvio.ejecutar(enCurso.id)).remitente.nombre).toBe("María Pérez");
    expect(await c.listarClientes.ejecutar({ q: "María" })).toEqual([]);
    await expect(c.login.ejecutar("maria@correo.ec", "x")).rejects.toMatchObject({ code: "CREDENCIALES_INVALIDAS" });
    expect(await c.consultarTitular.ejecutar(ADMIN, "0991234567")).toMatchObject({ cliente: null, envios: { total: 1, enCurso: 1 } });

    const pagina = await c.listarSolicitudesDatos.ejecutar(ADMIN);
    expect(pagina).toMatchObject({ total: 1, datos: [{ id: solicitud.id }] });
    await expect(c.consultarTitular.ejecutar(ADMIN, "123")).rejects.toMatchObject({ code: "VALIDACION" });
    await expect(c.atenderSolicitudDatos.ejecutar(OPERADOR, { telefono: "0991234567", nombreTitular: "X Y", canal: "CORREO" })).rejects.toMatchObject({
      code: "PROHIBIDO",
    });
  });
});

describe("Portal de clientes empresa", () => {
  const destinatario = { nombre: "Ana Torres", telefono: "0987654321", direccion: "Av. Amazonas, Quito" };
  const nuevo = (sobre: Record<string, unknown> = {}) => ({
    destinatario,
    rutaId: 11,
    items: [{ tipoCarga: "PAQUETE", cantidad: 2, pesoKg: 3 }],
    ...sobre,
  });

  it("registra con el cliente como remitente, CONTRATO por defecto, guía consecutiva y sin cobro", async () => {
    await crearEnvio({ numeroGuia: 500 });
    const e = await c.crearEnvioPortal.ejecutar(PORTAL, nuevo());
    expect(e).toMatchObject({ numeroGuia: 501, formaPago: "CONTRATO", costo: 6, estado: "REGISTRADO", destinatario });
    expect(e).not.toHaveProperty("remitente");
    expect(e.historial).toEqual([{ estado: "REGISTRADO", nota: "Registrado desde el portal de clientes", fecha: clock.ahora().toISOString(), usuario: null }]);
    const panel = await c.obtenerEnvio.ejecutar(e.id);
    expect(panel).toMatchObject({
      clienteId: TEXTILES,
      remitente: { nombre: "Textiles Atuntaqui", telefono: "0991112233", direccion: CLIENTES_SEED[0]!.direccion },
      origen: { canal: "PANEL", integracionId: null },
      registro: { operador: "Portal Textiles Atuntaqui" },
    });
    expect((await c.crearEnvioPortal.ejecutar(PORTAL, nuevo({ formaPago: "AL_COBRO" }))).formaPago).toBe("AL_COBRO");
    await expect(c.crearEnvioPortal.ejecutar(PORTAL, nuevo({ formaPago: "PAGADO" }))).rejects.toMatchObject({ code: "VALIDACION" });
    expect(await a.caja.pendientes()).toHaveLength(1); // solo el ORIGEN del envío PAGADO del panel
  });

  it("aislado por cliente: lista y detalle solo de sus envíos (de cualquier canal)", async () => {
    const propio = await c.crearEnvioPortal.ejecutar(PORTAL, nuevo());
    // desde el panel, con el teléfono del cliente: se asocia a Textiles y el portal lo ve
    const delPanel = await crearEnvio({ remitente: { nombre: "Textiles", telefono: "099 111 2233" } });
    const ajeno = await crearEnvio();
    const pagina = await c.listarEnviosPortal.ejecutar(PORTAL);
    expect(pagina.total).toBe(2);
    expect(pagina.datos.map((x) => x.id).sort()).toEqual([propio.id, delPanel.id].sort());
    expect(pagina.datos[0]).not.toHaveProperty("historial");
    await expect(c.obtenerEnvioPortal.ejecutar(PORTAL, ajeno.id)).rejects.toMatchObject({ code: "NO_ENCONTRADO" });
    expect((await c.listarEnviosPortal.ejecutar(PORTAL, { q: String(delPanel.numeroGuia).padStart(8, "0") })).datos.map((x) => x.id)).toEqual([delPanel.id]);
    expect((await c.listarEnviosPortal.ejecutar(PORTAL, { estado: "ENTREGADO" })).total).toBe(0);
    const detalle = await c.obtenerEnvioPortal.ejecutar(PORTAL, delPanel.id);
    expect(detalle.historial!.every((h) => h.usuario === null)).toBe(true);
    // otro CLIENTE de otra empresa no ve nada de Textiles
    const otro = await c.crearCliente.ejecutar({ nombre: "Ferretería", telefono: "062000111", consentimiento: true });
    const ajenoPortal = { ...PORTAL, id: "u-otro", clienteId: otro.id };
    expect((await c.listarEnviosPortal.ejecutar(ajenoPortal)).total).toBe(0);
    await expect(c.obtenerEnvioPortal.ejecutar(ajenoPortal, propio.id)).rejects.toMatchObject({ code: "NO_ENCONTRADO" });
    // CLIENTE sin cliente vinculado (cliente eliminado) → 403
    await expect(c.listarEnviosPortal.ejecutar({ ...PORTAL, clienteId: null })).rejects.toMatchObject({ code: "PROHIBIDO" });
    await expect(c.crearEnvioPortal.ejecutar({ ...PORTAL, clienteId: null }, nuevo())).rejects.toMatchObject({ code: "PROHIBIDO" });
  });

  it("resumen del mes en curso (Ecuador) por defecto, o del periodo indicado", async () => {
    const e1 = await c.crearEnvioPortal.ejecutar(PORTAL, nuevo({ formaPago: "AL_COBRO" }));
    const e2 = await c.crearEnvioPortal.ejecutar(PORTAL, nuevo());
    await c.cambiarEstado.ejecutar(OPERADOR, e2.id, "CANCELADO");
    clock.avanzar(24 * 60);
    const e3 = await c.crearEnvioPortal.ejecutar(PORTAL, nuevo({ items: [{ tipoCarga: "SOBRE", cantidad: 1, pesoKg: 0.1 }] }));
    await entregar(e3.id);
    const r = await c.resumenPortal.ejecutar(PORTAL);
    expect(r).toMatchObject({
      cliente: { id: TEXTILES, nombre: "Textiles Atuntaqui", telefono: "0991112233" },
      desde: "2026-10-01",
      hasta: "2026-10-16",
      envios: 3,
      monto: 9,
      enCurso: 1,
      entregados: 1,
      porCobrar: 6,
    });
    expect(r.porEstado).toMatchObject({ REGISTRADO: 1, CANCELADO: 1, ENTREGADO: 1 });
    expect(r.porFormaPago).toEqual([
      { formaPago: "PAGADO", envios: 0, monto: 0 },
      { formaPago: "AL_COBRO", envios: 1, monto: 6 },
      { formaPago: "CONTRATO", envios: 2, monto: 3 },
      { formaPago: "SEGURO", envios: 0, monto: 0 },
    ]);
    expect(r.porDia).toHaveLength(16);
    expect(r.porDia.slice(-2)).toEqual([
      { fecha: "2026-10-15", envios: 2, monto: 6 },
      { fecha: "2026-10-16", envios: 1, monto: 3 },
    ]);
    expect(await c.resumenPortal.ejecutar(PORTAL, { desde: "2026-10-16", hasta: "2026-10-16" })).toMatchObject({ envios: 1, monto: 3 });
    expect(e1.formaPago).toBe("AL_COBRO");
    await expect(c.resumenPortal.ejecutar(PORTAL, { desde: "2026-10-20", hasta: "2026-10-01" })).rejects.toMatchObject({ code: "VALIDACION" });
  });
});
