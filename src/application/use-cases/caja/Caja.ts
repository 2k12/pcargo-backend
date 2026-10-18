import {
  crearCierre,
  resumirCobros,
  type CierreCaja,
  type Cobro,
  type ResumenTipo,
} from "../../../domain/caja/Caja.js";
import { DomainError } from "../../../domain/shared/DomainError.js";
import { DIA_MS, inicioDiaEC, validarRangoEC } from "../../../domain/shared/FechaEcuador.js";
import type { Actor, Rol, UsuarioAdmin } from "../../../domain/usuario/Usuario.js";
import type { CajaRepository, Paginacion, UsuarioRepository } from "../../ports/repositories.js";
import type { Clock, IdGenerator } from "../../ports/services.js";
import { POR_PAGINA_DEFECTO, POR_PAGINA_MAX, type PaginaDTO } from "../envios/ConsultasEnvio.js";

// Cierre de caja (contrato v12).

export interface CobroDTO {
  id: string;
  tipo: string;
  monto: number;
  envioId: string;
  numeroGuia: number;
  formaPago: string;
  usuario: { id: string; nombre: string };
  fecha: string;
  cierreId: string | null;
}

export interface CajaPendienteDTO {
  usuario: { id: string; nombre: string; rol: Rol };
  total: number;
  cantidad: number;
  porTipo: ResumenTipo[];
  desde: string | null;
  cobros?: CobroDTO[];
}

export interface CierreCajaDTO {
  id: string;
  usuario: { id: string; nombre: string; rol: Rol };
  recibidoPor: { id: string; nombre: string };
  fecha: string;
  esperado: number;
  entregado: number;
  diferencia: number;
  cantidad: number;
  nota: string | null;
  porTipo: ResumenTipo[];
  cobros?: CobroDTO[];
}

export const toCobroDTO = (c: Cobro): CobroDTO => ({
  id: c.id,
  tipo: c.tipo,
  monto: c.monto,
  envioId: c.envioId,
  numeroGuia: c.numeroGuia,
  formaPago: c.formaPago,
  usuario: { ...c.usuario },
  fecha: c.fecha.toISOString(),
  cierreId: c.cierreId,
});

export function toCierreDTO(c: CierreCaja, cobros?: Cobro[]): CierreCajaDTO {
  return {
    id: c.id,
    usuario: { ...c.usuario },
    recibidoPor: { ...c.recibidoPor },
    fecha: c.fecha.toISOString(),
    esperado: c.esperado,
    entregado: c.entregado,
    diferencia: c.diferencia,
    cantidad: c.cantidad,
    nota: c.nota,
    porTipo: c.porTipo.map((t) => ({ ...t })),
    ...(cobros ? { cobros: cobros.map(toCobroDTO) } : {}),
  };
}

function toPendienteDTO(u: Pick<UsuarioAdmin, "id" | "nombre" | "rol">, cobros: Cobro[], conCobros: boolean): CajaPendienteDTO {
  const r = resumirCobros(cobros);
  return {
    usuario: { id: u.id, nombre: u.nombre, rol: u.rol },
    total: r.total,
    cantidad: r.cantidad,
    porTipo: r.porTipo,
    desde: r.desde?.toISOString() ?? null,
    ...(conCobros ? { cobros: cobros.map(toCobroDTO) } : {}),
  };
}

async function exigirUsuario(usuarios: UsuarioRepository, id: string): Promise<UsuarioAdmin> {
  const u = await usuarios.obtener(id);
  if (!u) throw new DomainError("NO_ENCONTRADO", "Usuario no encontrado");
  return u;
}

/** Personas con cobros pendientes, por total descendente. */
export class ListarCajasPendientes {
  constructor(
    private readonly caja: CajaRepository,
    private readonly usuarios: UsuarioRepository,
  ) {}

  async ejecutar(): Promise<CajaPendienteDTO[]> {
    const pendientes = await this.caja.pendientes();
    const porUsuario = new Map<string, Cobro[]>();
    for (const c of pendientes) porUsuario.set(c.usuario.id, [...(porUsuario.get(c.usuario.id) ?? []), c]);
    const usuarios = new Map((await this.usuarios.listar()).map((u) => [u.id, u]));
    return [...porUsuario]
      .map(([id, cobros]) => {
        const u = usuarios.get(id) ?? { id, nombre: cobros[0]!.usuario.nombre, rol: "OPERADOR" as Rol };
        return toPendienteDTO(u, cobros, false);
      })
      .sort((a, b) => b.total - a.total || a.usuario.nombre.localeCompare(b.usuario.nombre, "es"));
  }
}

/** Lo pendiente de una persona, con el detalle de cobros (también la caja propia del repartidor). */
export class ObtenerCajaPendiente {
  constructor(
    private readonly caja: CajaRepository,
    private readonly usuarios: UsuarioRepository,
  ) {}

  async ejecutar(usuarioId: string): Promise<CajaPendienteDTO> {
    const u = await exigirUsuario(this.usuarios, usuarioId);
    return toPendienteDTO(u, await this.caja.pendientes(usuarioId), true);
  }
}

export interface SolicitudCierre {
  usuarioId: string;
  montoEntregado: number;
  nota?: string | null;
}

/** Quien recibe el dinero (ADMIN u OPERADOR) cierra la caja de una persona con todos sus cobros pendientes. */
export class CerrarCaja {
  constructor(
    private readonly caja: CajaRepository,
    private readonly usuarios: UsuarioRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async ejecutar(actor: Actor, s: SolicitudCierre): Promise<CierreCajaDTO> {
    const u = await exigirUsuario(this.usuarios, s.usuarioId);
    const id = this.ids.uuid();
    const fecha = this.clock.ahora();
    const { cierre } = await this.caja.cerrar(u.id, (pendientes) =>
      crearCierre(pendientes, {
        id,
        fecha,
        usuario: { id: u.id, nombre: u.nombre, rol: u.rol },
        recibidoPor: { id: actor.id, nombre: actor.nombre },
        montoEntregado: s.montoEntregado,
        nota: s.nota,
      }),
    );
    return toCierreDTO(cierre);
  }
}

export interface FiltroCierresDTO {
  usuarioId?: string;
  /** Fechas locales de Ecuador `AAAA-MM-DD`, inclusive. */
  desde?: string;
  hasta?: string;
}

export class ListarCierresCaja {
  constructor(private readonly caja: CajaRepository) {}

  async ejecutar(filtro: FiltroCierresDTO = {}, paginacion: Partial<Paginacion> = {}): Promise<PaginaDTO<CierreCajaDTO>> {
    validarRangoEC(filtro.desde, filtro.hasta);
    const porPagina = Math.min(Math.max(1, Math.trunc(paginacion.porPagina ?? POR_PAGINA_DEFECTO)), POR_PAGINA_MAX);
    const pagina = Math.max(1, Math.trunc(paginacion.pagina ?? 1));
    const { cierres, total } = await this.caja.listarCierres(
      {
        ...(filtro.usuarioId ? { usuarioId: filtro.usuarioId } : {}),
        ...(filtro.desde ? { desde: inicioDiaEC(filtro.desde) } : {}),
        ...(filtro.hasta ? { hasta: new Date(inicioDiaEC(filtro.hasta).getTime() + DIA_MS) } : {}),
      },
      { pagina, porPagina },
    );
    return { datos: cierres.map((c) => toCierreDTO(c)), pagina, porPagina, total, totalPaginas: Math.ceil(total / porPagina) };
  }
}

export class ObtenerCierreCaja {
  constructor(private readonly caja: CajaRepository) {}

  async ejecutar(id: string): Promise<CierreCajaDTO> {
    const cierre = await this.caja.buscarCierre(id);
    if (!cierre) throw new DomainError("NO_ENCONTRADO", "Cierre de caja no encontrado");
    return toCierreDTO(cierre, await this.caja.cobrosDeCierre(id));
  }
}
