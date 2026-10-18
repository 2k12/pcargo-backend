import type { DatosPersonalesRepository, Paginacion } from "../../../application/ports/repositories.js";
import { RETENCION_MESES, type ConfiguracionDatos, type SolicitudDatos } from "../../../domain/datos/DatosPersonales.js";

export class InMemoryDatosPersonalesRepository implements DatosPersonalesRepository {
  private mesesRetencion: number = RETENCION_MESES.defecto;
  private readonly solicitudes: SolicitudDatos[] = [];

  async obtenerConfiguracion(): Promise<ConfiguracionDatos> {
    return { mesesRetencion: this.mesesRetencion };
  }

  async guardarMesesRetencion(meses: number): Promise<void> {
    this.mesesRetencion = meses;
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
