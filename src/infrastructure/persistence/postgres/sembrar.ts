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

  for (const [i, t] of TIPOS_CARGA_SEED.entries()) {
    await db.query(
      `INSERT INTO tipos_carga
         (codigo, nombre, precio, precio_rural, mayoreo_minimo_exclusivo, mayoreo_precio, peso_max_kg, orden)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (codigo) DO NOTHING`,
      [
        t.codigo, t.nombre, t.precio, t.precioRural, t.mayoreo?.minimoExclusivo ?? null,
        t.mayoreo?.precio ?? null, t.pesoMaxKg, i + 1,
      ],
    );
  }

  for (const r of RUTAS_SEED) {
    await db.query(
      `INSERT INTO rutas (origen_id, destino_id, tiempo_estimado_min)
       VALUES ($1, $2, $3) ON CONFLICT (origen_id, destino_id) DO NOTHING`,
      [r.origenId, r.destinoId, r.tiempoEstimadoMin],
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

