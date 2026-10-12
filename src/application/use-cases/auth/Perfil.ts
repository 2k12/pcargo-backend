import { DomainError } from "../../../domain/shared/DomainError.js";
import {
  normalizarCambiosPerfil,
  validarContrasenaNueva,
  type Actor,
  type CambiosPerfil,
} from "../../../domain/usuario/Usuario.js";
import type { UsuarioRepository } from "../../ports/repositories.js";
import type { PasswordHasher, TokenService } from "../../ports/services.js";
import type { LoginResultado } from "./Login.js";

const sesionInvalida = () => new DomainError("NO_AUTENTICADO", "La sesión ya no es válida");

/**
 * Edita el perfil propio (nombre y/o correo). Devuelve un token nuevo: el nombre viaja en el JWT y es el que
 * queda como operador en los historiales, así que el token anterior quedaría con el nombre viejo.
 */
export class ActualizarPerfil {
  constructor(
    private readonly usuarios: UsuarioRepository,
    private readonly tokens: TokenService,
  ) {}

  async ejecutar(actor: Actor, cambios: CambiosPerfil): Promise<LoginResultado> {
    const limpio = normalizarCambiosPerfil(cambios);
    if (!(await this.usuarios.buscarPorId(actor.id))) throw sesionInvalida();
    if (limpio.email !== undefined && (await this.usuarios.existeEmail(limpio.email, actor.id))) {
      throw new DomainError("CONFLICTO", "Ese correo ya está registrado por otro usuario");
    }
    const usuario = await this.usuarios.actualizarPerfil(actor.id, limpio);
    return {
      // El rol sale del repositorio, no del token: este endpoint no puede cambiarlo.
      token: this.tokens.firmar({ id: usuario.id, nombre: usuario.nombre, rol: usuario.rol }),
      usuario,
    };
  }
}

export interface SolicitudCambioContrasena {
  actual: string;
  nueva: string;
}

export class CambiarContrasena {
  constructor(
    private readonly usuarios: UsuarioRepository,
    private readonly hasher: PasswordHasher,
  ) {}

  async ejecutar(actor: Actor, { actual, nueva }: SolicitudCambioContrasena): Promise<void> {
    validarContrasenaNueva(actual, nueva);
    const usuario = await this.usuarios.buscarCredencialesPorId(actor.id);
    if (!usuario) throw sesionInvalida();
    if (!(await this.hasher.verificar(actual, usuario.passwordHash))) {
      throw new DomainError("CONTRASENA_INCORRECTA", "La contraseña actual no es correcta");
    }
    await this.usuarios.actualizarPasswordHash(actor.id, await this.hasher.hash(nueva));
  }
}
