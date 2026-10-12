import type { Envio, ItemEnvio } from "../../domain/envio/Envio.js";
import type { ApiKey, EventoWebhook, Integracion } from "../../domain/integracion/Integracion.js";
import type { EntregaWebhook } from "../../domain/integracion/Webhook.js";
import type { Ruta } from "../../domain/ruta/Ruta.js";
import type { SolicitudApi } from "../ports/integraciones.js";

export interface ApiKeyDTO {
  id: string;
  nombre: string;
  modo: "live" | "test";
  prefijo: string;
  alcances: string[];
  creadaEn: string;
  ultimoUsoEn: string | null;
  revocadaEn: string | null;
}

export interface IntegracionDTO {
  id: string;
  nombre: string;
  activa: boolean;
  remitente: { nombre: string; telefono: string; direccion: string };
  ciudadOrigenId: number;
  ciudadOrigen: string;
  formaPagoPorDefecto: string;
  clienteId: string | null;
  ipsPermitidas: string[];
  keys: ApiKeyDTO[];
  webhook: { url: string; eventos: EventoWebhook[]; activo: boolean; secretoPrefijo: string } | null;
  envios: number;
  ultimoEnvio: string | null;
  creadaEn: string;
}

export interface EntregaWebhookDTO {
  id: string;
  evento: EventoWebhook;
  envioId: string | null;
  numeroGuia: number | null;
  estado: string;
  intentos: number;
  ultimoStatus: number | null;
  ultimoError: string | null;
  proximoIntentoEn: string | null;
  creadoEn: string;
  entregadoEn: string | null;
}

export interface SolicitudApiDTO {
  id: string;
  fecha: string;
  metodo: string;
  ruta: string;
  status: number;
  ip: string;
  keyPrefijo: string | null;
  idempotencyKey: string | null;
  referenciaExterna: string | null;
  duracionMs: number;
  requestId: string;
}

/** Envío visto por la empresa: sin remitente (es ella), sin operadores ni foto de evidencia. */
export interface EnvioApiDTO {
  id: string;
  numeroGuia: number;
  referenciaExterna: string;
  prueba: boolean;
  estado: string;
  origen: string;
  destino: string;
  destinatario: { nombre: string; telefono: string; direccion: string };
  items: ItemEnvio[];
  totalPiezas: number;
  pesoTotalKg: number;
  zona: string;
  costo: number;
  formaPago: string;
  descripcion: string | null;
  seguimientoUrl: string;
  entrega: { resultado: string; fecha: string; nota: string | null } | null;
  evidencia: { recibidoPor: string; subidaEn: string } | null;
  creadoEn: string;
  actualizadoEn: string;
  historial?: { estado: string; nota: string | null; fecha: string }[];
}

export const toApiKeyDTO = (k: ApiKey): ApiKeyDTO => ({
  id: k.id,
  nombre: k.nombre,
  modo: k.modo,
  prefijo: k.prefijo,
  alcances: [...k.alcances],
  creadaEn: k.creadaEn.toISOString(),
  ultimoUsoEn: k.ultimoUsoEn?.toISOString() ?? null,
  revocadaEn: k.revocadaEn?.toISOString() ?? null,
});

export function toIntegracionDTO(
  i: Integracion,
  ciudadOrigen: string,
  est: { envios: number; ultimoEnvio: Date | null } = { envios: 0, ultimoEnvio: null },
): IntegracionDTO {
  return {
    id: i.id,
    nombre: i.nombre,
    activa: i.activa,
    remitente: { ...i.remitente },
    ciudadOrigenId: i.ciudadOrigenId,
    ciudadOrigen,
    formaPagoPorDefecto: i.formaPagoPorDefecto,
    clienteId: i.clienteId,
    ipsPermitidas: [...i.ipsPermitidas],
    keys: [...i.keys].sort((a, b) => b.creadaEn.getTime() - a.creadaEn.getTime()).map(toApiKeyDTO),
    webhook: i.webhook && {
      url: i.webhook.url,
      eventos: [...i.webhook.eventos],
      activo: i.webhook.activo,
      secretoPrefijo: i.webhook.secretoPrefijo,
    },
    envios: est.envios,
    ultimoEnvio: est.ultimoEnvio?.toISOString() ?? null,
    creadaEn: i.creadaEn.toISOString(),
  };
}

export const toEntregaWebhookDTO = (e: EntregaWebhook): EntregaWebhookDTO => ({
  id: e.id,
  evento: e.evento,
  envioId: e.envioId,
  numeroGuia: e.numeroGuia,
  estado: e.estado,
  intentos: e.intentos,
  ultimoStatus: e.ultimoStatus,
  ultimoError: e.ultimoError,
  proximoIntentoEn: e.proximoIntentoEn?.toISOString() ?? null,
  creadoEn: e.creadoEn.toISOString(),
  entregadoEn: e.entregadoEn?.toISOString() ?? null,
});

export const toSolicitudApiDTO = (s: SolicitudApi): SolicitudApiDTO => ({
  id: s.id,
  fecha: s.fecha.toISOString(),
  metodo: s.metodo,
  ruta: s.ruta,
  status: s.status,
  ip: s.ip,
  keyPrefijo: s.keyPrefijo,
  idempotencyKey: s.idempotencyKey,
  referenciaExterna: s.referenciaExterna,
  duracionMs: s.duracionMs,
  requestId: s.requestId,
});

/** `<PUBLIC_URL>/seguimiento/<numeroGuia>` sin barras repetidas. */
export const urlSeguimiento = (publicUrl: string, numeroGuia: number): string =>
  `${publicUrl.replace(/\/+$/, "")}/seguimiento/${numeroGuia}`;

export function toEnvioApiDTO(
  envio: Envio,
  ruta: Ruta | undefined,
  opciones: { publicUrl: string; prueba?: boolean; conHistorial?: boolean },
): EnvioApiDTO {
  const s = envio.toSnapshot();
  const entrega = envio.ultimaGestionEntrega;
  return {
    id: s.id,
    numeroGuia: s.numeroGuia,
    referenciaExterna: s.referenciaExterna ?? "",
    prueba: opciones.prueba ?? false,
    estado: s.estado,
    origen: ruta?.origen.nombre ?? "?",
    destino: ruta?.destino.nombre ?? "?",
    destinatario: { ...s.destinatario },
    items: s.items.map((i) => ({ ...i })),
    totalPiezas: envio.totalPiezas,
    pesoTotalKg: envio.pesoTotalKg,
    zona: s.zona,
    costo: s.costo,
    formaPago: s.formaPago,
    descripcion: s.descripcion,
    seguimientoUrl: urlSeguimiento(opciones.publicUrl, s.numeroGuia),
    entrega: entrega && { resultado: entrega.resultado, fecha: entrega.fecha.toISOString(), nota: entrega.nota },
    evidencia: s.evidencia ? { recibidoPor: s.evidencia.recibidoPor, subidaEn: s.evidencia.subidaEn.toISOString() } : null,
    creadoEn: s.creadoEn.toISOString(),
    actualizadoEn: s.actualizadoEn.toISOString(),
    ...(opciones.conHistorial
      ? { historial: s.historial.map((h) => ({ estado: h.estado, nota: h.nota, fecha: h.fecha.toISOString() })) }
      : {}),
  };
}
