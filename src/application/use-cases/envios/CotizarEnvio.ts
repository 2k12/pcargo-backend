import { esTipoCarga, type TipoCarga } from "../../../domain/carga/TipoCarga.js";
import type { Ruta } from "../../../domain/ruta/Ruta.js";
import { DomainError } from "../../../domain/shared/DomainError.js";
import { cotizarItems, type Cotizacion } from "../../../domain/tarifa/calcularTarifa.js";
import type { RutaRepository, TipoCargaRepository } from "../../ports/repositories.js";

export interface ItemSolicitud {
  tipoCarga: string;
  cantidad: number;
  /** Peso por unidad. */
  pesoKg: number;
}

export interface SolicitudCotizacion {
  rutaId: number;
  items: ItemSolicitud[];
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
  async resolver(s: SolicitudCotizacion): Promise<{ ruta: Ruta; cotizacion: Cotizacion }> {
    const ruta = await this.rutas.buscarPorId(s.rutaId);
    if (!ruta) throw new DomainError("NO_ENCONTRADO", "Ruta no encontrada");
    if (!ruta.activa) throw new DomainError("RUTA_INACTIVA", "La ruta seleccionada no está operativa");

    const catalogo = new Map<string, TipoCarga>((await this.tipos.listar()).map((t) => [t.codigo, t]));
    const items = s.items.map((i) => {
      const tipo = esTipoCarga(i.tipoCarga) ? catalogo.get(i.tipoCarga) : undefined;
      if (!tipo) throw new DomainError("VALIDACION", `Tipo de carga desconocido: ${i.tipoCarga}`);
      return { tipo, cantidad: i.cantidad, pesoKg: i.pesoKg };
    });
    return { ruta, cotizacion: cotizarItems(ruta.tarifaBase, items) };
  }
}
