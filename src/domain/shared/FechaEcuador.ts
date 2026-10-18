import { DomainError } from "./DomainError.js";

// Fechas locales de Ecuador continental: UTC−5 todo el año (no hay horario de verano).

export const OFFSET_EC_MS = -5 * 60 * 60 * 1000;
export const DIA_MS = 24 * 60 * 60 * 1000;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

/** Fecha local de Ecuador `YYYY-MM-DD`. */
export const fechaLocalEC = (d: Date): string => new Date(d.getTime() + OFFSET_EC_MS).toISOString().slice(0, 10);

/** Medianoche UTC de una fecha `YYYY-MM-DD` (para aritmética de días). */
export const aTiempo = (fecha: string): number => Date.parse(`${fecha}T00:00:00Z`);

/** Instante en que empieza el día local de Ecuador `YYYY-MM-DD`. */
export const inicioDiaEC = (fecha: string): Date => new Date(aTiempo(fecha) - OFFSET_EC_MS);

/** Primer día del mes local de Ecuador que contiene `d`. */
export const inicioMesEC = (d: Date): string => `${fechaLocalEC(d).slice(0, 8)}01`;

/** Valida el formato `AAAA-MM-DD` (400 VALIDACION, como el filtro del dashboard). */
export function validarFechaEC(texto: string | undefined, campo: string): void {
  if (texto !== undefined && (!FECHA.test(texto) || Number.isNaN(aTiempo(texto)))) {
    throw new DomainError("VALIDACION", `${campo}: use el formato AAAA-MM-DD`);
  }
}

/** Valida un rango de fechas locales (ambas opcionales e inclusivas). */
export function validarRangoEC(desde: string | undefined, hasta: string | undefined): void {
  validarFechaEC(desde, "desde");
  validarFechaEC(hasta, "hasta");
  if (desde && hasta && desde > hasta) {
    throw new DomainError("VALIDACION", "La fecha inicial no puede ser posterior a la final");
  }
}

/** Días consecutivos `YYYY-MM-DD` entre dos fechas (inclusive), como máximo los últimos `max`. */
export function diasEntre(desde: string, hasta: string, max = 92): string[] {
  const fin = aTiempo(hasta);
  const lista: string[] = [];
  for (let t = Math.max(aTiempo(desde), fin - (max - 1) * DIA_MS); t <= fin; t += DIA_MS) {
    lista.push(new Date(t).toISOString().slice(0, 10));
  }
  return lista;
}
