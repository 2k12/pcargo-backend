import { cargarConfig } from "./infrastructure/config/env.js";
import { crearContenedor } from "./infrastructure/container.js";
import { crearApp } from "./infrastructure/http/app.js";
import { Despachador } from "./infrastructure/webhooks/Despachador.js";

const config = cargarConfig();
const { casos, limitador, cerrar } = await crearContenedor(config);
const app = crearApp(casos, { corsOrigin: config.CORS_ORIGIN, limitador, trustProxy: config.TRUST_PROXY });
const servidor = app.listen(config.PORT, () => {
  console.log(
    `PCargo API escuchando en http://localhost:${config.PORT}/api (driver: ${config.DB_DRIVER}, caché: ${config.CACHE_DRIVER}, archivos: ${config.STORAGE_DRIVER})`,
  );
});

if (!config.INTEGRACIONES_CLAVE_CIFRADO) {
  console.warn(
    "Aviso: falta INTEGRACIONES_CLAVE_CIFRADO; la API para empresas funciona, pero no se pueden configurar webhooks" +
      (config.DB_DRIVER === "memory" ? " persistentes (en memoria se usa una clave efímera)." : "."),
  );
}
if (config.WEBHOOKS_PERMITIR_HTTP) {
  console.warn("Aviso: WEBHOOKS_PERMITIR_HTTP=true desactiva la protección anti-SSRF de los webhooks. Solo para desarrollo.");
}

// Webhooks (outbox) y purga de auditoría/idempotencia en este proceso.
const despachador = config.WEBHOOKS_DESPACHADOR
  ? new Despachador({ despachar: casos.despacharWebhooks, purgar: casos.purgarRegistrosApi }, config.WEBHOOKS_INTERVALO_SEG)
  : null;
despachador?.iniciar();

for (const senal of ["SIGINT", "SIGTERM"] as const) {
  process.on(senal, () => {
    servidor.close(
      () =>
        void (despachador?.detener() ?? Promise.resolve())
          .then(cerrar)
          .then(() => process.exit(0)),
    );
  });
}
