import { afterAll, beforeAll, describe } from "vitest";
import { migrar } from "../../../src/infrastructure/persistence/postgres/migrar.js";
import { sembrar } from "../../../src/infrastructure/persistence/postgres/sembrar.js";
import {
  InMemoryEnvioRepository,
  InMemoryRutaRepository,
} from "../../../src/infrastructure/persistence/memory/InMemoryRepositories.js";
import { PgEnvioRepository, PgRutaRepository } from "../../../src/infrastructure/persistence/postgres/PgRepositories.js";
import { crearPool, type Db } from "../../../src/infrastructure/persistence/postgres/pool.js";
import { contratoRepositorios } from "../../helpers/contrato-repositorios.js";

contratoRepositorios("memoria", async () => ({
  envios: new InMemoryEnvioRepository(),
  rutas: new InMemoryRutaRepository(),
}));

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
    await db.query("TRUNCATE envios, historial_estados");
    await db.query("UPDATE rutas SET tarifa_base = 6.00 WHERE id = 11");
    return { envios: new PgEnvioRepository(db), rutas: new PgRutaRepository(db) };
  });
});
