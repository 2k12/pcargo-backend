import { validarPeso, type TipoCarga, type TipoCargaCodigo } from "../carga/TipoCarga.js";
import { DomainError, redondear2 } from "../shared/DomainError.js";

export const RECARGO_POR_KG = 0.5;
export const MAX_ITEMS = 20;
export const MAX_CANTIDAD = 999;

export interface TarifaUnitaria {
  costo: number;
  tarifaBase: number;
  factor: number;
  recargoPeso: number;
}

/** Costo de UNA pieza: tarifaBase * factor + max(0, peso - pesoIncluido) * RECARGO_POR_KG */
export function calcularTarifa(tarifaBase: number, tipo: TipoCarga, pesoKg: number): TarifaUnitaria {
  validarPeso(tipo, pesoKg);
  // Se redondea el exceso antes de multiplicar para evitar errores de coma flotante (3.33 - 2 = 1.3299…).
  const excesoKg = redondear2(Math.max(0, pesoKg - tipo.pesoIncluidoKg));
  const recargoPeso = redondear2(excesoKg * RECARGO_POR_KG);
  return {
    costo: redondear2(tarifaBase * tipo.factor + recargoPeso),
    tarifaBase,
    factor: tipo.factor,
    recargoPeso,
  };
}

export interface ItemACotizar {
  tipo: TipoCarga;
  cantidad: number;
  /** Peso por unidad. */
  pesoKg: number;
}

export interface ItemCotizado {
  tipoCarga: TipoCargaCodigo;
  cantidad: number;
  pesoKg: number;
  factor: number;
  recargoPeso: number;
  costoUnitario: number;
  subtotal: number;
}

export interface Cotizacion {
  costo: number;
  tarifaBase: number;
  totalPiezas: number;
  pesoTotalKg: number;
  items: ItemCotizado[];
}

/** Cotiza un envío con varias líneas (p. ej. 5 paquetes + 20 cartones). */
export function cotizarItems(tarifaBase: number, items: ItemACotizar[]): Cotizacion {
  if (items.length === 0) throw new DomainError("VALIDACION", "El envío debe tener al menos un ítem");
  if (items.length > MAX_ITEMS) throw new DomainError("VALIDACION", `Máximo ${MAX_ITEMS} ítems por envío`);

  const cotizados = items.map(({ tipo, cantidad, pesoKg }): ItemCotizado => {
    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > MAX_CANTIDAD) {
      throw new DomainError("VALIDACION", `La cantidad debe ser un entero entre 1 y ${MAX_CANTIDAD}`);
    }
    const t = calcularTarifa(tarifaBase, tipo, pesoKg);
    return {
      tipoCarga: tipo.codigo,
      cantidad,
      pesoKg,
      factor: t.factor,
      recargoPeso: t.recargoPeso,
      costoUnitario: t.costo,
      subtotal: redondear2(t.costo * cantidad),
    };
  });

  return {
    costo: redondear2(cotizados.reduce((s, i) => s + i.subtotal, 0)),
    tarifaBase,
    totalPiezas: cotizados.reduce((s, i) => s + i.cantidad, 0),
    pesoTotalKg: redondear2(cotizados.reduce((s, i) => s + i.pesoKg * i.cantidad, 0)),
    items: cotizados,
  };
}
