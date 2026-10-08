import { cargarConfig } from "../infrastructure/config/env.js";
import { migrar } from "../infrastructure/persistence/postgres/migrar.js";
import { crearPool } from "../infrastructure/persistence/postgres/pool.js";
import { sembrar } from "../infrastructure/persistence/postgres/sembrar.js";

// Uso: tsx src/cli/db.ts <migrate|seed|setup>   (en producción: node dist/cli/db.js setup)
const comando = process.argv[2] ?? "setup";
if (!["migrate", "seed", "setup"].includes(comando)) {
  console.error(`Comando desconocido: ${comando}. Use migrate | seed | setup`);
  process.exit(1);
}

const db = crearPool(cargarConfig().DATABASE_URL);
try {
  if (comando !== "seed") await migrar(db);
  if (comando !== "migrate") {
    await sembrar(db);
    console.log("✔ Datos semilla cargados (ciudades, tipos de carga, rutas, usuarios)");
  }
} finally {
  await db.end();
}
