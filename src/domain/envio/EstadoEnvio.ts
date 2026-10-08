export const ESTADOS = ["REGISTRADO", "EN_TRANSITO", "EN_REPARTO", "ENTREGADO", "CANCELADO"] as const;
export type EstadoEnvio = (typeof ESTADOS)[number];

export const TRANSICIONES: Record<EstadoEnvio, readonly EstadoEnvio[]> = {
  REGISTRADO: ["EN_TRANSITO", "CANCELADO"],
  EN_TRANSITO: ["EN_REPARTO"],
  EN_REPARTO: ["ENTREGADO"],
  ENTREGADO: [],
  CANCELADO: [],
};

export const esEstado = (valor: string): valor is EstadoEnvio =>
  (ESTADOS as readonly string[]).includes(valor);

export const puedeTransicionar = (desde: EstadoEnvio, hacia: EstadoEnvio): boolean =>
  TRANSICIONES[desde].includes(hacia);
