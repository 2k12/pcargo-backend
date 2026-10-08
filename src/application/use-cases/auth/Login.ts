import { DomainError } from "../../../domain/shared/DomainError.js";
import type { Usuario } from "../../../domain/usuario/Usuario.js";
import type { UsuarioRepository } from "../../ports/repositories.js";
import type { PasswordHasher, TokenService } from "../../ports/services.js";

export interface LoginResultado {
  token: string;
  usuario: Usuario;
}

export class Login {
  constructor(
    private readonly usuarios: UsuarioRepository,
    private readonly hasher: PasswordHasher,
    private readonly tokens: TokenService,
  ) {}

  async ejecutar(email: string, password: string): Promise<LoginResultado> {
    const usuario = await this.usuarios.buscarPorEmail(email.trim().toLowerCase());
    // Mismo mensaje para usuario inexistente y contraseña incorrecta (no filtrar cuentas).
    const valido = usuario?.activo && (await this.hasher.verificar(password, usuario.passwordHash));
    if (!usuario || !valido) {
      throw new DomainError("CREDENCIALES_INVALIDAS", "Correo o contraseña incorrectos");
    }
    const { id, nombre, rol } = usuario;
    return {
      token: this.tokens.firmar({ id, nombre, rol }),
      usuario: { id, nombre, email: usuario.email, rol },
    };
  }
}
