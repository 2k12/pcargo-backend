import { validarPeso, type TipoCarga, type TipoCargaCodigo } from "../carga/TipoCarga.js";
import { DomainError, redondear2 } from "../shared/DomainError.js";
import { ZONA_POR_DEFECTO, type Zona } from "./Zona.js";

// Precio por unidad según el tipo de carga (contrato v8). La ruta NO influye y no hay recargo por peso:
// el peso solo se valida contra el máximo del tipo.

export const MAX_ITEMS = 20;
export const MAX_CANTIDAD = 999;

export interface PrecioUnitario {
  costoUnitario: number;
  /** Se aplicó el precio por volumen. */
  mayoreo: boolean;
}

/**
 * Precio de UNA unidad.
 * 1. Si el tipo tiene mayoreo y `unidadesDelTipo` (suma de ese tipo en TODO el envío) > minimoExclusivo,
 *    cuesta `mayoreo.precio` sin importar la zona.
 * 2. Si no, en zona RURAL usa `precioRural` cuando existe; en otro caso `precio`.
 */
export function calcularPrecioUnitario(tipo: TipoCarga, zona: Zona, unidadesDelTipo: number): PrecioUnitario {
  if (tipo.mayoreo && unidadesDelTipo > tipo.mayoreo.minimoExclusivo) {
    return { costoUnitario: tipo.mayoreo.precio, mayoreo: true };
  }
  const costoUnitario = zona === "RURAL" && tipo.precioRural !== null ? tipo.precioRural : tipo.precio;
  return { costoUnitario, mayoreo: false };
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
  costoUnitario: number;
  subtotal: number;
  mayoreo: boolean;
}

export interface Cotizacion {
  costo: number;
  zona: Zona;
  totalPiezas: number;
  pesoTotalKg: number;
  items: ItemCotizado[];
}

/** Cotiza un envío con varias líneas (p. ej. 5 paquetes + 60 rollos de tela repartidos en dos líneas). */
export function cotizarItems(items: ItemACotizar[], zona: Zona = ZONA_POR_DEFECTO): Cotizacion {
  if (items.length === 0) throw new DomainError("VALIDACION", "El envío debe tener al menos un ítem");
  if (items.length > MAX_ITEMS) throw new DomainError("VALIDACION", `Máximo ${MAX_ITEMS} ítems por envío`);

  for (const { tipo, cantidad, pesoKg } of items) {
    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > MAX_CANTIDAD) {
      throw new DomainError("VALIDACION", `La cantidad debe ser un entero entre 1 y ${MAX_CANTIDAD}`);
    }
    validarPeso(tipo, pesoKg);
  }

  // El mayoreo se decide con la suma de unidades del tipo en todo el envío, no por línea.
  const unidadesPorTipo = new Map<TipoCargaCodigo, number>();
  for (const { tipo, cantidad } of items) {
    unidadesPorTipo.set(tipo.codigo, (unidadesPorTipo.get(tipo.codigo) ?? 0) + cantidad);
  }

  const cotizados = items.map(({ tipo, cantidad, pesoKg }): ItemCotizado => {
    const p = calcularPrecioUnitario(tipo, zona, unidadesPorTipo.get(tipo.codigo)!);
    return {
      tipoCarga: tipo.codigo,
      cantidad,
      pesoKg,
      costoUnitario: p.costoUnitario,
      subtotal: redondear2(p.costoUnitario * cantidad),
      mayoreo: p.mayoreo,
    };
  });

  return {
    costo: redondear2(cotizados.reduce((s, i) => s + i.subtotal, 0)),
    zona,
    totalPiezas: cotizados.reduce((s, i) => s + i.cantidad, 0),
    pesoTotalKg: redondear2(cotizados.reduce((s, i) => s + i.pesoKg * i.cantidad, 0)),
    items: cotizados,
  };
}
