import type { CajaRepository, FiltroCierres, Paginacion } from "../../../application/ports/repositories.js";
import type { CierreCaja, Cobro, ResumenTipo, TipoCobro } from "../../../domain/caja/Caja.js";
import type { FormaPago } from "../../../domain/envio/FormaPago.js";
import type { Rol } from "../../../domain/usuario/Usuario.js";
import type { Db } from "./pool.js";

interface CobroRow {
  id: string;
  tipo: TipoCobro;
  monto: number;
  envio_id: string;
  numero_guia: string | number;
  forma_pago: FormaPago;
  usuario_id: string;
  usuario_nombre: string | null;
  fecha: Date;
  cierre_id: string | null;
}

interface CierreRow {
  id: string;
  usuario_id: string;
  usuario_nombre: string;
  usuario_rol: Rol;
  recibido_por: string;
  recibido_por_nombre: string;
  fecha: Date;
  esperado: number;
  entregado: number;
  diferencia: number;
  cantidad: number;
  nota: string | null;
  por_tipo: ResumenTipo[];
}

const SELECT_COBROS = `SELECT c.*, u.nombre AS usuario_nombre FROM cobros c JOIN usuarios u ON u.id = c.usuario_id`;

const SELECT_CIERRES = `SELECT k.*, u.nombre AS usuario_nombre, u.rol AS usuario_rol, r.nombre AS recibido_por_nombre
  FROM cierres_caja k JOIN usuarios u ON u.id = k.usuario_id JOIN usuarios r ON r.id = k.recibido_por`;

const aCobro = (r: CobroRow): Cobro => ({
  id: r.id,
  tipo: r.tipo,
  monto: r.monto,
  envioId: r.envio_id,
  numeroGuia: Number(r.numero_guia),
  formaPago: r.forma_pago,
  usuario: { id: r.usuario_id, nombre: r.usuario_nombre ?? "" },
  fecha: r.fecha,
  cierreId: r.cierre_id,
});

const aCierre = (r: CierreRow): CierreCaja => ({
  id: r.id,
  usuario: { id: r.usuario_id, nombre: r.usuario_nombre, rol: r.usuario_rol },
  recibidoPor: { id: r.recibido_por, nombre: r.recibido_por_nombre },
  fecha: r.fecha,
  esperado: r.esperado,
  entregado: r.entregado,
  diferencia: r.diferencia,
  cantidad: r.cantidad,
  nota: r.nota,
  porTipo: r.por_tipo,
});

export class PgCajaRepository implements CajaRepository {
  constructor(private readonly db: Db) {}

  async cobrosDeEnvio(envioId: string): Promise<Cobro[]> {
    const { rows } = await this.db.query<CobroRow>(`${SELECT_COBROS} WHERE c.envio_id = $1 ORDER BY c.fecha, c.id`, [
      envioId,
    ]);
    return rows.map(aCobro);
  }

  async pendientes(usuarioId?: string): Promise<Cobro[]> {
    const { rows } = await this.db.query<CobroRow>(
      `${SELECT_COBROS} WHERE c.cierre_id IS NULL AND ($1::uuid IS NULL OR c.usuario_id = $1) ORDER BY c.fecha, c.id`,
      [usuarioId ?? null],
    );
    return rows.map(aCobro);
  }

  /**
   * Bloquea (FOR UPDATE) los cobros pendientes de la persona: un cierre simultáneo espera y, al continuar, ya no los ve
   * pendientes; una cancelación simultánea que quiera anular el ORIGEN también espera y registra la devolución.
   */
  async cerrar(
    usuarioId: string,
    fabricar: (pendientes: Cobro[]) => CierreCaja,
  ): Promise<{ cierre: CierreCaja; cobros: Cobro[] }> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<CobroRow>(
        `SELECT c.*, u.nombre AS usuario_nombre FROM cobros c JOIN usuarios u ON u.id = c.usuario_id
          WHERE c.usuario_id = $1 AND c.cierre_id IS NULL ORDER BY c.fecha, c.id FOR UPDATE OF c`,
        [usuarioId],
      );
      const pendientes = rows.map(aCobro);
      const cierre = fabricar(pendientes);
      await client.query(
        `INSERT INTO cierres_caja (id, usuario_id, recibido_por, fecha, esperado, entregado, diferencia, cantidad, nota, por_tipo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          cierre.id, cierre.usuario.id, cierre.recibidoPor.id, cierre.fecha, cierre.esperado, cierre.entregado,
          cierre.diferencia, cierre.cantidad, cierre.nota, JSON.stringify(cierre.porTipo),
        ],
      );
      const { rowCount } = await client.query(
        "UPDATE cobros SET cierre_id = $1 WHERE id = ANY($2::uuid[]) AND cierre_id IS NULL",
        [cierre.id, pendientes.map((c) => c.id)],
      );
      if (rowCount !== pendientes.length) throw new Error("Cobros del cierre modificados durante la transacción");
      await client.query("COMMIT");
      return { cierre, cobros: pendientes.map((c) => ({ ...c, cierreId: cierre.id })) };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async listarCierres(f: FiltroCierres, { pagina, porPagina }: Paginacion): Promise<{ cierres: CierreCaja[]; total: number }> {
    const cond: string[] = [];
    const params: unknown[] = [];
    if (f.usuarioId) cond.push(`k.usuario_id = $${params.push(f.usuarioId)}`);
    if (f.desde) cond.push(`k.fecha >= $${params.push(f.desde)}`);
    if (f.hasta) cond.push(`k.fecha < $${params.push(f.hasta)}`);
    const where = cond.length ? `WHERE ${cond.join(" AND ")}` : "";
    const p = [...params];
    const [conteo, datos] = await Promise.all([
      this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM cierres_caja k ${where}`, params),
      this.db.query<CierreRow>(
        `${SELECT_CIERRES} ${where} ORDER BY k.fecha DESC, k.id DESC LIMIT $${p.push(porPagina)} OFFSET $${p.push((pagina - 1) * porPagina)}`,
        p,
      ),
    ]);
    return { cierres: datos.rows.map(aCierre), total: conteo.rows[0]!.n };
  }

  async buscarCierre(id: string): Promise<CierreCaja | null> {
    const { rows } = await this.db.query<CierreRow>(`${SELECT_CIERRES} WHERE k.id = $1`, [id]);
    return rows[0] ? aCierre(rows[0]) : null;
  }

  async cobrosDeCierre(cierreId: string): Promise<Cobro[]> {
    const { rows } = await this.db.query<CobroRow>(`${SELECT_COBROS} WHERE c.cierre_id = $1 ORDER BY c.fecha, c.id`, [
      cierreId,
    ]);
    return rows.map(aCobro);
  }
}
