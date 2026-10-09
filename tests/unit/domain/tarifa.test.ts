import { describe, expect, it } from "vitest";
import { TIPOS_CARGA, validarPeso, type TipoCarga } from "../../../src/domain/carga/TipoCarga.js";
import { DomainError } from "../../../src/domain/shared/DomainError.js";
import { calcularPrecioUnitario, cotizarItems } from "../../../src/domain/tarifa/calcularTarifa.js";
import { esZona } from "../../../src/domain/tarifa/Zona.js";
import { TIPOS_CARGA_SEED } from "../../../src/infrastructure/persistence/seed-data.js";

const tipo = (codigo: string): TipoCarga => TIPOS_CARGA_SEED.find((t) => t.codigo === codigo)!;
const linea = (codigo: string, cantidad: number, pesoKg = 1) => ({ tipo: tipo(codigo), cantidad, pesoKg });

describe("catálogo de tipos de carga (v8)", () => {
  it("la semilla tiene los 7 tipos del dominio, en orden", () => {
    expect(TIPOS_CARGA_SEED.map((t) => t.codigo)).toEqual([...TIPOS_CARGA]);
  });

  it.each([
    ["SOBRE", 3, null, 0.5],
    ["PAQUETE", 3, null, 50],
    ["CARTON", 3, null, 35],
    ["VALIJA", 3, null, 25],
    ["TELA", 1.25, 1.5, 50],
    ["PLUMON_PEQUENO", 3, null, 50],
    ["PLUMON_GRANDE", 4, null, 50],
  ])("%s: precio %s, rural %s, peso máximo %s kg", (codigo, precio, precioRural, pesoMaxKg) => {
    expect(tipo(codigo)).toMatchObject({ precio, precioRural, pesoMaxKg });
  });

  it("solo la tela tiene precio por volumen: más de 50 rollos a 1.00", () => {
    expect(tipo("TELA").mayoreo).toEqual({ minimoExclusivo: 50, precio: 1 });
    expect(TIPOS_CARGA_SEED.filter((t) => t.mayoreo).map((t) => t.codigo)).toEqual(["TELA"]);
  });
});

describe("calcularPrecioUnitario", () => {
  it.each([
    ["SOBRE", 3],
    ["PAQUETE", 3],
    ["CARTON", 3],
    ["VALIJA", 3],
    ["TELA", 1.25],
    ["PLUMON_PEQUENO", 3],
    ["PLUMON_GRANDE", 4],
  ])("%s en zona urbana cuesta %s por unidad", (codigo, precio) => {
    expect(calcularPrecioUnitario(tipo(codigo), "URBANA", 1)).toEqual({ costoUnitario: precio, mayoreo: false });
  });

  it("la tela en zona rural cuesta 1.50", () => {
    expect(calcularPrecioUnitario(tipo("TELA"), "RURAL", 10)).toEqual({ costoUnitario: 1.5, mayoreo: false });
  });

  it.each(["SOBRE", "PAQUETE", "CARTON", "VALIJA", "PLUMON_PEQUENO", "PLUMON_GRANDE"])(
    "%s (sin precio rural) cuesta lo mismo en zona rural",
    (codigo) => {
      expect(calcularPrecioUnitario(tipo(codigo), "RURAL", 1)).toEqual(calcularPrecioUnitario(tipo(codigo), "URBANA", 1));
    },
  );

  it("mayoreo: con 50 rollos exactos no aplica; con 51 sí, y sin importar la zona", () => {
    expect(calcularPrecioUnitario(tipo("TELA"), "URBANA", 50)).toEqual({ costoUnitario: 1.25, mayoreo: false });
    expect(calcularPrecioUnitario(tipo("TELA"), "RURAL", 50)).toEqual({ costoUnitario: 1.5, mayoreo: false });
    expect(calcularPrecioUnitario(tipo("TELA"), "URBANA", 51)).toEqual({ costoUnitario: 1, mayoreo: true });
    expect(calcularPrecioUnitario(tipo("TELA"), "RURAL", 51)).toEqual({ costoUnitario: 1, mayoreo: true });
  });

  it("los tipos sin mayoreo no cambian de precio por volumen", () => {
    expect(calcularPrecioUnitario(tipo("PAQUETE"), "URBANA", 999)).toEqual({ costoUnitario: 3, mayoreo: false });
  });
});

describe("cotizarItems (varias líneas y cantidades)", () => {
  it("la ruta y el peso no influyen: 5 paquetes de 2 kg + 20 cartones de 8 kg = 25 × 3.00", () => {
    const c = cotizarItems([linea("PAQUETE", 5, 2), linea("CARTON", 20, 8)]);
    expect(c).toEqual({
      costo: 75,
      zona: "URBANA",
      totalPiezas: 25,
      pesoTotalKg: 170,
      items: [
        { tipoCarga: "PAQUETE", cantidad: 5, pesoKg: 2, costoUnitario: 3, subtotal: 15, mayoreo: false },
        { tipoCarga: "CARTON", cantidad: 20, pesoKg: 8, costoUnitario: 3, subtotal: 60, mayoreo: false },
      ],
    });
    // el mismo paquete pesado o liviano cuesta igual
    expect(cotizarItems([linea("PAQUETE", 1, 50)]).costo).toBe(cotizarItems([linea("PAQUETE", 1, 0.1)]).costo);
  });

  it("zona por defecto URBANA; RURAL solo cambia la tela", () => {
    const items = [linea("TELA", 10), linea("PLUMON_GRANDE", 2)];
    expect(cotizarItems(items)).toMatchObject({ zona: "URBANA", costo: 20.5 }); // 12.50 + 8
    expect(cotizarItems(items, "RURAL")).toMatchObject({ zona: "RURAL", costo: 23 }); // 15 + 8
  });

  it("tela: 50 rollos repartidos en varias líneas NO tienen mayoreo", () => {
    const c = cotizarItems([linea("TELA", 20), linea("PAQUETE", 1), linea("TELA", 30)], "RURAL");
    expect(c.items.map((i) => [i.tipoCarga, i.costoUnitario, i.subtotal, i.mayoreo])).toEqual([
      ["TELA", 1.5, 30, false],
      ["PAQUETE", 3, 3, false],
      ["TELA", 1.5, 45, false],
    ]);
    expect(c.costo).toBe(78);
  });

  it("tela: 51 rollos repartidos en varias líneas → todas las unidades a 1.00, sin importar la zona", () => {
    for (const zona of ["URBANA", "RURAL"] as const) {
      const c = cotizarItems([linea("TELA", 20), linea("SOBRE", 2, 0.2), linea("TELA", 31)], zona);
      expect(c.items.map((i) => [i.tipoCarga, i.costoUnitario, i.subtotal, i.mayoreo])).toEqual([
        ["TELA", 1, 20, true],
        ["SOBRE", 3, 6, false],
        ["TELA", 1, 31, true],
      ]);
      expect(c).toMatchObject({ costo: 57, zona, totalPiezas: 53 });
    }
  });

  it("60 rollos en una sola línea → 60.00", () => {
    expect(cotizarItems([linea("TELA", 60)]).costo).toBe(60);
  });

  it("redondea los subtotales a 2 decimales", () => {
    expect(cotizarItems([linea("TELA", 3)]).items[0]!.subtotal).toBe(3.75);
  });

  it.each([
    [[], /al menos un ítem/],
    [[{ c: 0 }], /cantidad/],
    [[{ c: 1.5 }], /cantidad/],
    [[{ c: 1000 }], /cantidad/],
    [Array.from({ length: 21 }, () => ({ c: 1 })), /Máximo 20/],
  ])("valida líneas y cantidades (%#)", (lineas, msg) => {
    const items = (lineas as { c: number }[]).map(({ c }) => linea("PAQUETE", c));
    expect(() => cotizarItems(items)).toThrow(msg);
  });

  it("valida el peso por unidad de cada línea contra el máximo del tipo", () => {
    expect(() => cotizarItems([linea("SOBRE", 10, 0.6)])).toThrow(/máximo/);
    expect(() => cotizarItems([linea("TELA", 60, 50.5)])).toThrow(DomainError);
  });
});

describe("validarPeso", () => {
  it.each([0, -1, Number.NaN])("rechaza peso %s", (p) => {
    expect(() => validarPeso(tipo("PAQUETE"), p)).toThrow(/mayor a 0/);
  });

  it.each([
    ["PAQUETE", 50],
    ["CARTON", 35],
    ["VALIJA", 25],
    ["TELA", 50],
    ["PLUMON_PEQUENO", 50],
    ["PLUMON_GRANDE", 50],
    ["SOBRE", 0.5],
  ])("%s acepta su peso máximo exacto (%s kg) y rechaza 0.1 kg más", (codigo, max) => {
    expect(() => validarPeso(tipo(codigo), max)).not.toThrow();
    expect(() => validarPeso(tipo(codigo), max + 0.1)).toThrow(/peso máximo/);
  });
});

describe("Zona", () => {
  it("solo URBANA y RURAL", () => {
    expect(esZona("URBANA")).toBe(true);
    expect(esZona("RURAL")).toBe(true);
    expect(esZona("rural")).toBe(false);
    expect(esZona(undefined)).toBe(false);
  });
});
