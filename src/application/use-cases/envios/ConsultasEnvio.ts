import { normalizarCodigo } from "../../../domain/envio/CodigoSeguimiento.js";
import { esEstado } from "../../../domain/envio/EstadoEnvio.js";
import type { Ruta } from "../../../domain/ruta/Ruta.js";
import { DomainError } from "../../../domain/shared/DomainError.js";
import type { Actor } from "../../../domain/usuario/Usuario.js";
import { toEnvioDTO, toEventoDTO, type EnvioDTO, type EventoHistorialDTO } from "../../dto/EnvioDTO.js";
import type { EnvioRepository, FiltroEnvios, RutaRepository } from "../../ports/repositories.js";
import type { Clock } from "../../ports/services.js";

async function rutasPorId(rutas: RutaRepository): Promise<Map<number, Ruta>> {
  return new Map((await rutas.listar()).map((r) => [r.id, r]));
}

export class ListarEnvios {
  constructor(
    private readonly envios: EnvioRepository,
    private readonly rutas: RutaRepository,
  ) {}

  async ejecutar(filtro: FiltroEnvios = {}): Promise<EnvioDTO[]> {
    const [lista, mapa] = await Promise.all([this.envios.listar(filtro), rutasPorId(this.rutas)]);
    return lista.map((e) => toEnvioDTO(e, mapa.get(e.rutaId)));
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
  ) {}

  async ejecutar(actor: Actor, id: string, estado: string, nota?: string | null): Promise<EnvioDTO> {
    if (!esEstado(estado)) throw new DomainError("VALIDACION", `Estado desconocido: ${estado}`);
    const envio = await this.envios.buscarPorId(id);
    if (!envio) throw new DomainError("NO_ENCONTRADO", "Envío no encontrado");
    envio.cambiarEstado(estado, { ahora: this.clock.ahora(), actor, nota });
    await this.envios.guardar(envio);
    return toEnvioDTO(envio, (await this.rutas.buscarPorId(envio.rutaId)) ?? undefined, true);
  }
}

export interface SeguimientoDTO {
  codigo: string;
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

  async ejecutar(codigo: string): Promise<SeguimientoDTO> {
    const envio = await this.envios.buscarPorCodigo(normalizarCodigo(codigo));
    if (!envio) throw new DomainError("NO_ENCONTRADO", "No existe un envío con ese código");
    const ruta = await this.rutas.buscarPorId(envio.rutaId);
    const s = envio.toSnapshot();
    return {
      codigo: s.codigo,
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
