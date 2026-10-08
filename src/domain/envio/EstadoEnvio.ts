export const ESTADOS = [
  "REGISTRADO",
  "EN_TRANSITO",
  "EN_REPARTO",
  "ENTREGADO",
  "NO_ENTREGADO",
  "NOVEDAD",
  "CANCELADO",
] as const;
export type EstadoEnvio = (typeof ESTADOS)[number];

export const TRANSICIONES: Record<EstadoEnvio, readonly EstadoEnvio[]> = {
  REGISTRADO: ["EN_TRANSITO", "CANCELADO"],
  EN_TRANSITO: ["EN_REPARTO", "NOVEDAD"],
  EN_REPARTO: ["ENTREGADO", "NO_ENTREGADO", "NOVEDAD"],
  NOVEDAD: ["EN_REPARTO", "ENTREGADO", "NO_ENTREGADO"],
  NO_ENTREGADO: ["EN_REPARTO"], // reintento de entrega
  ENTREGADO: [],
  CANCELADO: [],
};

/** Resultados de un intento de entrega: se reportan como "gestión de entrega". */
export const ESTADOS_GESTION_ENTREGA = ["ENTREGADO", "NO_ENTREGADO", "NOVEDAD"] as const;
export type ResultadoEntrega = (typeof ESTADOS_GESTION_ENTREGA)[number];

/** Estados que exigen registrar el motivo en la nota. */
export const REQUIEREN_NOTA: readonly EstadoEnvio[] = ["NO_ENTREGADO", "NOVEDAD"];

export const esEstado = (valor: string): valor is EstadoEnvio =>
  (ESTADOS as readonly string[]).includes(valor);

export const esResultadoEntrega = (e: EstadoEnvio): e is ResultadoEntrega =>
  (ESTADOS_GESTION_ENTREGA as readonly string[]).includes(e);

export const puedeTransicionar = (desde: EstadoEnvio, hacia: EstadoEnvio): boolean =>
  TRANSICIONES[desde].includes(hacia);
