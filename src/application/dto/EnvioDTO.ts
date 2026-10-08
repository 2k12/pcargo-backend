import type { Envio, EventoHistorial, ItemEnvio } from "../../domain/envio/Envio.js";
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

export interface EnvioDTO {
  id: string;
  codigo: string;
  remitente: { nombre: string; telefono: string };
  destinatario: { nombre: string; telefono: string; direccion: string };
  ruta: { id: number; origen: string; destino: string };
  items: ItemEnvio[];
  totalPiezas: number;
  pesoTotalKg: number;
  descripcion: string | null;
  costo: number;
  formaPago: string;
  estado: string;
  registro: GestionDTO;
  entrega: GestionEntregaDTO | null;
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
  const entrega = envio.ultimaGestionEntrega;
  return {
    id: s.id,
    codigo: s.codigo,
    remitente: s.remitente,
    destinatario: s.destinatario,
    ruta: { id: s.rutaId, origen: ruta?.origen.nombre ?? "?", destino: ruta?.destino.nombre ?? "?" },
    items: s.items,
    totalPiezas: envio.totalPiezas,
    pesoTotalKg: envio.pesoTotalKg,
    descripcion: s.descripcion,
    costo: s.costo,
    formaPago: s.formaPago,
    estado: s.estado,
    registro: { fecha: envio.registro.fecha.toISOString(), operador: envio.registro.operador },
    entrega: entrega && { ...entrega, fecha: entrega.fecha.toISOString() },
    creadoEn: s.creadoEn.toISOString(),
    actualizadoEn: s.actualizadoEn.toISOString(),
    ...(conHistorial ? { historial: s.historial.map(toEventoDTO) } : {}),
  };
}
