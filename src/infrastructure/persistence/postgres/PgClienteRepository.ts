import type { ClienteRepository } from "../../../application/ports/repositories.js";
import { digitosTelefono, type Cliente, type DatosCliente } from "../../../domain/cliente/Cliente.js";
import { DomainError } from "../../../domain/shared/DomainError.js";
import type { Db } from "./pool.js";

interface ClienteRow {
  id: string;
  nombre: string;
  telefono: string;
  direccion: string | null;
  notas: string | null;
  creado_en: Date;
  consentimiento_en: Date | null;
}

const COLUMNAS = "id, nombre, telefono, direccion, notas, creado_en, consentimiento_en";

const aCliente = (r: ClienteRow): Cliente => ({
  id: r.id,
  nombre: r.nombre,
  telefono: r.telefono,
  direccion: r.direccion,
  notas: r.notas,
  creadoEn: r.creado_en,
  consentimientoEn: r.consentimiento_en,
});

/** Carrera entre dos altas con el mismo teléfono: decide el índice único. */
function traducirDuplicado(e: unknown, telefono: string): never {
  if ((e as { constraint?: string }).constraint === "clientes_telefono_key") {
    throw new DomainError("CONFLICTO", `El teléfono ${telefono} ya pertenece a otro cliente`);
  }
  throw e;
}

export class PgClienteRepository implements ClienteRepository {
  constructor(private readonly db: Db) {}

  async listar(filtro: { q?: string } = {}): Promise<Cliente[]> {
    const q = filtro.q?.trim();
    const digitos = q ? digitosTelefono(q) : "";
    const { rows } = await this.db.query<ClienteRow>(
      `SELECT ${COLUMNAS} FROM clientes
        WHERE $1::text IS NULL OR nombre ILIKE '%' || $1 || '%'
           OR ($2 <> '' AND regexp_replace(telefono, '[^0-9]', '', 'g') LIKE '%' || $2 || '%')
        ORDER BY lower(nombre)`,
      [q || null, digitos],
    );
    return rows.map(aCliente);
  }

  async buscarPorId(id: string): Promise<Cliente | null> {
    const { rows } = await this.db.query<ClienteRow>(`SELECT ${COLUMNAS} FROM clientes WHERE id = $1`, [id]);
    return rows[0] ? aCliente(rows[0]) : null;
  }

  async buscarPorTelefono(telefono: string, excluirId?: string): Promise<Cliente | null> {
    const { rows } = await this.db.query<ClienteRow>(
      `SELECT ${COLUMNAS} FROM clientes
        WHERE regexp_replace(telefono, '[^0-9]', '', 'g') = $1 AND ($2::uuid IS NULL OR id <> $2)`,
      [digitosTelefono(telefono), excluirId ?? null],
    );
    return rows[0] ? aCliente(rows[0]) : null;
  }

  async crear(c: Cliente): Promise<void> {
    await this.db
      .query(`INSERT INTO clientes (${COLUMNAS}) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
        c.id, c.nombre, c.telefono, c.direccion, c.notas, c.creadoEn, c.consentimientoEn,
      ])
      .catch((e) => traducirDuplicado(e, c.telefono));
  }

  async actualizar(id: string, d: Required<DatosCliente>): Promise<Cliente> {
    const { rows } = await this.db
      .query<ClienteRow>(
        `UPDATE clientes SET nombre = $2, telefono = $3, direccion = $4, notas = $5 WHERE id = $1 RETURNING ${COLUMNAS}`,
        [id, d.nombre, d.telefono, d.direccion, d.notas],
      )
      .catch((e) => traducirDuplicado(e, d.telefono));
    return aCliente(rows[0]!);
  }

  async registrarConsentimiento(id: string, fecha: Date): Promise<Cliente> {
    // COALESCE: si ya había consentimiento se conserva la fecha original (lo que se debe poder demostrar)
    const { rows } = await this.db.query<ClienteRow>(
      `UPDATE clientes SET consentimiento_en = COALESCE(consentimiento_en, $2) WHERE id = $1 RETURNING ${COLUMNAS}`,
      [id, fecha],
    );
    return aCliente(rows[0]!);
  }

  /** Desactiva y desvincula sus usuarios del portal y elimina el cliente en una transacción (v12). */
  async eliminar(id: string): Promise<number> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{ n: number }>(
        `WITH previos AS (SELECT id, activo FROM usuarios WHERE cliente_id = $1 FOR UPDATE),
              cambio AS (UPDATE usuarios u SET activo = FALSE, cliente_id = NULL FROM previos p WHERE u.id = p.id)
         SELECT count(*) FILTER (WHERE activo)::int AS n FROM previos`,
        [id],
      );
      await client.query("DELETE FROM clientes WHERE id = $1", [id]);
      await client.query("COMMIT");
      return rows[0]?.n ?? 0;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
}
