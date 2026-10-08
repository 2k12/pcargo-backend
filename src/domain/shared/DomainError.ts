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

export interface OpcionesDomainError {
  /**
   * La solicitud tiene la forma correcta pero incumple una regla de negocio (p. ej. falta el consentimiento).
   * Distingue esos `VALIDACION` de los de forma; la capa HTTP los responde como 422.
   */
  regla?: boolean;
}

/** Error de negocio. La capa HTTP traduce `code` a un status. */
export class DomainError extends Error {
  public readonly regla: boolean;

  constructor(
    public readonly code: ErrorCode,
    message: string,
    opciones: OpcionesDomainError = {},
  ) {
    super(message);
    this.name = "DomainError";
    this.regla = opciones.regla ?? false;
  }
}

export const redondear2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
