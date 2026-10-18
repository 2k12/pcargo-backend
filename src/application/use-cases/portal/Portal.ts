import type { Cliente } from "../../../domain/cliente/Cliente.js";
import { MAX_DIRECCION_REMITENTE, type Destinatario } from "../../../domain/envio/Envio.js";
import { ESTADOS, esEstado, esFinal, type EstadoEnvio } from "../../../domain/envio/EstadoEnvio.js";
import { FORMAS_PAGO, type FormaPago } from "../../../domain/envio/FormaPago.js";
import { pareceNumeroGuia } from "../../../domain/envio/NumeroGuia.js";
import type { Ruta } from "../../../domain/ruta/Ruta.js";
import { DomainError, redondear2 } from "../../../domain/shared/DomainError.js";
import { diasEntre, fechaLocalEC, inicioMesEC, validarRangoEC } from "../../../domain/shared/FechaEcuador.js";
import type { Actor } from "../../../domain/usuario/Usuario.js";
import { toEnvioPortalDTO, type EnvioPortalDTO } from "../../dto/VistasEnvioDTO.js";
import type { ClienteRepository, EnvioRepository, Paginacion, RutaRepository } from "../../ports/repositories.js";
import type { Clock } from "../../ports/services.js";
import { POR_PAGINA_DEFECTO, POR_PAGINA_MAX, parsearNumeroGuiaSeguro, type PaginaDTO } from "../envios/ConsultasEnvio.js";
import type { CrearEnvio } from "../envios/CrearEnvio.js";
import type { ItemSolicitud } from "../envios/CotizarEnvio.js";

// Portal de clientes empresa (contrato v12): el usuario CLIENTE ve y registra solo los envíos de SU cliente.

export const NOTA_REGISTRO_PORTAL = "Registrado desde el portal de clientes";
export const FORMAS_PAGO_PORTAL = ["CONTRATO", "AL_COBRO"] as const;

/** El cliente del portal; un CLIENTE sin cliente vinculado (cliente eliminado) → 403. */
export function clienteDelActor(actor: Actor): string {
  if (actor.rol !== "CLIENTE" || !actor.clienteId) {
    throw new DomainError("PROHIBIDO", "Su usuario no está vinculado a un cliente");
  }
  return actor.clienteId;
}

async function exigirCliente(clientes: ClienteRepository, actor: Actor): Promise<Cliente> {
  const cliente = await clientes.buscarPorId(clienteDelActor(actor));
  if (!cliente) throw new DomainError("PROHIBIDO", "Su usuario no está vinculado a un cliente");
  return cliente;
}

async function rutasPorId(rutas: RutaRepository): Promise<Map<number, Ruta>> {
  return new Map((await rutas.listar()).map((r) => [r.id, r]));
}

export interface ResumenPortalDTO {
  cliente: { id: string; nombre: string; telefono: string; direccion: string | null };
  desde: string;
  hasta: string;
  envios: number;
  monto: number;
  enCurso: number;
  entregados: number;
  porCobrar: number;
  porEstado: Record<EstadoEnvio, number>;
  porFormaPago: { formaPago: FormaPago; envios: number; monto: number }[];
  porDia: { fecha: string; envios: number; monto: number }[];
}

/** Resumen del periodo (por defecto, el mes en curso de Ecuador hasta hoy) por fecha de registro. */
export class ObtenerResumenPortal {
  constructor(
    private readonly envios: EnvioRepository,
    private readonly clientes: ClienteRepository,
    private readonly clock: Clock,
  ) {}

  async ejecutar(actor: Actor, filtro: { desde?: string; hasta?: string } = {}): Promise<ResumenPortalDTO> {
    const cliente = await exigirCliente(this.clientes, actor);
    validarRangoEC(filtro.desde, filtro.hasta);
    const ahora = this.clock.ahora();
    const hasta = filtro.hasta ?? fechaLocalEC(ahora);
    const desde = filtro.desde ?? inicioMesEC(filtro.hasta ? new Date(`${filtro.hasta}T12:00:00Z`) : ahora);
    validarRangoEC(desde, hasta);

    const porEstado = Object.fromEntries(ESTADOS.map((e) => [e, 0])) as Record<EstadoEnvio, number>;
    const porPago = new Map<FormaPago, { envios: number; monto: number }>(FORMAS_PAGO.map((f) => [f, { envios: 0, monto: 0 }]));
    const porDia = new Map<string, { envios: number; monto: number }>();
    let envios = 0;
    let monto = 0;
    let enCurso = 0;
    let entregados = 0;
    let porCobrar = 0;
    for (const e of await this.envios.listar({ clienteId: cliente.id })) {
      const dia = fechaLocalEC(e.toSnapshot().creadoEn);
      if (dia < desde || dia > hasta) continue;
      const m = e.estado === "CANCELADO" ? 0 : e.costo;
      envios++;
      monto += m;
      porEstado[e.estado]++;
      if (!esFinal(e.estado)) enCurso++;
      if (e.estado === "ENTREGADO") entregados++;
      if (e.formaPago === "AL_COBRO" && !esFinal(e.estado)) porCobrar += m;
      const p = porPago.get(e.formaPago)!;
      p.envios++;
      p.monto += m;
      const d = porDia.get(dia) ?? { envios: 0, monto: 0 };
      d.envios++;
      d.monto += m;
      porDia.set(dia, d);
    }
    return {
      cliente: { id: cliente.id, nombre: cliente.nombre, telefono: cliente.telefono, direccion: cliente.direccion },
      desde,
      hasta,
      envios,
      monto: redondear2(monto),
      enCurso,
      entregados,
      porCobrar: redondear2(porCobrar),
      porEstado,
      porFormaPago: [...porPago].map(([formaPago, v]) => ({ formaPago, envios: v.envios, monto: redondear2(v.monto) })),
      porDia: diasEntre(desde, hasta).map((fecha) => {
        const d = porDia.get(fecha);
        return { fecha, envios: d?.envios ?? 0, monto: redondear2(d?.monto ?? 0) };
      }),
    };
  }
}

export class ListarEnviosPortal {
  constructor(
    private readonly envios: EnvioRepository,
    private readonly rutas: RutaRepository,
  ) {}

  async ejecutar(
    actor: Actor,
    filtro: { estado?: string; q?: string } = {},
    paginacion: Partial<Paginacion> = {},
  ): Promise<PaginaDTO<EnvioPortalDTO>> {
    const clienteId = clienteDelActor(actor);
    if (filtro.estado !== undefined && !esEstado(filtro.estado)) {
      throw new DomainError("VALIDACION", `Estado desconocido: ${filtro.estado}`);
    }
    const porPagina = Math.min(Math.max(1, Math.trunc(paginacion.porPagina ?? POR_PAGINA_DEFECTO)), POR_PAGINA_MAX);
    const pagina = Math.max(1, Math.trunc(paginacion.pagina ?? 1));
    const q = filtro.q?.trim();
    const [{ envios, total }, mapa] = await Promise.all([
      this.envios.listarPagina(
        {
          clienteId,
          ...(filtro.estado ? { estado: filtro.estado as EstadoEnvio } : {}),
          ...(q ? { q, ...(pareceNumeroGuia(q) ? { numeroGuia: parsearNumeroGuiaSeguro(q) } : {}) } : {}),
        },
        { pagina, porPagina },
      ),
      rutasPorId(this.rutas),
    ]);
    return {
      datos: envios.map((e) => toEnvioPortalDTO(e, mapa.get(e.rutaId))),
      pagina,
      porPagina,
      total,
      totalPaginas: Math.ceil(total / porPagina),
    };
  }
}

export class ObtenerEnvioPortal {
  constructor(
    private readonly envios: EnvioRepository,
    private readonly rutas: RutaRepository,
  ) {}

  async ejecutar(actor: Actor, id: string): Promise<EnvioPortalDTO> {
    const clienteId = clienteDelActor(actor);
    const envio = await this.envios.buscarPorId(id);
    if (!envio || envio.clienteId !== clienteId) throw new DomainError("NO_ENCONTRADO", "Envío no encontrado");
    return toEnvioPortalDTO(envio, (await this.rutas.buscarPorId(envio.rutaId)) ?? undefined, true);
  }
}

export interface NuevoEnvioPortal {
  destinatario: Destinatario;
  rutaId: number;
  items: ItemSolicitud[];
  zona?: string | null;
  formaPago?: string | null;
  descripcion?: string | null;
}

/**
 * Registro desde el portal: el remitente es el cliente (no se toma del body), forma de pago CONTRATO (por defecto)
 * o AL_COBRO, guía consecutiva y canal PANEL. No genera cobro ORIGEN (no se paga en efectivo al registrar).
 */
export class CrearEnvioPortal {
  constructor(
    private readonly crearEnvio: Pick<CrearEnvio, "registrar">,
    private readonly clientes: ClienteRepository,
  ) {}

  async ejecutar(actor: Actor, s: NuevoEnvioPortal): Promise<EnvioPortalDTO> {
    const cliente = await exigirCliente(this.clientes, actor);
    const formaPago = s.formaPago ?? "CONTRATO";
    if (!(FORMAS_PAGO_PORTAL as readonly string[]).includes(formaPago)) {
      throw new DomainError("VALIDACION", `Forma de pago no admitida en el portal: ${formaPago}`);
    }
    const { envio, ruta } = await this.crearEnvio.registrar(
      {
        remitente: {
          nombre: cliente.nombre,
          telefono: cliente.telefono,
          direccion: cliente.direccion?.slice(0, MAX_DIRECCION_REMITENTE) ?? null,
        },
        destinatario: s.destinatario,
        rutaId: s.rutaId,
        items: s.items,
        zona: s.zona,
        formaPago,
        descripcion: s.descripcion,
        numeroGuia: null,
        clienteId: cliente.id,
      },
      { actor, notaRegistro: NOTA_REGISTRO_PORTAL },
    );
    return toEnvioPortalDTO(envio, ruta, true);
  }
}
