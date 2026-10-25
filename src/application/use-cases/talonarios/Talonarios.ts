import { parsearNumeroGuia } from "../../../domain/envio/NumeroGuia.js";
import { DomainError } from "../../../domain/shared/DomainError.js";
import {
  Talonario,
  type EstadoGuiaTalonario,
  type GuiaTalonario,
} from "../../../domain/talonario/Talonario.js";
import type { Actor } from "../../../domain/usuario/Usuario.js";
import type { Paginacion, TalonarioRepository } from "../../ports/repositories.js";
import type { Clock, IdGenerator } from "../../ports/services.js";
import { POR_PAGINA_DEFECTO, POR_PAGINA_MAX, type PaginaDTO } from "../envios/ConsultasEnvio.js";

// Talonarios de guías en blanco (contrato v20). Roles ADMIN y OPERADOR (lo aplica la capa HTTP).

export interface GuiaTalonarioDTO {
  numeroGuia: number;
  estado: EstadoGuiaTalonario;
  envioId: string | null;
  motivo: string | null;
  actualizadoEn: string | null;
}

export interface TalonarioResumenDTO {
  id: string;
  desde: number;
  hasta: number;
  cantidad: number;
  nota: string | null;
  creadoEn: string;
  creadoPor: string | null;
  disponibles: number;
  usadas: number;
  anuladas: number;
}

export interface TalonarioDTO extends TalonarioResumenDTO {
  guias: GuiaTalonarioDTO[];
}

export interface GuiaDeTalonarioDTO extends GuiaTalonarioDTO {
  talonarioId: string;
  nota: string | null;
  creadoEn: string;
}

const toGuiaDTO = (g: GuiaTalonario): GuiaTalonarioDTO => ({
  numeroGuia: g.numeroGuia,
  estado: g.estado,
  envioId: g.envioId,
  motivo: g.motivo,
  actualizadoEn: g.actualizadoEn?.toISOString() ?? null,
});

export const toTalonarioResumenDTO = (t: Talonario): TalonarioResumenDTO => ({
  id: t.id,
  desde: t.desde,
  hasta: t.hasta,
  cantidad: t.cantidad,
  nota: t.nota,
  creadoEn: t.creadoEn.toISOString(),
  creadoPor: t.creadoPor,
  disponibles: t.disponibles,
  usadas: t.usadas,
  anuladas: t.anuladas,
});

export const toTalonarioDTO = (t: Talonario): TalonarioDTO => ({
  ...toTalonarioResumenDTO(t),
  guias: t.guias.map(toGuiaDTO),
});

export interface SolicitudTalonario {
  cantidad: number;
  nota?: string | null;
}

/** Reserva de forma atómica `cantidad` números consecutivos siguientes al consecutivo. */
export class CrearTalonario {
  constructor(
    private readonly talonarios: TalonarioRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async ejecutar(actor: Actor, s: SolicitudTalonario): Promise<TalonarioDTO> {
    const id = this.ids.uuid();
    const ahora = this.clock.ahora();
    // Valida antes de tomar el bloqueo (y otra vez dentro, con el número inicial ya calculado).
    Talonario.crear(s, { id, desde: 1, ahora, creadoPor: actor.nombre });
    const t = await this.talonarios.reservar((desde) => Talonario.crear(s, { id, desde, ahora, creadoPor: actor.nombre }));
    return toTalonarioDTO(t);
  }
}

export type EstadoListadoTalonarios = "abiertos" | "todos";

export class ListarTalonarios {
  constructor(private readonly talonarios: TalonarioRepository) {}

  async ejecutar(
    filtro: { estado?: EstadoListadoTalonarios } = {},
    paginacion: Partial<Paginacion> = {},
  ): Promise<PaginaDTO<TalonarioResumenDTO>> {
    const porPagina = Math.min(Math.max(1, Math.trunc(paginacion.porPagina ?? POR_PAGINA_DEFECTO)), POR_PAGINA_MAX);
    const pagina = Math.max(1, Math.trunc(paginacion.pagina ?? 1));
    const { talonarios, total } = await this.talonarios.listar(
      { abiertos: (filtro.estado ?? "abiertos") === "abiertos" },
      { pagina, porPagina },
    );
    return {
      datos: talonarios.map(toTalonarioResumenDTO),
      pagina,
      porPagina,
      total,
      totalPaginas: Math.ceil(total / porPagina),
    };
  }
}

async function exigirTalonario(talonarios: TalonarioRepository, id: string): Promise<Talonario> {
  const t = await talonarios.buscarPorId(id);
  if (!t) throw new DomainError("NO_ENCONTRADO", "Talonario no encontrado");
  return t;
}

export class ObtenerTalonario {
  constructor(private readonly talonarios: TalonarioRepository) {}

  async ejecutar(id: string): Promise<TalonarioDTO> {
    return toTalonarioDTO(await exigirTalonario(this.talonarios, id));
  }
}

/** Guía de talonario por número (acepta ceros a la izquierda); 404 si no es de ningún talonario. */
export class ObtenerGuiaTalonario {
  constructor(private readonly talonarios: TalonarioRepository) {}

  async ejecutar(numeroGuia: string | number): Promise<GuiaDeTalonarioDTO> {
    const n = parsearNumeroGuia(numeroGuia);
    const t = await this.talonarios.buscarPorNumeroGuia(n);
    if (!t) throw new DomainError("NO_ENCONTRADO", `La guía ${n} no es de ningún talonario`);
    return { ...toGuiaDTO(t.guia(n)), talonarioId: t.id, nota: t.nota, creadoEn: t.creadoEn.toISOString() };
  }
}

export interface SolicitudAnulacion {
  numeroGuia: string | number;
  motivo: string;
}

/** Anula una guía DISPONIBLE (dañada, perdida o mal llenada). */
export class AnularGuiaTalonario {
  constructor(
    private readonly talonarios: TalonarioRepository,
    private readonly clock: Clock,
  ) {}

  async ejecutar(id: string, s: SolicitudAnulacion): Promise<TalonarioDTO> {
    const n = parsearNumeroGuia(s.numeroGuia);
    const ahora = this.clock.ahora();
    const t = await this.talonarios.modificar(id, (t) => t.anular(n, s.motivo, ahora));
    return toTalonarioDTO(t);
  }
}
