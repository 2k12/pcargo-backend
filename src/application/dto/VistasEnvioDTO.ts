import type { Envio, ItemEnvio } from "../../domain/envio/Envio.js";
import type { Ruta } from "../../domain/ruta/Ruta.js";
import type { GestionEntregaDTO } from "./EnvioDTO.js";

// Vistas reducidas de un envío para la app del repartidor y el portal de clientes (contrato v12).

const rutaDTO = (envio: Envio, ruta: Ruta | undefined) => ({
  id: envio.rutaId,
  origen: ruta?.origen.nombre ?? "?",
  destino: ruta?.destino.nombre ?? "?",
});

const evidenciaCorta = (envio: Envio) => {
  const e = envio.evidencia;
  return e ? { recibidoPor: e.recibidoPor, subidaEn: e.subidaEn.toISOString() } : null;
};

/** Para el repartidor también si ya hay foto (v19), para avisarle lo que falta completar. */
const evidenciaReparto = (envio: Envio) => {
  const e = envio.evidencia;
  return e ? { recibidoPor: e.recibidoPor, conFoto: e.tipo !== null, subidaEn: e.subidaEn.toISOString() } : null;
};

/** Lo que el repartidor debe cobrar al entregar: el costo si es AL_COBRO y aún no se entregó ni canceló. */
export const porCobrar = (envio: Envio): number =>
  envio.formaPago === "AL_COBRO" && envio.estado !== "ENTREGADO" && envio.estado !== "CANCELADO" ? envio.costo : 0;

export interface EnvioRepartoDTO {
  id: string;
  numeroGuia: number;
  /** v21 */
  guiaFisica: number | null;
  estado: string;
  remitente: { nombre: string; telefono: string; direccion: string | null };
  destinatario: { nombre: string; telefono: string; direccion: string };
  ruta: { id: number; origen: string; destino: string };
  zona: string;
  items: { tipoCarga: string; cantidad: number; pesoKg: number }[];
  totalPiezas: number;
  pesoTotalKg: number;
  descripcion: string | null;
  formaPago: string;
  costo: number;
  porCobrar: number;
  entrega: GestionEntregaDTO | null;
  evidencia: { recibidoPor: string | null; conFoto: boolean; subidaEn: string } | null;
  asignadoEn: string | null;
  actualizadoEn: string;
}

/** Datos para entregar, sin el historial completo ni los operadores. */
export function toEnvioRepartoDTO(envio: Envio, ruta: Ruta | undefined): EnvioRepartoDTO {
  const s = envio.toSnapshot();
  const entrega = envio.ultimaGestionEntrega;
  return {
    id: s.id,
    numeroGuia: s.numeroGuia,
    guiaFisica: envio.guiaFisica,
    estado: s.estado,
    remitente: { nombre: s.remitente.nombre, telefono: s.remitente.telefono, direccion: s.remitente.direccion ?? null },
    destinatario: { ...s.destinatario },
    ruta: rutaDTO(envio, ruta),
    zona: s.zona,
    items: s.items.map(({ tipoCarga, cantidad, pesoKg }) => ({ tipoCarga, cantidad, pesoKg })),
    totalPiezas: envio.totalPiezas,
    pesoTotalKg: envio.pesoTotalKg,
    descripcion: s.descripcion,
    formaPago: s.formaPago,
    costo: s.costo,
    porCobrar: porCobrar(envio),
    entrega: entrega && { ...entrega, fecha: entrega.fecha.toISOString() },
    evidencia: evidenciaReparto(envio),
    asignadoEn: envio.asignadoEn?.toISOString() ?? null,
    actualizadoEn: s.actualizadoEn.toISOString(),
  };
}

export interface EnvioPortalDTO {
  id: string;
  numeroGuia: number;
  estado: string;
  destinatario: { nombre: string; telefono: string; direccion: string };
  ruta: { id: number; origen: string; destino: string };
  zona: string;
  items: ItemEnvio[];
  totalPiezas: number;
  pesoTotalKg: number;
  descripcion: string | null;
  costo: number;
  formaPago: string;
  referenciaExterna: string | null;
  creadoEn: string;
  actualizadoEn: string;
  entrega: { resultado: string; fecha: string; nota: string | null } | null;
  evidencia: { recibidoPor: string | null; subidaEn: string } | null;
  historial?: { estado: string; nota: string | null; fecha: string; usuario: null }[];
}

/** Vista del cliente empresa: sin remitente (es él), sin operadores ni datos internos. */
export function toEnvioPortalDTO(envio: Envio, ruta: Ruta | undefined, conHistorial = false): EnvioPortalDTO {
  const s = envio.toSnapshot();
  const entrega = envio.ultimaGestionEntrega;
  return {
    id: s.id,
    numeroGuia: s.numeroGuia,
    estado: s.estado,
    destinatario: { ...s.destinatario },
    ruta: rutaDTO(envio, ruta),
    zona: s.zona,
    items: s.items.map((i) => ({ ...i })),
    totalPiezas: envio.totalPiezas,
    pesoTotalKg: envio.pesoTotalKg,
    descripcion: s.descripcion,
    costo: s.costo,
    formaPago: s.formaPago,
    referenciaExterna: envio.referenciaExterna,
    creadoEn: s.creadoEn.toISOString(),
    actualizadoEn: s.actualizadoEn.toISOString(),
    entrega: entrega && { resultado: entrega.resultado, fecha: entrega.fecha.toISOString(), nota: entrega.nota },
    evidencia: evidenciaCorta(envio),
    ...(conHistorial
      ? {
          historial: s.historial.map((e) => ({
            estado: e.estado,
            nota: e.nota,
            fecha: e.fecha.toISOString(),
            usuario: null,
          })),
        }
      : {}),
  };
}
