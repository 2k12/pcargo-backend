export type ErrorCode =
  | "VALIDACION"
  | "NO_ENCONTRADO"
  | "NO_AUTENTICADO"
  | "PROHIBIDO"
  | "CONFLICTO"
  | "CREDENCIALES_INVALIDAS"
  | "TRANSICION_INVALIDA"
  | "PESO_INVALIDO"
  | "RUTA_INACTIVA";

/** Error de negocio. La capa HTTP traduce `code` a un status. */
export class DomainError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export const redondear2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
