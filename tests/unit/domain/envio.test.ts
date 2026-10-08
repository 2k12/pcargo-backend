import { describe, expect, it } from "vitest";
import { Envio, type NuevoEnvio } from "../../../src/domain/envio/Envio.js";
import { ESTADOS, puedeTransicionar } from "../../../src/domain/envio/EstadoEnvio.js";
import { pareceNumeroGuia, parsearNumeroGuia } from "../../../src/domain/envio/NumeroGuia.js";
import { conEstado, esOperativa, nombreRuta, normalizarNombreCiudad, validarDatosRuta } from "../../../src/domain/ruta/Ruta.js";
import { ADMIN, OPERADOR } from "../../helpers/fakes.js";

const ahora = new Date("2026-10-01T10:00:00Z");
const despues = (min: number) => new Date(ahora.getTime() + min * 60_000);
const datos: NuevoEnvio = {
  remitente: { nombre: " María ", telefono: "0991234567" },
  destinatario: { nombre: "Juan", telefono: "+593 98 765 4321", direccion: "Calle Bolívar 1-23" },
  rutaId: 5,
  items: [
    { tipoCarga: "PAQUETE", cantidad: 5, pesoKg: 2, costoUnitario: 3.5, subtotal: 17.5 },
    { tipoCarga: "CARTON", cantidad: 20, pesoKg: 8, costoUnitario: 7, subtotal: 140 },
  ],
  formaPago: "AL_COBRO",
};
const crear = (d: Partial<NuevoEnvio> = {}) =>
  Envio.crear({ ...datos, ...d }, { id: "e1", numeroGuia: 40425, ahora, actor: OPERADOR });

describe("Envio", () => {
  it("se crea REGISTRADO con totales de piezas, peso y costo, y registro (fecha + operador)", () => {
    const e = crear();
    expect(e.estado).toBe("REGISTRADO");
    expect(e.totalPiezas).toBe(25);
    expect(e.pesoTotalKg).toBe(170);
    expect(e.toSnapshot()).toMatchObject({ costo: 157.5, formaPago: "AL_COBRO", remitente: { nombre: "María" } });
    expect(e.registro).toEqual({ fecha: ahora, operador: OPERADOR.nombre });
    expect(e.ultimaGestionEntrega).toBeNull();
  });

  it.each([
    [{ remitente: { nombre: "", telefono: "0991234567" } }, /nombre del remitente/],
    [{ remitente: { nombre: "Ana", telefono: "abc" } }, /teléfono del remitente/],
    [{ destinatario: { nombre: "Juan", telefono: "0991234567", direccion: " " } }, /dirección/],
    [{ items: [] }, /al menos un ítem/],
  ])("valida datos obligatorios (%#)", (d, msg) => {
    expect(() => crear(d as Partial<NuevoEnvio>)).toThrow(msg);
  });

  it("recorre el flujo hasta ENTREGADO y expone la gestión de entrega", () => {
    const e = crear();
    e.cambiarEstado("EN_TRANSITO", { ahora: despues(10), actor: OPERADOR });
    e.cambiarEstado("EN_REPARTO", { ahora: despues(60), actor: OPERADOR });
    e.cambiarEstado("ENTREGADO", { ahora: despues(90), actor: ADMIN, nota: "Recibió portero" });
    expect(e.historial.map((h) => h.estado)).toEqual(["REGISTRADO", "EN_TRANSITO", "EN_REPARTO", "ENTREGADO"]);
    expect(e.ultimaGestionEntrega).toEqual({
      resultado: "ENTREGADO",
      fecha: despues(90),
      operador: ADMIN.nombre,
      nota: "Recibió portero",
    });
  });

  it("NO_ENTREGADO y NOVEDAD exigen motivo; se puede reintentar y la gestión muestra la última", () => {
    const e = crear();
    e.cambiarEstado("EN_TRANSITO", { ahora, actor: OPERADOR });
    e.cambiarEstado("EN_REPARTO", { ahora, actor: OPERADOR });
    expect(() => e.cambiarEstado("NO_ENTREGADO", { ahora, actor: OPERADOR, nota: "  " })).toThrow(/motivo/);
    e.cambiarEstado("NO_ENTREGADO", { ahora: despues(5), actor: OPERADOR, nota: "Nadie en casa" });
    expect(e.ultimaGestionEntrega).toMatchObject({ resultado: "NO_ENTREGADO", nota: "Nadie en casa" });

    e.cambiarEstado("EN_REPARTO", { ahora: despues(60), actor: OPERADOR }); // reintento
    expect(() => e.cambiarEstado("NOVEDAD", { ahora, actor: OPERADOR })).toThrow(/motivo/);
    e.cambiarEstado("NOVEDAD", { ahora: despues(70), actor: OPERADOR, nota: "Dirección incompleta" });
    e.cambiarEstado("ENTREGADO", { ahora: despues(80), actor: OPERADOR });
    expect(e.ultimaGestionEntrega).toMatchObject({ resultado: "ENTREGADO", fecha: despues(80), nota: null });
  });

  it("rechaza transiciones inválidas", () => {
    const e = crear();
    expect(() => e.cambiarEstado("ENTREGADO", { ahora, actor: OPERADOR })).toThrow(/No se puede pasar/);
    e.cambiarEstado("EN_TRANSITO", { ahora, actor: OPERADOR });
    expect(() => e.cambiarEstado("CANCELADO", { ahora, actor: OPERADOR })).toThrow(/TRANSITO a CANCELADO/);
  });

  it("los snapshots no comparten el historial ni los ítems con el agregado", () => {
    const e = crear();
    const snap = e.toSnapshot();
    snap.historial.push({ estado: "CANCELADO", nota: null, fecha: ahora, usuario: null });
    snap.items.pop();
    expect(e.historial).toHaveLength(1);
    expect(e.totalPiezas).toBe(25);
  });
});

describe("máquina de estados", () => {
  it("ENTREGADO y CANCELADO son estados finales", () => {
    for (const hacia of ESTADOS) {
      expect(puedeTransicionar("ENTREGADO", hacia)).toBe(false);
      expect(puedeTransicionar("CANCELADO", hacia)).toBe(false);
    }
  });

  it("solo se cancela desde REGISTRADO", () => {
    expect(ESTADOS.filter((d) => puedeTransicionar(d, "CANCELADO"))).toEqual(["REGISTRADO"]);
  });

  it("NO_ENTREGADO solo permite reintentar (EN_REPARTO)", () => {
    expect(ESTADOS.filter((h) => puedeTransicionar("NO_ENTREGADO", h))).toEqual(["EN_REPARTO"]);
  });

  it("una NOVEDAD se puede registrar en tránsito o en reparto y luego resolver", () => {
    expect(puedeTransicionar("EN_TRANSITO", "NOVEDAD")).toBe(true);
    expect(puedeTransicionar("EN_REPARTO", "NOVEDAD")).toBe(true);
    expect(ESTADOS.filter((h) => puedeTransicionar("NOVEDAD", h))).toEqual(["EN_REPARTO", "ENTREGADO", "NO_ENTREGADO"]);
  });
});

describe("número de guía", () => {
  it.each([
    ["0040425", 40425],
    ["40425", 40425],
    ["  00 40 425 ", 40425],
    [40425, 40425],
    ["000000000001", 1],
  ])("%j se interpreta como %i (ignora ceros a la izquierda y espacios)", (entrada, esperado) => {
    expect(parsearNumeroGuia(entrada)).toBe(esperado);
  });

  it.each(["PC-7K2M9QXA", "40-425", "4.5", "", "0000", "-12", "1234567890123"])("rechaza %j", (entrada) => {
    expect(() => parsearNumeroGuia(entrada)).toThrow(/número de guía/);
  });

  it("acepta hasta 12 dígitos significativos aunque tenga ceros delante", () => {
    expect(parsearNumeroGuia("000999999999999")).toBe(999999999999);
  });

  it("detecta textos de búsqueda que son números", () => {
    expect(pareceNumeroGuia(" 0040425 ")).toBe(true);
    expect(pareceNumeroGuia("Rosa")).toBe(false);
    expect(pareceNumeroGuia("40425a")).toBe(false);
  });

  it("el envío conserva su número de guía", () => {
    expect(crear().numeroGuia).toBe(40425);
  });
});

describe("Ruta", () => {
  const ib = { id: 1, nombre: "Ibarra", activa: true };
  const qu = { id: 4, nombre: "Quito", activa: true };

  it("nombra rutas urbanas e interurbanas", () => {
    expect(nombreRuta({ origen: ib, destino: ib })).toBe("Ibarra (urbano)");
    expect(nombreRuta({ origen: ib, destino: qu })).toBe("Ibarra → Quito");
  });

  it("una ruta es operativa solo si ella y sus dos ciudades están activas", () => {
    const base = { id: 1, origen: ib, destino: qu, tarifaBase: 6, tiempoEstimadoMin: 180, activa: true };
    expect(esOperativa(base)).toBe(true);
    expect(esOperativa({ ...base, activa: false })).toBe(false);
    expect(esOperativa({ ...base, destino: { ...qu, activa: false } })).toBe(false);
    expect(conEstado({ ...base, origen: { ...ib, activa: false } }).operativa).toBe(false);
  });

  it("normaliza y valida el nombre de una ciudad", () => {
    expect(normalizarNombreCiudad("  San   Antonio de Ibarra ")).toBe("San Antonio de Ibarra");
    expect(() => normalizarNombreCiudad("X")).toThrow(/entre 2 y 60/);
    expect(() => normalizarNombreCiudad("a".repeat(61))).toThrow(/entre 2 y 60/);
  });

  it("valida tarifa y tiempo", () => {
    expect(() => validarDatosRuta({ tarifaBase: 0 })).toThrow(/tarifa/);
    expect(() => validarDatosRuta({ tiempoEstimadoMin: 1.5 })).toThrow(/tiempo/);
    expect(() => validarDatosRuta({ tarifaBase: 3, tiempoEstimadoMin: 30 })).not.toThrow();
  });
});
