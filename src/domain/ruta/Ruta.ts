import { DomainError } from "../shared/DomainError.js";

export interface Ciudad {
  id: number;
  nombre: string;
}

export interface Ruta {
  id: number;
  origen: Ciudad;
  destino: Ciudad;
  tarifaBase: number;
  tiempoEstimadoMin: number;
  activa: boolean;
}

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
