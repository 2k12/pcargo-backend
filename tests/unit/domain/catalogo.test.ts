import { describe, expect, it } from "vitest";
import {
  accionDeCambios,
  diferenciasTipoCarga,
  exigirAlgunoActivo,
  exigirTipoUsable,
  normalizarDatosTipoCarga,
  validarCodigoTipoCarga,
  type DatosTipoCarga,
  type TipoCarga,
} from "../../../src/domain/carga/TipoCarga.js";
import {
  compararArticulos,
  exigirMismoConjunto,
  normalizarDatosArticulo,
  type ArticuloRestringido,
} from "../../../src/domain/catalogo/ArticuloRestringido.js";
import { cotizarItems } from "../../../src/domain/tarifa/calcularTarifa.js";
import { ARTICULOS_SEED, TIPOS_CARGA_SEED } from "../../../src/infrastructure/persistence/seed-data.js";

const datos = (sobre: Partial<DatosTipoCarga> = {}): DatosTipoCarga => ({
  nombre: "Caja grande",
  precio: 5.5,
  precioRural: null,
  mayoreo: null,
  pesoMaxKg: 40,
  ...sobre,
});

describe("tipo de carga: código", () => {
  it.each(["SOBRE", "CAJA_GRANDE", "C1", "A".repeat(30)])("acepta %s", (c) => {
    expect(validarCodigoTipoCarga(c)).toBe(c);
  });

  it.each(["", "A", "caja", "1CAJA", "_CAJA", "CAJA-GRANDE", "CAJA GRANDE", "A".repeat(31), 12])("rechaza %s → VALIDACION", (c) => {
    expect(() => validarCodigoTipoCarga(c)).toThrow(expect.objectContaining({ code: "VALIDACION" }));
  });
});

describe("tipo de carga: datos (contrato v11)", () => {
  it("normaliza: nombre sin espacios sobrantes, activo por defecto true, montos a 2 decimales", () => {
    expect(normalizarDatosTipoCarga(datos({ nombre: "  Caja   grande ", precio: 0.1 + 0.2 }))).toEqual({
      nombre: "Caja grande",
      precio: 0.3,
      precioRural: null,
      mayoreo: null,
      pesoMaxKg: 40,
      activo: true,
    });
    expect(normalizarDatosTipoCarga(datos({ activo: false, precioRural: 6.25, mayoreo: { minimoExclusivo: 10, precio: 4.99 } }))).toMatchObject({
      activo: false,
      precioRural: 6.25,
      mayoreo: { minimoExclusivo: 10, precio: 4.99 },
    });
  });

  it.each<[string, Partial<DatosTipoCarga>]>([
    ["nombre de 1 carácter", { nombre: "X" }],
    ["nombre de 41 caracteres", { nombre: "x".repeat(41) }],
    ["precio 0", { precio: 0 }],
    ["precio negativo", { precio: -1 }],
    ["precio > 1000", { precio: 1000.01 }],
    ["precio con 3 decimales", { precio: 1.255 }],
    ["precio NaN", { precio: Number.NaN }],
    ["precioRural 0", { precioRural: 0 }],
    ["precioRural con 3 decimales", { precioRural: 2.001 }],
    ["pesoMaxKg 0", { pesoMaxKg: 0 }],
    ["pesoMaxKg > 1000", { pesoMaxKg: 1001 }],
    ["pesoMaxKg con 3 decimales", { pesoMaxKg: 0.125 }],
    ["mayoreo.minimoExclusivo 0", { mayoreo: { minimoExclusivo: 0, precio: 1 } }],
    ["mayoreo.minimoExclusivo 10000", { mayoreo: { minimoExclusivo: 10000, precio: 1 } }],
    ["mayoreo.minimoExclusivo decimal", { mayoreo: { minimoExclusivo: 5.5, precio: 1 } }],
    ["mayoreo.precio igual al precio", { mayoreo: { minimoExclusivo: 5, precio: 5.5 } }],
    ["mayoreo.precio mayor que el precio", { mayoreo: { minimoExclusivo: 5, precio: 6 } }],
    ["mayoreo.precio 0", { mayoreo: { minimoExclusivo: 5, precio: 0 } }],
  ])("rechaza %s → VALIDACION", (_caso, sobre) => {
    expect(() => normalizarDatosTipoCarga(datos(sobre))).toThrow(expect.objectContaining({ code: "VALIDACION" }));
  });

  it("acepta los límites: precio y peso 1000, mínimo de mayoreo 1 y 9999", () => {
    expect(() => normalizarDatosTipoCarga(datos({ precio: 1000, pesoMaxKg: 1000, mayoreo: { minimoExclusivo: 9999, precio: 999.99 } }))).not.toThrow();
    expect(() => normalizarDatosTipoCarga(datos({ mayoreo: { minimoExclusivo: 1, precio: 0.01 } }))).not.toThrow();
  });
});

describe("tipo de carga: uso en cotizaciones y envíos", () => {
  const sobre = TIPOS_CARGA_SEED[0]!;

  it("código inexistente → 422 VALIDACION (regla); inactivo → TIPO_CARGA_INACTIVO", () => {
    expect(() => exigirTipoUsable(undefined, "PIANO")).toThrow(expect.objectContaining({ code: "VALIDACION", regla: true }));
    expect(() => exigirTipoUsable({ ...sobre, activo: false }, "SOBRE")).toThrow(expect.objectContaining({ code: "TIPO_CARGA_INACTIVO" }));
    expect(exigirTipoUsable(sobre, "SOBRE")).toBe(sobre);
  });

  it("debe quedar al menos un tipo activo → CONFLICTO", () => {
    expect(() => exigirAlgunoActivo([{ activo: false }, { activo: false }])).toThrow(expect.objectContaining({ code: "CONFLICTO" }));
    expect(() => exigirAlgunoActivo([])).toThrow(expect.objectContaining({ code: "CONFLICTO" }));
    expect(() => exigirAlgunoActivo([{ activo: false }, { activo: true }])).not.toThrow();
  });

  it("un tipo nuevo cotiza con la misma regla de precio (urbano, rural y mayoreo de todo el envío)", () => {
    const caja: TipoCarga = {
      codigo: "CAJA_GRANDE",
      nombre: "Caja grande",
      precio: 5.5,
      precioRural: 6.25,
      mayoreo: { minimoExclusivo: 10, precio: 4.75 },
      pesoMaxKg: 40,
      activo: true,
      orden: 8,
      actualizadoEn: null,
      actualizadoPor: null,
    };
    expect(cotizarItems([{ tipo: caja, cantidad: 2, pesoKg: 10 }]).costo).toBe(11);
    expect(cotizarItems([{ tipo: caja, cantidad: 2, pesoKg: 10 }], "RURAL").costo).toBe(12.5);
    expect(cotizarItems([{ tipo: caja, cantidad: 5, pesoKg: 1 }, { tipo: caja, cantidad: 6, pesoKg: 1 }], "RURAL").costo).toBe(52.25);
    expect(() => cotizarItems([{ tipo: caja, cantidad: 1, pesoKg: 41 }])).toThrow(expect.objectContaining({ code: "PESO_INVALIDO" }));
  });
});

describe("tipo de carga: historial", () => {
  const base = { ...TIPOS_CARGA_SEED[4]! }; // TELA

  it("diff campo a campo: alta (antes null), cambio y eliminación (después null)", () => {
    const alta = diferenciasTipoCarga(null, base);
    expect(alta.map((c) => c.campo)).toEqual(["nombre", "precio", "precioRural", "mayoreo", "pesoMaxKg", "activo", "orden"]);
    expect(alta.find((c) => c.campo === "mayoreo")).toEqual({ campo: "mayoreo", antes: null, despues: { minimoExclusivo: 50, precio: 1 } });

    const cambio = diferenciasTipoCarga(base, { ...base, precio: 1.3, mayoreo: { minimoExclusivo: 60, precio: 1 } });
    expect(cambio).toEqual([
      { campo: "precio", antes: 1.25, despues: 1.3 },
      { campo: "mayoreo", antes: { minimoExclusivo: 50, precio: 1 }, despues: { minimoExclusivo: 60, precio: 1 } },
    ]);
    expect(diferenciasTipoCarga(base, { ...base, actualizadoPor: "otro", actualizadoEn: new Date() })).toEqual([]);
    expect(diferenciasTipoCarga(base, null).every((c) => c.despues === null)).toBe(true);
  });

  it("acción: ACTIVADO/DESACTIVADO si solo cambia `activo`; si cambia algo más, MODIFICADO", () => {
    expect(accionDeCambios(diferenciasTipoCarga(base, { ...base, activo: false }))).toBe("DESACTIVADO");
    expect(accionDeCambios(diferenciasTipoCarga({ ...base, activo: false }, base))).toBe("ACTIVADO");
    expect(accionDeCambios(diferenciasTipoCarga(base, { ...base, activo: false, precio: 2 }))).toBe("MODIFICADO");
    expect(accionDeCambios(diferenciasTipoCarga(base, { ...base, orden: 1 }))).toBe("MODIFICADO");
  });
});

describe("artículos restringidos", () => {
  it("normaliza: título recortado, detalle vacío si falta, ícono null en las notas, activo por defecto", () => {
    expect(normalizarDatosArticulo({ categoria: "PROHIBIDO", titulo: "  Baterías   sueltas ", icono: "bateria" })).toEqual({
      categoria: "PROHIBIDO",
      titulo: "Baterías sueltas",
      detalle: "",
      icono: "bateria",
      activo: true,
    });
    expect(normalizarDatosArticulo({ categoria: "NOTA", titulo: "Declara el contenido", icono: "alerta", detalle: null })).toMatchObject({
      icono: null,
      detalle: "",
    });
    expect(normalizarDatosArticulo({ categoria: "CONDICIONADO", titulo: "Plantas" }).icono).toBeNull();
  });

  it.each<[string, Record<string, unknown>]>([
    ["título de 1 carácter", { titulo: "X" }],
    ["título de 81 caracteres", { titulo: "x".repeat(81) }],
    ["detalle de 301 caracteres", { detalle: "x".repeat(301) }],
    ["ícono desconocido", { icono: "cohete" }],
    ["categoría desconocida", { categoria: "OTRA" }],
  ])("rechaza %s → VALIDACION", (_c, sobre) => {
    expect(() => normalizarDatosArticulo({ categoria: "PROHIBIDO", titulo: "Armas", ...sobre } as never)).toThrow(
      expect.objectContaining({ code: "VALIDACION" }),
    );
  });

  it("orden de publicación: PROHIBIDO, CONDICIONADO, NOTA y luego por orden", () => {
    const a = (id: string, categoria: ArticuloRestringido["categoria"], orden: number) =>
      ({ ...ARTICULOS_SEED[0]!, id, categoria, orden }) as ArticuloRestringido;
    const lista = [a("n1", "NOTA", 1), a("c2", "CONDICIONADO", 2), a("p2", "PROHIBIDO", 2), a("c1", "CONDICIONADO", 1), a("p1", "PROHIBIDO", 1)];
    expect(lista.sort(compararArticulos).map((x) => x.id)).toEqual(["p1", "p2", "c1", "c2", "n1"]);
  });

  it("reordenar exige todos los elementos, sin repetir ni agregar → 422 VALIDACION", () => {
    expect(() => exigirMismoConjunto(["a", "b"], ["b", "a"], "x")).not.toThrow();
    for (const pedidos of [["a"], ["a", "a"], ["a", "b", "c"], ["a", "c"]]) {
      expect(() => exigirMismoConjunto(pedidos, ["a", "b"], "x")).toThrow(expect.objectContaining({ code: "VALIDACION", regla: true }));
    }
  });

  it("la semilla es la lista de la landing v9: 9 prohibidos, 3 condicionados y 2 notas sin ícono", () => {
    const por = (c: string) => ARTICULOS_SEED.filter((x) => x.categoria === c);
    expect(por("PROHIBIDO").map((x) => x.icono)).toEqual(["dinero", "documento", "joya", "arma", "explosivo", "fuego", "droga", "animal", "prohibido"]);
    expect(por("CONDICIONADO").map((x) => x.icono)).toEqual(["perecible", "liquido", "fragil"]);
    expect(por("NOTA").map((x) => `${x.titulo} ${x.detalle}`.trim())).toEqual([
      "Declara siempre el contenido real de tu envío. Podemos pedir revisar un paquete antes de recibirlo.",
      "No entregamos en apartados postales.",
    ]);
    expect(por("NOTA").every((x) => x.icono === null)).toBe(true);
    // todos pasan las validaciones del contrato
    for (const x of ARTICULOS_SEED) expect(() => normalizarDatosArticulo(x)).not.toThrow();
  });
});
