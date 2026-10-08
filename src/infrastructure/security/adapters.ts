import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { PasswordHasher, TokenService } from "../../application/ports/services.js";
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
