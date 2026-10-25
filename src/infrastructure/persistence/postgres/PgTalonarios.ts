import type pg from "pg";
import type { Paginacion, TalonarioRepository } from "../../../application/ports/repositories.js";
import { DomainError } from "../../../domain/shared/DomainError.js";
import {
  exigirGuiaDisponible,
  Talonario,
  type EstadoGuiaTalonario,
  type GuiaTalonario,
} from "../../../domain/talonario/Talonario.js";
import type { Db } from "./pool.js";

/**
 * Clave del bloqueo consultivo que serializa la asignación de números de guía (v20): la reserva de talonarios y el
 * alta de envíos lo toman dentro de su transacción (se libera al confirmar o deshacer). Así una reserva nunca toma un
 * número que un envío está registrando, ni un envío con consecutivo automático un número recién reservado.
 */
const BLOQUEO_NUMEROS_GUIA = 2026_10_20;

export async function bloquearNumerosGuia(client: pg.PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock($1)", [BLOQUEO_NUMEROS_GUIA]);
}

/** Máximo entre los números de envíos y los reservados en talonarios, + 1. */
export const SQL_SIGUIENTE_NUMERO_GUIA = `SELECT GREATEST(
    (SELECT COALESCE(MAX(numero_guia), 0) FROM envios),
    (SELECT COALESCE(MAX(hasta), 0) FROM talonarios)) + 1 AS n`;

/**
 * Comprobación al insertar un envío nuevo, ya con el bloqueo tomado (ver OpcionesGuardarEnvio.numeroGuiaIndicado).
 * Devuelve true si el número es de un talonario DISPONIBLE y el envío debe marcarlo USADA (con `marcarGuiaUsada`).
 */
export async function validarUsoGuiaTalonario(
  client: pg.PoolClient,
  numeroGuia: number,
  indicado: boolean,
): Promise<boolean> {
  const { rows } = await client.query<{ estado: EstadoGuiaTalonario }>(
    "SELECT estado FROM talonario_guias WHERE numero_guia = $1 FOR UPDATE",
    [numeroGuia],
  );
  if (!rows[0]) return false;
  if (!indicado) throw new DomainError("CONFLICTO", `La guía ${numeroGuia} está reservada en un talonario`);
  exigirGuiaDisponible({ numeroGuia, estado: rows[0].estado });
  return true;
}

export async function marcarGuiaUsada(client: pg.PoolClient, numeroGuia: number, envioId: string, fecha: Date): Promise<void> {
  await client.query(
    "UPDATE talonario_guias SET estado = 'USADA', envio_id = $2, actualizado_en = $3 WHERE numero_guia = $1 AND estado = 'DISPONIBLE'",
    [numeroGuia, envioId, fecha],
  );
}

interface TalonarioRow {
  id: string;
  desde: string | number;
  hasta: string | number;
  nota: string | null;
  creado_en: Date;
  creado_por: string | null;
}

interface GuiaRow {
  numero_guia: string | number;
  talonario_id: string;
  estado: EstadoGuiaTalonario;
  envio_id: string | null;
  motivo: string | null;
  actualizado_en: Date | null;
}

const aGuia = (r: GuiaRow): GuiaTalonario => ({
  numeroGuia: Number(r.numero_guia),
  estado: r.estado,
  envioId: r.envio_id,
  motivo: r.motivo,
  actualizadoEn: r.actualizado_en,
});

type Consultor = Pick<pg.Pool, "query"> | pg.PoolClient;

export class PgTalonarioRepository implements TalonarioRepository {
  constructor(private readonly db: Db) {}

  /** Talonarios con sus guías (en el mismo orden que `filas`). */
  private async conGuias(q: Consultor, filas: TalonarioRow[], bloquear = false): Promise<Talonario[]> {
    if (filas.length === 0) return [];
    const { rows } = await q.query<GuiaRow>(
      `SELECT * FROM talonario_guias WHERE talonario_id = ANY($1::uuid[]) ORDER BY numero_guia${bloquear ? " FOR UPDATE" : ""}`,
      [filas.map((f) => f.id)],
    );
    return filas.map((f) =>
      Talonario.reconstruir({
        id: f.id,
        desde: Number(f.desde),
        hasta: Number(f.hasta),
        nota: f.nota,
        creadoEn: f.creado_en,
        creadoPor: f.creado_por,
        guias: rows.filter((g) => g.talonario_id === f.id).map(aGuia),
      }),
    );
  }

  async reservar(fabricar: (desde: number) => Talonario): Promise<Talonario> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      await bloquearNumerosGuia(client);
      const { rows } = await client.query<{ n: string | number }>(SQL_SIGUIENTE_NUMERO_GUIA);
      const t = fabricar(Number(rows[0]!.n));
      await client.query(
        "INSERT INTO talonarios (id, desde, hasta, nota, creado_en, creado_por) VALUES ($1, $2, $3, $4, $5, $6)",
        [t.id, t.desde, t.hasta, t.nota, t.creadoEn, t.creadoPor],
      );
      await client.query(
        `INSERT INTO talonario_guias (numero_guia, talonario_id)
         SELECT n, $1 FROM generate_series($2::bigint, $3::bigint) AS n`,
        [t.id, t.desde, t.hasta],
      );
      await client.query("COMMIT");
      return t;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async listar(
    filtro: { abiertos?: boolean },
    { pagina, porPagina }: Paginacion,
  ): Promise<{ talonarios: Talonario[]; total: number }> {
    const where = filtro.abiertos
      ? "WHERE EXISTS (SELECT 1 FROM talonario_guias g WHERE g.talonario_id = t.id AND g.estado = 'DISPONIBLE')"
      : "";
    const [conteo, filas] = await Promise.all([
      this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM talonarios t ${where}`),
      this.db.query<TalonarioRow>(
        `SELECT t.* FROM talonarios t ${where} ORDER BY t.creado_en DESC, t.id DESC LIMIT $1 OFFSET $2`,
        [porPagina, (pagina - 1) * porPagina],
      ),
    ]);
    return { talonarios: await this.conGuias(this.db, filas.rows), total: conteo.rows[0]!.n };
  }

  async buscarPorId(id: string): Promise<Talonario | null> {
    const { rows } = await this.db.query<TalonarioRow>("SELECT * FROM talonarios WHERE id = $1", [id]);
    return (await this.conGuias(this.db, rows))[0] ?? null;
  }

  async buscarPorNumeroGuia(numeroGuia: number): Promise<Talonario | null> {
    const { rows } = await this.db.query<TalonarioRow>(
      "SELECT t.* FROM talonarios t JOIN talonario_guias g ON g.talonario_id = t.id WHERE g.numero_guia = $1",
      [numeroGuia],
    );
    return (await this.conGuias(this.db, rows))[0] ?? null;
  }

  /** Bloquea las guías del talonario (un registro simultáneo de una de ellas espera) y guarda las que cambiaron. */
  async modificar(id: string, cambio: (t: Talonario) => void): Promise<Talonario> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<TalonarioRow>("SELECT * FROM talonarios WHERE id = $1", [id]);
      const [t] = await this.conGuias(client, rows, true);
      if (!t) throw new DomainError("NO_ENCONTRADO", "Talonario no encontrado");
      const antes = new Map(t.guias.map((g) => [g.numeroGuia, g]));
      cambio(t);
      for (const g of t.guias) {
        const previa = antes.get(g.numeroGuia)!;
        if (previa.estado === g.estado && previa.motivo === g.motivo && previa.envioId === g.envioId) continue;
        await client.query(
          "UPDATE talonario_guias SET estado = $2, envio_id = $3, motivo = $4, actualizado_en = $5 WHERE numero_guia = $1",
          [g.numeroGuia, g.estado, g.envioId, g.motivo, g.actualizadoEn],
        );
      }
      await client.query("COMMIT");
      return t;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
}
