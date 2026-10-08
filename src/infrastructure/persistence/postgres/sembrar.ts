import type { Db } from "./pool.js";
import { CIUDADES, RUTAS_SEED, TIPOS_CARGA_SEED, USUARIOS_SEED } from "../seed-data.js";
import { BcryptPasswordHasher } from "../../security/adapters.js";

/** Idempotente: puede ejecutarse varias veces sin duplicar datos. */
export async function sembrar(db: Db, rondasBcrypt = 10): Promise<void> {
  const hasher = new BcryptPasswordHasher(rondasBcrypt);
  for (const c of CIUDADES) {
    await db.query("INSERT INTO ciudades (id, nombre) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [c.id, c.nombre]);
  }
  await db.query("SELECT setval('ciudades_id_seq', (SELECT max(id) FROM ciudades))");

  for (const t of TIPOS_CARGA_SEED) {
    await db.query(
      `INSERT INTO tipos_carga (codigo, nombre, factor, peso_incluido_kg, peso_max_kg)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (codigo) DO NOTHING`,
      [t.codigo, t.nombre, t.factor, t.pesoIncluidoKg, t.pesoMaxKg],
    );
  }

  for (const r of RUTAS_SEED) {
    await db.query(
      `INSERT INTO rutas (origen_id, destino_id, tarifa_base, tiempo_estimado_min)
       VALUES ($1, $2, $3, $4) ON CONFLICT (origen_id, destino_id) DO NOTHING`,
      [r.origenId, r.destinoId, r.tarifaBase, r.tiempoEstimadoMin],
    );
  }

  for (const u of USUARIOS_SEED) {
    await db.query(
      `INSERT INTO usuarios (id, nombre, email, password_hash, rol)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (email) DO NOTHING`,
      [u.id, u.nombre, u.email, await hasher.hash(u.password), u.rol],
    );
  }
}

