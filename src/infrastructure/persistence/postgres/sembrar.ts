import type { Db } from "./pool.js";
import { digitosTelefono } from "../../../domain/cliente/Cliente.js";
import { CIUDADES, CLIENTES_SEED, RUTAS_SEED, TIPOS_CARGA_SEED, USUARIOS_SEED } from "../seed-data.js";
import { BcryptPasswordHasher } from "../../security/adapters.js";

/** Idempotente: puede ejecutarse varias veces sin duplicar datos. */
export async function sembrar(db: Db, rondasBcrypt = 10): Promise<void> {
  const hasher = new BcryptPasswordHasher(rondasBcrypt);
  for (const c of CIUDADES) {
    await db.query("INSERT INTO ciudades (id, nombre) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [c.id, c.nombre]);
  }
  await db.query("SELECT setval('ciudades_id_seq', (SELECT max(id) FROM ciudades))");

  // v11: el catálogo de tipos lo administra el ADMIN. Solo se siembra en una BD sin tipos, así `db:seed` nunca
  // reactiva, sobrescribe ni vuelve a crear tipos que se cambiaron o eliminaron. Los artículos restringidos los
  // siembra la migración 011 (tampoco se tocan aquí).
  const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM tipos_carga");
  if (rows[0]!.n === 0) {
    for (const t of TIPOS_CARGA_SEED) {
      await db.query(
        `INSERT INTO tipos_carga
           (codigo, nombre, precio, precio_rural, mayoreo_minimo_exclusivo, mayoreo_precio, peso_max_kg, orden, activo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (codigo) DO NOTHING`,
        [
          t.codigo, t.nombre, t.precio, t.precioRural, t.mayoreo?.minimoExclusivo ?? null,
          t.mayoreo?.precio ?? null, t.pesoMaxKg, t.orden, t.activo,
        ],
      );
    }
  }

  for (const r of RUTAS_SEED) {
    await db.query(
      `INSERT INTO rutas (origen_id, destino_id, tiempo_estimado_min)
       VALUES ($1, $2, $3) ON CONFLICT (origen_id, destino_id) DO NOTHING`,
      [r.origenId, r.destinoId, r.tiempoEstimadoMin],
    );
  }

  // v12: cliente semilla del portal. ON CONFLICT sin destino: tampoco duplica si otro cliente ya tiene su teléfono.
  const idClientePorSemilla = new Map<string, string>();
  for (const c of CLIENTES_SEED) {
    await db.query(
      `INSERT INTO clientes (id, nombre, telefono, direccion, notas, creado_en, consentimiento_en)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
      [c.id, c.nombre, c.telefono, c.direccion, c.notas, c.creadoEn, c.consentimientoEn],
    );
    const { rows: existente } = await db.query<{ id: string }>(
      "SELECT id FROM clientes WHERE regexp_replace(telefono, '[^0-9]', '', 'g') = $1",
      [digitosTelefono(c.telefono)],
    );
    if (existente[0]) idClientePorSemilla.set(c.id, existente[0].id);
  }

  // Usuarios: solo se crean si su correo no existe (nunca se sobrescriben contraseñas ni roles cambiados).
  for (const u of USUARIOS_SEED) {
    await db.query(
      `INSERT INTO usuarios (id, nombre, email, password_hash, rol, cliente_id)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
      [u.id, u.nombre, u.email, await hasher.hash(u.password), u.rol, u.clienteId ? (idClientePorSemilla.get(u.clienteId) ?? null) : null],
    );
  }
}

