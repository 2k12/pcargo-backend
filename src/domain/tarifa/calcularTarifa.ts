import { validarPeso, type TipoCarga } from "../carga/TipoCarga.js";
import { redondear2 } from "../shared/DomainError.js";

export const RECARGO_POR_KG = 0.5;

export interface Cotizacion {
  costo: number;
  tarifaBase: number;
  factor: number;
  recargoPeso: number;
}

/** costo = tarifaBase * factor + max(0, peso - pesoIncluido) * RECARGO_POR_KG */
export function calcularTarifa(tarifaBase: number, tipo: TipoCarga, pesoKg: number): Cotizacion {
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
