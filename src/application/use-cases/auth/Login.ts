import { DomainError } from "../../../domain/shared/DomainError.js";
import type { Usuario } from "../../../domain/usuario/Usuario.js";
import type { UsuarioRepository } from "../../ports/repositories.js";
import type { PasswordHasher, TokenService } from "../../ports/services.js";

export interface LoginResultado {
  token: string;
  usuario: Usuario;
}

/** Token y usuario de una sesión nueva (login con correo o con código único). */
export function iniciarSesion(tokens: TokenService, usuario: Usuario): LoginResultado {
  const { id, nombre, rol } = usuario;
  return {
    token: tokens.firmar({ id, nombre, rol }),
    usuario: { id, nombre, email: usuario.email, rol, clienteId: usuario.clienteId ?? null },
  };
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
    return iniciarSesion(this.tokens, usuario);
  }
}
