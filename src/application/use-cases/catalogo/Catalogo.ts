import type { TipoCarga } from "../../../domain/carga/TipoCarga.js";
import type { Ciudad } from "../../../domain/ruta/Ruta.js";
import type { CiudadRepository, TipoCargaRepository } from "../../ports/repositories.js";

export class ListarCiudades {
  constructor(private readonly ciudades: CiudadRepository) {}
  ejecutar(): Promise<Ciudad[]> {
    return this.ciudades.listar();
  }
}

export class ListarTiposCarga {
  constructor(private readonly tipos: TipoCargaRepository) {}
  ejecutar(): Promise<TipoCarga[]> {
    return this.tipos.listar();
  }
}
