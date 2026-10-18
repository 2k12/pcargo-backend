import { DomainError } from "../../../domain/shared/DomainError.js";
import {
  esRol,
  exigirRol,
  LARGO_CONTRASENA_TEMPORAL,
  normalizarCambiosUsuario,
  normalizarNuevoUsuario,
  type Actor,
  type CambiosUsuario,
  type DatosNuevoUsuario,
  type UsuarioAdmin,
} from "../../../domain/usuario/Usuario.js";
import type { CambiosUsuarioRepo, ClienteRepository, UsuarioRepository } from "../../ports/repositories.js";
import type { Clock, GeneradorContrasenas, IdGenerator, PasswordHasher } from "../../ports/services.js";

// Gestión de usuarios y accesos al portal (contrato v12, solo ADMIN salvo la lista de repartidores).

export interface UsuarioAdminDTO {
  id: string;
  nombre: string;
  email: string;
  rol: string;
  clienteId: string | null;
  activo: boolean;
  /** Nombre del cliente vinculado (solo CLIENTE). */
  cliente: string | null;
  creadoEn: string;
}

export interface AccesoPortalCreadoDTO {
  usuario: UsuarioAdminDTO;
  /** Solo viaja en esta respuesta. */
  passwordTemporal: string;
}

export interface DepsUsuarios {
  usuarios: UsuarioRepository;
  clientes: ClienteRepository;
  hasher: PasswordHasher;
  ids: IdGenerator;
  clock: Clock;
}

const SOLO_ADMIN = ["ADMIN"] as const;

export function toUsuarioAdminDTO(u: UsuarioAdmin, nombreCliente: string | null = null): UsuarioAdminDTO {
  return {
    id: u.id,
    nombre: u.nombre,
    email: u.email,
    rol: u.rol,
    clienteId: u.clienteId,
    activo: u.activo,
    cliente: u.clienteId ? nombreCliente : null,
    creadoEn: u.creadoEn.toISOString(),
  };
}

async function conCliente(clientes: ClienteRepository, u: UsuarioAdmin): Promise<UsuarioAdminDTO> {
  const cliente = u.clienteId ? await clientes.buscarPorId(u.clienteId) : null;
  return toUsuarioAdminDTO(u, cliente?.nombre ?? null);
}

async function conClientes(clientes: ClienteRepository, lista: UsuarioAdmin[]): Promise<UsuarioAdminDTO[]> {
  const nombres = lista.some((u) => u.clienteId)
    ? new Map((await clientes.listar()).map((c) => [c.id, c.nombre]))
    : new Map<string, string>();
  return lista.map((u) => toUsuarioAdminDTO(u, u.clienteId ? (nombres.get(u.clienteId) ?? null) : null));
}

async function exigirEmailLibre(usuarios: UsuarioRepository, email: string, excluirId?: string): Promise<void> {
  if (await usuarios.existeEmail(email, excluirId)) {
    throw new DomainError("CONFLICTO", "Ese correo ya está registrado por otro usuario");
  }
}

/** Alta común del ADMIN y de los accesos al portal. */
async function crearUsuario(d: DepsUsuarios, datos: DatosNuevoUsuario): Promise<UsuarioAdmin> {
  const limpio = normalizarNuevoUsuario(datos);
  if (limpio.clienteId && !(await d.clientes.buscarPorId(limpio.clienteId))) {
    throw new DomainError("VALIDACION", "El cliente indicado no existe", { regla: true });
  }
  await exigirEmailLibre(d.usuarios, limpio.email);
  const usuario: UsuarioAdmin = {
    id: d.ids.uuid(),
    nombre: limpio.nombre,
    email: limpio.email,
    rol: limpio.rol,
    clienteId: limpio.clienteId,
    activo: true,
    creadoEn: d.clock.ahora(),
  };
  await d.usuarios.crear({ ...usuario, passwordHash: await d.hasher.hash(limpio.password) });
  return usuario;
}

export class ListarUsuarios {
  constructor(private readonly d: DepsUsuarios) {}

  async ejecutar(actor: Actor, filtro: { rol?: string; activo?: boolean } = {}): Promise<UsuarioAdminDTO[]> {
    exigirRol(actor, SOLO_ADMIN);
    if (filtro.rol !== undefined && !esRol(filtro.rol)) throw new DomainError("VALIDACION", "Rol desconocido");
    const lista = await this.d.usuarios.listar({
      ...(filtro.rol ? { rol: filtro.rol } : {}),
      ...(filtro.activo !== undefined ? { activo: filtro.activo } : {}),
    });
    return conClientes(this.d.clientes, lista);
  }
}

export class CrearUsuario {
  constructor(private readonly d: DepsUsuarios) {}

  async ejecutar(actor: Actor, datos: DatosNuevoUsuario): Promise<UsuarioAdminDTO> {
    exigirRol(actor, SOLO_ADMIN);
    return conCliente(this.d.clientes, await crearUsuario(this.d, datos));
  }
}

export class ActualizarUsuario {
  constructor(private readonly d: DepsUsuarios) {}

  async ejecutar(actor: Actor, id: string, cambios: CambiosUsuario): Promise<UsuarioAdminDTO> {
    exigirRol(actor, SOLO_ADMIN);
    const actual = await this.d.usuarios.obtener(id);
    if (!actual) throw new DomainError("NO_ENCONTRADO", "Usuario no encontrado");
    const limpio = normalizarCambiosUsuario(actual, cambios, actor.id);
    if (limpio.email !== undefined) await exigirEmailLibre(this.d.usuarios, limpio.email, id);
    const { password, ...resto } = limpio;
    const repo: CambiosUsuarioRepo = { ...resto };
    if (password !== undefined) repo.passwordHash = await this.d.hasher.hash(password);
    return conCliente(this.d.clientes, await this.d.usuarios.actualizar(id, repo));
  }
}

/** Repartidores activos (para asignar envíos desde el panel). */
export class ListarRepartidores {
  constructor(private readonly usuarios: UsuarioRepository) {}

  async ejecutar(): Promise<{ id: string; nombre: string }[]> {
    const lista = await this.usuarios.listar({ rol: "REPARTIDOR", activo: true });
    return lista.map(({ id, nombre }) => ({ id, nombre }));
  }
}

export class ListarAccesosCliente {
  constructor(private readonly d: DepsUsuarios) {}

  async ejecutar(actor: Actor, clienteId: string): Promise<UsuarioAdminDTO[]> {
    exigirRol(actor, SOLO_ADMIN);
    const cliente = await this.d.clientes.buscarPorId(clienteId);
    if (!cliente) throw new DomainError("NO_ENCONTRADO", "Cliente no encontrado");
    const lista = await this.d.usuarios.listar({ clienteId });
    return lista.map((u) => toUsuarioAdminDTO(u, cliente.nombre));
  }
}

/** Crea un usuario CLIENTE vinculado al cliente con una contraseña temporal generada (12 letras y números). */
export class CrearAccesoPortal {
  constructor(
    private readonly d: DepsUsuarios,
    private readonly contrasenas: GeneradorContrasenas,
  ) {}

  async ejecutar(
    actor: Actor,
    clienteId: string,
    datos: { nombre: string; email: string },
  ): Promise<AccesoPortalCreadoDTO> {
    exigirRol(actor, SOLO_ADMIN);
    const cliente = await this.d.clientes.buscarPorId(clienteId);
    if (!cliente) throw new DomainError("NO_ENCONTRADO", "Cliente no encontrado");
    const passwordTemporal = this.contrasenas.temporal(LARGO_CONTRASENA_TEMPORAL);
    const usuario = await crearUsuario(this.d, { ...datos, password: passwordTemporal, rol: "CLIENTE", clienteId });
    return { usuario: toUsuarioAdminDTO(usuario, cliente.nombre), passwordTemporal };
  }
}
