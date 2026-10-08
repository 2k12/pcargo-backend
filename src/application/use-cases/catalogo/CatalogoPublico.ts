import type { TipoCarga } from "../../../domain/carga/TipoCarga.js";
import type { Ciudad, Ruta } from "../../../domain/ruta/Ruta.js";
import type { CiudadRepository, RutaRepository, TipoCargaRepository } from "../../ports/repositories.js";

export interface CatalogoPublico {
  ciudades: Ciudad[];
  tiposCarga: TipoCarga[];
  /** Solo rutas activas: es lo que se ofrece en la web pública. */
  rutas: Ruta[];
}

export class ObtenerCatalogoPublico {
  constructor(
    private readonly ciudades: CiudadRepository,
    private readonly tipos: TipoCargaRepository,
    private readonly rutas: RutaRepository,
  ) {}

  async ejecutar(): Promise<CatalogoPublico> {
    const [ciudades, tiposCarga, rutas] = await Promise.all([
      this.ciudades.listar(),
      this.tipos.listar(),
      this.rutas.listar({ activa: true }),
    ]);
    return { ciudades, tiposCarga, rutas };
  }
}
