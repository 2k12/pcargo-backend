import { beforeEach, describe, expect, it } from "vitest";
import {
  adaptadoresEnMemoria,
  crearCasosDeUso,
  type Adaptadores,
  type CasosDeUso,
} from "../../../src/infrastructure/container.js";
import { CLIENTES_SEED } from "../../../src/infrastructure/persistence/seed-data.js";
import {
  ADMIN,
  FakeClock,
  hasherFalso,
  IMAGENES,
  JWT_SECRET_TEST,
  OPERADOR,
  PORTAL,
  REPARTIDOR,
  SecuenciaIds,
  solicitudEnvio,
} from "../../helpers/fakes.js";

// Contrato v12 (casos de uso sobre adaptadores en memoria): usuarios y accesos al portal, asignación de repartidor,
// app del repartidor y caja.

let c: CasosDeUso;
let a: Adaptadores;
let clock: FakeClock;

beforeEach(async () => {
  clock = new FakeClock();
  a = await adaptadoresEnMemoria({ jwtSecret: JWT_SECRET_TEST, hasher: hasherFalso, clock, ids: new SecuenciaIds() });
  c = crearCasosDeUso(a);
});

const TEXTILES = CLIENTES_SEED[0]!.id;
const crearEnvio = (sobre: Record<string, unknown> = {}, actor = OPERADOR) => c.crearEnvio.ejecutar(actor, solicitudEnvio(sobre));
const avanzar = async (id: string, estados: string[], actor = OPERADOR) => {
  for (const e of estados) await c.cambiarEstado.ejecutar(actor, id, e, e === "NOVEDAD" || e === "NO_ENTREGADO" ? "motivo" : null);
};

describe("Usuarios (ADMIN)", () => {
  it("crea, lista por nombre con filtros, edita y restablece la contraseña", async () => {
    const nuevo = await c.crearUsuario.ejecutar(ADMIN, {
      nombre: "Carlos Repartidor",
      email: "Carlos@PCargo.ec",
      password: "Reparto2026",
      rol: "REPARTIDOR",
    });
    expect(nuevo).toMatchObject({ email: "carlos@pcargo.ec", rol: "REPARTIDOR", activo: true, clienteId: null, cliente: null });
    expect(nuevo.creadoEn).toBe(clock.ahora().toISOString());
    const lista = await c.listarUsuarios.ejecutar(ADMIN);
    expect(lista.map((u) => u.nombre)).toEqual([
      "Administrador PCargo",
      "Carlos Repartidor",
      "Operador Ibarra",
      "Portal Textiles Atuntaqui",
      "Repartidor Ibarra",
    ]);
    expect(lista.find((u) => u.rol === "CLIENTE")).toMatchObject({ clienteId: TEXTILES, cliente: "Textiles Atuntaqui" });
    expect((await c.listarUsuarios.ejecutar(ADMIN, { rol: "REPARTIDOR" })).map((u) => u.nombre)).toEqual(["Carlos Repartidor", "Repartidor Ibarra"]);

    await c.actualizarUsuario.ejecutar(ADMIN, nuevo.id, { password: "Nueva2026x", nombre: "Carlos Pérez" });
    await expect(c.login.ejecutar("carlos@pcargo.ec", "Nueva2026x")).resolves.toMatchObject({ usuario: { nombre: "Carlos Pérez", rol: "REPARTIDOR", clienteId: null } });
    expect(await c.listarRepartidores.ejecutar()).toEqual([
      { id: nuevo.id, nombre: "Carlos Pérez" },
      { id: REPARTIDOR.id, nombre: "Repartidor Ibarra" },
    ]);
  });

  it("reglas: correo repetido, CLIENTE con cliente existente, sin cambiar de/hacia CLIENTE, el ADMIN no se desactiva", async () => {
    const datos = { nombre: "Otro", email: "operador@pcargo.ec", password: "Clave1234", rol: "OPERADOR" };
    await expect(c.crearUsuario.ejecutar(ADMIN, datos)).rejects.toMatchObject({ code: "CONFLICTO" });
    await expect(
      c.crearUsuario.ejecutar(ADMIN, { ...datos, email: "x@pcargo.ec", rol: "CLIENTE", clienteId: "00000000-0000-4000-8000-0000000000ff" }),
    ).rejects.toMatchObject({ code: "VALIDACION", regla: true });
    await expect(c.crearUsuario.ejecutar(ADMIN, { ...datos, email: "x@pcargo.ec", clienteId: TEXTILES })).rejects.toMatchObject({
      code: "VALIDACION",
      regla: false,
    });
    await expect(c.actualizarUsuario.ejecutar(ADMIN, PORTAL.id, { rol: "OPERADOR" })).rejects.toMatchObject({ regla: true });
    await expect(c.actualizarUsuario.ejecutar(ADMIN, ADMIN.id, { activo: false })).rejects.toMatchObject({ regla: true });
    await expect(c.actualizarUsuario.ejecutar(ADMIN, OPERADOR.id, { email: "admin@pcargo.ec" })).rejects.toMatchObject({ code: "CONFLICTO" });
    await expect(c.actualizarUsuario.ejecutar(ADMIN, "00000000-0000-4000-8000-0000000000ff", { activo: false })).rejects.toMatchObject({
      code: "NO_ENCONTRADO",
    });
    // solo ADMIN
    await expect(c.listarUsuarios.ejecutar(OPERADOR)).rejects.toMatchObject({ code: "PROHIBIDO" });
    await expect(c.crearUsuario.ejecutar(OPERADOR, { ...datos, email: "y@pcargo.ec" })).rejects.toMatchObject({ code: "PROHIBIDO" });
  });

  it("un usuario desactivado no inicia sesión y su token deja de valer en la siguiente solicitud", async () => {
    const { token } = await c.login.ejecutar("operador@pcargo.ec", "Operador123!");
    expect(await c.sesion.ejecutar(token)).toEqual({ ...OPERADOR, clienteId: null });
    await c.actualizarUsuario.ejecutar(ADMIN, OPERADOR.id, { activo: false });
    await expect(c.sesion.ejecutar(token)).rejects.toMatchObject({ code: "NO_AUTENTICADO" });
    await expect(c.login.ejecutar("operador@pcargo.ec", "Operador123!")).rejects.toMatchObject({ code: "CREDENCIALES_INVALIDAS" });
    // el rol vigente sale del repositorio, no del token
    await c.actualizarUsuario.ejecutar(ADMIN, OPERADOR.id, { activo: true, rol: "REPARTIDOR" });
    expect((await c.sesion.ejecutar(token)).rol).toBe("REPARTIDOR");
  });

  it("accesos al portal: contraseña temporal de 12 letras y números, accesosPortal y baja al eliminar el cliente", async () => {
    const acceso = await c.crearAccesoPortal.ejecutar(ADMIN, TEXTILES, { nombre: "Compras Textiles", email: "compras@textiles.ec" });
    expect(acceso.passwordTemporal).toMatch(/^[A-Za-z0-9]{12}$/);
    expect(acceso.passwordTemporal).toMatch(/[0-9]/);
    expect(acceso.usuario).toMatchObject({ rol: "CLIENTE", clienteId: TEXTILES, cliente: "Textiles Atuntaqui", activo: true });
    const sesion = await c.login.ejecutar("compras@textiles.ec", acceso.passwordTemporal);
    expect(sesion.usuario.clienteId).toBe(TEXTILES);
    expect((await c.listarAccesosCliente.ejecutar(ADMIN, TEXTILES)).map((u) => u.email)).toEqual(["compras@textiles.ec", "portal@pcargo.ec"]);
    expect((await c.listarClientes.ejecutar({ q: "textiles" }))[0]!.accesosPortal).toBe(2);
    await expect(c.crearAccesoPortal.ejecutar(ADMIN, "00000000-0000-4000-8000-0000000000ff", { nombre: "X Y", email: "z@x.ec" })).rejects.toMatchObject({
      code: "NO_ENCONTRADO",
    });

    await c.eliminarCliente.ejecutar(TEXTILES);
    const usuarios = await c.listarUsuarios.ejecutar(ADMIN, { rol: "CLIENTE" });
    expect(usuarios.map((u) => [u.activo, u.clienteId])).toEqual([
      [false, null],
      [false, null],
    ]);
    await expect(c.sesion.ejecutar(sesion.token)).rejects.toMatchObject({ code: "NO_AUTENTICADO" });
  });
});

describe("Asignación de repartidor", () => {
  it("asigna varios envíos de forma atómica y filtra por repartidor (o sin asignar)", async () => {
    const e1 = await crearEnvio();
    const e2 = await crearEnvio();
    const e3 = await crearEnvio();
    expect(await c.asignarRepartidor.ejecutar({ envioIds: [e1.id, e2.id], repartidorId: REPARTIDOR.id })).toEqual({ asignados: 2 });
    const leido = await c.obtenerEnvio.ejecutar(e1.id);
    expect(leido).toMatchObject({ repartidor: { id: REPARTIDOR.id, nombre: "Repartidor Ibarra" }, asignadoEn: clock.ahora().toISOString() });
    expect(leido.historial).toHaveLength(1);
    const ids = async (repartidorId: string | null) =>
      (await c.listarEnvios.ejecutar({ repartidorId })).datos.map((e) => e.numeroGuia).sort();
    expect(await ids(REPARTIDOR.id)).toEqual([e1.numeroGuia, e2.numeroGuia]);
    expect(await ids(null)).toEqual([e3.numeroGuia]);

    // uno entregado → no se asigna ninguno
    await avanzar(e3.id, ["EN_TRANSITO", "EN_REPARTO", "ENTREGADO"]);
    await expect(c.asignarRepartidor.ejecutar({ envioIds: [e1.id, e3.id], repartidorId: null })).rejects.toMatchObject({ code: "ESTADO_INVALIDO" });
    expect((await c.obtenerEnvio.ejecutar(e1.id)).repartidor).not.toBeNull();
    await expect(
      c.asignarRepartidor.ejecutar({ envioIds: [e1.id, "00000000-0000-4000-a000-0000000000ff"], repartidorId: null }),
    ).rejects.toMatchObject({ code: "NO_ENCONTRADO" });
    // quitar
    expect(await c.asignarRepartidor.ejecutar({ envioIds: [e1.id], repartidorId: null })).toEqual({ asignados: 1 });
    expect(await c.obtenerEnvio.ejecutar(e1.id)).toMatchObject({ repartidor: null, asignadoEn: null });
  });

  it("solo a un REPARTIDOR activo", async () => {
    const e = await crearEnvio();
    for (const repartidorId of [OPERADOR.id, "00000000-0000-4000-8000-0000000000ff"]) {
      await expect(c.asignarRepartidor.ejecutar({ envioIds: [e.id], repartidorId })).rejects.toMatchObject({ code: "VALIDACION", regla: true });
    }
    await c.actualizarUsuario.ejecutar(ADMIN, REPARTIDOR.id, { activo: false });
    await expect(c.asignarRepartidor.ejecutar({ envioIds: [e.id], repartidorId: REPARTIDOR.id })).rejects.toMatchObject({ regla: true });
  });
});

describe("App del repartidor", () => {
  it("pendientes por destino y guía; solo los suyos; búsqueda por guía con ceros", async () => {
    const quito = await crearEnvio({ numeroGuia: 30 });
    const atuntaqui = await crearEnvio({ numeroGuia: 31, rutaId: 5 });
    const quito2 = await crearEnvio({ numeroGuia: 29, formaPago: "AL_COBRO" });
    const ajeno = await crearEnvio({ numeroGuia: 32 });
    await c.asignarRepartidor.ejecutar({ envioIds: [quito.id, atuntaqui.id, quito2.id], repartidorId: REPARTIDOR.id });
    const lista = await c.listarEnviosRepartidor.ejecutar(REPARTIDOR);
    expect(lista.map((e) => [e.ruta.destino, e.numeroGuia])).toEqual([
      ["Atuntaqui", 31],
      ["Quito", 29],
      ["Quito", 30],
    ]);
    expect(lista[1]).toMatchObject({ formaPago: "AL_COBRO", porCobrar: 3, destinatario: { telefono: "0987654321" } });
    expect(lista[1]).not.toHaveProperty("historial");
    expect(lista[2]!.porCobrar).toBe(0);
    expect(await c.buscarGuiaRepartidor.ejecutar(REPARTIDOR, "00031")).toMatchObject({ id: atuntaqui.id });
    await expect(c.buscarGuiaRepartidor.ejecutar(REPARTIDOR, "32")).rejects.toMatchObject({ code: "NO_ENCONTRADO" });
    await expect(c.cambiarEstadoRepartidor.ejecutar(REPARTIDOR, ajeno.id, "EN_REPARTO")).rejects.toMatchObject({ code: "NO_ENCONTRADO" });
  });

  it("marca la entrega (mismas transiciones y notas), sube evidencia y ve lo de hoy", async () => {
    const e = await crearEnvio({ formaPago: "AL_COBRO" });
    const otro = await crearEnvio();
    await c.asignarRepartidor.ejecutar({ envioIds: [e.id, otro.id], repartidorId: REPARTIDOR.id });
    await expect(c.cambiarEstadoRepartidor.ejecutar(REPARTIDOR, e.id, "CANCELADO")).rejects.toMatchObject({ code: "VALIDACION" });
    await expect(c.cambiarEstadoRepartidor.ejecutar(REPARTIDOR, e.id, "EN_REPARTO")).rejects.toMatchObject({ code: "TRANSICION_INVALIDA" });
    await avanzar(e.id, ["EN_TRANSITO"]);
    await avanzar(otro.id, ["EN_TRANSITO"]);
    await c.cambiarEstadoRepartidor.ejecutar(REPARTIDOR, e.id, "EN_REPARTO");
    await c.cambiarEstadoRepartidor.ejecutar(REPARTIDOR, otro.id, "EN_REPARTO");
    await expect(c.cambiarEstadoRepartidor.ejecutar(REPARTIDOR, otro.id, "NO_ENTREGADO")).rejects.toMatchObject({ code: "VALIDACION" });
    clock.avanzar(60);
    await c.cambiarEstadoRepartidor.ejecutar(REPARTIDOR, otro.id, "NO_ENTREGADO", "Nadie en casa");
    const entregado = await c.cambiarEstadoRepartidor.ejecutar(REPARTIDOR, e.id, "ENTREGADO");
    expect(entregado).toMatchObject({ estado: "ENTREGADO", porCobrar: 0, entrega: { resultado: "ENTREGADO", operador: "Repartidor Ibarra" } });
    const conFoto = await c.subirEvidenciaRepartidor.ejecutar(REPARTIDOR, e.id, { foto: IMAGENES.jpeg, recibidoPor: "Rosa Vera" });
    expect(conFoto.evidencia).toEqual({ recibidoPor: "Rosa Vera", subidaEn: clock.ahora().toISOString() });

    expect((await c.listarEnviosRepartidor.ejecutar(REPARTIDOR, "hoy")).map((x) => x.id).sort()).toEqual([e.id, otro.id].sort());
    expect((await c.listarEnviosRepartidor.ejecutar(REPARTIDOR, "pendientes")).map((x) => x.id)).toEqual([otro.id]);
    clock.avanzar(24 * 60);
    expect(await c.listarEnviosRepartidor.ejecutar(REPARTIDOR, "hoy")).toEqual([]);
  });

  it("«hoy» usa la fecha de Ecuador (UTC−5)", async () => {
    clock = new FakeClock(new Date("2026-10-02T03:00:00Z")); // 1 de octubre, 22:00 en Ecuador
    a = await adaptadoresEnMemoria({ jwtSecret: JWT_SECRET_TEST, hasher: hasherFalso, clock, ids: new SecuenciaIds() });
    c = crearCasosDeUso(a);
    const e = await crearEnvio();
    await c.asignarRepartidor.ejecutar({ envioIds: [e.id], repartidorId: REPARTIDOR.id });
    await avanzar(e.id, ["EN_TRANSITO", "EN_REPARTO"]);
    await c.cambiarEstadoRepartidor.ejecutar(REPARTIDOR, e.id, "ENTREGADO");
    clock.avanzar(60); // 23:00 en Ecuador: sigue siendo hoy
    expect(await c.listarEnviosRepartidor.ejecutar(REPARTIDOR, "hoy")).toHaveLength(1);
    clock.avanzar(60); // 00:00 del 2 de octubre en Ecuador
    expect(await c.listarEnviosRepartidor.ejecutar(REPARTIDOR, "hoy")).toHaveLength(0);
  });
});

describe("Caja", () => {
  it("ORIGEN al registrar PAGADO desde el panel; CONTRATO, la API de empresas y el portal no generan cobro", async () => {
    await crearEnvio();
    await crearEnvio({ formaPago: "CONTRATO" });
    await c.crearEnvioPortal.ejecutar(PORTAL, {
      destinatario: { nombre: "Ana", telefono: "0987654321", direccion: "Quito" },
      rutaId: 11,
      items: [{ tipoCarga: "SOBRE", cantidad: 1, pesoKg: 0.2 }],
    });
    const integracion = await c.crearIntegracion.ejecutar(ADMIN, {
      nombre: "Tienda",
      remitente: { nombre: "Tienda", telefono: "062600100", direccion: "Centro" },
      ciudadOrigenId: 1,
      formaPagoPorDefecto: "PAGADO",
    });
    const { key } = await c.crearApiKey.ejecutar(ADMIN, integracion.id, { nombre: "Principal", modo: "live", alcances: ["envios:crear"] });
    const ctx = await c.autenticarApiKey.ejecutar(key);
    await c.crearEnvioApi.ejecutar(ctx, {
      referenciaExterna: "P-1",
      destinatario: { nombre: "Rosa", telefono: "0991234567", direccion: "Centro", ciudad: "Quito" },
      items: [{ tipoCarga: "PAQUETE", cantidad: 1, pesoKg: 1 }],
    });
    expect(await a.caja.pendientes()).toEqual([
      expect.objectContaining({ tipo: "ORIGEN", monto: 3, formaPago: "PAGADO", usuario: { id: OPERADOR.id, nombre: OPERADOR.nombre } }),
    ]);
  });

  it("pendientes por persona, cierre con diferencia y nota, y un cobro nunca en dos cierres", async () => {
    await crearEnvio();
    await crearEnvio({ items: [{ tipoCarga: "PLUMON_GRANDE", cantidad: 2, pesoKg: 3 }] });
    const alCobro = await crearEnvio({ formaPago: "AL_COBRO" });
    await c.asignarRepartidor.ejecutar({ envioIds: [alCobro.id], repartidorId: REPARTIDOR.id });
    await avanzar(alCobro.id, ["EN_TRANSITO", "EN_REPARTO"]);
    await c.cambiarEstadoRepartidor.ejecutar(REPARTIDOR, alCobro.id, "ENTREGADO");

    const pendientes = await c.listarCajasPendientes.ejecutar();
    expect(pendientes.map((p) => [p.usuario.nombre, p.usuario.rol, p.total, p.cantidad])).toEqual([
      ["Operador Ibarra", "OPERADOR", 11, 2],
      ["Repartidor Ibarra", "REPARTIDOR", 3, 1],
    ]);
    expect(pendientes[0]).not.toHaveProperty("cobros");
    const mia = await c.obtenerCajaPendiente.ejecutar(REPARTIDOR.id);
    expect(mia.cobros).toEqual([expect.objectContaining({ tipo: "CONTRA_ENTREGA", monto: 3, envioId: alCobro.id, cierreId: null })]);

    await expect(c.cerrarCaja.ejecutar(ADMIN, { usuarioId: OPERADOR.id, montoEntregado: 10 })).rejects.toMatchObject({ code: "VALIDACION", regla: true });
    const cierre = await c.cerrarCaja.ejecutar(ADMIN, { usuarioId: OPERADOR.id, montoEntregado: 10, nota: "Falta un dólar" });
    expect(cierre).toMatchObject({
      usuario: { id: OPERADOR.id, nombre: OPERADOR.nombre, rol: "OPERADOR" },
      recibidoPor: { id: ADMIN.id, nombre: ADMIN.nombre },
      esperado: 11,
      entregado: 10,
      diferencia: -1,
      cantidad: 2,
      nota: "Falta un dólar",
      porTipo: [
        { tipo: "ORIGEN", cantidad: 2, monto: 11 },
        { tipo: "CONTRA_ENTREGA", cantidad: 0, monto: 0 },
        { tipo: "DEVOLUCION", cantidad: 0, monto: 0 },
      ],
    });
    expect(cierre).not.toHaveProperty("cobros");
    await expect(c.cerrarCaja.ejecutar(ADMIN, { usuarioId: OPERADOR.id, montoEntregado: 0 })).rejects.toMatchObject({ code: "SIN_COBROS" });
    expect(await c.obtenerCajaPendiente.ejecutar(OPERADOR.id)).toMatchObject({ total: 0, cantidad: 0, desde: null, cobros: [] });
    const detalle = await c.obtenerCierreCaja.ejecutar(cierre.id);
    expect(detalle.cobros?.map((x) => x.cierreId)).toEqual([cierre.id, cierre.id]);
    // un operador puede cerrar su propia caja
    await crearEnvio();
    expect((await c.cerrarCaja.ejecutar(OPERADOR, { usuarioId: OPERADOR.id, montoEntregado: 3 })).diferencia).toBe(0);
    await expect(c.obtenerCajaPendiente.ejecutar("00000000-0000-4000-8000-0000000000ff")).rejects.toMatchObject({ code: "NO_ENCONTRADO" });
    await expect(c.obtenerCierreCaja.ejecutar("00000000-0000-4000-8000-0000000000ff")).rejects.toMatchObject({ code: "NO_ENCONTRADO" });
  });

  it("cancelar: con el ORIGEN pendiente se anula; si ya se cerró, DEVOLUCION negativa a nombre de quien cancela", async () => {
    const pendiente = await crearEnvio();
    await c.cambiarEstado.ejecutar(ADMIN, pendiente.id, "CANCELADO");
    expect(await a.caja.pendientes()).toEqual([]);

    const cerrado = await crearEnvio();
    await c.cerrarCaja.ejecutar(ADMIN, { usuarioId: OPERADOR.id, montoEntregado: 3 });
    await c.cambiarEstado.ejecutar(ADMIN, cerrado.id, "CANCELADO");
    const caja = await c.obtenerCajaPendiente.ejecutar(ADMIN.id);
    expect(caja).toMatchObject({ total: -3, cantidad: 1, porTipo: expect.arrayContaining([{ tipo: "DEVOLUCION", cantidad: 1, monto: -3 }]) });
    expect(caja.cobros![0]).toMatchObject({ tipo: "DEVOLUCION", monto: -3, envioId: cerrado.id, numeroGuia: cerrado.numeroGuia });
  });

  it("lista cierres recientes primero con filtros de persona y fechas de Ecuador", async () => {
    await crearEnvio();
    const primero = await c.cerrarCaja.ejecutar(ADMIN, { usuarioId: OPERADOR.id, montoEntregado: 3 });
    clock.avanzar(24 * 60);
    await crearEnvio({}, ADMIN);
    const segundo = await c.cerrarCaja.ejecutar(OPERADOR, { usuarioId: ADMIN.id, montoEntregado: 3 });
    const todos = await c.listarCierresCaja.ejecutar();
    expect(todos).toMatchObject({ total: 2, pagina: 1, porPagina: 20, totalPaginas: 1 });
    expect(todos.datos.map((x) => x.id)).toEqual([segundo.id, primero.id]);
    expect((await c.listarCierresCaja.ejecutar({ usuarioId: OPERADOR.id })).datos.map((x) => x.id)).toEqual([primero.id]);
    expect((await c.listarCierresCaja.ejecutar({ desde: "2026-10-02", hasta: "2026-10-02" })).datos.map((x) => x.id)).toEqual([segundo.id]);
    expect((await c.listarCierresCaja.ejecutar({ hasta: "2026-10-01" })).datos.map((x) => x.id)).toEqual([primero.id]);
    expect((await c.listarCierresCaja.ejecutar({}, { pagina: 2, porPagina: 1 })).datos.map((x) => x.id)).toEqual([primero.id]);
    await expect(c.listarCierresCaja.ejecutar({ desde: "ayer" })).rejects.toMatchObject({ code: "VALIDACION" });
    await expect(c.listarCierresCaja.ejecutar({ desde: "2026-10-03", hasta: "2026-10-01" })).rejects.toMatchObject({ code: "VALIDACION" });
  });

  it("la caja del repartidor son sus cobros pendientes con el detalle", async () => {
    const e = await crearEnvio({ formaPago: "AL_COBRO", items: [{ tipoCarga: "TELA", cantidad: 3, pesoKg: 10 }] });
    await c.asignarRepartidor.ejecutar({ envioIds: [e.id], repartidorId: REPARTIDOR.id });
    await avanzar(e.id, ["EN_TRANSITO", "EN_REPARTO"]);
    await c.cambiarEstadoRepartidor.ejecutar(REPARTIDOR, e.id, "ENTREGADO");
    expect(await c.obtenerCajaPendiente.ejecutar(REPARTIDOR.id)).toMatchObject({
      usuario: { id: REPARTIDOR.id, rol: "REPARTIDOR" },
      total: 3.75,
      cantidad: 1,
      cobros: [{ tipo: "CONTRA_ENTREGA", monto: 3.75 }],
    });
  });
});
