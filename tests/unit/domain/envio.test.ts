import { describe, expect, it } from "vitest";
import { generarCodigoSeguimiento, PATRON_CODIGO } from "../../../src/domain/envio/CodigoSeguimiento.js";
import { Envio, type NuevoEnvio } from "../../../src/domain/envio/Envio.js";
import { ESTADOS, puedeTransicionar } from "../../../src/domain/envio/EstadoEnvio.js";
import { nombreRuta, validarDatosRuta } from "../../../src/domain/ruta/Ruta.js";
import { OPERADOR } from "../../helpers/fakes.js";

const ahora = new Date("2026-10-01T10:00:00Z");
const datos: NuevoEnvio = {
  remitente: { nombre: " María ", telefono: "0991234567" },
  destinatario: { nombre: "Juan", telefono: "+593 98 765 4321", direccion: "Calle Bolívar 1-23" },
  rutaId: 1,
  tipoCarga: "SOBRE",
  pesoKg: 0.2,
  costo: 2,
};
const crear = (d: Partial<NuevoEnvio> = {}) =>
  Envio.crear({ ...datos, ...d }, { id: "e1", codigo: "PC-ABCD2345", ahora, actor: OPERADOR });

describe("Envio", () => {
  it("se crea en estado REGISTRADO con el primer evento de historial", () => {
    const e = crear();
    expect(e.estado).toBe("REGISTRADO");
    expect(e.historial).toHaveLength(1);
    expect(e.historial[0]).toMatchObject({ estado: "REGISTRADO", usuario: { id: OPERADOR.id } });
    expect(e.toSnapshot().remitente.nombre).toBe("María");
  });

  it.each([
    [{ remitente: { nombre: "", telefono: "0991234567" } }, /nombre del remitente/],
    [{ remitente: { nombre: "Ana", telefono: "abc" } }, /teléfono del remitente/],
    [{ destinatario: { nombre: "Juan", telefono: "0991234567", direccion: " " } }, /dirección/],
  ])("valida datos obligatorios (%#)", (d, msg) => {
    expect(() => crear(d as Partial<NuevoEnvio>)).toThrow(msg);
  });

  it("recorre el flujo completo hasta ENTREGADO registrando historial", () => {
    const e = crear();
    for (const estado of ["EN_TRANSITO", "EN_REPARTO", "ENTREGADO"] as const) {
      e.cambiarEstado(estado, { ahora, actor: OPERADOR, nota: estado === "ENTREGADO" ? "Recibió portero" : null });
    }
    expect(e.estado).toBe("ENTREGADO");
    expect(e.historial.map((h) => h.estado)).toEqual(["REGISTRADO", "EN_TRANSITO", "EN_REPARTO", "ENTREGADO"]);
    expect(e.historial.at(-1)?.nota).toBe("Recibió portero");
  });

  it("rechaza transiciones inválidas", () => {
    const e = crear();
    expect(() => e.cambiarEstado("ENTREGADO", { ahora, actor: OPERADOR })).toThrow(/No se puede pasar/);
    e.cambiarEstado("EN_TRANSITO", { ahora, actor: OPERADOR });
    expect(() => e.cambiarEstado("CANCELADO", { ahora, actor: OPERADOR })).toThrow(/TRANSITO a CANCELADO/);
  });

  it("los snapshots no comparten el historial con el agregado", () => {
    const e = crear();
    e.toSnapshot().historial.push({ estado: "CANCELADO", nota: null, fecha: ahora, usuario: null });
    expect(e.historial).toHaveLength(1);
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
});

describe("código de seguimiento", () => {
  it("cumple el patrón PC-XXXXXXXX", () => {
    for (let i = 0; i < 50; i++) expect(generarCodigoSeguimiento()).toMatch(PATRON_CODIGO);
  });

  it("es determinista con un generador aleatorio fijo", () => {
    expect(generarCodigoSeguimiento(() => 0)).toBe("PC-AAAAAAAA");
  });
});

describe("Ruta", () => {
  const ib = { id: 1, nombre: "Ibarra" };
  const qu = { id: 4, nombre: "Quito" };

  it("nombra rutas urbanas e interurbanas", () => {
    expect(nombreRuta({ origen: ib, destino: ib })).toBe("Ibarra (urbano)");
    expect(nombreRuta({ origen: ib, destino: qu })).toBe("Ibarra → Quito");
  });

  it("valida tarifa y tiempo", () => {
    expect(() => validarDatosRuta({ tarifaBase: 0 })).toThrow(/tarifa/);
    expect(() => validarDatosRuta({ tiempoEstimadoMin: 1.5 })).toThrow(/tiempo/);
    expect(() => validarDatosRuta({ tarifaBase: 3, tiempoEstimadoMin: 30 })).not.toThrow();
  });
});
