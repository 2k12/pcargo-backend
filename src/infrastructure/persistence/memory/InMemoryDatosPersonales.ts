import type { DatosPersonalesRepository, Paginacion } from "../../../application/ports/repositories.js";
import {
  RETENCION_MESES,
  type ConfiguracionDatos,
  type SolicitudDatos,
  type UltimaDepuracion,
} from "../../../domain/datos/DatosPersonales.js";

export class InMemoryDatosPersonalesRepository implements DatosPersonalesRepository {
  private mesesRetencion: number = RETENCION_MESES.defecto;
  private ultimaDepuracion: UltimaDepuracion | null = null;
  private readonly solicitudes: SolicitudDatos[] = [];

  async obtenerConfiguracion(): Promise<ConfiguracionDatos> {
    return {
      mesesRetencion: this.mesesRetencion,
      ultimaDepuracion: this.ultimaDepuracion && structuredClone(this.ultimaDepuracion),
    };
  }

  async guardarMesesRetencion(meses: number): Promise<void> {
    this.mesesRetencion = meses;
  }

  async registrarDepuracion(depuracion: UltimaDepuracion): Promise<void> {
    this.ultimaDepuracion = structuredClone(depuracion);
  }

  async crearSolicitud(solicitud: SolicitudDatos): Promise<void> {
    this.solicitudes.push(structuredClone(solicitud));
  }

  async listarSolicitudes({ pagina, porPagina }: Paginacion): Promise<{ solicitudes: SolicitudDatos[]; total: number }> {
    const orden = [...this.solicitudes].sort(
      (a, b) => b.fecha.getTime() - a.fecha.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    );
    const desde = (pagina - 1) * porPagina;
    return { solicitudes: orden.slice(desde, desde + porPagina).map((s) => structuredClone(s)), total: orden.length };
  }
}
