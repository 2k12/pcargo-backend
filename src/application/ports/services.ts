import type { Actor } from "../../domain/usuario/Usuario.js";

export interface PasswordHasher {
  hash(plano: string): Promise<string>;
  verificar(plano: string, hash: string): Promise<boolean>;
}

export interface TokenService {
  firmar(actor: Actor): string;
  /** Lanza DomainError("NO_AUTENTICADO") si el token es inválido o expiró. */
  verificar(token: string): Actor;
}

export interface Clock {
  ahora(): Date;
}

export interface IdGenerator {
  uuid(): string;
}

/**
 * Huella del código único de acceso (v17): determinista para buscar al usuario por ella, con una clave del servidor
 * para que una copia de la base no permita probar códigos sin esa clave.
 */
export interface HuellaCodigoAcceso {
  huella(codigo: string): string;
}

/** Contraseñas temporales (accesos al portal): letras y números, generadas criptográficamente. */
export interface GeneradorContrasenas {
  temporal(largo: number): string;
}

/**
 * Almacén privado de archivos (evidencias de entrega). Adaptadores: memoria (tests), disco local (desarrollo)
 * y Cloudflare R2 (producción). Las claves las genera la aplicación; nunca se exponen con una URL pública.
 */
export interface AlmacenArchivos {
  guardar(clave: string, bytes: Uint8Array, tipo: string): Promise<void>;
  /** `null` si la clave no existe. */
  obtener(clave: string): Promise<Uint8Array | null>;
  /** Idempotente: borrar una clave inexistente no es un error. */
  eliminar(clave: string): Promise<void>;
}
