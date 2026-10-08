import { afterAll, beforeAll, describe } from "vitest";
import { migrar } from "../../../src/infrastructure/persistence/postgres/migrar.js";
import { sembrar } from "../../../src/infrastructure/persistence/postgres/sembrar.js";
import {
  ciudadesSemilla,
  InMemoryCiudadRepository,
  InMemoryEnvioRepository,
  InMemoryRutaRepository,
} from "../../../src/infrastructure/persistence/memory/InMemoryRepositories.js";
import { PgCiudadRepository, PgEnvioRepository, PgRutaRepository } from "../../../src/infrastructure/persistence/postgres/PgRepositories.js";
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
    await db.query("UPDATE rutas SET tarifa_base = 6.00 WHERE id = 11");
    await db.query("DELETE FROM ciudades c WHERE id > 4 AND NOT EXISTS (SELECT 1 FROM rutas r WHERE c.id IN (r.origen_id, r.destino_id))");
    await db.query("UPDATE ciudades SET activa = TRUE");
    return {
      envios: new PgEnvioRepository(db),
      rutas: new PgRutaRepository(db),
      ciudades: new PgCiudadRepository(db),
      clientes: new PgClienteRepository(db),
    };
  });
});
