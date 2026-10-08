import { Router } from "express";
import type { CasosDeUso } from "../container.js";
import {
  actualizarRutaSchema,
  cambioEstadoSchema,
  cotizacionSchema,
  crearEnvioSchema,
  crearRutaSchema,
  filtroEnviosSchema,
  idNumerico,
  idUuid,
  loginSchema,
} from "./esquemas.js";
import { actorDe, autenticar } from "./middlewares/auth.js";

/** Adaptador de entrada HTTP: traduce peticiones a llamadas de casos de uso. */
export function crearRouter(c: CasosDeUso): Router {
  const publico = Router();
  const privado = Router();

  publico.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  publico.post("/auth/login", async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    res.json(await c.login.ejecutar(email, password));
  });

  publico.get("/seguimiento/:codigo", async (req, res) => {
    res.json(await c.seguimiento.ejecutar(req.params.codigo));
  });

  privado.use(autenticar(c.tokens));

  privado.get("/auth/me", async (_req, res) => {
    res.json(await c.perfil.ejecutar(actorDe(res)));
  });

  privado.get("/ciudades", async (_req, res) => {
    res.json(await c.listarCiudades.ejecutar());
  });

  privado.get("/tipos-carga", async (_req, res) => {
    res.json(await c.listarTiposCarga.ejecutar());
  });

  privado.get("/rutas", async (req, res) => {
    const activa = req.query.activa === undefined ? undefined : req.query.activa === "true";
    res.json(await c.listarRutas.ejecutar({ activa }));
  });

  privado.post("/rutas", async (req, res) => {
    res.status(201).json(await c.crearRuta.ejecutar(actorDe(res), crearRutaSchema.parse(req.body)));
  });

  privado.patch("/rutas/:id", async (req, res) => {
    const id = idNumerico.parse(req.params.id);
    res.json(await c.actualizarRuta.ejecutar(actorDe(res), id, actualizarRutaSchema.parse(req.body)));
  });

  privado.post("/envios/cotizar", async (req, res) => {
    res.json(await c.cotizar.ejecutar(cotizacionSchema.parse(req.body)));
  });

  privado.get("/envios", async (req, res) => {
    res.json(await c.listarEnvios.ejecutar(filtroEnviosSchema.parse(req.query)));
  });

  privado.post("/envios", async (req, res) => {
    res.status(201).json(await c.crearEnvio.ejecutar(actorDe(res), crearEnvioSchema.parse(req.body)));
  });

  privado.get("/envios/:id", async (req, res) => {
    res.json(await c.obtenerEnvio.ejecutar(idUuid.parse(req.params.id)));
  });

  privado.patch("/envios/:id/estado", async (req, res) => {
    const { estado, nota } = cambioEstadoSchema.parse(req.body);
    res.json(await c.cambiarEstado.ejecutar(actorDe(res), idUuid.parse(req.params.id), estado, nota));
  });

  privado.get("/dashboard/resumen", async (_req, res) => {
    res.json(await c.resumen.ejecutar());
  });

  return Router().use(publico).use(privado);
}
