import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "./pool.js";

// Mismo nivel relativo desde src/ (tsx) y dist/ (build): <raíz>/db/migrations
const DIR = join(import.meta.dirname, "..", "..", "..", "..", "db", "migrations");

/** Aplica en orden los .sql de db/migrations que aún no estén registrados. */
export async function migrar(db: Db, log: (m: string) => void = console.log): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    nombre TEXT PRIMARY KEY, aplicada_en TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const aplicadas = new Set(
    (await db.query<{ nombre: string }>("SELECT nombre FROM schema_migrations")).rows.map((r) => r.nombre),
  );
  const archivos = (await readdir(DIR)).filter((f) => f.endsWith(".sql")).sort();
  for (const archivo of archivos.filter((f) => !aplicadas.has(f))) {
    const sql = await readFile(join(DIR, archivo), "utf8");
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (nombre) VALUES ($1)", [archivo]);
      await client.query("COMMIT");
      log(`✔ ${archivo}`);
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
}

