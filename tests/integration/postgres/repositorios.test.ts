import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrar } from "../../../src/infrastructure/persistence/postgres/migrar.js";
import { sembrar } from "../../../src/infrastructure/persistence/postgres/sembrar.js";
import { TIPOS_CARGA_SEED } from "../../../src/infrastructure/persistence/seed-data.js";
import {
  ciudadesSemilla,
  InMemoryCiudadRepository,
  InMemoryEnvioRepository,
  InMemoryRutaRepository,
  InMemoryTipoCargaRepository,
} from "../../../src/infrastructure/persistence/memory/InMemoryRepositories.js";
import { PgCiudadRepository, PgEnvioRepository, PgRutaRepository, PgTipoCargaRepository } from "../../../src/infrastructure/persistence/postgres/PgRepositories.js";
import { crearPool, type Db } from "../../../src/infrastructure/persistence/postgres/pool.js";
import { InMemoryClienteRepository } from "../../../src/infrastructure/persistence/memory/InMemoryClienteRepository.js";
import { PgClienteRepository } from "../../../src/infrastructure/persistence/postgres/PgClienteRepository.js";
import { contratoRepositorios } from "../../helpers/contrato-repositorios.js";

contratoRepositorios("memoria", async () => {
  const ciudades = ciudadesSemilla();
  return {
    envios: new InMemoryEnvioRepository(),
    rutas: new InMemoryRutaRepository(ciudades),
    ciudades: new InMemoryCiudadRepository(ciudades),
    clientes: new InMemoryClienteRepository(),
    tiposCarga: new InMemoryTipoCargaRepository(),
  };
});

const url = process.env.TEST_DATABASE_URL;

// Requiere Postgres (docker compose up -d db). Usa una BD dedicada: ¡se borra en cada test!
describe.skipIf(!url)("PostgreSQL", () => {
  let db: Db;

  beforeAll(async () => {
    db = crearPool(url!);
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrar(db, () => {});
    await sembrar(db, 4);
  });

  afterAll(async () => {
    await db?.end();
  });

  contratoRepositorios("postgres", async () => {
    await db.query("TRUNCATE envios, envio_items, historial_estados, clientes");
    await db.query("DELETE FROM rutas WHERE origen_id > 4 OR destino_id > 4");
    await db.query("DELETE FROM ciudades WHERE id > 4");
    await db.query("UPDATE ciudades SET activa = TRUE");
    return {
      envios: new PgEnvioRepository(db),
      rutas: new PgRutaRepository(db),
      ciudades: new PgCiudadRepository(db),
      clientes: new PgClienteRepository(db),
      tiposCarga: new PgTipoCargaRepository(db),
    };
  });
});

// Migración 008 sobre una BD en v7 con datos: los envíos y rutas existentes no se recalculan.
// Usa un esquema aparte (search_path) para no interferir con las pruebas anteriores.
describe.skipIf(!url)("Migración 008 (precio por tipo y zona) sobre datos v7", () => {
  const ESQUEMA = "migracion_v7";
  let db: Db;

  beforeAll(async () => {
    const admin = crearPool(url!);
    await admin.query(`DROP SCHEMA IF EXISTS ${ESQUEMA} CASCADE; CREATE SCHEMA ${ESQUEMA};`);
    await admin.end();
    db = new pg.Pool({ connectionString: url!, max: 2, options: `-c search_path=${ESQUEMA},public` }); // public: extensiones (pg_trgm)

    // Aplica 001..007 a mano y deja datos con la fórmula vieja.
    const dir = join(import.meta.dirname, "..", "..", "..", "db", "migrations");
    await db.query("CREATE TABLE schema_migrations (nombre TEXT PRIMARY KEY, aplicada_en TIMESTAMPTZ NOT NULL DEFAULT now())");
    for (const archivo of (await readdir(dir)).filter((f) => f.endsWith(".sql") && f < "008").sort()) {
      await db.query(await readFile(join(dir, archivo), "utf8"));
      await db.query("INSERT INTO schema_migrations (nombre) VALUES ($1)", [archivo]);
    }
    await db.query(`INSERT INTO ciudades (id, nombre) VALUES (1, 'Ibarra'), (4, 'Quito')`);
    await db.query(`INSERT INTO tipos_carga (codigo, nombre, factor, peso_incluido_kg, peso_max_kg) VALUES
      ('SOBRE', 'Sobre', 1.0, 0.5, 0.5), ('PAQUETE', 'Paquete', 1.4, 2, 30),
      ('CARTON', 'Cartón', 1.6, 2, 40), ('VALIJA', 'Valija', 1.8, 2, 25)`);
    await db.query(`INSERT INTO rutas (id, origen_id, destino_id, tarifa_base, tiempo_estimado_min) VALUES (1, 1, 4, 6.00, 180)`);
    await db.query(`INSERT INTO envios (id, numero_guia, remitente_nombre, remitente_telefono, destinatario_nombre,
        destinatario_telefono, destinatario_direccion, ruta_id, total_piezas, peso_total_kg, costo, forma_pago)
      VALUES ('00000000-0000-4000-d000-000000000001', 1, 'Ana', '0991234567', 'Luis', '0987654321', 'Quito', 1, 3, 15, 33.30, 'PAGADO')`);
    await db.query(`INSERT INTO envio_items (envio_id, linea, tipo_carga, cantidad, peso_unitario_kg, costo_unitario, subtotal)
      VALUES ('00000000-0000-4000-d000-000000000001', 1, 'CARTON', 3, 5, 11.10, 33.30)`);

    await migrar(db, () => {}); // solo aplica 008
  });

  afterAll(async () => {
    await db?.end();
    const admin = crearPool(url!);
    await admin.query(`DROP SCHEMA IF EXISTS ${ESQUEMA} CASCADE`);
    await admin.end();
  });

  it("actualiza los 4 tipos, inserta los 3 nuevos y ajusta pesos máximos", async () => {
    expect(await new PgTipoCargaRepository(db).listar()).toEqual(TIPOS_CARGA_SEED);
    const { rows } = await db.query("SELECT nombre FROM schema_migrations WHERE nombre LIKE '008%'");
    expect(rows).toHaveLength(1);
  });

  it("los envíos existentes quedan URBANA y conservan su costo e ítems guardados", async () => {
    const e = (await new PgEnvioRepository(db).buscarPorNumeroGuia(1))!;
    expect(e.toSnapshot()).toMatchObject({
      zona: "URBANA",
      costo: 33.3,
      items: [{ tipoCarga: "CARTON", cantidad: 3, pesoKg: 5, costoUnitario: 11.1, subtotal: 33.3 }],
    });
  });

  it("la ruta conserva su tarifa_base histórica pero ya no la expone, y se pueden crear rutas sin tarifa", async () => {
    expect((await db.query("SELECT tarifa_base FROM rutas WHERE id = 1")).rows[0].tarifa_base).toBe(6);
    const rutas = new PgRutaRepository(db);
    expect(await rutas.buscarPorId(1)).not.toHaveProperty("tarifaBase");
    await db.query("SELECT setval('rutas_id_seq', 1)");
    const nueva = await rutas.crear({ origenId: 4, destinoId: 1, tiempoEstimadoMin: 180 });
    expect((await db.query("SELECT tarifa_base FROM rutas WHERE id = $1", [nueva.id])).rows[0].tarifa_base).toBeNull();
  });

  it("restricciones: zona válida y mayoreo completo", async () => {
    await expect(db.query("UPDATE envios SET zona = 'CENTRO'")).rejects.toMatchObject({ code: "23514" });
    await expect(db.query("UPDATE tipos_carga SET mayoreo_precio = NULL WHERE codigo = 'TELA'")).rejects.toMatchObject({ code: "23514" });
    await expect(db.query("UPDATE tipos_carga SET precio = 0 WHERE codigo = 'SOBRE'")).rejects.toMatchObject({ code: "23514" });
  });
});
