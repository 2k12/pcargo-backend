import { DomainError } from "../shared/DomainError.js";

/** Número de pedido de la empresa: 1–64 caracteres `[A-Za-z0-9._\-/#]`, único por integración. */
export const REFERENCIA_EXTERNA = /^[A-Za-z0-9._\-/#]{1,64}$/;

export function validarReferenciaExterna(ref: unknown): string {
  if (typeof ref !== "string" || !REFERENCIA_EXTERNA.test(ref)) {
    throw new DomainError("VALIDACION", "referenciaExterna: 1 a 64 caracteres (letras, dígitos y . _ - / #)");
  }
  return ref;
}

export const notaRegistroApi = (integracion: string): string => `Ingresado por API: ${integracion}`;
