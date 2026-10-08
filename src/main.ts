import { cargarConfig } from "./infrastructure/config/env.js";
import { crearContenedor } from "./infrastructure/container.js";
import { crearApp } from "./infrastructure/http/app.js";

const config = cargarConfig();
const { casos, cerrar } = await crearContenedor(config);
const servidor = crearApp(casos, { corsOrigin: config.CORS_ORIGIN }).listen(config.PORT, () => {
  console.log(`PCargo API escuchando en http://localhost:${config.PORT}/api (driver: ${config.DB_DRIVER})`);
});

for (const senal of ["SIGINT", "SIGTERM"] as const) {
  process.on(senal, () => {
    servidor.close(() => void cerrar().then(() => process.exit(0)));
  });
}
