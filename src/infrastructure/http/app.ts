import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import type { CasosDeUso } from "../container.js";
import { manejarErrores, noEncontrado } from "./middlewares/errores.js";
import { crearRouter } from "./rutas.js";

export function crearApp(casos: CasosDeUso, opciones: { corsOrigin?: string } = {}): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors({ origin: opciones.corsOrigin ?? "http://localhost:5173" }));
  app.use(express.json({ limit: "100kb" }));
  app.use("/api", crearRouter(casos));
  app.use(noEncontrado);
  app.use(manejarErrores);
  return app;
}
