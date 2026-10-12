import type { Envio, EventoHistorial, ItemEnvio } from "../../domain/envio/Envio.js";
import type { EvidenciaEntrega } from "../../domain/envio/Evidencia.js";
import type { OrigenEnvio } from "../../domain/integracion/Integracion.js";
import type { Ruta } from "../../domain/ruta/Ruta.js";

export interface EventoHistorialDTO {
  estado: string;
  nota: string | null;
  fecha: string;
  usuario: string | null;
}

export interface GestionDTO {
  fecha: string;
  operador: string | null;
}

export interface GestionEntregaDTO extends GestionDTO {
  resultado: string;
  nota: string | null;
}

/** Metadatos de la evidencia de entrega. La clave del almacén no se expone. */
export interface EvidenciaEntregaDTO {
  recibidoPor: string;
  tipo: string;
  bytes: number;
  subidaEn: string;
  subidaPor: string | null;
}

export interface EnvioDTO {
  id: string;
  numeroGuia: number;
  clienteId: string | null;
  remitente: { nombre: string; telefono: string; direccion: string | null };
  destinatario: { nombre: string; telefono: string; direccion: string };
  ruta: { id: number; origen: string; destino: string };
  items: ItemEnvio[];
  totalPiezas: number;
  pesoTotalKg: number;
  zona: string;
  descripcion: string | null;
  costo: number;
  formaPago: string;
  estado: string;
  registro: GestionDTO;
  entrega: GestionEntregaDTO | null;
  evidencia: EvidenciaEntregaDTO | null;
  /** PANEL o API (+ integración). */
  origen: OrigenEnvio;
  referenciaExterna: string | null;
  creadoEn: string;
  actualizadoEn: string;
  historial?: EventoHistorialDTO[];
}

export const toEventoDTO = (e: EventoHistorial): EventoHistorialDTO => ({
  estado: e.estado,
  nota: e.nota,
  fecha: e.fecha.toISOString(),
  usuario: e.usuario?.nombre ?? null,
});

export const toEvidenciaDTO = (e: EvidenciaEntrega): EvidenciaEntregaDTO => ({
  recibidoPor: e.recibidoPor,
  tipo: e.tipo,
  bytes: e.bytes,
  subidaEn: e.subidaEn.toISOString(),
  subidaPor: e.subidaPor?.nombre ?? null,
});

export function toEnvioDTO(envio: Envio, ruta: Ruta | undefined, conHistorial = false): EnvioDTO {
  const s = envio.toSnapshot();
  const entrega = envio.ultimaGestionEntrega;
  return {
    id: s.id,
    numeroGuia: s.numeroGuia,
    clienteId: s.clienteId ?? null,
    remitente: { nombre: s.remitente.nombre, telefono: s.remitente.telefono, direccion: s.remitente.direccion ?? null },
    destinatario: s.destinatario,
    ruta: { id: s.rutaId, origen: ruta?.origen.nombre ?? "?", destino: ruta?.destino.nombre ?? "?" },
    items: s.items,
    totalPiezas: envio.totalPiezas,
    pesoTotalKg: envio.pesoTotalKg,
    zona: s.zona,
    descripcion: s.descripcion,
    costo: s.costo,
    formaPago: s.formaPago,
    estado: s.estado,
    registro: { fecha: envio.registro.fecha.toISOString(), operador: envio.registro.operador },
    entrega: entrega && { ...entrega, fecha: entrega.fecha.toISOString() },
    evidencia: s.evidencia ? toEvidenciaDTO(s.evidencia) : null,
    origen: envio.origen,
    referenciaExterna: envio.referenciaExterna,
    creadoEn: s.creadoEn.toISOString(),
    actualizadoEn: s.actualizadoEn.toISOString(),
    ...(conHistorial ? { historial: s.historial.map(toEventoDTO) } : {}),
  };
}
