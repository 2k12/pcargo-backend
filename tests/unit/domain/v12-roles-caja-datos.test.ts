import { describe, expect, it } from "vitest";
import {
  cobroAlRegistrar,
  crearCierre,
  movimientosPorEstado,
  resumirCobros,
  type Cobro,
} from "../../../src/domain/caja/Caja.js";
import { normalizarSolicitud, telefonoFinal } from "../../../src/domain/datos/DatosPersonales.js";
import { ANONIMIZADO, Envio, type NuevoEnvio } from "../../../src/domain/envio/Envio.js";
import { fechaLocalEC, inicioDiaEC, inicioMesEC } from "../../../src/domain/shared/FechaEcuador.js";
import {
  exigirRol,
  normalizarCambiosUsuario,
  normalizarNuevoUsuario,
  ROLES_PANEL,
} from "../../../src/domain/usuario/Usuario.js";
import { ADMIN, OPERADOR } from "../../helpers/fakes.js";

// Contrato v12: reglas de roles y usuarios, caja, asignación de repartidor y retención de datos personales.

const ahora = new Date("2026-10-18T15:00:00Z");
const despues = (min: number) => new Date(ahora.getTime() + min * 60_000);
const REPARTIDOR = { id: "00000000-0000-4000-8000-000000000003", nombre: "Repartidor Ibarra", rol: "REPARTIDOR" as const };

const datos = (sobre: Partial<NuevoEnvio> = {}): NuevoEnvio => ({
  remitente: { nombre: "María", telefono: "0991234567", direccion: "Bolívar 1-23" },
  destinatario: { nombre: "Juan", telefono: "0987654321", direccion: "Calle Sucre 4-56" },
  rutaId: 11,
  items: [{ tipoCarga: "PAQUETE", cantidad: 2, pesoKg: 2, costoUnitario: 3, subtotal: 6 }],
  formaPago: "PAGADO",
  descripcion: "Ropa",
  ...sobre,
});
const crear = (sobre: Partial<NuevoEnvio> = {}) =>
  Envio.crear(datos(sobre), { id: "e1", numeroGuia: 40425, ahora, actor: OPERADOR });

const entregado = (sobre: Partial<NuevoEnvio> = {}) => {
  const e = crear(sobre);
  e.cambiarEstado("EN_TRANSITO", { ahora: despues(1), actor: OPERADOR, nota: "Sale en el bus de las 10" });
  e.cambiarEstado("EN_REPARTO", { ahora: despues(2), actor: OPERADOR });
  e.cambiarEstado("ENTREGADO", { ahora: despues(3), actor: REPARTIDOR, nota: "Recibió la vecina" });
  return e;
};

let n = 0;
const nuevoId = () => `cobro-${++n}`;

describe("Roles y permisos", () => {
  it("exigirRol: solo los roles indicados; el panel es ADMIN u OPERADOR", () => {
    expect(() => exigirRol(ADMIN, ROLES_PANEL)).not.toThrow();
    expect(() => exigirRol(OPERADOR, ROLES_PANEL)).not.toThrow();
    for (const rol of ["REPARTIDOR", "CLIENTE"] as const) {
      expect(() => exigirRol({ rol }, ROLES_PANEL)).toThrow(expect.objectContaining({ code: "PROHIBIDO" }));
    }
    expect(() => exigirRol(OPERADOR, ["ADMIN"])).toThrow(expect.objectContaining({ code: "PROHIBIDO" }));
  });

  it("nuevo usuario: CLIENTE exige clienteId; los demás roles no lo admiten; política de contraseña", () => {
    const base = { nombre: " Rosa  Vera ", email: "Rosa@PCargo.ec", password: "Clave1234", rol: "OPERADOR" };
    expect(normalizarNuevoUsuario(base)).toEqual({
      nombre: "Rosa Vera",
      email: "rosa@pcargo.ec",
      password: "Clave1234",
      rol: "OPERADOR",
      clienteId: null,
    });
    expect(normalizarNuevoUsuario({ ...base, rol: "CLIENTE", clienteId: "c1" }).clienteId).toBe("c1");
    for (const malo of [
      { ...base, rol: "CLIENTE" },
      { ...base, rol: "CLIENTE", clienteId: null },
      { ...base, clienteId: "c1" },
      { ...base, rol: "JEFE" },
      { ...base, password: "corta1" },
      { ...base, password: "sinnumeros" },
      { ...base, email: "no-es-correo" },
      { ...base, nombre: "R" },
    ]) {
      expect(() => normalizarNuevoUsuario(malo)).toThrow(expect.objectContaining({ code: "VALIDACION", regla: false }));
    }
  });

  it("cambios de usuario: no se cambia de/hacia CLIENTE y un ADMIN no se desactiva ni se quita el rol (422)", () => {
    const op = { id: "u-op", rol: "OPERADOR" as const };
    expect(normalizarCambiosUsuario(op, { rol: "REPARTIDOR", activo: false }, ADMIN.id)).toEqual({ rol: "REPARTIDOR", activo: false });
    expect(() => normalizarCambiosUsuario(op, { rol: "CLIENTE" }, ADMIN.id)).toThrow(
      expect.objectContaining({ code: "VALIDACION", regla: true }),
    );
    expect(() => normalizarCambiosUsuario({ id: "u-c", rol: "CLIENTE" }, { rol: "OPERADOR" }, ADMIN.id)).toThrow(
      expect.objectContaining({ regla: true }),
    );
    // mismo rol CLIENTE: no es un cambio
    expect(normalizarCambiosUsuario({ id: "u-c", rol: "CLIENTE" }, { rol: "CLIENTE" }, ADMIN.id)).toEqual({ rol: "CLIENTE" });
    const yo = { id: ADMIN.id, rol: "ADMIN" as const };
    expect(() => normalizarCambiosUsuario(yo, { activo: false }, ADMIN.id)).toThrow(expect.objectContaining({ regla: true }));
    expect(() => normalizarCambiosUsuario(yo, { rol: "OPERADOR" }, ADMIN.id)).toThrow(expect.objectContaining({ regla: true }));
    expect(normalizarCambiosUsuario(yo, { nombre: "Gerencia", activo: true }, ADMIN.id)).toEqual({ nombre: "Gerencia", activo: true });
    expect(() => normalizarCambiosUsuario(op, {}, ADMIN.id)).toThrow(expect.objectContaining({ code: "VALIDACION" }));
    expect(() => normalizarCambiosUsuario(op, { password: "abc" }, ADMIN.id)).toThrow(expect.objectContaining({ code: "VALIDACION" }));
  });
});

describe("Asignación de repartidor", () => {
  it("asigna, reasigna y quita sin tocar el historial ni actualizadoEn; no en estados finales", () => {
    const e = crear();
    const antes = e.toSnapshot();
    e.asignarRepartidor({ id: REPARTIDOR.id, nombre: REPARTIDOR.nombre }, despues(5));
    expect(e.repartidor).toEqual({ id: REPARTIDOR.id, nombre: REPARTIDOR.nombre });
    expect(e.asignadoEn).toEqual(despues(5));
    expect(e.historial).toHaveLength(1);
    expect(e.actualizadoEn).toEqual(antes.actualizadoEn);
    e.asignarRepartidor({ id: "otro", nombre: "Otro" }, despues(6));
    expect(e.repartidor?.id).toBe("otro");
    e.asignarRepartidor(null, despues(7));
    expect([e.repartidor, e.asignadoEn]).toEqual([null, null]);

    const fin = entregado();
    expect(() => fin.asignarRepartidor({ id: "r", nombre: "R" }, ahora)).toThrow(expect.objectContaining({ code: "ESTADO_INVALIDO" }));
    const cancelado = crear();
    cancelado.cambiarEstado("CANCELADO", { ahora, actor: OPERADOR });
    expect(() => cancelado.asignarRepartidor(null, ahora)).toThrow(expect.objectContaining({ code: "ESTADO_INVALIDO" }));
  });
});

describe("Caja: cobros automáticos", () => {
  const ctx = { nuevoId, ahora, actor: OPERADOR };

  it("ORIGEN solo para envíos PAGADO, por el costo y a nombre de quien registra", () => {
    expect(cobroAlRegistrar(crear(), ctx)).toMatchObject({
      tipo: "ORIGEN",
      monto: 6,
      envioId: "e1",
      numeroGuia: 40425,
      formaPago: "PAGADO",
      usuario: { id: OPERADOR.id, nombre: OPERADOR.nombre },
      cierreId: null,
    });
    for (const formaPago of ["AL_COBRO", "CONTRATO", "SEGURO"] as const) {
      expect(cobroAlRegistrar(crear({ formaPago }), ctx)).toBeNull();
    }
  });

  it("CONTRA_ENTREGA al entregar un AL_COBRO, a nombre de quien lo marca (una sola vez)", () => {
    const e = entregado({ formaPago: "AL_COBRO" });
    const m = movimientosPorEstado(e, "ENTREGADO", [], { nuevoId, ahora, actor: REPARTIDOR });
    expect(m.cobros).toEqual([expect.objectContaining({ tipo: "CONTRA_ENTREGA", monto: 6, usuario: { id: REPARTIDOR.id, nombre: REPARTIDOR.nombre } })]);
    expect(movimientosPorEstado(e, "ENTREGADO", m.cobros, ctx).cobros).toEqual([]);
    expect(movimientosPorEstado(entregado({ formaPago: "CONTRATO" }), "ENTREGADO", [], ctx)).toEqual({ cobros: [], anulaciones: [] });
    expect(movimientosPorEstado(crear({ formaPago: "AL_COBRO" }), "EN_TRANSITO", [], ctx).cobros).toEqual([]);
  });

  it("cancelar: el ORIGEN pendiente se anula; si ya está en un cierre, DEVOLUCION por −costo", () => {
    const e = crear();
    const origen = cobroAlRegistrar(e, ctx)!;
    const pendiente = movimientosPorEstado(e, "CANCELADO", [origen], ctx);
    expect(pendiente.cobros).toEqual([]);
    expect(pendiente.anulaciones).toEqual([
      { cobroId: origen.id, siYaCerrado: expect.objectContaining({ tipo: "DEVOLUCION", monto: -6 }) },
    ]);
    const cerrado = movimientosPorEstado(e, "CANCELADO", [{ ...origen, cierreId: "k1" }], ctx);
    expect(cerrado.anulaciones).toEqual([]);
    expect(cerrado.cobros).toEqual([expect.objectContaining({ tipo: "DEVOLUCION", monto: -6, usuario: { id: OPERADOR.id, nombre: OPERADOR.nombre } })]);
    // sin cobro ORIGEN (p. ej. CONTRATO o envío anterior a v12) no hay movimiento
    expect(movimientosPorEstado(e, "CANCELADO", [], ctx)).toEqual({ cobros: [], anulaciones: [] });
  });
});

describe("Caja: resumen y cierre", () => {
  const cobro = (tipo: Cobro["tipo"], monto: number, min: number): Cobro => ({
    id: `c${min}`,
    tipo,
    monto,
    envioId: `e${min}`,
    numeroGuia: min,
    formaPago: tipo === "CONTRA_ENTREGA" ? "AL_COBRO" : "PAGADO",
    usuario: { id: OPERADOR.id, nombre: OPERADOR.nombre },
    fecha: despues(min),
    cierreId: null,
  });
  const cobros = [cobro("ORIGEN", 3.1, 2), cobro("CONTRA_ENTREGA", 4.2, 1), cobro("DEVOLUCION", -3, 3)];
  const base = {
    id: "k1",
    fecha: despues(10),
    usuario: { id: OPERADOR.id, nombre: OPERADOR.nombre, rol: "OPERADOR" as const },
    recibidoPor: { id: ADMIN.id, nombre: ADMIN.nombre },
  };

  it("resumirCobros: total redondeado, los tres tipos y el más antiguo", () => {
    expect(resumirCobros(cobros)).toEqual({
      total: 4.3,
      cantidad: 3,
      porTipo: [
        { tipo: "ORIGEN", cantidad: 1, monto: 3.1 },
        { tipo: "CONTRA_ENTREGA", cantidad: 1, monto: 4.2 },
        { tipo: "DEVOLUCION", cantidad: 1, monto: -3 },
      ],
      desde: despues(1),
    });
    expect(resumirCobros([])).toMatchObject({ total: 0, cantidad: 0, desde: null });
  });

  it("cierre exacto, con faltante o sobrante (nota obligatoria si hay diferencia)", () => {
    expect(crearCierre(cobros, { ...base, montoEntregado: 4.3 })).toMatchObject({
      esperado: 4.3,
      entregado: 4.3,
      diferencia: 0,
      cantidad: 3,
      nota: null,
    });
    expect(crearCierre(cobros, { ...base, montoEntregado: 4, nota: "Faltan 30 centavos" }).diferencia).toBe(-0.3);
    expect(crearCierre(cobros, { ...base, montoEntregado: 5, nota: "Sobra" }).diferencia).toBe(0.7);
    expect(() => crearCierre(cobros, { ...base, montoEntregado: 4 })).toThrow(
      expect.objectContaining({ code: "VALIDACION", regla: true }),
    );
    expect(() => crearCierre(cobros, { ...base, montoEntregado: 4, nota: "   " })).toThrow(expect.objectContaining({ regla: true }));
  });

  it("sin cobros → SIN_COBROS; monto negativo o con más de 2 decimales → VALIDACION", () => {
    expect(() => crearCierre([], { ...base, montoEntregado: 0 })).toThrow(expect.objectContaining({ code: "SIN_COBROS" }));
    expect(() => crearCierre(cobros, { ...base, montoEntregado: -1 })).toThrow(expect.objectContaining({ code: "VALIDACION" }));
    expect(() => crearCierre(cobros, { ...base, montoEntregado: 4.301 })).toThrow(expect.objectContaining({ code: "VALIDACION" }));
  });
});

describe("Anonimización (LOPDP)", () => {
  it("borra datos personales, notas y evidencia; conserva guía, ítems, costos, estados y fechas", () => {
    const e = entregado();
    e.registrarEvidencia({ recibidoPor: "Rosa Vera", tipo: "image/jpeg", bytes: 10, clave: "evidencias/e1/a.jpg" }, { ahora: despues(4), actor: REPARTIDOR });
    const antes = e.toSnapshot();
    const evidencia = e.anonimizar(despues(100));
    expect(evidencia?.clave).toBe("evidencias/e1/a.jpg");
    const s = e.toSnapshot();
    expect(s.remitente).toEqual({ nombre: ANONIMIZADO, telefono: "", direccion: null });
    expect(s.destinatario).toEqual({ nombre: ANONIMIZADO, telefono: "", direccion: ANONIMIZADO });
    expect(s.descripcion).toBeNull();
    expect(s.evidencia).toBeNull();
    expect(s.historial.map((h) => h.nota)).toEqual([null, null, null, null]);
    expect(s.historial.map((h) => h.estado)).toEqual(antes.historial.map((h) => h.estado));
    expect(s.anonimizadoEn).toEqual(despues(100));
    expect({ guia: s.numeroGuia, costo: s.costo, items: s.items, forma: s.formaPago, act: s.actualizadoEn }).toEqual({
      guia: antes.numeroGuia,
      costo: antes.costo,
      items: antes.items,
      forma: antes.formaPago,
      act: antes.actualizadoEn,
    });
    // idempotente (conserva la primera fecha) y sin evidencia nueva
    expect(e.anonimizar(despues(200))).toBeNull();
    expect(e.anonimizadoEn).toEqual(despues(100));
    expect(() =>
      e.registrarEvidencia({ recibidoPor: "Rosa", tipo: "image/png", bytes: 1, clave: "k" }, { ahora, actor: OPERADOR }),
    ).toThrow(expect.objectContaining({ code: "ESTADO_INVALIDO" }));
  });

  it("solo envíos terminados", () => {
    expect(() => crear().anonimizar(ahora)).toThrow(expect.objectContaining({ code: "ESTADO_INVALIDO" }));
  });
});

describe("Solicitudes del titular (datos)", () => {
  it("del teléfono solo quedan los 4 últimos dígitos; datos de la solicitud", () => {
    expect(telefonoFinal("099 123-4567")).toBe("…4567");
    expect(() => telefonoFinal("12345")).toThrow(expect.objectContaining({ code: "VALIDACION" }));
    expect(normalizarSolicitud({ telefono: "0991234567", nombreTitular: " Ana  López ", canal: "WHATSAPP", nota: " " })).toEqual({
      digitos: "0991234567",
      nombreTitular: "Ana López",
      canal: "WHATSAPP",
      nota: null,
    });
    expect(() => normalizarSolicitud({ telefono: "0991234567", nombreTitular: "A", canal: "CORREO" })).toThrow();
    expect(() => normalizarSolicitud({ telefono: "0991234567", nombreTitular: "Ana", canal: "FAX" })).toThrow();
  });

  it("fechas de Ecuador (UTC−5): inicio del día y del mes", () => {
    expect(inicioDiaEC("2026-10-18")).toEqual(new Date("2026-10-18T05:00:00Z"));
    expect(fechaLocalEC(new Date("2026-11-01T03:00:00Z"))).toBe("2026-10-31");
    expect(inicioMesEC(new Date("2026-11-01T03:00:00Z"))).toBe("2026-10-01");
  });
});
