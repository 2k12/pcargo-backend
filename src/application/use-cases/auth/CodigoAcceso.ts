import { DomainError } from "../../../domain/shared/DomainError.js";
import { validarCodigoAcceso, type Actor } from "../../../domain/usuario/Usuario.js";
import type { UsuarioRepository } from "../../ports/repositories.js";
import type { Clock, HuellaCodigoAcceso, PasswordHasher, TokenService } from "../../ports/services.js";
import { iniciarSesion, type LoginResultado } from "./Login.js";

// Código único de acceso (contrato v17): entrar solo con un código que el propio usuario activa desde su perfil.

export interface CodigoAccesoDTO {
  activo: boolean;
  actualizadoEn: Date | null;
}

const sesionInvalida = () => new DomainError("NO_AUTENTICADO", "La sesión ya no es válida");

export class LoginConCodigo {
  constructor(
    private readonly usuarios: UsuarioRepository,
    private readonly huellas: HuellaCodigoAcceso,
    private readonly tokens: TokenService,
  ) {}

  async ejecutar(codigo: string): Promise<LoginResultado> {
    const usuario = await this.usuarios.buscarPorCodigoAcceso(this.huellas.huella(codigo));
    if (!usuario?.activo) throw new DomainError("CREDENCIALES_INVALIDAS", "Código incorrecto o no activado");
    return iniciarSesion(this.tokens, usuario);
  }
}

export class ObtenerCodigoAcceso {
  constructor(private readonly usuarios: UsuarioRepository) {}

  async ejecutar(actor: Actor): Promise<CodigoAccesoDTO> {
    const desde = await this.usuarios.codigoAccesoActivoDesde(actor.id);
    return { activo: desde !== null, actualizadoEn: desde };
  }
}

export interface SolicitudCodigoAcceso {
  password: string;
  codigo: string;
}

export class ActivarCodigoAcceso {
  constructor(
    private readonly usuarios: UsuarioRepository,
    private readonly hasher: PasswordHasher,
    private readonly huellas: HuellaCodigoAcceso,
    private readonly clock: Clock,
  ) {}

  async ejecutar(actor: Actor, { password, codigo }: SolicitudCodigoAcceso): Promise<CodigoAccesoDTO> {
    validarCodigoAcceso(codigo, password);
    const usuario = await this.usuarios.buscarCredencialesPorId(actor.id);
    if (!usuario) throw sesionInvalida();
    if (!(await this.hasher.verificar(password, usuario.passwordHash))) {
      throw new DomainError("CONTRASENA_INCORRECTA", "La contraseña actual no es correcta");
    }
    const huella = this.huellas.huella(codigo);
    const otro = await this.usuarios.buscarPorCodigoAcceso(huella);
    if (otro && otro.id !== actor.id) {
      // Si se conservara, quien eligió el código sabría que existe y podría entrar con él: se desactiva para ambos.
      await this.usuarios.quitarCodigoAcceso(otro.id);
      throw new DomainError("CONFLICTO", "Ese código no está disponible, elige otro");
    }
    const en = this.clock.ahora();
    await this.usuarios.guardarCodigoAcceso(actor.id, huella, en);
    return { activo: true, actualizadoEn: en };
  }
}

export class DesactivarCodigoAcceso {
  constructor(private readonly usuarios: UsuarioRepository) {}

  async ejecutar(actor: Actor): Promise<void> {
    await this.usuarios.quitarCodigoAcceso(actor.id);
  }
}
