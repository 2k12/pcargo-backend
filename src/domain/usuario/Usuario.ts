import { DomainError } from "../shared/DomainError.js";

export const ROLES = ["ADMIN", "OPERADOR"] as const;
export type Rol = (typeof ROLES)[number];

export interface Usuario {
  id: string;
  nombre: string;
  email: string;
  rol: Rol;
}

export interface UsuarioConCredenciales extends Usuario {
  passwordHash: string;
  activo: boolean;
}

/** Usuario autenticado que ejecuta un caso de uso. */
export type Actor = Pick<Usuario, "id" | "nombre" | "rol">;

// ── Perfil propio (contrato v9) ──────────────────────────────────────────────

export const NOMBRE_USUARIO = { min: 2, max: 80 } as const;
export const CONTRASENA = { min: 8, max: 72 } as const;

/** Cambios que un usuario puede hacer en su propio perfil (el rol no se cambia por aquí). */
export interface CambiosPerfil {
  nombre?: string;
  email?: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Normaliza y valida los cambios del perfil: nombre 2–80 (espacios colapsados) y correo en minúsculas. */
export function normalizarCambiosPerfil(c: CambiosPerfil): CambiosPerfil {
  const r: CambiosPerfil = {};
  if (c.nombre !== undefined) {
    const nombre = c.nombre.trim().replace(/\s+/g, " ");
    if (nombre.length < NOMBRE_USUARIO.min || nombre.length > NOMBRE_USUARIO.max) {
      throw new DomainError(
        "VALIDACION",
        `El nombre debe tener entre ${NOMBRE_USUARIO.min} y ${NOMBRE_USUARIO.max} caracteres`,
      );
    }
    r.nombre = nombre;
  }
  if (c.email !== undefined) {
    const email = c.email.trim().toLowerCase();
    if (!EMAIL.test(email)) throw new DomainError("VALIDACION", "El correo no es válido");
    r.email = email;
  }
  if (r.nombre === undefined && r.email === undefined) {
    throw new DomainError("VALIDACION", "Debe enviar al menos un campo (nombre o email)");
  }
  return r;
}

/** Política de la contraseña nueva: 8–72 caracteres, al menos una letra y un número, distinta de la actual. */
export function validarContrasenaNueva(actual: string, nueva: string): void {
  if (nueva.length < CONTRASENA.min || nueva.length > CONTRASENA.max) {
    throw new DomainError(
      "VALIDACION",
      `La contraseña nueva debe tener entre ${CONTRASENA.min} y ${CONTRASENA.max} caracteres`,
    );
  }
  if (!/\p{L}/u.test(nueva) || !/\p{Nd}/u.test(nueva)) {
    throw new DomainError("VALIDACION", "La contraseña nueva debe tener al menos una letra y un número");
  }
  if (nueva === actual) throw new DomainError("VALIDACION", "La contraseña nueva debe ser distinta de la actual");
}
