import { DomainError } from "../shared/DomainError.js";

export const TIPOS_CARGA = [
  "SOBRE",
  "PAQUETE",
  "CARTON",
  "VALIJA",
  "TELA",
  "PLUMON_PEQUENO",
  "PLUMON_GRANDE",
] as const;
export type TipoCargaCodigo = (typeof TIPOS_CARGA)[number];

/** Precio por volumen: con MÁS de `minimoExclusivo` unidades del tipo en el envío, todas cuestan `precio`. */
export interface Mayoreo {
  minimoExclusivo: number;
  precio: number;
}

export interface TipoCarga {
  codigo: TipoCargaCodigo;
  nombre: string;
  /** Precio por unidad (USD) en zona urbana. */
  precio: number;
  /** Precio por unidad en zona rural; null = el mismo que en zona urbana. */
  precioRural: number | null;
  /** Precio por volumen (no depende de la zona); null = no aplica. */
  mayoreo: Mayoreo | null;
  pesoMaxKg: number;
}

export const esTipoCarga = (valor: string): valor is TipoCargaCodigo =>
  (TIPOS_CARGA as readonly string[]).includes(valor);

export function validarPeso(tipo: TipoCarga, pesoKg: number): void {
  if (!Number.isFinite(pesoKg) || pesoKg <= 0) {
    throw new DomainError("PESO_INVALIDO", "El peso debe ser mayor a 0 kg");
  }
  if (pesoKg > tipo.pesoMaxKg) {
    throw new DomainError(
      "PESO_INVALIDO",
      `${tipo.nombre}: peso máximo permitido ${tipo.pesoMaxKg} kg`,
    );
  }
}
