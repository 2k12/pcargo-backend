import type { Envio, EventoHistorial } from "../../domain/envio/Envio.js";
import type { Ruta } from "../../domain/ruta/Ruta.js";

export interface EventoHistorialDTO {
  estado: string;
  nota: string | null;
  fecha: string;
  usuario: string | null;
}

export interface EnvioDTO {
  id: string;
  codigo: string;
  remitente: { nombre: string; telefono: string };
  destinatario: { nombre: string; telefono: string; direccion: string };
  ruta: { id: number; origen: string; destino: string };
  tipoCarga: string;
  pesoKg: number;
  descripcion: string | null;
  costo: number;
  estado: string;
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

export function toEnvioDTO(envio: Envio, ruta: Ruta | undefined, conHistorial = false): EnvioDTO {
  const s = envio.toSnapshot();
  return {
    id: s.id,
    codigo: s.codigo,
    remitente: s.remitente,
    destinatario: s.destinatario,
    ruta: { id: s.rutaId, origen: ruta?.origen.nombre ?? "?", destino: ruta?.destino.nombre ?? "?" },
    tipoCarga: s.tipoCarga,
    pesoKg: s.pesoKg,
    descripcion: s.descripcion,
    costo: s.costo,
    estado: s.estado,
    creadoEn: s.creadoEn.toISOString(),
    actualizadoEn: s.actualizadoEn.toISOString(),
    ...(conHistorial ? { historial: s.historial.map(toEventoDTO) } : {}),
  };
}
