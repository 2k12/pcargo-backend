import { describe, expect, it } from "vitest";
import { validarPeso, type TipoCarga } from "../../../src/domain/carga/TipoCarga.js";
import { DomainError } from "../../../src/domain/shared/DomainError.js";
import { calcularTarifa, cotizarItems } from "../../../src/domain/tarifa/calcularTarifa.js";
import { TIPOS_CARGA_SEED } from "../../../src/infrastructure/persistence/seed-data.js";

const tipo = (codigo: string): TipoCarga => TIPOS_CARGA_SEED.find((t) => t.codigo === codigo)!;

describe("calcularTarifa (por pieza)", () => {
  it("un sobre cuesta exactamente la tarifa base", () => {
    expect(calcularTarifa(6, tipo("SOBRE"), 0.3).costo).toBe(6);
  });

  it("aplica el factor del tipo de carga sin recargo dentro del peso incluido", () => {
    expect(calcularTarifa(3, tipo("PAQUETE"), 2)).toEqual({ costo: 4.2, tarifaBase: 3, factor: 1.4, recargoPeso: 0 });
  });

  it("cobra 0.50 USD por kg sobre el peso incluido", () => {
    // 6 * 1.8 + (10 - 2) * 0.5 = 10.8 + 4
    expect(calcularTarifa(6, tipo("VALIJA"), 10)).toMatchObject({ costo: 14.8, recargoPeso: 4 });
  });

  it("redondea a 2 decimales", () => {
    expect(calcularTarifa(2.5, tipo("CARTON"), 3.33).costo).toBe(4.67); // 4 + 0.665
  });

  it("rechaza pesos sobre el máximo del tipo", () => {
    expect(() => calcularTarifa(3, tipo("SOBRE"), 1)).toThrow(DomainError);
  });
});

describe("cotizarItems (varias líneas y cantidades)", () => {
  it("5 paquetes de 2 kg + 20 cartones de 8 kg en Ibarra → Atuntaqui", () => {
    const c = cotizarItems(2.5, [
      { tipo: tipo("PAQUETE"), cantidad: 5, pesoKg: 2 }, // 3.50 c/u
      { tipo: tipo("CARTON"), cantidad: 20, pesoKg: 8 }, // 4 + 3 = 7.00 c/u
    ]);
    expect(c).toMatchObject({ costo: 157.5, totalPiezas: 25, pesoTotalKg: 170, tarifaBase: 2.5 });
    expect(c.items.map((i) => [i.tipoCarga, i.cantidad, i.costoUnitario, i.subtotal])).toEqual([
      ["PAQUETE", 5, 3.5, 17.5],
      ["CARTON", 20, 7, 140],
    ]);
  });

  it.each([
    [[], /al menos un ítem/],
    [[{ c: 0 }], /cantidad/],
    [[{ c: 1.5 }], /cantidad/],
    [[{ c: 1000 }], /cantidad/],
    [Array.from({ length: 21 }, () => ({ c: 1 })), /Máximo 20/],
  ])("valida líneas y cantidades (%#)", (lineas, msg) => {
    const items = (lineas as { c: number }[]).map(({ c }) => ({ tipo: tipo("PAQUETE"), cantidad: c, pesoKg: 1 }));
    expect(() => cotizarItems(3, items)).toThrow(msg);
  });

  it("valida el peso por unidad de cada línea", () => {
    expect(() => cotizarItems(3, [{ tipo: tipo("SOBRE"), cantidad: 10, pesoKg: 0.6 }])).toThrow(/máximo/);
  });
});

describe("validarPeso", () => {
  it.each([0, -1, Number.NaN])("rechaza peso %s", (p) => {
    expect(() => validarPeso(tipo("PAQUETE"), p)).toThrow(/mayor a 0/);
  });

  it("acepta el peso máximo exacto", () => {
    expect(() => validarPeso(tipo("CARTON"), 40)).not.toThrow();
  });
});
