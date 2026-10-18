import type { DatosPersonalesRepository, Paginacion } from "../../../application/ports/repositories.js";
import {
  RETENCION_MESES,
  type CanalSolicitud,
  type ConfiguracionDatos,
  type ResultadoSolicitud,
  type SolicitudDatos,
  type UltimaDepuracion,
} from "../../../domain/datos/DatosPersonales.js";
import type { Db } from "./pool.js";

const CLAVE_MESES = "datos_personales.meses_retencion";
const CLAVE_DEPURACION = "datos_personales.ultima_depuracion";

interface SolicitudRow {
  id: string;
  tipo: "ELIMINACION";
  nombre_titular: string;
  telefono_final: string;
  canal: CanalSolicitud;
  nota: string | null;
  fecha: Date;
  atendida_por: string;
  resultado: ResultadoSolicitud;
}

const aSolicitud = (r: SolicitudRow): SolicitudDatos => ({
  id: r.id,
  tipo: r.tipo,
  nombreTitular: r.nombre_titular,
  telefonoFinal: r.telefono_final,
  canal: r.canal,
  nota: r.nota,
  fecha: r.fecha,
  atendidaPor: r.atendida_por,
  resultado: r.resultado,
});

export class PgDatosPersonalesRepository implements DatosPersonalesRepository {
  constructor(private readonly db: Db) {}

  private async guardar(clave: string, valor: unknown): Promise<void> {
    await this.db.query(
      `INSERT INTO configuracion (clave, valor, actualizado_en) VALUES ($1, $2, now())
       ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado_en = now()`,
      [clave, JSON.stringify(valor)],
    );
  }

  async obtenerConfiguracion(): Promise<ConfiguracionDatos> {
    const { rows } = await this.db.query<{ clave: string; valor: unknown }>(
      "SELECT clave, valor FROM configuracion WHERE clave = ANY($1)",
      [[CLAVE_MESES, CLAVE_DEPURACION]],
    );
    const valor = (clave: string) => rows.find((r) => r.clave === clave)?.valor;
    const meses = valor(CLAVE_MESES);
    const dep = valor(CLAVE_DEPURACION) as (Omit<UltimaDepuracion, "fecha"> & { fecha: string }) | undefined;
    return {
      mesesRetencion: typeof meses === "number" ? meses : RETENCION_MESES.defecto,
      ultimaDepuracion: dep ? { ...dep, fecha: new Date(dep.fecha) } : null,
    };
  }

  async guardarMesesRetencion(meses: number): Promise<void> {
    await this.guardar(CLAVE_MESES, meses);
  }

  async registrarDepuracion(d: UltimaDepuracion): Promise<void> {
    await this.guardar(CLAVE_DEPURACION, { ...d, fecha: d.fecha.toISOString() });
  }

  async crearSolicitud(s: SolicitudDatos): Promise<void> {
    await this.db.query(
      `INSERT INTO solicitudes_datos (id, tipo, nombre_titular, telefono_final, canal, nota, fecha, atendida_por, resultado)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [s.id, s.tipo, s.nombreTitular, s.telefonoFinal, s.canal, s.nota, s.fecha, s.atendidaPor, JSON.stringify(s.resultado)],
    );
  }

  async listarSolicitudes({ pagina, porPagina }: Paginacion): Promise<{ solicitudes: SolicitudDatos[]; total: number }> {
    const [conteo, datos] = await Promise.all([
      this.db.query<{ n: number }>("SELECT count(*)::int AS n FROM solicitudes_datos"),
      this.db.query<SolicitudRow>(
        "SELECT * FROM solicitudes_datos ORDER BY fecha DESC, id DESC LIMIT $1 OFFSET $2",
        [porPagina, (pagina - 1) * porPagina],
      ),
    ]);
    return { solicitudes: datos.rows.map(aSolicitud), total: conteo.rows[0]!.n };
  }
}
