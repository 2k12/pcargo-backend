import type { ArticuloRestringidoRepository } from "../../../application/ports/repositories.js";
import type {
  ArticuloRestringido,
  CategoriaArticulo,
  IconoArticulo,
} from "../../../domain/catalogo/ArticuloRestringido.js";
import { enTransaccion } from "./PgRepositories.js";
import type { Db } from "./pool.js";

interface ArticuloRow {
  id: string;
  categoria: CategoriaArticulo;
  titulo: string;
  detalle: string;
  icono: IconoArticulo | null;
  activo: boolean;
  orden: number;
  actualizado_en: Date;
  actualizado_por: string | null;
}

const aArticulo = (r: ArticuloRow): ArticuloRestringido => ({
  id: r.id,
  categoria: r.categoria,
  titulo: r.titulo,
  detalle: r.detalle,
  icono: r.icono,
  activo: r.activo,
  orden: r.orden,
  actualizadoEn: r.actualizado_en,
  actualizadoPor: r.actualizado_por,
});

const SELECT = `SELECT id, categoria, titulo, detalle, icono, activo, orden, actualizado_en, actualizado_por
  FROM articulos_restringidos`;
/** Mismo orden que `compararArticulos` del dominio. */
const ORDEN = `ORDER BY array_position(ARRAY['PROHIBIDO', 'CONDICIONADO', 'NOTA'], categoria), orden, id`;

export class PgArticuloRestringidoRepository implements ArticuloRestringidoRepository {
  constructor(private readonly db: Db) {}

  async listar(filtro: { activos?: boolean } = {}): Promise<ArticuloRestringido[]> {
    const { rows } = await this.db.query<ArticuloRow>(`${SELECT} ${filtro.activos ? "WHERE activo" : ""} ${ORDEN}`);
    return rows.map(aArticulo);
  }

  async buscarPorId(id: string): Promise<ArticuloRestringido | null> {
    const { rows } = await this.db.query<ArticuloRow>(`${SELECT} WHERE id = $1`, [id]);
    return rows[0] ? aArticulo(rows[0]) : null;
  }

  async crear(a: ArticuloRestringido): Promise<void> {
    await this.db.query(
      `INSERT INTO articulos_restringidos (id, categoria, titulo, detalle, icono, activo, orden, actualizado_en, actualizado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [a.id, a.categoria, a.titulo, a.detalle, a.icono, a.activo, a.orden, a.actualizadoEn, a.actualizadoPor],
    );
  }

  async actualizar(articulos: ArticuloRestringido[]): Promise<void> {
    await enTransaccion(this.db, async (client) => {
      for (const a of articulos) {
        await client.query(
          `UPDATE articulos_restringidos SET categoria = $2, titulo = $3, detalle = $4, icono = $5, activo = $6,
             orden = $7, actualizado_en = $8, actualizado_por = $9
           WHERE id = $1`,
          [a.id, a.categoria, a.titulo, a.detalle, a.icono, a.activo, a.orden, a.actualizadoEn, a.actualizadoPor],
        );
      }
    });
  }

  async eliminar(id: string): Promise<void> {
    await this.db.query("DELETE FROM articulos_restringidos WHERE id = $1", [id]);
  }
}
