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
  codigoSeguimiento(): string;
}
