import { ESTADOS_PENDIENTES_REPARTO, type EstadoEnvio } from "../../../domain/envio/EstadoEnvio.js";
import type { Envio } from "../../../domain/envio/Envio.js";
import { parsearNumeroGuia } from "../../../domain/envio/NumeroGuia.js";
import type { Ruta } from "../../../domain/ruta/Ruta.js";
import { DomainError } from "../../../domain/shared/DomainError.js";
import { DIA_MS, fechaLocalEC, inicioDiaEC } from "../../../domain/shared/FechaEcuador.js";
import type { Actor } from "../../../domain/usuario/Usuario.js";
import { toEnvioRepartoDTO, type EnvioRepartoDTO } from "../../dto/VistasEnvioDTO.js";
import type { EnvioRepository, RutaRepository, UsuarioRepository } from "../../ports/repositories.js";
import type { Clock } from "../../ports/services.js";
import type { CambiarEstadoEnvio } from "../envios/ConsultasEnvio.js";
import type { SolicitudEvidencia, SubirEvidencia } from "../envios/EvidenciaEntrega.js";

// Asignación de repartidor (panel) y app del repartidor (contrato v12).

export const MAX_ENVIOS_REPARTO = 200;
/** Estados que el repartidor puede marcar desde la app. */
export const ESTADOS_REPARTIDOR = ["EN_REPARTO", "ENTREGADO", "NO_ENTREGADO", "NOVEDAD"] as const;
const RESULTADOS_HOY: readonly EstadoEnvio[] = ["ENTREGADO", "NO_ENTREGADO"];

export interface SolicitudAsignacion {
  envioIds: string[];
  repartidorId: string | null;
}

/** Asigna (o quita) el repartidor de varios envíos de forma atómica: o se asignan todos o ninguno. */
export class AsignarRepartidor {
  constructor(
    private readonly envios: EnvioRepository,
    private readonly usuarios: UsuarioRepository,
    private readonly clock: Clock,
  ) {}

  async ejecutar({ envioIds, repartidorId }: SolicitudAsignacion): Promise<{ asignados: number }> {
    if (envioIds.length === 0 || envioIds.length > 100 || new Set(envioIds).size !== envioIds.length) {
      throw new DomainError("VALIDACION", "Indique de 1 a 100 envíos sin repetir");
    }
    let repartidor: { id: string; nombre: string } | null = null;
    if (repartidorId !== null) {
      const u = await this.usuarios.obtener(repartidorId);
      if (!u || !u.activo || u.rol !== "REPARTIDOR") {
        throw new DomainError("VALIDACION", "El repartidor indicado no existe o no está activo", { regla: true });
      }
      repartidor = { id: u.id, nombre: u.nombre };
    }
    const ahora = this.clock.ahora();
    // Validación previa con mensajes claros; el repositorio vuelve a comprobarlo de forma atómica.
    for (const id of envioIds) {
      const envio = await this.envios.buscarPorId(id);
      if (!envio) throw new DomainError("NO_ENCONTRADO", `Envío no encontrado: ${id}`);
      envio.asignarRepartidor(repartidor, ahora);
    }
    return { asignados: await this.envios.asignarRepartidor(envioIds, repartidorId, ahora) };
  }
}

async function rutasPorId(rutas: RutaRepository): Promise<Map<number, Ruta>> {
  return new Map((await rutas.listar()).map((r) => [r.id, r]));
}

/** El envío asignado a este repartidor; cualquier otro → 404. */
function exigirAsignado(envio: Envio | null, actor: Actor): Envio {
  if (!envio || envio.repartidor?.id !== actor.id) throw new DomainError("NO_ENCONTRADO", "Envío no encontrado");
  return envio;
}

export class ListarEnviosRepartidor {
  constructor(
    private readonly envios: EnvioRepository,
    private readonly rutas: RutaRepository,
    private readonly clock: Clock,
  ) {}

  /**
   * `pendientes`: sus envíos en curso, por destino y número de guía. `hoy`: los que pasaron hoy (hora de Ecuador)
   * a ENTREGADO o NO_ENTREGADO marcados por él. Como máximo 200.
   */
  async ejecutar(actor: Actor, vista: "pendientes" | "hoy" = "pendientes"): Promise<EnvioRepartoDTO[]> {
    const mapa = await rutasPorId(this.rutas);
    if (vista === "hoy") {
      const hoy = fechaLocalEC(this.clock.ahora());
      const desde = inicioDiaEC(hoy);
      const hasta = new Date(desde.getTime() + DIA_MS);
      const lista = await this.envios.listar({ repartidorId: actor.id, actualizadoDesde: desde });
      return lista
        .filter((e) =>
          e.historial.some(
            (ev) => RESULTADOS_HOY.includes(ev.estado) && ev.usuario?.id === actor.id && ev.fecha >= desde && ev.fecha < hasta,
          ),
        )
        .slice(0, MAX_ENVIOS_REPARTO)
        .map((e) => toEnvioRepartoDTO(e, mapa.get(e.rutaId)));
    }
    const lista = await this.envios.listar({ repartidorId: actor.id, estados: [...ESTADOS_PENDIENTES_REPARTO] });
    const destino = (e: Envio) => mapa.get(e.rutaId)?.destino.nombre ?? "";
    return lista
      .sort((a, b) => destino(a).localeCompare(destino(b), "es") || a.numeroGuia - b.numeroGuia)
      .slice(0, MAX_ENVIOS_REPARTO)
      .map((e) => toEnvioRepartoDTO(e, mapa.get(e.rutaId)));
  }
}

/** Escaneo del QR o búsqueda por número de guía (acepta ceros a la izquierda). */
export class BuscarGuiaRepartidor {
  constructor(
    private readonly envios: EnvioRepository,
    private readonly rutas: RutaRepository,
  ) {}

  async ejecutar(actor: Actor, numeroGuia: string): Promise<EnvioRepartoDTO> {
    const envio = exigirAsignado(await this.envios.buscarPorNumeroGuia(parsearNumeroGuia(numeroGuia)), actor);
    return toEnvioRepartoDTO(envio, (await this.rutas.buscarPorId(envio.rutaId)) ?? undefined);
  }
}

/** Mismas transiciones y notas obligatorias que el panel, solo con los estados de la entrega. */
export class CambiarEstadoRepartidor {
  constructor(private readonly cambiar: Pick<CambiarEstadoEnvio, "aplicar">) {}

  async ejecutar(actor: Actor, id: string, estado: string, nota?: string | null): Promise<EnvioRepartoDTO> {
    if (!(ESTADOS_REPARTIDOR as readonly string[]).includes(estado)) {
      throw new DomainError("VALIDACION", `El repartidor solo puede marcar ${ESTADOS_REPARTIDOR.join(", ")}`);
    }
    const { envio, ruta } = await this.cambiar.aplicar(actor, id, estado, nota, { repartidorId: actor.id });
    return toEnvioRepartoDTO(envio, ruta);
  }
}

export class SubirEvidenciaRepartidor {
  constructor(private readonly subirEvidencia: Pick<SubirEvidencia, "subir">) {}

  async ejecutar(actor: Actor, id: string, s: SolicitudEvidencia): Promise<EnvioRepartoDTO> {
    const { envio, ruta } = await this.subirEvidencia.subir(actor, id, s, { repartidorId: actor.id });
    return toEnvioRepartoDTO(envio, ruta);
  }
}
