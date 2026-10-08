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
