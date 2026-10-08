import { esTipoCarga, type TipoCarga } from "../../../domain/carga/TipoCarga.js";
import type { Ruta } from "../../../domain/ruta/Ruta.js";
import { DomainError } from "../../../domain/shared/DomainError.js";
import { calcularTarifa, type Cotizacion } from "../../../domain/tarifa/calcularTarifa.js";
import type { RutaRepository, TipoCargaRepository } from "../../ports/repositories.js";

export interface SolicitudCotizacion {
  rutaId: number;
  tipoCarga: string;
  pesoKg: number;
}

export class CotizarEnvio {
  constructor(
    private readonly rutas: RutaRepository,
    private readonly tipos: TipoCargaRepository,
  ) {}

  async ejecutar(s: SolicitudCotizacion): Promise<Cotizacion> {
    return (await this.resolver(s)).cotizacion;
  }

  /** Reutilizado por CrearEnvio para garantizar que el costo cobrado es el cotizado. */
  async resolver(s: SolicitudCotizacion): Promise<{ ruta: Ruta; tipo: TipoCarga; cotizacion: Cotizacion }> {
    if (!esTipoCarga(s.tipoCarga)) {
      throw new DomainError("VALIDACION", `Tipo de carga desconocido: ${s.tipoCarga}`);
    }
    const [ruta, tipo] = await Promise.all([
      this.rutas.buscarPorId(s.rutaId),
      this.tipos.buscarPorCodigo(s.tipoCarga),
    ]);
    if (!ruta) throw new DomainError("NO_ENCONTRADO", "Ruta no encontrada");
    if (!ruta.activa) throw new DomainError("RUTA_INACTIVA", "La ruta seleccionada no está operativa");
    if (!tipo) throw new DomainError("NO_ENCONTRADO", "Tipo de carga no encontrado");
    return { ruta, tipo, cotizacion: calcularTarifa(ruta.tarifaBase, tipo, s.pesoKg) };
  }
}
