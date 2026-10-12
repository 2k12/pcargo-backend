import { pareceNumeroGuia, parsearNumeroGuia } from "../../../domain/envio/NumeroGuia.js";
import { esEstado } from "../../../domain/envio/EstadoEnvio.js";
import type { Ruta } from "../../../domain/ruta/Ruta.js";
import { DomainError } from "../../../domain/shared/DomainError.js";
import type { Actor } from "../../../domain/usuario/Usuario.js";
import { toEnvioDTO, toEventoDTO, type EnvioDTO, type EventoHistorialDTO } from "../../dto/EnvioDTO.js";
import type { EnvioRepository, FiltroEnvios, Paginacion, RutaRepository } from "../../ports/repositories.js";
import type { Clock } from "../../ports/services.js";
import type { EmisorWebhooks } from "../integraciones/EmisorWebhooks.js";

/** Para búsquedas: un número fuera de rango simplemente no filtra por guía. */
function parsearNumeroGuiaSeguro(texto: string): number | undefined {
  try {
    return parsearNumeroGuia(texto);
  } catch {
    return undefined;
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

export class ListarEnvios {
  constructor(
    private readonly envios: EnvioRepository,
    private readonly rutas: RutaRepository,
  ) {}

  /** Paginado en el servidor: solo viaja y se reconstruye la página pedida. */
  async ejecutar(filtro: FiltroEnvios = {}, paginacion: Partial<Paginacion> = {}): Promise<PaginaDTO<EnvioDTO>> {
    const porPagina = Math.min(Math.max(1, Math.trunc(paginacion.porPagina ?? POR_PAGINA_DEFECTO)), POR_PAGINA_MAX);
    const pagina = Math.max(1, Math.trunc(paginacion.pagina ?? 1));
    // Si el texto es un número, también busca la guía exacta sin importar ceros a la izquierda.
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

export class CambiarEstadoEnvio {
  constructor(
    private readonly envios: EnvioRepository,
    private readonly rutas: RutaRepository,
    private readonly clock: Clock,
    private readonly webhooks?: EmisorWebhooks,
  ) {}

  async ejecutar(actor: Actor, id: string, estado: string, nota?: string | null): Promise<EnvioDTO> {
    if (!esEstado(estado)) throw new DomainError("VALIDACION", `Estado desconocido: ${estado}`);
    const envio = await this.envios.buscarPorId(id);
    if (!envio) throw new DomainError("NO_ENCONTRADO", "Envío no encontrado");
    envio.cambiarEstado(estado, { ahora: this.clock.ahora(), actor, nota });
    const ruta = (await this.rutas.buscarPorId(envio.rutaId)) ?? undefined;
    // Envíos de una empresa: el webhook se encola en la misma transacción que el cambio de estado.
    const webhooks = (await this.webhooks?.entregasPara(envio, ruta, "envio.estado_actualizado")) ?? [];
    await this.envios.guardar(envio, { webhooks });
    return toEnvioDTO(envio, ruta, true);
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
    const envio = await this.envios.buscarPorNumeroGuia(parsearNumeroGuia(numeroGuia));
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
