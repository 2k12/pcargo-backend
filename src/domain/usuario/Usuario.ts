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
