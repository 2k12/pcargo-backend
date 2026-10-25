import { describe, expect, it } from "vitest";
import { validarFechaGuia } from "../../../src/domain/envio/Envio.js";
import { exigirGuiaDisponible, Talonario } from "../../../src/domain/talonario/Talonario.js";

// Contrato v20: talonarios de guías en blanco.

const AHORA = new Date("2026-10-20T15:00:00Z"); // 2026-10-20 en Ecuador
const ctx = (desde = 101) => ({ id: "t1", desde, ahora: AHORA, creadoPor: "Operador" });

describe("Talonario (dominio)", () => {
  it("crea N guías consecutivas DISPONIBLE desde el número indicado, con nota recortada", () => {
    const t = Talonario.crear({ cantidad: 3, nota: "  Camión Quito – sábado " }, ctx());
    expect([t.desde, t.hasta, t.cantidad, t.nota, t.creadoPor]).toEqual([101, 103, 3, "Camión Quito – sábado", "Operador"]);
    expect(t.guias).toEqual([101, 102, 103].map((numeroGuia) => ({
      numeroGuia,
      estado: "DISPONIBLE",
      envioId: null,
      motivo: null,
      actualizadoEn: null,
    })));
    expect([t.disponibles, t.usadas, t.anuladas, t.abierto]).toEqual([3, 0, 0, true]);
    expect(Talonario.crear({ cantidad: 1, nota: "   " }, ctx()).nota).toBeNull();
  });

  it.each([0, 51, 1.5, "5", null])("cantidad %s → VALIDACION", (cantidad) => {
    expect(() => Talonario.crear({ cantidad }, ctx())).toThrow(expect.objectContaining({ code: "VALIDACION" }));
  });

  it("acepta 1 y 50; nota de más de 120 caracteres → VALIDACION", () => {
    expect(Talonario.crear({ cantidad: 1 }, ctx()).cantidad).toBe(1);
    expect(Talonario.crear({ cantidad: 50 }, ctx()).hasta).toBe(150);
    expect(() => Talonario.crear({ cantidad: 1, nota: "x".repeat(121) }, ctx())).toThrow(
      expect.objectContaining({ code: "VALIDACION" }),
    );
  });

  it("no pasa del máximo de 12 dígitos", () => {
    expect(() => Talonario.crear({ cantidad: 2 }, ctx(999_999_999_999))).toThrow(
      expect.objectContaining({ code: "CONFLICTO" }),
    );
  });

  it("la fecha mínima de la guía es el día de Ecuador de creación", () => {
    // 2026-10-21 03:00 UTC = 2026-10-20 22:00 en Ecuador
    const t = Talonario.crear({ cantidad: 1 }, { ...ctx(), ahora: new Date("2026-10-21T03:00:00Z") });
    expect(t.fechaMinimaGuia).toBe("2026-10-20");
  });

  it("usar: DISPONIBLE → USADA con el envío; no se usa dos veces; número ajeno → NO_ENCONTRADO", () => {
    const t = Talonario.crear({ cantidad: 2 }, ctx());
    t.usar(101, "e1", AHORA);
    expect(t.guia(101)).toEqual({ numeroGuia: 101, estado: "USADA", envioId: "e1", motivo: null, actualizadoEn: AHORA });
    expect(() => t.usar(101, "e2", AHORA)).toThrow(expect.objectContaining({ code: "CONFLICTO" }));
    expect(() => t.usar(999, "e2", AHORA)).toThrow(expect.objectContaining({ code: "NO_ENCONTRADO" }));
    expect([t.disponibles, t.usadas]).toEqual([1, 1]);
  });

  it("anular: solo DISPONIBLE, con motivo de 3 a 200 caracteres; una anulada no se puede usar", () => {
    const t = Talonario.crear({ cantidad: 3 }, ctx());
    t.usar(101, "e1", AHORA);
    expect(() => t.anular(101, "Se mojó", AHORA)).toThrow(expect.objectContaining({ code: "ESTADO_INVALIDO" }));
    expect(() => t.anular(102, "ab", AHORA)).toThrow(expect.objectContaining({ code: "VALIDACION" }));
    expect(() => t.anular(102, "x".repeat(201), AHORA)).toThrow(expect.objectContaining({ code: "VALIDACION" }));
    expect(() => t.anular(500, "Se mojó", AHORA)).toThrow(expect.objectContaining({ code: "NO_ENCONTRADO" }));
    t.anular(102, "  Se mojó  ", AHORA);
    expect(t.guia(102)).toMatchObject({ estado: "ANULADA", motivo: "Se mojó", envioId: null, actualizadoEn: AHORA });
    expect(() => t.anular(102, "Otra vez", AHORA)).toThrow(expect.objectContaining({ code: "ESTADO_INVALIDO" }));
    expect(() => t.usar(102, "e2", AHORA)).toThrow(expect.objectContaining({ code: "GUIA_ANULADA" }));
    expect([t.disponibles, t.usadas, t.anuladas]).toEqual([1, 1, 1]);
    t.anular(103, "Perdida", AHORA);
    expect(t.abierto).toBe(false);
  });

  it("exigirGuiaDisponible: ANULADA → GUIA_ANULADA, USADA → CONFLICTO", () => {
    expect(() => exigirGuiaDisponible({ numeroGuia: 1, estado: "DISPONIBLE" })).not.toThrow();
    expect(() => exigirGuiaDisponible({ numeroGuia: 1, estado: "ANULADA" })).toThrow(
      expect.objectContaining({ code: "GUIA_ANULADA" }),
    );
    expect(() => exigirGuiaDisponible({ numeroGuia: 1, estado: "USADA" })).toThrow(
      expect.objectContaining({ code: "CONFLICTO" }),
    );
  });
});

describe("validarFechaGuia con mínimo del talonario (v20)", () => {
  const hoy = "2026-10-24";

  it("desde el día del talonario hasta hoy + 90; antes → VALIDACION", () => {
    expect(validarFechaGuia("2026-10-20", hoy, "2026-10-20")).toBe("2026-10-20");
    expect(validarFechaGuia("2026-10-22", hoy, "2026-10-20")).toBe("2026-10-22");
    expect(validarFechaGuia(null, hoy, "2026-10-20")).toBe(hoy);
    expect(validarFechaGuia("2027-01-22", hoy, "2026-10-20")).toBe("2027-01-22");
    expect(() => validarFechaGuia("2026-10-19", hoy, "2026-10-20")).toThrow(/anterior al día del talonario \(2026-10-20\)/);
    expect(() => validarFechaGuia("2027-01-23", hoy, "2026-10-20")).toThrow(/como máximo 90 días/);
  });

  it("sin mínimo (o con uno igual a hoy) sigue exigiendo hoy o posterior", () => {
    expect(() => validarFechaGuia("2026-10-23", hoy)).toThrow(/anterior a hoy/);
    expect(() => validarFechaGuia("2026-10-23", hoy, hoy)).toThrow(/anterior a hoy/);
  });
});
