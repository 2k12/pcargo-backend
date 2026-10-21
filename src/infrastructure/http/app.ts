import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import type { LimitadorTasa } from "../../application/ports/cache.js";
import type { CasosDeUso } from "../container.js";
import { manejarErrores, noEncontrado } from "./middlewares/errores.js";
import { limitarTasa, REGLAS } from "./middlewares/limitarTasa.js";
import { BASE_API_EMPRESAS, crearRouterApiEmpresas } from "./integraciones/apiEmpresas.js";
import { crearRouter } from "./rutas.js";

export interface OpcionesApp {
  corsOrigin?: string;
  /** Sin limitador no se aplican límites de tasa (tests). */
  limitador?: LimitadorTasa;
  /** Saltos de proxy inverso de confianza (nginx, balanceador) para obtener la IP real del cliente. */
  trustProxy?: number;
}

export function crearApp(casos: CasosDeUso, opciones: OpcionesApp = {}): Express {
  const app = express();
  app.disable("x-powered-by");
  if (opciones.trustProxy) app.set("trust proxy", opciones.trustProxy);
  app.use(helmet());
  app.use(cors({ origin: opciones.corsOrigin ?? "http://localhost:5173" }));
  // API para empresas: va antes del parser global (admite 1 MB, autentica con API key y nunca cae en el panel).
  app.use(BASE_API_EMPRESAS, crearRouterApiEmpresas(casos, { limitador: opciones.limitador }));
  app.use(express.json({ limit: "100kb" }));
  if (opciones.limitador) {
    app.post("/api/auth/login", limitarTasa(opciones.limitador, REGLAS.login));
    app.post("/api/auth/login/codigo", limitarTasa(opciones.limitador, REGLAS.loginCodigo));
    app.use(["/api/publico", "/api/seguimiento"], limitarTasa(opciones.limitador, REGLAS.publico));
  }
  app.use("/api", crearRouter(casos, { limitador: opciones.limitador }));
  app.use(noEncontrado);
  app.use(manejarErrores);
  return app;
}
