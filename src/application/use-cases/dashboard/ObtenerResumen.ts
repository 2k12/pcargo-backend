import { TIPOS_CARGA, type TipoCargaCodigo } from "../../../domain/carga/TipoCarga.js";
import { ESTADOS, type EstadoEnvio } from "../../../domain/envio/EstadoEnvio.js";
import { FORMAS_PAGO, type FormaPago } from "../../../domain/envio/FormaPago.js";
import type { Canal } from "../../../domain/integracion/Integracion.js";
import { nombreRuta } from "../../../domain/ruta/Ruta.js";
import { DomainError, redondear2 } from "../../../domain/shared/DomainError.js";
import type { ClienteRepository, EnvioRepository, RutaRepository } from "../../ports/repositories.js";
import type { Clock } from "../../ports/services.js";

export interface FiltroResumen {
  clienteId?: string;
  canal?: Canal;
  integracionId?: string;
  /** Fechas locales de Ecuador `YYYY-MM-DD`, ambas inclusive. */
  desde?: string;
  hasta?: string;
}

export interface Resumen {
  totalEnvios: number;
  totalPiezas: number;
  pesoTotalKg: number;
  /** Excluye envíos cancelados. */
  ingresos: number;
  /** Envíos AL_COBRO aún no entregados ni cancelados: dinero pendiente de cobrar. */
  porCobrar: number;
  porEstado: Record<EstadoEnvio, number>;
  porTipo: { tipoCarga: TipoCargaCodigo; piezas: number }[];
  porRuta: { rutaId: number; ruta: string; total: number; monto: number }[];
  porFormaPago: { formaPago: FormaPago; envios: number; monto: number }[];
  /** Serie diaria continua (días sin envíos en 0), como máximo los últimos 92 días del periodo. */
  porDia: { fecha: string; envios: number; ingresos: number }[];
  /** Ordenado por monto; `clienteId: null` agrupa los envíos sin cliente registrado. */
  porCliente: { clienteId: string | null; nombre: string; envios: number; monto: number }[];
  /** Por canal de ingreso: el panel y cada integración (ordenado por monto). */
  porCanal: { canal: Canal; integracionId: string | null; nombre: string; envios: number; monto: number }[];
}

/** Ecuador continental no tiene horario de verano: UTC−5 todo el año. */
const OFFSET_EC_MS = -5 * 60 * 60 * 1000;
const DIA_MS = 24 * 60 * 60 * 1000;
const MAX_DIAS_SERIE = 92;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

/** Fecha local de Ecuador `YYYY-MM-DD`. */
export const fechaLocalEC = (d: Date): string => new Date(d.getTime() + OFFSET_EC_MS).toISOString().slice(0, 10);

const aTiempo = (fecha: string): number => Date.parse(`${fecha}T00:00:00Z`);

function validarFecha(texto: string | undefined, campo: string): void {
  if (texto !== undefined && (!FECHA.test(texto) || Number.isNaN(aTiempo(texto)))) {
    throw new DomainError("VALIDACION", `${campo}: use el formato AAAA-MM-DD`);
  }
}

/** Días consecutivos `YYYY-MM-DD` entre dos fechas (inclusive), como máximo los últimos `MAX_DIAS_SERIE`. */
function dias(desde: string, hasta: string): string[] {
  const fin = aTiempo(hasta);
  const lista: string[] = [];
  for (let t = Math.max(aTiempo(desde), fin - (MAX_DIAS_SERIE - 1) * DIA_MS); t <= fin; t += DIA_MS) {
    lista.push(new Date(t).toISOString().slice(0, 10));
  }
  return lista;
}

interface Acumulado {
  envios: number;
  monto: number;
}

function acumular<K>(mapa: Map<K, Acumulado>, clave: K, monto: number): void {
  const v = mapa.get(clave) ?? { envios: 0, monto: 0 };
  v.envios++;
  v.monto += monto;
  mapa.set(clave, v);
}

export class ObtenerResumen {
  constructor(
    private readonly envios: EnvioRepository,
    private readonly rutas: RutaRepository,
    private readonly clientes?: ClienteRepository,
    private readonly clock: Clock = { ahora: () => new Date() },
  ) {}

  async ejecutar(filtro: FiltroResumen = {}): Promise<Resumen> {
    validarFecha(filtro.desde, "desde");
    validarFecha(filtro.hasta, "hasta");
    if (filtro.desde && filtro.hasta && filtro.desde > filtro.hasta) {
      throw new DomainError("VALIDACION", "La fecha inicial no puede ser posterior a la final");
    }
    const [todos, rutas, clientes] = await Promise.all([
      this.envios.listar({
        ...(filtro.clienteId ? { clienteId: filtro.clienteId } : {}),
        ...(filtro.canal ? { canal: filtro.canal } : {}),
        ...(filtro.integracionId ? { integracionId: filtro.integracionId } : {}),
      }),
      this.rutas.listar(),
      this.clientes ? this.clientes.listar() : Promise.resolve([]),
    ]);

    const porEstado = Object.fromEntries(ESTADOS.map((e) => [e, 0])) as Record<EstadoEnvio, number>;
    const porTipo = new Map<TipoCargaCodigo, number>(TIPOS_CARGA.map((t) => [t, 0]));
    const porPago = new Map<FormaPago, Acumulado>(FORMAS_PAGO.map((f) => [f, { envios: 0, monto: 0 }]));
    const porRuta = new Map<number, Acumulado>();
    const porCliente = new Map<string | null, Acumulado>();
    const porDia = new Map<string, Acumulado>();
    const porCanal = new Map<string | null, Acumulado>();
    const nombresIntegracion = new Map<string, string>();
    let totalEnvios = 0;
    let ingresos = 0;
    let porCobrar = 0;
    let totalPiezas = 0;
    let pesoTotalKg = 0;
    let primerDia: string | undefined;

    for (const e of todos) {
      const s = e.toSnapshot();
      const dia = fechaLocalEC(s.creadoEn);
      if ((filtro.desde && dia < filtro.desde) || (filtro.hasta && dia > filtro.hasta)) continue;
      const monto = s.estado === "CANCELADO" ? 0 : s.costo;
      totalEnvios++;
      porEstado[s.estado]++;
      for (const i of s.items) porTipo.set(i.tipoCarga, (porTipo.get(i.tipoCarga) ?? 0) + i.cantidad);
      totalPiezas += e.totalPiezas;
      pesoTotalKg += e.pesoTotalKg;
      ingresos += monto;
      if (s.formaPago === "AL_COBRO" && s.estado !== "ENTREGADO") porCobrar += monto;
      acumular(porPago, s.formaPago, monto);
      acumular(porRuta, s.rutaId, monto);
      acumular(porCliente, e.clienteId, monto);
      acumular(porDia, dia, monto);
      const origen = e.origen;
      acumular(porCanal, origen.integracionId, monto);
      if (origen.integracionId) nombresIntegracion.set(origen.integracionId, origen.integracion ?? "Integración eliminada");
      if (!primerDia || dia < primerDia) primerDia = dia;
    }

    const nombresRuta = new Map(rutas.map((r) => [r.id, nombreRuta(r)]));
    const nombresCliente = new Map(clientes.map((c) => [c.id, c.nombre]));
    const hasta = filtro.hasta ?? fechaLocalEC(this.clock.ahora());
    const desde = filtro.desde ?? primerDia ?? new Date(aTiempo(hasta) - 29 * DIA_MS).toISOString().slice(0, 10);

    return {
      totalEnvios,
      totalPiezas,
      pesoTotalKg: redondear2(pesoTotalKg),
      ingresos: redondear2(ingresos),
      porCobrar: redondear2(porCobrar),
      porEstado,
      porTipo: [...porTipo].map(([tipoCarga, piezas]) => ({ tipoCarga, piezas })),
      porRuta: [...porRuta]
        .map(([rutaId, v]) => ({
          rutaId,
          ruta: nombresRuta.get(rutaId) ?? `Ruta ${rutaId}`,
          total: v.envios,
          monto: redondear2(v.monto),
        }))
        .sort((a, b) => b.total - a.total),
      porFormaPago: [...porPago].map(([formaPago, v]) => ({ formaPago, envios: v.envios, monto: redondear2(v.monto) })),
      porDia: dias(desde, hasta > desde ? hasta : desde).map((fecha) => {
        const d = porDia.get(fecha);
        return { fecha, envios: d?.envios ?? 0, ingresos: redondear2(d?.monto ?? 0) };
      }),
      porCliente: [...porCliente]
        .map(([clienteId, v]) => ({
          clienteId,
          nombre: clienteId ? (nombresCliente.get(clienteId) ?? "Cliente eliminado") : "Sin cliente registrado",
          envios: v.envios,
          monto: redondear2(v.monto),
        }))
        .sort((a, b) => b.monto - a.monto || b.envios - a.envios),
      porCanal: [...porCanal]
        .map(([integracionId, v]) => ({
          canal: (integracionId ? "API" : "PANEL") as Canal,
          integracionId,
          nombre: integracionId ? (nombresIntegracion.get(integracionId) ?? "Integración") : "Panel",
          envios: v.envios,
          monto: redondear2(v.monto),
        }))
        .sort((a, b) => b.monto - a.monto || b.envios - a.envios),
    };
  }
}
