import { DomainError } from "../shared/DomainError.js";

// Idempotencia de la API para empresas (POST /envios y /envios/lote).

/** Las respuestas guardadas se reproducen durante 24 h. */
export const VIGENCIA_IDEMPOTENCIA_MS = 24 * 60 * 60 * 1000;
/** Una solicitud "en proceso" más vieja que esto se considera abandonada (p. ej. el proceso se reinició). */
export const ABANDONO_IDEMPOTENCIA_MS = 5 * 60 * 1000;

const CLAVE = /^[\x21-\x7e]{1,255}$/;

/** 1–255 caracteres ASCII visibles. Falta o inválida → VALIDACION (400). */
export function validarClaveIdempotencia(clave: unknown): string {
  if (typeof clave !== "string" || clave.length === 0) {
    throw new DomainError("VALIDACION", "Falta el header Idempotency-Key");
  }
  if (!CLAVE.test(clave)) {
    throw new DomainError("VALIDACION", "Idempotency-Key debe tener entre 1 y 255 caracteres ASCII visibles");
  }
  return clave;
}

/**
 * JSON canónico: claves de objetos ordenadas recursivamente y sin espacios. Dos cuerpos con el mismo contenido
 * (aunque cambie el orden de las claves) producen el mismo texto, y por tanto el mismo hash.
 */
export function jsonCanonico(valor: unknown): string {
  if (valor === null || typeof valor !== "object") return JSON.stringify(valor) ?? "null";
  if (Array.isArray(valor)) return `[${valor.map((v) => (v === undefined ? "null" : jsonCanonico(v))).join(",")}]`;
  const entradas = Object.entries(valor as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entradas.map(([k, v]) => `${JSON.stringify(k)}:${jsonCanonico(v)}`).join(",")}}`;
}

export interface RespuestaGuardada {
  status: number;
  /** Cuerpo JSON exacto de la primera respuesta. */
  cuerpo: string;
}

export type ResultadoReserva =
  | { tipo: "nueva" }
  | { tipo: "repetida"; respuesta: RespuestaGuardada }
  | { tipo: "conflicto" }
  | { tipo: "en_proceso" };
