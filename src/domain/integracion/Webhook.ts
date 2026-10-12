import type { EventoWebhook } from "./Integracion.js";

// Entregas de webhooks (Standard Webhooks) y su política de reintentos.

export const ESTADOS_ENTREGA = ["PENDIENTE", "ENTREGADO", "FALLIDO"] as const;
export type EstadoEntrega = (typeof ESTADOS_ENTREGA)[number];

const MIN = 60_000;
/** Espera antes de cada reintento: 1 min, 5 min, 30 min, 2 h, 6 h, 12 h, 24 h (8 intentos en total). */
export const ESPERAS_REINTENTO_MS = [1 * MIN, 5 * MIN, 30 * MIN, 120 * MIN, 360 * MIN, 720 * MIN, 1440 * MIN] as const;
export const MAX_INTENTOS_WEBHOOK = ESPERAS_REINTENTO_MS.length + 1;
/** Una respuesta 2xx en este plazo cuenta como entregada. */
export const TIMEOUT_WEBHOOK_MS = 10_000;

export interface EntregaWebhook {
  id: string;
  integracionId: string;
  /** `webhook-id`: igual en todos los reintentos del mismo mensaje. */
  mensajeId: string;
  evento: EventoWebhook;
  envioId: string | null;
  numeroGuia: number | null;
  /** Cuerpo JSON exacto que se firma y envía (mismo en cada reintento). */
  cuerpo: string;
  /** Evento de prueba enviado desde el panel: un solo intento, sin reintentos. */
  prueba: boolean;
  estado: EstadoEntrega;
  intentos: number;
  ultimoStatus: number | null;
  ultimoError: string | null;
  proximoIntentoEn: Date | null;
  creadoEn: Date;
  entregadoEn: Date | null;
}

export interface ResultadoEnvioWebhook {
  /** Respuesta 2xx dentro del plazo. */
  ok: boolean;
  status: number | null;
  error: string | null;
}

/** Cuándo reintentar tras `intentos` intentos fallidos, o `null` si ya no quedan (→ FALLIDO). */
export function proximoReintento(intentos: number, ahora: Date): Date | null {
  if (intentos >= MAX_INTENTOS_WEBHOOK) return null;
  const espera = ESPERAS_REINTENTO_MS[intentos - 1];
  return espera === undefined ? null : new Date(ahora.getTime() + espera);
}

/** Aplica el resultado de un intento a la entrega (pura: devuelve una copia). */
export function registrarIntento(e: EntregaWebhook, r: ResultadoEnvioWebhook, ahora: Date): EntregaWebhook {
  const intentos = e.intentos + 1;
  const base = { ...e, intentos, ultimoStatus: r.status, ultimoError: r.ok ? null : (r.error ?? `HTTP ${r.status}`) };
  if (r.ok) return { ...base, estado: "ENTREGADO", proximoIntentoEn: null, entregadoEn: ahora };
  const proximo = e.prueba ? null : proximoReintento(intentos, ahora);
  return proximo
    ? { ...base, estado: "PENDIENTE", proximoIntentoEn: proximo }
    : { ...base, estado: "FALLIDO", proximoIntentoEn: null };
}

/** Recorta textos de error para no guardar respuestas enormes. */
export const recortarError = (s: string, max = 300): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
