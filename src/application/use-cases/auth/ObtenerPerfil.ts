import { DomainError } from "../../../domain/shared/DomainError.js";
import type { Actor, Usuario } from "../../../domain/usuario/Usuario.js";
import type { UsuarioRepository } from "../../ports/repositories.js";

export class ObtenerPerfil {
  constructor(private readonly usuarios: UsuarioRepository) {}

  async ejecutar(actor: Actor): Promise<Usuario> {
    const usuario = await this.usuarios.buscarPorId(actor.id);
    if (!usuario) throw new DomainError("NO_AUTENTICADO", "La sesión ya no es válida");
    return usuario;
  }
}
