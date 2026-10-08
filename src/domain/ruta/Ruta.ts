import { DomainError } from "../shared/DomainError.js";

export interface Ciudad {
  id: number;
  nombre: string;
  /** Una ciudad inactiva deja de ofrecerse: sus rutas no son operativas. */
  activa: boolean;
}

export interface Ruta {
  id: number;
  origen: Ciudad;
  destino: Ciudad;
  tarifaBase: number;
  tiempoEstimadoMin: number;
  activa: boolean;
}

/** Ruta tal como se expone: incluye si puede usarse para envíos nuevos. */
export interface RutaConEstado extends Ruta {
  operativa: boolean;
}

/** Se puede cotizar/enviar solo si la ruta y ambas ciudades están activas. */
export const esOperativa = (r: Ruta): boolean => r.activa && r.origen.activa && r.destino.activa;

export const conEstado = (r: Ruta): RutaConEstado => ({ ...r, operativa: esOperativa(r) });

export const nombreRuta = (r: Pick<Ruta, "origen" | "destino">): string =>
  r.origen.id === r.destino.id
    ? `${r.origen.nombre} (urbano)`
    : `${r.origen.nombre} → ${r.destino.nombre}`;

export function validarDatosRuta(datos: { tarifaBase?: number; tiempoEstimadoMin?: number }): void {
  if (datos.tarifaBase !== undefined && !(datos.tarifaBase > 0)) {
    throw new DomainError("VALIDACION", "La tarifa base debe ser mayor a 0");
  }
  if (
    datos.tiempoEstimadoMin !== undefined &&
    !(Number.isInteger(datos.tiempoEstimadoMin) && datos.tiempoEstimadoMin > 0)
  ) {
    throw new DomainError("VALIDACION", "El tiempo estimado debe ser un entero positivo (minutos)");
  }
}

/** Normaliza y valida el nombre de una ciudad (2 a 60 caracteres, espacios colapsados). */
export function normalizarNombreCiudad(nombre: string): string {
  const limpio = (nombre ?? "").trim().replace(/\s+/g, " ");
  if (limpio.length < 2 || limpio.length > 60) {
    throw new DomainError("VALIDACION", "El nombre de la ciudad debe tener entre 2 y 60 caracteres");
  }
  return limpio;
}
