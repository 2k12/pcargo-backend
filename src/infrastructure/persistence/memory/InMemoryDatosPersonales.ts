import type { DatosPersonalesRepository, Paginacion } from "../../../application/ports/repositories.js";
import type { SolicitudDatos } from "../../../domain/datos/DatosPersonales.js";

export class InMemoryDatosPersonalesRepository implements DatosPersonalesRepository {
  private readonly solicitudes: SolicitudDatos[] = [];

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
