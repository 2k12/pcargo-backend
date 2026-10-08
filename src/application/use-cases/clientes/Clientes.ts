import {
  digitosTelefono,
  exigirConsentimiento,
  normalizarCliente,
  type Cliente,
  type DatosCliente,
} from "../../../domain/cliente/Cliente.js";
import type { Envio } from "../../../domain/envio/Envio.js";
import { DomainError, redondear2 } from "../../../domain/shared/DomainError.js";
import type { ClienteRepository, EnvioRepository } from "../../ports/repositories.js";
import type { Clock, IdGenerator } from "../../ports/services.js";

export interface ClienteDTO {
  id: string;
  nombre: string;
  telefono: string;
  direccion: string | null;
  notas: string | null;
  creadoEn: string;
  /** Cuándo aceptó que se guarden sus datos (LOPDP); null en clientes anteriores a v7. */
  consentimientoEn: string | null;
  /** Envíos registrados a nombre del cliente (incluye cancelados). */
  envios: number;
  /** Suma de los envíos no cancelados. */
  monto: number;
  ultimoEnvio: string | null;
}

interface Estadistica {
  envios: number;
  monto: number;
  ultimo: Date | null;
}

function estadisticas(envios: Envio[]): Map<string, Estadistica> {
  const mapa = new Map<string, Estadistica>();
  for (const e of envios) {
    if (!e.clienteId) continue;
    const s = e.toSnapshot();
    const est = mapa.get(e.clienteId) ?? { envios: 0, monto: 0, ultimo: null };
    est.envios++;
    if (s.estado !== "CANCELADO") est.monto += s.costo;
    if (!est.ultimo || s.creadoEn > est.ultimo) est.ultimo = s.creadoEn;
    mapa.set(e.clienteId, est);
  }
  return mapa;
}

export function toClienteDTO(c: Cliente, est?: Estadistica): ClienteDTO {
  return {
    id: c.id,
    nombre: c.nombre,
    telefono: c.telefono,
    direccion: c.direccion,
    notas: c.notas,
    creadoEn: c.creadoEn.toISOString(),
    consentimientoEn: c.consentimientoEn?.toISOString() ?? null,
    envios: est?.envios ?? 0,
    monto: redondear2(est?.monto ?? 0),
    ultimoEnvio: est?.ultimo?.toISOString() ?? null,
  };
}

/** Datos de alta de un cliente: `consentimiento` debe ser `true` (se valida aquí, no en la capa HTTP). */
export type AltaCliente = DatosCliente & { consentimiento?: unknown };

/** Cambios de un cliente: `consentimiento`, si viene, solo puede ser `true` (no se revoca por edición). */
export type CambiosCliente = Partial<DatosCliente> & { consentimiento?: unknown };

async function exigirTelefonoLibre(clientes: ClienteRepository, telefono: string, excluirId?: string): Promise<void> {
  const otro = await clientes.buscarPorTelefono(telefono, excluirId);
  if (otro) throw new DomainError("CONFLICTO", `El teléfono ${telefono} ya pertenece al cliente ${otro.nombre}`);
}

export class ListarClientes {
  constructor(
    private readonly clientes: ClienteRepository,
    private readonly envios: EnvioRepository,
  ) {}

  async ejecutar(filtro: { q?: string } = {}): Promise<ClienteDTO[]> {
    const [lista, envios] = await Promise.all([this.clientes.listar(filtro), this.envios.listar()]);
    const est = estadisticas(envios);
    return lista.map((c) => toClienteDTO(c, est.get(c.id)));
  }
}

export class CrearCliente {
  constructor(
    private readonly clientes: ClienteRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async ejecutar({ consentimiento, ...datos }: AltaCliente): Promise<ClienteDTO> {
    exigirConsentimiento(consentimiento);
    const limpio = normalizarCliente(datos);
    await exigirTelefonoLibre(this.clientes, limpio.telefono);
    const ahora = this.clock.ahora();
    const cliente: Cliente = { id: this.ids.uuid(), ...limpio, creadoEn: ahora, consentimientoEn: ahora };
    await this.clientes.crear(cliente);
    return toClienteDTO(cliente);
  }
}

/**
 * Alta rápida desde un envío (exige el consentimiento del remitente): si ya hay un cliente con ese teléfono
 * lo reutiliza (no falla ni duplica) y, si aún no tenía consentimiento registrado, lo registra ahora;
 * si no, lo crea con el consentimiento de este momento.
 */
export async function obtenerOCrearCliente(
  clientes: ClienteRepository,
  ctx: { ids: IdGenerator; clock: Clock },
  datos: DatosCliente,
  consentimiento: unknown,
): Promise<Cliente> {
  exigirConsentimiento(consentimiento);
  const limpio = normalizarCliente(datos);
  const existente = await clientes.buscarPorTelefono(limpio.telefono);
  if (existente) {
    return existente.consentimientoEn
      ? existente
      : clientes.registrarConsentimiento(existente.id, ctx.clock.ahora());
  }
  const ahora = ctx.clock.ahora();
  const cliente: Cliente = { id: ctx.ids.uuid(), ...limpio, creadoEn: ahora, consentimientoEn: ahora };
  await clientes.crear(cliente);
  return cliente;
}

export class ActualizarCliente {
  constructor(
    private readonly clientes: ClienteRepository,
    private readonly envios: EnvioRepository,
    private readonly clock: Clock,
  ) {}

  async ejecutar(id: string, { consentimiento, ...cambios }: CambiosCliente): Promise<ClienteDTO> {
    const registrar = consentimiento !== undefined;
    if (registrar) exigirConsentimiento(consentimiento);
    const actual = await this.clientes.buscarPorId(id);
    if (!actual) throw new DomainError("NO_ENCONTRADO", "Cliente no encontrado");
    const limpio = normalizarCliente({ ...actual, ...cambios });
    if (digitosTelefono(limpio.telefono) !== digitosTelefono(actual.telefono)) {
      await exigirTelefonoLibre(this.clientes, limpio.telefono, id);
    }
    const [actualizado, envios] = await Promise.all([
      this.clientes.actualizar(id, limpio),
      this.envios.listar({ clienteId: id }),
    ]);
    // Si ya tenía consentimiento el repositorio conserva la fecha original.
    const cliente = registrar ? await this.clientes.registrarConsentimiento(id, this.clock.ahora()) : actualizado;
    return toClienteDTO(cliente, estadisticas(envios).get(id));
  }
}

export class EliminarCliente {
  constructor(private readonly clientes: ClienteRepository) {}

  async ejecutar(id: string): Promise<void> {
    if (!(await this.clientes.buscarPorId(id))) throw new DomainError("NO_ENCONTRADO", "Cliente no encontrado");
    await this.clientes.eliminar(id);
  }
}
