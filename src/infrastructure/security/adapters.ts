import { randomInt } from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { GeneradorContrasenas, PasswordHasher, TokenService } from "../../application/ports/services.js";
import { DomainError } from "../../domain/shared/DomainError.js";
import { ROLES, type Actor } from "../../domain/usuario/Usuario.js";

export class BcryptPasswordHasher implements PasswordHasher {
  constructor(private readonly rondas = 10) {}
  hash(plano: string): Promise<string> {
    return bcrypt.hash(plano, this.rondas);
  }
  verificar(plano: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plano, hash);
  }
}

export class JwtTokenService implements TokenService {
  constructor(
    private readonly secreto: string,
    private readonly expiraEn: string = "8h",
  ) {}

  firmar(actor: Actor): string {
    return jwt.sign({ nombre: actor.nombre, rol: actor.rol }, this.secreto, {
      subject: actor.id,
      expiresIn: this.expiraEn as jwt.SignOptions["expiresIn"],
    });
  }

  verificar(token: string): Actor {
    try {
      const p = jwt.verify(token, this.secreto) as jwt.JwtPayload;
      if (!p.sub || !ROLES.includes(p.rol)) throw new Error("payload inválido");
      return { id: p.sub, nombre: String(p.nombre), rol: p.rol };
    } catch {
      throw new DomainError("NO_AUTENTICADO", "Sesión inválida o expirada");
    }
  }
}

const ALFANUMERICO = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/**
 * Contraseñas temporales con `crypto.randomInt` (CSPRNG, sin sesgo de módulo). Sin caracteres confusos (0/O, 1/l/I) y
 * siempre con al menos una letra y un número (cumplen la política de contraseñas).
 */
export class GeneradorContrasenasCrypto implements GeneradorContrasenas {
  temporal(largo: number): string {
    for (;;) {
      let clave = "";
      for (let i = 0; i < largo; i++) clave += ALFANUMERICO[randomInt(ALFANUMERICO.length)];
      if (/[A-Za-z]/.test(clave) && /[0-9]/.test(clave)) return clave;
    }
  }
}
