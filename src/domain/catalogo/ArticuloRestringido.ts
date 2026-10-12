import { DomainError } from "../shared/DomainError.js";

// Artículos restringidos de la landing («Qué no transportamos»), configurables por el ADMIN (contrato v11).

/** En este orden se publican: prohibidos, condicionados y, al final, las notas generales. */
export const CATEGORIAS_ARTICULO = ["PROHIBIDO", "CONDICIONADO", "NOTA"] as const;
export type CategoriaArticulo = (typeof CATEGORIAS_ARTICULO)[number];

export const ICONOS_ARTICULO = [
  "dinero",
  "documento",
  "joya",
  "arma",
  "explosivo",
  "fuego",
  "quimico",
  "droga",
  "animal",
  "prohibido",
  "perecible",
  "liquido",
  "fragil",
  "bateria",
  "planta",
  "medicina",
  "electronico",
  "alerta",
] as const;
export type IconoArticulo = (typeof ICONOS_ARTICULO)[number];

export const TITULO_ARTICULO = { min: 2, max: 80 } as const;
export const MAX_DETALLE_ARTICULO = 300;

export interface ArticuloRestringido {
  id: string;
  categoria: CategoriaArticulo;
  titulo: string;
  detalle: string;
  /** Siempre null en las notas. */
  icono: IconoArticulo | null;
  /** Los inactivos no se publican. */
  activo: boolean;
  /** Orden dentro de su categoría. */
  orden: number;
  actualizadoEn: Date;
  actualizadoPor: string | null;
}

export interface DatosArticulo {
  categoria: CategoriaArticulo;
  titulo: string;
  detalle?: string | null;
  icono?: IconoArticulo | null;
  activo?: boolean;
}

export const esCategoriaArticulo = (v: unknown): v is CategoriaArticulo =>
  (CATEGORIAS_ARTICULO as readonly unknown[]).includes(v);
export const esIconoArticulo = (v: unknown): v is IconoArticulo => (ICONOS_ARTICULO as readonly unknown[]).includes(v);

const invalido = (mensaje: string) => new DomainError("VALIDACION", mensaje);

/** Valida y normaliza: título 2–80, detalle 0–300 (vacío si falta), ícono del catálogo (null en las notas). */
export function normalizarDatosArticulo(d: DatosArticulo): Required<DatosArticulo> & { detalle: string } {
  if (!esCategoriaArticulo(d.categoria)) throw invalido("categoria: PROHIBIDO, CONDICIONADO o NOTA");
  const titulo = typeof d.titulo === "string" ? d.titulo.trim().replace(/\s+/g, " ") : "";
  if (titulo.length < TITULO_ARTICULO.min || titulo.length > TITULO_ARTICULO.max) {
    throw invalido(`titulo: de ${TITULO_ARTICULO.min} a ${TITULO_ARTICULO.max} caracteres`);
  }
  const detalle = typeof d.detalle === "string" ? d.detalle.trim() : "";
  if (d.detalle !== undefined && d.detalle !== null && typeof d.detalle !== "string") throw invalido("detalle: texto");
  if (detalle.length > MAX_DETALLE_ARTICULO) throw invalido(`detalle: máximo ${MAX_DETALLE_ARTICULO} caracteres`);
  let icono: IconoArticulo | null = null;
  if (d.categoria !== "NOTA" && d.icono !== undefined && d.icono !== null) {
    if (!esIconoArticulo(d.icono)) throw invalido(`icono: uno de ${ICONOS_ARTICULO.join(", ")}`);
    icono = d.icono;
  }
  if (d.activo !== undefined && typeof d.activo !== "boolean") throw invalido("activo: debe ser true o false");
  return { categoria: d.categoria, titulo, detalle, icono, activo: d.activo ?? true };
}

/** Orden de publicación: categoría (PROHIBIDO, CONDICIONADO, NOTA), orden y, a igualdad, id. */
export function compararArticulos(a: ArticuloRestringido, b: ArticuloRestringido): number {
  return (
    CATEGORIAS_ARTICULO.indexOf(a.categoria) - CATEGORIAS_ARTICULO.indexOf(b.categoria) ||
    a.orden - b.orden ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * Un reordenamiento debe nombrar todos los elementos (sin repetir ni agregar otros); si no → 422 VALIDACION.
 * Sirve para los tipos de carga (códigos) y para los artículos de una categoría (ids).
 */
export function exigirMismoConjunto(pedidos: string[], existentes: string[], que: string): void {
  const unicos = new Set(pedidos);
  const completos = unicos.size === pedidos.length && unicos.size === existentes.length && existentes.every((x) => unicos.has(x));
  if (!completos) {
    throw new DomainError("VALIDACION", `Indique todos los ${que}, una sola vez cada uno`, { regla: true });
  }
}
