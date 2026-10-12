import { exigirTipoUsable, type TipoCarga } from "../../../domain/carga/TipoCarga.js";
import { esOperativa, type Ruta } from "../../../domain/ruta/Ruta.js";
import { DomainError } from "../../../domain/shared/DomainError.js";
import { cotizarItems, type Cotizacion } from "../../../domain/tarifa/calcularTarifa.js";
import { esZona, ZONA_POR_DEFECTO } from "../../../domain/tarifa/Zona.js";
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
  /** Zona de entrega: URBANA (por defecto) o RURAL. */
  zona?: string | null;
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
    const zona = s.zona ?? ZONA_POR_DEFECTO;
    if (!esZona(zona)) throw new DomainError("VALIDACION", `Zona de entrega desconocida: ${zona}`);
    const ruta = await this.rutas.buscarPorId(s.rutaId);
    if (!ruta) throw new DomainError("NO_ENCONTRADO", "Ruta no encontrada");
    if (!esOperativa(ruta)) {
      throw new DomainError("RUTA_INACTIVA", "La ruta seleccionada (o una de sus ciudades) no está operativa");
    }

    // Catálogo vigente (v11, configurable): código inexistente → 422 VALIDACION; inactivo → 422 TIPO_CARGA_INACTIVO.
    const catalogo = new Map<string, TipoCarga>((await this.tipos.listar()).map((t) => [t.codigo, t]));
    const items = s.items.map((i) => ({
      tipo: exigirTipoUsable(catalogo.get(i.tipoCarga), i.tipoCarga),
      cantidad: i.cantidad,
      pesoKg: i.pesoKg,
    }));
    // La ruta solo determina el trayecto: el precio depende del tipo de carga y la zona.
    return { ruta, cotizacion: cotizarItems(items, zona) };
  }
}
