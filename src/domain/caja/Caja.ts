import type { Envio } from "../envio/Envio.js";
import type { EstadoEnvio } from "../envio/EstadoEnvio.js";
import type { FormaPago } from "../envio/FormaPago.js";
import { DomainError, redondear2 } from "../shared/DomainError.js";
import type { Actor, Rol } from "../usuario/Usuario.js";

// Cierre de caja (contrato v12): el efectivo que reciben operadores y repartidores se registra como cobros
// automáticos y se entrega en un cierre.

export const TIPOS_COBRO = ["ORIGEN", "CONTRA_ENTREGA", "DEVOLUCION"] as const;
export type TipoCobro = (typeof TIPOS_COBRO)[number];

export const MAX_NOTA_CIERRE = 300;

export interface Cobro {
  id: string;
  tipo: TipoCobro;
  /** Negativo en DEVOLUCION. */
  monto: number;
  envioId: string;
  numeroGuia: number;
  formaPago: FormaPago;
  /** Quien recibió (o devolvió) el dinero. */
  usuario: { id: string; nombre: string };
  fecha: Date;
  /** null mientras está pendiente. */
  cierreId: string | null;
}

export interface ResumenTipo {
  tipo: TipoCobro;
  cantidad: number;
  monto: number;
}

export interface ResumenCobros {
  total: number;
  cantidad: number;
  porTipo: ResumenTipo[];
  /** Fecha del cobro más antiguo (null sin cobros). */
  desde: Date | null;
}

export interface CierreCaja {
  id: string;
  /** Quien entrega el dinero. */
  usuario: { id: string; nombre: string; rol: Rol };
  /** Quien lo recibe (ADMIN u OPERADOR). */
  recibidoPor: { id: string; nombre: string };
  fecha: Date;
  esperado: number;
  entregado: number;
  /** round2(entregado − esperado): negativa = faltante, positiva = sobrante. */
  diferencia: number;
  cantidad: number;
  nota: string | null;
  porTipo: ResumenTipo[];
}

/**
 * Anulación del cobro ORIGEN al cancelar: si al guardar sigue pendiente se elimina; si otro proceso ya lo cerró,
 * se registra `siYaCerrado` (la DEVOLUCION) en su lugar. Así la decisión es atómica en el repositorio.
 */
export interface AnulacionCobro {
  cobroId: string;
  siYaCerrado: Cobro;
}

export interface MovimientosCaja {
  cobros: Cobro[];
  anulaciones: AnulacionCobro[];
}

export const SIN_MOVIMIENTOS: MovimientosCaja = { cobros: [], anulaciones: [] };

interface Contexto {
  /** Se llama solo si se crea un cobro. */
  nuevoId: () => string;
  ahora: Date;
  actor: Pick<Actor, "id" | "nombre">;
}

const cobro = (envio: Envio, tipo: TipoCobro, monto: number, ctx: Contexto): Cobro => ({
  id: ctx.nuevoId(),
  tipo,
  monto: redondear2(monto),
  envioId: envio.id,
  numeroGuia: envio.numeroGuia,
  formaPago: envio.formaPago,
  usuario: { id: ctx.actor.id, nombre: ctx.actor.nombre },
  fecha: ctx.ahora,
  cierreId: null,
});

/**
 * Cobro ORIGEN de un envío PAGADO registrado desde el panel (lo cobra quien lo registra). Los envíos de la API de
 * empresas o del portal no generan cobro: se pagan por fuera.
 */
export function cobroAlRegistrar(envio: Envio, ctx: Contexto): Cobro | null {
  return envio.formaPago === "PAGADO" ? cobro(envio, "ORIGEN", envio.costo, ctx) : null;
}

/**
 * Movimientos de caja de un cambio de estado ya aplicado al envío:
 * - ENTREGADO de un AL_COBRO → CONTRA_ENTREGA por el costo, a nombre de quien lo marca.
 * - CANCELADO con cobro ORIGEN pendiente → se anula; si ya está en un cierre → DEVOLUCION por −costo.
 */
export function movimientosPorEstado(
  envio: Envio,
  nuevo: EstadoEnvio,
  cobrosDelEnvio: readonly Cobro[],
  ctx: Contexto,
): MovimientosCaja {
  if (nuevo === "ENTREGADO" && envio.formaPago === "AL_COBRO") {
    if (cobrosDelEnvio.some((c) => c.tipo === "CONTRA_ENTREGA")) return SIN_MOVIMIENTOS;
    return { cobros: [cobro(envio, "CONTRA_ENTREGA", envio.costo, ctx)], anulaciones: [] };
  }
  if (nuevo === "CANCELADO") {
    const origen = cobrosDelEnvio.find((c) => c.tipo === "ORIGEN");
    if (!origen || cobrosDelEnvio.some((c) => c.tipo === "DEVOLUCION")) return SIN_MOVIMIENTOS;
    const devolucion = cobro(envio, "DEVOLUCION", -origen.monto, ctx);
    return origen.cierreId
      ? { cobros: [devolucion], anulaciones: [] }
      : { cobros: [], anulaciones: [{ cobroId: origen.id, siYaCerrado: devolucion }] };
  }
  return SIN_MOVIMIENTOS;
}

/** Totales de un conjunto de cobros; `porTipo` lista siempre los tres tipos (en 0 si no hay). */
export function resumirCobros(cobros: readonly Cobro[]): ResumenCobros {
  const porTipo = TIPOS_COBRO.map((tipo) => {
    const delTipo = cobros.filter((c) => c.tipo === tipo);
    return { tipo, cantidad: delTipo.length, monto: redondear2(delTipo.reduce((s, c) => s + c.monto, 0)) };
  });
  const desde = cobros.reduce<Date | null>((min, c) => (!min || c.fecha < min ? c.fecha : min), null);
  return {
    total: redondear2(cobros.reduce((s, c) => s + c.monto, 0)),
    cantidad: cobros.length,
    porTipo,
    desde,
  };
}

const conDosDecimales = (n: number): boolean => Math.abs(Math.round(n * 100) - n * 100) < 1e-6;

export interface DatosCierre {
  id: string;
  fecha: Date;
  usuario: { id: string; nombre: string; rol: Rol };
  recibidoPor: { id: string; nombre: string };
  montoEntregado: number;
  nota?: string | null;
}

/**
 * Cierra la caja con TODOS los cobros pendientes recibidos. Sin cobros → SIN_COBROS; la nota es obligatoria si hay
 * diferencia (422).
 */
export function crearCierre(pendientes: readonly Cobro[], d: DatosCierre): CierreCaja {
  if (pendientes.length === 0) {
    throw new DomainError("SIN_COBROS", `${d.usuario.nombre} no tiene cobros pendientes de entregar`);
  }
  if (!Number.isFinite(d.montoEntregado) || d.montoEntregado < 0 || !conDosDecimales(d.montoEntregado)) {
    throw new DomainError("VALIDACION", "El monto entregado debe ser mayor o igual a 0, con hasta 2 decimales");
  }
  const nota = d.nota?.trim() || null;
  if (nota && nota.length > MAX_NOTA_CIERRE) {
    throw new DomainError("VALIDACION", `La nota admite hasta ${MAX_NOTA_CIERRE} caracteres`);
  }
  const resumen = resumirCobros(pendientes);
  const entregado = redondear2(d.montoEntregado);
  const diferencia = redondear2(entregado - resumen.total);
  if (diferencia !== 0 && !nota) {
    throw new DomainError("VALIDACION", "Explique la diferencia (faltante o sobrante) en la nota", { regla: true });
  }
  return {
    id: d.id,
    usuario: { ...d.usuario },
    recibidoPor: { ...d.recibidoPor },
    fecha: d.fecha,
    esperado: resumen.total,
    entregado,
    diferencia,
    cantidad: resumen.cantidad,
    nota,
    porTipo: resumen.porTipo,
  };
}
