import { DomainError } from "../../../domain/shared/DomainError.js";
import type { Actor } from "../../../domain/usuario/Usuario.js";
import type { UsuarioRepository } from "../../ports/repositories.js";
import type { TokenService } from "../../ports/services.js";

/**
 * Resuelve el actor de una solicitud: verifica el JWT y consulta al usuario, que debe seguir activo (un usuario
 * desactivado pierde la sesión en la siguiente solicitud). Nombre, rol y cliente salen del repositorio, no del token.
 */
export class ResolverSesion {
  constructor(
    private readonly tokens: TokenService,
    private readonly usuarios: UsuarioRepository,
  ) {}

  async ejecutar(token: string): Promise<Actor> {
    const { id } = this.tokens.verificar(token);
    const usuario = await this.usuarios.buscarPorId(id);
    if (!usuario) throw new DomainError("NO_AUTENTICADO", "La sesión ya no es válida");
    return { id: usuario.id, nombre: usuario.nombre, rol: usuario.rol, clienteId: usuario.clienteId ?? null };
  }
}
