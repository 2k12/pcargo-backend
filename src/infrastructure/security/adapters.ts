import { createHmac, randomInt } from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type {
  GeneradorContrasenas,
  HuellaCodigoAcceso,
  PasswordHasher,
  TokenService,
} from "../../application/ports/services.js";
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

/**
 * Huella del código único de acceso: HMAC-SHA256 con una clave derivada del secreto del JWT (separada por contexto, así
 * la misma clave nunca firma tokens y huellas). Cambiar el secreto invalida los códigos guardados.
 */
export class HuellaCodigoHmac implements HuellaCodigoAcceso {
  private readonly clave: Buffer;

  constructor(secreto: string) {
    this.clave = createHmac("sha256", secreto).update("pcargo:codigo-acceso:v1").digest();
  }

  huella(codigo: string): string {
    // NFC: el mismo código escrito con otro teclado (p. ej. «ñ» compuesta) da la misma huella.
    return createHmac("sha256", this.clave).update(codigo.normalize("NFC"), "utf8").digest("hex");
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
