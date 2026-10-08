import type { TipoCarga } from "../../../domain/carga/TipoCarga.js";
import { conEstado, type Ciudad, type RutaConEstado } from "../../../domain/ruta/Ruta.js";
import type { CiudadRepository, RutaRepository, TipoCargaRepository } from "../../ports/repositories.js";

export interface CatalogoPublico {
  ciudades: Ciudad[];
  tiposCarga: TipoCarga[];
  /** Solo rutas operativas: es lo que se ofrece en la web pública. */
  rutas: RutaConEstado[];
}

export class ObtenerCatalogoPublico {
  constructor(
    private readonly ciudades: CiudadRepository,
    private readonly tipos: TipoCargaRepository,
    private readonly rutas: RutaRepository,
  ) {}

  async ejecutar(): Promise<CatalogoPublico> {
    const [ciudades, tiposCarga, rutas] = await Promise.all([
      this.ciudades.listar({ activa: true }),
      this.tipos.listar(),
      this.rutas.listar({ activa: true }),
    ]);
    return { ciudades, tiposCarga, rutas: rutas.map(conEstado).filter((r) => r.operativa) };
  }
}
