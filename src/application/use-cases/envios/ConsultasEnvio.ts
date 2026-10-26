import { movimientosPorEstado, SIN_MOVIMIENTOS } from "../../../domain/caja/Caja.js";
import type { Envio } from "../../../domain/envio/Envio.js";
import { pareceNumeroGuia, parsearNumeroGuia } from "../../../domain/envio/NumeroGuia.js";
import { esEstado } from "../../../domain/envio/EstadoEnvio.js";
import type { Ruta } from "../../../domain/ruta/Ruta.js";
import { DomainError } from "../../../domain/shared/DomainError.js";
import { validarRangoEC } from "../../../domain/shared/FechaEcuador.js";
import type { Actor } from "../../../domain/usuario/Usuario.js";
import { toEnvioDTO, toEventoDTO, type EnvioDTO, type EventoHistorialDTO } from "../../dto/EnvioDTO.js";
import type {
  CajaRepository,
  EnvioRepository,
  FiltroEnvios,
  Paginacion,
  RutaRepository,
} from "../../ports/repositories.js";
import type { Clock, IdGenerator } from "../../ports/services.js";
import type { EmisorWebhooks } from "../integraciones/EmisorWebhooks.js";

/** Para búsquedas: un número fuera de rango simplemente no filtra por guía. */
export function parsearNumeroGuiaSeguro(texto: string): number | undefined {
  try {
    return parsearNumeroGuia(texto);
  } catch {
    return undefined;
  }
}

/**
 * v21: envío por número de guía del sistema y, si no hay ninguno, por guía física antigua (seguimiento público y
 * escaneo del repartidor).
 */
export async function buscarPorNumeroOGuiaFisica(envios: EnvioRepository, numero: number): Promise<Envio | null> {
  return (await envios.buscarPorNumeroGuia(numero)) ?? (await envios.buscarPorGuiaFisica(numero));
}

/**
 * v21: búsqueda rápida del panel. Los envíos cuyo número de guía **o** guía física es ese número (0, 1 o 2; primero el
 * que coincide por número de guía). Acepta ceros a la izquierda; otro texto → VALIDACION.
 */
export class BuscarEnviosPorGuia {
  constructor(
    private readonly envios: EnvioRepository,
    private readonly rutas: RutaRepository,
  ) {}

  async ejecutar(numero: string): Promise<EnvioDTO[]> {
    const n = parsearNumeroGuia(numero);
    const [porNumero, porGuiaFisica] = await Promise.all([
      this.envios.buscarPorNumeroGuia(n),
      this.envios.buscarPorGuiaFisica(n),
    ]);
    const encontrados = [porNumero, porGuiaFisica].filter((e): e is Envio => e !== null);
    const unicos = encontrados.filter((e, i) => encontrados.findIndex((x) => x.id === e.id) === i);
    if (unicos.length === 0) return [];
    const mapa = await rutasPorId(this.rutas);
    return unicos.map((e) => toEnvioDTO(e, mapa.get(e.rutaId)));
  }
}

async function rutasPorId(rutas: RutaRepository): Promise<Map<number, Ruta>> {
  return new Map((await rutas.listar()).map((r) => [r.id, r]));
}

export const POR_PAGINA_DEFECTO = 20;
export const POR_PAGINA_MAX = 100;

export interface PaginaDTO<T> {
  datos: T[];
  pagina: number;
  porPagina: number;
  total: number;
  totalPaginas: number;
}

/**
 * Filtro del listado del panel: `desde`/`hasta` son fechas `AAAA-MM-DD` de Ecuador (v16, inclusive) sobre la fecha de
 * la guía (v18; antes, la de registro).
 */
export interface FiltroListarEnvios extends FiltroEnvios {
  desde?: string;
  hasta?: string;
}

export class ListarEnvios {
  constructor(
    private readonly envios: EnvioRepository,
    private readonly rutas: RutaRepository,
  ) {}

  /** Paginado en el servidor: solo viaja y se reconstruye la página pedida. */
  async ejecutar(
    { desde, hasta, ...resto }: FiltroListarEnvios = {},
    paginacion: Partial<Paginacion> = {},
  ): Promise<PaginaDTO<EnvioDTO>> {
    validarRangoEC(desde, hasta);
    const filtro: FiltroEnvios = { ...resto };
    if (desde) filtro.fechaGuiaDesde = desde;
    if (hasta) filtro.fechaGuiaHasta = hasta;
    const porPagina = Math.min(Math.max(1, Math.trunc(paginacion.porPagina ?? POR_PAGINA_DEFECTO)), POR_PAGINA_MAX);
    const pagina = Math.max(1, Math.trunc(paginacion.pagina ?? 1));
    // Si el texto es un número, también busca la guía o la guía física (v21) exactas sin importar ceros a la izquierda.
    const q = filtro.q?.trim();
    const conGuia = q && pareceNumeroGuia(q) ? { ...filtro, numeroGuia: parsearNumeroGuiaSeguro(q) } : filtro;
    const [{ envios, total }, mapa] = await Promise.all([
      this.envios.listarPagina(conGuia, { pagina, porPagina }),
      rutasPorId(this.rutas),
    ]);
    return {
      datos: envios.map((e) => toEnvioDTO(e, mapa.get(e.rutaId))),
      pagina,
      porPagina,
      total,
      totalPaginas: Math.ceil(total / porPagina),
    };
  }
}

export class ObtenerEnvio {
  constructor(
    private readonly envios: EnvioRepository,
    private readonly rutas: RutaRepository,
  ) {}

  async ejecutar(id: string): Promise<EnvioDTO> {
    const envio = await this.envios.buscarPorId(id);
    if (!envio) throw new DomainError("NO_ENCONTRADO", "Envío no encontrado");
    return toEnvioDTO(envio, (await this.rutas.buscarPorId(envio.rutaId)) ?? undefined, true);
  }
}

export interface OpcionesCambioEstado {
  /** App del repartidor: solo sus envíos asignados (cualquier otro → 404). */
  repartidorId?: string;
}

export class CambiarEstadoEnvio {
  constructor(
    private readonly envios: EnvioRepository,
    private readonly rutas: RutaRepository,
    private readonly clock: Clock,
    private readonly webhooks?: EmisorWebhooks,
    /** Caja (v12): cobro CONTRA_ENTREGA al entregar un AL_COBRO y anulación/devolución del ORIGEN al cancelar. */
    private readonly caja?: { cobros: CajaRepository; ids: IdGenerator },
  ) {}

  async ejecutar(actor: Actor, id: string, estado: string, nota?: string | null): Promise<EnvioDTO> {
    const { envio, ruta } = await this.aplicar(actor, id, estado, nota);
    return toEnvioDTO(envio, ruta, true);
  }

  /** Lógica común del panel y de la app del repartidor. */
  async aplicar(
    actor: Actor,
    id: string,
    estado: string,
    nota?: string | null,
    opciones: OpcionesCambioEstado = {},
  ): Promise<{ envio: Envio; ruta: Ruta | undefined }> {
    if (!esEstado(estado)) throw new DomainError("VALIDACION", `Estado desconocido: ${estado}`);
    const envio = await this.envios.buscarPorId(id);
    if (!envio || (opciones.repartidorId !== undefined && envio.repartidor?.id !== opciones.repartidorId)) {
      throw new DomainError("NO_ENCONTRADO", "Envío no encontrado");
    }
    const ahora = this.clock.ahora();
    envio.cambiarEstado(estado, { ahora, actor, nota });
    const ruta = (await this.rutas.buscarPorId(envio.rutaId)) ?? undefined;
    // Envíos de una empresa: el webhook se encola en la misma transacción que el cambio de estado.
    const webhooks = (await this.webhooks?.entregasPara(envio, ruta, "envio.estado_actualizado")) ?? [];
    // Los cobros también: si el cambio no se guarda, no hay cobro.
    const afectaCaja = estado === "CANCELADO" || (estado === "ENTREGADO" && envio.formaPago === "AL_COBRO");
    const caja =
      this.caja && afectaCaja
        ? movimientosPorEstado(envio, estado, await this.caja.cobros.cobrosDeEnvio(envio.id), {
            nuevoId: () => this.caja!.ids.uuid(),
            ahora,
            actor,
          })
        : SIN_MOVIMIENTOS;
    await this.envios.guardar(envio, { webhooks, caja });
    return { envio, ruta };
  }
}

export interface SeguimientoDTO {
  numeroGuia: number;
  estado: string;
  origen: string;
  destino: string;
  items: { tipoCarga: string; cantidad: number }[];
  totalPiezas: number;
  creadoEn: string;
  historial: EventoHistorialDTO[];
}

/** Consulta pública: no expone datos personales (nombres, teléfonos, dirección). */
export class ConsultarSeguimiento {
  constructor(
    private readonly envios: EnvioRepository,
    private readonly rutas: RutaRepository,
  ) {}

  async ejecutar(numeroGuia: string): Promise<SeguimientoDTO> {
    const envio = await buscarPorNumeroOGuiaFisica(this.envios, parsearNumeroGuia(numeroGuia));
    if (!envio) throw new DomainError("NO_ENCONTRADO", "No existe un envío con ese número de guía");
    const ruta = await this.rutas.buscarPorId(envio.rutaId);
    const s = envio.toSnapshot();
    return {
      numeroGuia: s.numeroGuia,
      estado: s.estado,
      origen: ruta?.origen.nombre ?? "?",
      destino: ruta?.destino.nombre ?? "?",
      items: s.items.map(({ tipoCarga, cantidad }) => ({ tipoCarga, cantidad })),
      totalPiezas: envio.totalPiezas,
      creadoEn: s.creadoEn.toISOString(),
      historial: s.historial.map((e) => ({ ...toEventoDTO(e), usuario: null })),
    };
  }
}
