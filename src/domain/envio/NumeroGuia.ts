import { DomainError } from "../shared/DomainError.js";

/** Número impreso en la guía física. Solo dígitos; los ceros a la izquierda no cuentan (0040425 = 40425). */
export const MAX_DIGITOS_GUIA = 12;
const MAXIMO = 10 ** MAX_DIGITOS_GUIA - 1;

/** Texto que parece un número de guía (dígitos, con espacios opcionales). Útil para búsquedas. */
export const pareceNumeroGuia = (texto: string): boolean => /^\s*\d[\d\s]*$/.test(texto);

/**
 * Convierte lo que escribe el operador o el cliente en el número canónico.
 * Acepta espacios y ceros a la izquierda; rechaza letras, signos y el cero.
 */
export function parsearNumeroGuia(valor: string | number): number {
  let n: number;
  if (typeof valor === "number") {
    n = valor;
  } else {
    const limpio = valor.replace(/\s+/g, "");
    if (!/^\d+$/.test(limpio)) {
      throw new DomainError("VALIDACION", "El número de guía solo admite dígitos");
    }
    const sinCeros = limpio.replace(/^0+/, "");
    if (sinCeros.length > MAX_DIGITOS_GUIA) {
      throw new DomainError("VALIDACION", `El número de guía admite hasta ${MAX_DIGITOS_GUIA} dígitos`);
    }
    n = Number(sinCeros || "0");
  }
  if (!Number.isInteger(n) || n < 1 || n > MAXIMO) {
    throw new DomainError("VALIDACION", "El número de guía debe ser un entero mayor a 0");
  }
  return n;
}

/**
 * v21: número impreso en una guía física antigua (preimpresa, no del sistema). Mismas reglas de entrada que el número
 * de guía (solo dígitos, hasta 12, sin contar espacios ni ceros a la izquierda). Vacío (undefined, null o solo
 * espacios) → null (el envío no tiene guía física).
 */
export function parsearGuiaFisica(valor: string | number | null | undefined): number | null {
  if (valor === undefined || valor === null) return null;
  if (typeof valor === "string" && valor.trim() === "") return null;
  try {
    return parsearNumeroGuia(valor);
  } catch (e) {
    if (e instanceof DomainError) {
      throw new DomainError("VALIDACION", e.message.replace("El número de guía", "La guía física"));
    }
    throw e;
  }
}
