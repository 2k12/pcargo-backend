/**
 * PAGADO: pagado al enviar · AL_COBRO: paga el destinatario al recibir ·
 * CONTRATO: cliente corporativo con contrato/crédito · SEGURO: cubierto por seguro.
 */
export const FORMAS_PAGO = ["PAGADO", "AL_COBRO", "CONTRATO", "SEGURO"] as const;
export type FormaPago = (typeof FORMAS_PAGO)[number];

export const esFormaPago = (valor: string): valor is FormaPago =>
  (FORMAS_PAGO as readonly string[]).includes(valor);
