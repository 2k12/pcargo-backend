export type ErrorCode =
  | "VALIDACION"
  | "NO_ENCONTRADO"
  | "NO_AUTENTICADO"
  | "PROHIBIDO"
  | "CONFLICTO"
  | "CREDENCIALES_INVALIDAS"
  | "TRANSICION_INVALIDA"
  | "PESO_INVALIDO"
  | "RUTA_INACTIVA"
  /** La operación no se admite en el estado actual del recurso (p. ej. evidencia de un envío no entregado). */
  | "ESTADO_INVALIDO"
  /** La contraseña actual no coincide al cambiarla (no es 401: la sesión sigue siendo válida). */
  | "CONTRASENA_INCORRECTA"
  // ── API para empresas (v10) ──
  /** Sin key, con formato inválido, inexistente o revocada: siempre el mismo mensaje. */
  | "API_KEY_INVALIDA"
  | "ALCANCE_INSUFICIENTE"
  | "IP_NO_PERMITIDA"
  | "INTEGRACION_INACTIVA"
  | "IDEMPOTENCIA_CONFLICTO"
  | "IDEMPOTENCIA_EN_PROCESO"
  /** Ciudad de destino desconocida o sin ruta operativa desde la ciudad de origen de la integración. */
  | "RUTA_NO_DISPONIBLE"
  /** Falta configuración del servidor para la operación (p. ej. la clave de cifrado de los webhooks). */
  | "SERVICIO_NO_CONFIGURADO"
  /** Tipo de carga desactivado por el ADMIN: no se puede cotizar ni usar en envíos nuevos (v11). */
  | "TIPO_CARGA_INACTIVO";

export interface OpcionesDomainError {
  /**
   * La solicitud tiene la forma correcta pero incumple una regla de negocio (p. ej. falta el consentimiento).
   * Distingue esos `VALIDACION` de los de forma; la capa HTTP los responde como 422.
   */
  regla?: boolean;
  /** Datos adicionales que viajan dentro de `error` (p. ej. `envio` en un 409 de referencia repetida). */
  detalles?: Record<string, unknown>;
}

/** Error de negocio. La capa HTTP traduce `code` a un status. */
export class DomainError extends Error {
  public readonly regla: boolean;
  public readonly detalles: Record<string, unknown> | undefined;

  constructor(
    public readonly code: ErrorCode,
    message: string,
    opciones: OpcionesDomainError = {},
  ) {
    super(message);
    this.name = "DomainError";
    this.regla = opciones.regla ?? false;
    this.detalles = opciones.detalles;
  }
}

export const redondear2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
