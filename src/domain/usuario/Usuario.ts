import { DomainError } from "../shared/DomainError.js";

/**
 * ADMIN y OPERADOR usan el panel; REPARTIDOR, la app del repartidor; CLIENTE, el portal de su empresa (contrato v12).
 */
export const ROLES = ["ADMIN", "OPERADOR", "REPARTIDOR", "CLIENTE"] as const;
export type Rol = (typeof ROLES)[number];

/** Roles con acceso al panel (todas las rutas privadas anteriores a v12). */
export const ROLES_PANEL: readonly Rol[] = ["ADMIN", "OPERADOR"];

export const esRol = (valor: unknown): valor is Rol => (ROLES as readonly unknown[]).includes(valor);

export interface Usuario {
  id: string;
  nombre: string;
  email: string;
  rol: Rol;
  /** Cliente frecuente vinculado (solo CLIENTE; null si se eliminó el cliente). */
  clienteId: string | null;
}

export interface UsuarioConCredenciales extends Usuario {
  passwordHash: string;
  activo: boolean;
}

/** Usuario tal como lo gestiona el ADMIN (incluye los inactivos). */
export interface UsuarioAdmin extends Usuario {
  activo: boolean;
  creadoEn: Date;
}

/** Usuario autenticado que ejecuta un caso de uso. */
export interface Actor {
  id: string;
  nombre: string;
  rol: Rol;
  /** Solo CLIENTE: el cliente frecuente cuyo portal usa (null si el cliente se eliminó). */
  clienteId?: string | null;
}

/** Lanza 403 PROHIBIDO si el rol del actor no está entre los permitidos. */
export function exigirRol(actor: Pick<Actor, "rol">, roles: readonly Rol[]): void {
  if (!roles.includes(actor.rol)) {
    throw new DomainError("PROHIBIDO", "No tiene permiso para realizar esta operación");
  }
}

// ── Perfil propio (contrato v9) ──────────────────────────────────────────────

export const NOMBRE_USUARIO = { min: 2, max: 80 } as const;
export const CONTRASENA = { min: 8, max: 72 } as const;
/** Largo de la contraseña temporal de un acceso al portal (letras y números). */
export const LARGO_CONTRASENA_TEMPORAL = 12;

/** Cambios que un usuario puede hacer en su propio perfil (el rol no se cambia por aquí). */
export interface CambiosPerfil {
  nombre?: string;
  email?: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Nombre de usuario: 2–80 caracteres, espacios colapsados. */
export function normalizarNombreUsuario(nombre: string): string {
  const limpio = (nombre ?? "").trim().replace(/\s+/g, " ");
  if (limpio.length < NOMBRE_USUARIO.min || limpio.length > NOMBRE_USUARIO.max) {
    throw new DomainError(
      "VALIDACION",
      `El nombre debe tener entre ${NOMBRE_USUARIO.min} y ${NOMBRE_USUARIO.max} caracteres`,
    );
  }
  return limpio;
}

/** Correo válido, en minúsculas. */
export function normalizarEmail(email: string): string {
  const limpio = (email ?? "").trim().toLowerCase();
  if (!EMAIL.test(limpio)) throw new DomainError("VALIDACION", "El correo no es válido");
  return limpio;
}

/** Normaliza y valida los cambios del perfil: nombre 2–80 (espacios colapsados) y correo en minúsculas. */
export function normalizarCambiosPerfil(c: CambiosPerfil): CambiosPerfil {
  const r: CambiosPerfil = {};
  if (c.nombre !== undefined) r.nombre = normalizarNombreUsuario(c.nombre);
  if (c.email !== undefined) r.email = normalizarEmail(c.email);
  if (r.nombre === undefined && r.email === undefined) {
    throw new DomainError("VALIDACION", "Debe enviar al menos un campo (nombre o email)");
  }
  return r;
}

/** Política de contraseñas: 8–72 caracteres, al menos una letra y un número. */
export function validarPoliticaContrasena(password: string, etiqueta = "La contraseña"): void {
  if (password.length < CONTRASENA.min || password.length > CONTRASENA.max) {
    throw new DomainError(
      "VALIDACION",
      `${etiqueta} debe tener entre ${CONTRASENA.min} y ${CONTRASENA.max} caracteres`,
    );
  }
  if (!/\p{L}/u.test(password) || !/\p{Nd}/u.test(password)) {
    throw new DomainError("VALIDACION", `${etiqueta} debe tener al menos una letra y un número`);
  }
}

/** Política de la contraseña nueva: 8–72 caracteres, al menos una letra y un número, distinta de la actual. */
export function validarContrasenaNueva(actual: string, nueva: string): void {
  validarPoliticaContrasena(nueva, "La contraseña nueva");
  if (nueva === actual) throw new DomainError("VALIDACION", "La contraseña nueva debe ser distinta de la actual");
}

// ── Código único de acceso (contrato v17) ────────────────────────────────────

export const CODIGO_ACCESO = { min: 6, max: 32 } as const;

/**
 * Código único de acceso: 6–32 caracteres sin espacios (letras, números, símbolos o una mezcla), distinto de la
 * contraseña. Distingue mayúsculas; el largo se cuenta en caracteres, no en unidades UTF-16.
 */
export function validarCodigoAcceso(codigo: string, password: string): void {
  const largo = [...codigo].length;
  if (largo < CODIGO_ACCESO.min || largo > CODIGO_ACCESO.max) {
    throw new DomainError(
      "VALIDACION",
      `El código debe tener entre ${CODIGO_ACCESO.min} y ${CODIGO_ACCESO.max} caracteres`,
    );
  }
  if (/\s/u.test(codigo)) throw new DomainError("VALIDACION", "El código no puede tener espacios");
  if (codigo === password) throw new DomainError("VALIDACION", "El código debe ser distinto de la contraseña");
}

// ── Gestión de usuarios por el ADMIN (contrato v12) ──────────────────────────

export interface DatosNuevoUsuario {
  nombre: string;
  email: string;
  password: string;
  rol: string;
  clienteId?: string | null;
}

export interface NuevoUsuarioNormalizado {
  nombre: string;
  email: string;
  password: string;
  rol: Rol;
  clienteId: string | null;
}

/**
 * Valida un usuario nuevo. CLIENTE exige `clienteId` (que exista lo comprueba el caso de uso, 422); en los demás
 * roles `clienteId` debe omitirse o ser null (400).
 */
export function normalizarNuevoUsuario(d: DatosNuevoUsuario): NuevoUsuarioNormalizado {
  if (!esRol(d.rol)) throw new DomainError("VALIDACION", `Rol desconocido: ${d.rol}`);
  const clienteId = d.clienteId ?? null;
  if (d.rol === "CLIENTE" && !clienteId) {
    throw new DomainError("VALIDACION", "Un usuario CLIENTE debe estar vinculado a un cliente (clienteId)");
  }
  if (d.rol !== "CLIENTE" && clienteId) {
    throw new DomainError("VALIDACION", "Solo los usuarios CLIENTE se vinculan a un cliente");
  }
  validarPoliticaContrasena(d.password ?? "");
  return {
    nombre: normalizarNombreUsuario(d.nombre),
    email: normalizarEmail(d.email),
    password: d.password,
    rol: d.rol,
    clienteId,
  };
}

export interface CambiosUsuario {
  nombre?: string;
  email?: string;
  password?: string;
  rol?: string;
  activo?: boolean;
}

export interface CambiosUsuarioNormalizados {
  nombre?: string;
  email?: string;
  password?: string;
  rol?: Rol;
  activo?: boolean;
}

/**
 * Valida los cambios de un usuario hechos por un ADMIN (`actorId`): el rol no cambia de/hacia CLIENTE y un ADMIN no
 * puede desactivarse ni quitarse el rol ADMIN (422).
 */
export function normalizarCambiosUsuario(
  actual: Pick<Usuario, "id" | "rol">,
  c: CambiosUsuario,
  actorId: string,
): CambiosUsuarioNormalizados {
  const r: CambiosUsuarioNormalizados = {};
  if (c.nombre !== undefined) r.nombre = normalizarNombreUsuario(c.nombre);
  if (c.email !== undefined) r.email = normalizarEmail(c.email);
  if (c.password !== undefined) {
    validarPoliticaContrasena(c.password);
    r.password = c.password;
  }
  if (c.rol !== undefined) {
    if (!esRol(c.rol)) throw new DomainError("VALIDACION", `Rol desconocido: ${c.rol}`);
    if (c.rol !== actual.rol && (c.rol === "CLIENTE" || actual.rol === "CLIENTE")) {
      throw new DomainError(
        "VALIDACION",
        "El rol de un usuario no cambia de o hacia CLIENTE: cree otro usuario",
        { regla: true },
      );
    }
    r.rol = c.rol;
  }
  if (c.activo !== undefined) r.activo = c.activo;
  if (Object.keys(r).length === 0) throw new DomainError("VALIDACION", "Debe enviar al menos un campo");
  if (actual.id === actorId && (r.activo === false || (r.rol !== undefined && r.rol !== "ADMIN"))) {
    throw new DomainError("VALIDACION", "No puede desactivarse ni quitarse el rol de administrador", {
      regla: true,
    });
  }
  return r;
}
