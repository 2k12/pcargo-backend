import { DomainError } from "../shared/DomainError.js";

export const TIPOS_CARGA = ["SOBRE", "PAQUETE", "CARTON", "VALIJA"] as const;
export type TipoCargaCodigo = (typeof TIPOS_CARGA)[number];

export interface TipoCarga {
  codigo: TipoCargaCodigo;
  nombre: string;
  /** Multiplicador sobre la tarifa base de la ruta. */
  factor: number;
  /** Peso cubierto por la tarifa antes de aplicar recargo. */
  pesoIncluidoKg: number;
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
