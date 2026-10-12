import { cargarConfig } from "./infrastructure/config/env.js";
import { crearContenedor } from "./infrastructure/container.js";
import { crearApp } from "./infrastructure/http/app.js";

const config = cargarConfig();
const { casos, limitador, cerrar } = await crearContenedor(config);
const app = crearApp(casos, { corsOrigin: config.CORS_ORIGIN, limitador, trustProxy: config.TRUST_PROXY });
const servidor = app.listen(config.PORT, () => {
  console.log(
    `PCargo API escuchando en http://localhost:${config.PORT}/api (driver: ${config.DB_DRIVER}, caché: ${config.CACHE_DRIVER}, archivos: ${config.STORAGE_DRIVER})`,
  );
});

for (const senal of ["SIGINT", "SIGTERM"] as const) {
  process.on(senal, () => {
    servidor.close(() => void cerrar().then(() => process.exit(0)));
  });
}
