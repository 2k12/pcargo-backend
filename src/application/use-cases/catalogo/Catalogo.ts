import type { TipoCarga } from "../../../domain/carga/TipoCarga.js";
import { normalizarNombreCiudad, type Ciudad } from "../../../domain/ruta/Ruta.js";
import { DomainError } from "../../../domain/shared/DomainError.js";
import type { Actor } from "../../../domain/usuario/Usuario.js";
import type {
  CambiosCiudad,
  CiudadRepository,
  RutaRepository,
  TipoCargaRepository,
} from "../../ports/repositories.js";

function exigirAdmin(actor: Actor): void {
  if (actor.rol !== "ADMIN") {
    throw new DomainError("PROHIBIDO", "Solo un administrador puede gestionar las ciudades de cobertura");
  }
}

export class ListarCiudades {
  constructor(private readonly ciudades: CiudadRepository) {}
  ejecutar(filtro?: { activa?: boolean }): Promise<Ciudad[]> {
    return this.ciudades.listar(filtro);
  }
}

export class CrearCiudad {
  constructor(private readonly ciudades: CiudadRepository) {}

  async ejecutar(actor: Actor, nombre: string): Promise<Ciudad> {
    exigirAdmin(actor);
    const limpio = normalizarNombreCiudad(nombre);
    if (await this.ciudades.existeNombre(limpio)) {
      throw new DomainError("CONFLICTO", `La ciudad ${limpio} ya existe`);
    }
    return this.ciudades.crear(limpio);
  }
}

export class ActualizarCiudad {
  constructor(private readonly ciudades: CiudadRepository) {}

  async ejecutar(actor: Actor, id: number, cambios: CambiosCiudad): Promise<Ciudad> {
    exigirAdmin(actor);
    if (!(await this.ciudades.buscarPorId(id))) throw new DomainError("NO_ENCONTRADO", "Ciudad no encontrada");
    const nombre = cambios.nombre === undefined ? undefined : normalizarNombreCiudad(cambios.nombre);
    if (nombre && (await this.ciudades.existeNombre(nombre, id))) {
      throw new DomainError("CONFLICTO", `La ciudad ${nombre} ya existe`);
    }
    return this.ciudades.actualizar(id, { nombre, activa: cambios.activa });
  }
}

export class EliminarCiudad {
  constructor(
    private readonly ciudades: CiudadRepository,
    private readonly rutas: RutaRepository,
  ) {}

  async ejecutar(actor: Actor, id: number): Promise<void> {
    exigirAdmin(actor);
    const ciudad = await this.ciudades.buscarPorId(id);
    if (!ciudad) throw new DomainError("NO_ENCONTRADO", "Ciudad no encontrada");
    if (await this.rutas.usaCiudad(id)) {
      throw new DomainError(
        "CONFLICTO",
        `${ciudad.nombre} tiene rutas registradas; desactívela en lugar de eliminarla para conservar el historial`,
      );
    }
    await this.ciudades.eliminar(id);
  }
}

export class ListarTiposCarga {
  constructor(private readonly tipos: TipoCargaRepository) {}
  ejecutar(): Promise<TipoCarga[]> {
    return this.tipos.listar();
  }
}
