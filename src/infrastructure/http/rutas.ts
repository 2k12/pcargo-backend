import { Router, type RequestHandler } from "express";
import type { LimitadorTasa } from "../../application/ports/cache.js";
import type { CasosDeUso } from "../container.js";
import {
  actualizarCiudadSchema,
  actualizarPerfilSchema,
  cambiarContrasenaSchema,
  evidenciaSchema,
  actualizarClienteSchema,
  actualizarRutaSchema,
  cambioEstadoSchema,
  cotizacionSchema,
  crearCiudadSchema,
  crearClienteSchema,
  crearEnvioSchema,
  crearRutaSchema,
  actualizarIntegracionSchema,
  crearApiKeySchema,
  crearIntegracionSchema,
  filtroEntregasSchema,
  webhookSchema,
  filtroEnviosSchema,
  filtroResumenSchema,
  idNumerico,
  idUuid,
  loginSchema,
  paginacionSchema,
  actualizarArticuloSchema,
  actualizarTipoCargaSchema,
  crearArticuloSchema,
  crearTipoCargaSchema,
  filtroHistorialTiposSchema,
  listarTiposCargaSchema,
  ordenArticulosSchema,
  ordenTiposCargaSchema,
  codigoTipoCargaSchema,
  actualizarUsuarioSchema,
  asignarRepartidorSchema,
  cambioEstadoRepartidorSchema,
  cierreCajaSchema,
  crearAccesoPortalSchema,
  crearEnvioPortalSchema,
  crearUsuarioSchema,
  filtroCierresSchema,
  filtroEnviosPortalSchema,
  filtroResumenPortalSchema,
  filtroUsuariosSchema,
  politicaDatosSchema,
  solicitudDatosSchema,
  titularSchema,
  vistaRepartidorSchema,
} from "./esquemas.js";
import { DomainError } from "../../domain/shared/DomainError.js";
import { ROLES_PANEL } from "../../domain/usuario/Usuario.js";
import { actorDe, autenticar, exigirRoles } from "./middlewares/auth.js";
import { limitarTasa, REGLAS } from "./middlewares/limitarTasa.js";
import { bytesSubidos, subirArchivo } from "./middlewares/subirArchivo.js";

export interface OpcionesRouter {
  /** Sin limitador no se aplican límites de tasa (tests). */
  limitador?: LimitadorTasa;
}

/** Adaptador de entrada HTTP: traduce peticiones a llamadas de casos de uso. */
export function crearRouter(c: CasosDeUso, opciones: OpcionesRouter = {}): Router {
  const publico = Router();
  const privado = Router();

  publico.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  publico.post("/auth/login", async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    res.json(await c.login.ejecutar(email, password));
  });

  publico.get("/seguimiento/:numeroGuia", async (req, res) => {
    res.json(await c.seguimiento.ejecutar(req.params.numeroGuia));
  });

  // Web pública (landing): catálogo de servicios/tarifas y cotizador sin sesión.
  publico.get("/publico/catalogo", async (_req, res) => {
    res.json(await c.catalogoPublico.ejecutar());
  });

  publico.post("/publico/cotizar", async (req, res) => {
    res.json(await c.cotizar.ejecutar(cotizacionSchema.parse(req.body)));
  });

  // «Qué no transportamos» (v11): solo los activos, por categoría y orden.
  publico.get("/publico/articulos-restringidos", async (_req, res) => {
    res.json(await c.articulosPublicos.ejecutar());
  });

  privado.use(autenticar(c.sesion));

  privado.get("/auth/me", async (_req, res) => {
    res.json(await c.perfil.ejecutar(actorDe(res)));
  });

  privado.patch("/auth/me", async (req, res) => {
    res.json(await c.actualizarPerfil.ejecutar(actorDe(res), actualizarPerfilSchema.parse(req.body)));
  });

  // Límite por usuario: se aplica después de autenticar para contar por id y no por IP.
  const limiteContrasena: RequestHandler[] = opciones.limitador
    ? [limitarTasa(opciones.limitador, REGLAS.contrasena)]
    : [];
  privado.put("/auth/me/password", ...limiteContrasena, async (req, res) => {
    await c.cambiarContrasena.ejecutar(actorDe(res), cambiarContrasenaSchema.parse(req.body));
    res.status(204).end();
  });

  // ── Panel (ADMIN u OPERADOR): todas las rutas privadas anteriores a v12 ──
  const panel = Router();
  panel.use(exigirRoles(...ROLES_PANEL));

  panel.get("/ciudades", async (req, res) => {
    const activa = req.query.activa === undefined ? undefined : req.query.activa === "true";
    res.json(await c.listarCiudades.ejecutar({ activa }));
  });

  panel.post("/ciudades", async (req, res) => {
    const { nombre } = crearCiudadSchema.parse(req.body);
    res.status(201).json(await c.crearCiudad.ejecutar(actorDe(res), nombre));
  });

  panel.patch("/ciudades/:id", async (req, res) => {
    const id = idNumerico.parse(req.params.id);
    res.json(await c.actualizarCiudad.ejecutar(actorDe(res), id, actualizarCiudadSchema.parse(req.body)));
  });

  panel.delete("/ciudades/:id", async (req, res) => {
    await c.eliminarCiudad.ejecutar(actorDe(res), idNumerico.parse(req.params.id));
    res.status(204).end();
  });

  // ── Tipos de carga (v11): lectura para todos (solo activos); `?todos=true` y la administración, solo ADMIN ──
  panel.get("/tipos-carga", async (req, res) => {
    const { todos } = listarTiposCargaSchema.parse(req.query);
    res.json(await c.listarTiposCarga.ejecutar(actorDe(res), { todos }));
  });

  panel.post("/tipos-carga", async (req, res) => {
    res.status(201).json(await c.crearTipoCarga.ejecutar(actorDe(res), crearTipoCargaSchema.parse(req.body)));
  });

  // Rutas fijas antes de las que llevan :codigo.
  panel.put("/tipos-carga/orden", async (req, res) => {
    const { codigos } = ordenTiposCargaSchema.parse(req.body);
    res.json(await c.reordenarTiposCarga.ejecutar(actorDe(res), codigos));
  });

  panel.get("/tipos-carga/historial", async (req, res) => {
    res.json(
      await c.historialTiposCarga.ejecutar(
        actorDe(res),
        filtroHistorialTiposSchema.parse(req.query),
        paginacionSchema.parse(req.query),
      ),
    );
  });

  panel.patch("/tipos-carga/:codigo", async (req, res) => {
    const codigo = codigoTipoCargaSchema.parse(req.params.codigo);
    res.json(await c.actualizarTipoCarga.ejecutar(actorDe(res), codigo, actualizarTipoCargaSchema.parse(req.body)));
  });

  panel.delete("/tipos-carga/:codigo", async (req, res) => {
    await c.eliminarTipoCarga.ejecutar(actorDe(res), codigoTipoCargaSchema.parse(req.params.codigo));
    res.status(204).end();
  });

  // ── Artículos restringidos (v11, ADMIN) ──
  panel.get("/articulos-restringidos", async (_req, res) => {
    res.json(await c.listarArticulos.ejecutar(actorDe(res)));
  });

  panel.post("/articulos-restringidos", async (req, res) => {
    res.status(201).json(await c.crearArticulo.ejecutar(actorDe(res), crearArticuloSchema.parse(req.body)));
  });

  panel.put("/articulos-restringidos/orden", async (req, res) => {
    const { categoria, ids } = ordenArticulosSchema.parse(req.body);
    res.json(await c.reordenarArticulos.ejecutar(actorDe(res), categoria, ids));
  });

  panel.patch("/articulos-restringidos/:id", async (req, res) => {
    const id = idUuid.parse(req.params.id);
    res.json(await c.actualizarArticulo.ejecutar(actorDe(res), id, actualizarArticuloSchema.parse(req.body)));
  });

  panel.delete("/articulos-restringidos/:id", async (req, res) => {
    await c.eliminarArticulo.ejecutar(actorDe(res), idUuid.parse(req.params.id));
    res.status(204).end();
  });

  panel.get("/rutas", async (req, res) => {
    const activa = req.query.activa === undefined ? undefined : req.query.activa === "true";
    res.json(await c.listarRutas.ejecutar({ activa }));
  });

  panel.post("/rutas", async (req, res) => {
    res.status(201).json(await c.crearRuta.ejecutar(actorDe(res), crearRutaSchema.parse(req.body)));
  });

  panel.patch("/rutas/:id", async (req, res) => {
    const id = idNumerico.parse(req.params.id);
    res.json(await c.actualizarRuta.ejecutar(actorDe(res), id, actualizarRutaSchema.parse(req.body)));
  });

  panel.get("/clientes", async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    res.json(await c.listarClientes.ejecutar({ q }));
  });

  panel.post("/clientes", async (req, res) => {
    res.status(201).json(await c.crearCliente.ejecutar(crearClienteSchema.parse(req.body)));
  });

  panel.patch("/clientes/:id", async (req, res) => {
    const id = idUuid.parse(req.params.id);
    res.json(await c.actualizarCliente.ejecutar(id, actualizarClienteSchema.parse(req.body)));
  });

  panel.delete("/clientes/:id", async (req, res) => {
    await c.eliminarCliente.ejecutar(idUuid.parse(req.params.id));
    res.status(204).end();
  });

  panel.post("/envios/cotizar", async (req, res) => {
    res.json(await c.cotizar.ejecutar(cotizacionSchema.parse(req.body)));
  });

  panel.get("/envios", async (req, res) => {
    res.json(await c.listarEnvios.ejecutar(filtroEnviosSchema.parse(req.query), paginacionSchema.parse(req.query)));
  });

  panel.post("/envios", async (req, res) => {
    res.status(201).json(await c.crearEnvio.ejecutar(actorDe(res), crearEnvioSchema.parse(req.body)));
  });

  // v12: asignación atómica de repartidor (ruta fija antes de /envios/:id).
  panel.post("/envios/asignar", async (req, res) => {
    res.json(await c.asignarRepartidor.ejecutar(asignarRepartidorSchema.parse(req.body)));
  });

  panel.get("/envios/:id", async (req, res) => {
    res.json(await c.obtenerEnvio.ejecutar(idUuid.parse(req.params.id)));
  });

  panel.patch("/envios/:id/estado", async (req, res) => {
    const { estado, nota } = cambioEstadoSchema.parse(req.body);
    res.json(await c.cambiarEstado.ejecutar(actorDe(res), idUuid.parse(req.params.id), estado, nota));
  });

  panel.post("/envios/:id/evidencia", subirArchivo("foto"), async (req, res) => {
    const id = idUuid.parse(req.params.id);
    const { recibidoPor } = evidenciaSchema.parse(req.body ?? {});
    res.json(await c.subirEvidencia.ejecutar(actorDe(res), id, { foto: bytesSubidos(req), recibidoPor }));
  });

  // Foto privada: solo con token y sin caché en navegador ni proxies.
  panel.get("/envios/:id/evidencia", async (req, res) => {
    const { bytes, tipo } = await c.obtenerEvidencia.ejecutar(idUuid.parse(req.params.id));
    res
      .status(200)
      .set({ "Content-Type": tipo, "Cache-Control": "private, no-store", "Content-Disposition": "inline" })
      .end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length));
  });

  panel.get("/dashboard/resumen", async (req, res) => {
    res.json(await c.resumen.ejecutar(filtroResumenSchema.parse(req.query)));
  });

  // ── Integraciones con empresas (solo ADMIN; lo exige cada caso de uso) ──
  panel.get("/integraciones", async (_req, res) => {
    res.json(await c.listarIntegraciones.ejecutar(actorDe(res)));
  });

  panel.post("/integraciones", async (req, res) => {
    res.status(201).json(await c.crearIntegracion.ejecutar(actorDe(res), crearIntegracionSchema.parse(req.body)));
  });

  panel.get("/integraciones/:id", async (req, res) => {
    res.json(await c.obtenerIntegracion.ejecutar(actorDe(res), idUuid.parse(req.params.id)));
  });

  panel.patch("/integraciones/:id", async (req, res) => {
    const id = idUuid.parse(req.params.id);
    res.json(await c.actualizarIntegracion.ejecutar(actorDe(res), id, actualizarIntegracionSchema.parse(req.body)));
  });

  panel.delete("/integraciones/:id", async (req, res) => {
    await c.eliminarIntegracion.ejecutar(actorDe(res), idUuid.parse(req.params.id));
    res.status(204).end();
  });

  // La key completa solo viaja en esta respuesta: que nadie (navegador ni proxy) la guarde.
  panel.post("/integraciones/:id/keys", async (req, res) => {
    const id = idUuid.parse(req.params.id);
    const r = await c.crearApiKey.ejecutar(actorDe(res), id, crearApiKeySchema.parse(req.body));
    res.status(201).set("Cache-Control", "no-store").json(r);
  });

  panel.delete("/integraciones/:id/keys/:keyId", async (req, res) => {
    await c.revocarApiKey.ejecutar(actorDe(res), idUuid.parse(req.params.id), idUuid.parse(req.params.keyId));
    res.status(204).end();
  });

  panel.put("/integraciones/:id/webhook", async (req, res) => {
    const id = idUuid.parse(req.params.id);
    const r = await c.configurarWebhook.ejecutar(actorDe(res), id, webhookSchema.parse(req.body));
    res.set("Cache-Control", "no-store").json(r);
  });

  panel.post("/integraciones/:id/webhook/rotar-secreto", async (req, res) => {
    const r = await c.rotarSecretoWebhook.ejecutar(actorDe(res), idUuid.parse(req.params.id));
    res.set("Cache-Control", "no-store").json(r);
  });

  panel.delete("/integraciones/:id/webhook", async (req, res) => {
    await c.eliminarWebhook.ejecutar(actorDe(res), idUuid.parse(req.params.id));
    res.status(204).end();
  });

  panel.post("/integraciones/:id/webhook/prueba", async (req, res) => {
    res.json(await c.enviarWebhookPrueba.ejecutar(actorDe(res), idUuid.parse(req.params.id)));
  });

  panel.get("/integraciones/:id/webhook/entregas", async (req, res) => {
    const id = idUuid.parse(req.params.id);
    res.json(
      await c.listarEntregasWebhook.ejecutar(
        actorDe(res),
        id,
        filtroEntregasSchema.parse(req.query),
        paginacionSchema.parse(req.query),
      ),
    );
  });

  panel.post("/integraciones/:id/webhook/entregas/:entregaId/reintentar", async (req, res) => {
    const id = idUuid.parse(req.params.id);
    res.json(await c.reintentarEntregaWebhook.ejecutar(actorDe(res), id, idUuid.parse(req.params.entregaId)));
  });

  panel.get("/integraciones/:id/solicitudes", async (req, res) => {
    const id = idUuid.parse(req.params.id);
    res.json(await c.listarSolicitudesApi.ejecutar(actorDe(res), id, paginacionSchema.parse(req.query)));
  });

  // ── Usuarios (v12): administración solo ADMIN; la lista de repartidores, todo el panel ──
  const soloAdmin = exigirRoles("ADMIN");

  panel.get("/usuarios/repartidores", async (_req, res) => {
    res.json(await c.listarRepartidores.ejecutar());
  });

  panel.get("/usuarios", soloAdmin, async (req, res) => {
    res.json(await c.listarUsuarios.ejecutar(actorDe(res), filtroUsuariosSchema.parse(req.query)));
  });

  panel.post("/usuarios", soloAdmin, async (req, res) => {
    res.status(201).json(await c.crearUsuario.ejecutar(actorDe(res), crearUsuarioSchema.parse(req.body)));
  });

  panel.patch("/usuarios/:id", soloAdmin, async (req, res) => {
    const id = idUuid.parse(req.params.id);
    res.json(await c.actualizarUsuario.ejecutar(actorDe(res), id, actualizarUsuarioSchema.parse(req.body)));
  });

  panel.get("/clientes/:id/accesos", soloAdmin, async (req, res) => {
    res.json(await c.listarAccesosCliente.ejecutar(actorDe(res), idUuid.parse(req.params.id)));
  });

  // La contraseña temporal solo viaja en esta respuesta: que nadie (navegador ni proxy) la guarde.
  panel.post("/clientes/:id/accesos", soloAdmin, async (req, res) => {
    const id = idUuid.parse(req.params.id);
    const r = await c.crearAccesoPortal.ejecutar(actorDe(res), id, crearAccesoPortalSchema.parse(req.body));
    res.status(201).set("Cache-Control", "no-store").json(r);
  });

  // ── Caja (v12, ADMIN u OPERADOR) ──
  panel.get("/caja/pendientes", async (_req, res) => {
    res.json(await c.listarCajasPendientes.ejecutar());
  });

  panel.get("/caja/pendientes/:usuarioId", async (req, res) => {
    res.json(await c.obtenerCajaPendiente.ejecutar(idUuid.parse(req.params.usuarioId)));
  });

  panel.post("/caja/cierres", async (req, res) => {
    res.status(201).json(await c.cerrarCaja.ejecutar(actorDe(res), cierreCajaSchema.parse(req.body)));
  });

  panel.get("/caja/cierres", async (req, res) => {
    res.json(await c.listarCierresCaja.ejecutar(filtroCierresSchema.parse(req.query), paginacionSchema.parse(req.query)));
  });

  panel.get("/caja/cierres/:id", async (req, res) => {
    res.json(await c.obtenerCierreCaja.ejecutar(idUuid.parse(req.params.id)));
  });

  // ── Datos personales (LOPDP, solo ADMIN; v13: sin depuración automática) ──
  panel.get("/datos-personales/politica", soloAdmin, async (_req, res) => {
    res.json(await c.obtenerPoliticaDatos.ejecutar(actorDe(res)));
  });

  panel.put("/datos-personales/politica", soloAdmin, async (req, res) => {
    const { mesesRetencion } = politicaDatosSchema.parse(req.body);
    res.json(await c.actualizarPoliticaDatos.ejecutar(actorDe(res), mesesRetencion));
  });

  // El teléfono del titular es un dato personal: la respuesta no se guarda en cachés.
  panel.get("/datos-personales/titular", soloAdmin, async (req, res) => {
    const { telefono } = titularSchema.parse(req.query);
    res.set("Cache-Control", "no-store").json(await c.consultarTitular.ejecutar(actorDe(res), telefono));
  });

  panel.get("/datos-personales/solicitudes", soloAdmin, async (req, res) => {
    res.json(await c.listarSolicitudesDatos.ejecutar(actorDe(res), paginacionSchema.parse(req.query)));
  });

  panel.post("/datos-personales/solicitudes", soloAdmin, async (req, res) => {
    res.status(201).json(await c.atenderSolicitudDatos.ejecutar(actorDe(res), solicitudDatosSchema.parse(req.body)));
  });

  // ── App del repartidor (v12, rol REPARTIDOR): solo sus envíos asignados ──
  const repartidor = Router();
  repartidor.use(exigirRoles("REPARTIDOR"));

  repartidor.get("/envios", async (req, res) => {
    const { vista } = vistaRepartidorSchema.parse(req.query);
    res.json(await c.listarEnviosRepartidor.ejecutar(actorDe(res), vista));
  });

  repartidor.get("/envios/guia/:numeroGuia", async (req, res) => {
    res.json(await c.buscarGuiaRepartidor.ejecutar(actorDe(res), req.params.numeroGuia));
  });

  repartidor.patch("/envios/:id/estado", async (req, res) => {
    const { estado, nota } = cambioEstadoRepartidorSchema.parse(req.body);
    res.json(await c.cambiarEstadoRepartidor.ejecutar(actorDe(res), idUuid.parse(req.params.id), estado, nota));
  });

  repartidor.post("/envios/:id/evidencia", subirArchivo("foto"), async (req, res) => {
    const id = idUuid.parse(req.params.id);
    const { recibidoPor } = evidenciaSchema.parse(req.body ?? {});
    res.json(await c.subirEvidenciaRepartidor.ejecutar(actorDe(res), id, { foto: bytesSubidos(req), recibidoPor }));
  });

  repartidor.get("/caja", async (_req, res) => {
    res.json(await c.obtenerCajaPendiente.ejecutar(actorDe(res).id));
  });

  // ── Portal de clientes empresa (v12, rol CLIENTE): solo los envíos de su cliente ──
  const portal = Router();
  portal.use(exigirRoles("CLIENTE"), (_req, res, next) => {
    // CLIENTE sin cliente vinculado (cliente eliminado) → 403.
    if (!actorDe(res).clienteId) throw new DomainError("PROHIBIDO", "Su usuario no está vinculado a un cliente");
    next();
  });

  portal.get("/resumen", async (req, res) => {
    res.json(await c.resumenPortal.ejecutar(actorDe(res), filtroResumenPortalSchema.parse(req.query)));
  });

  portal.get("/catalogo", async (_req, res) => {
    res.json(await c.catalogoPublico.ejecutar());
  });

  portal.post("/cotizar", async (req, res) => {
    res.json(await c.cotizar.ejecutar(cotizacionSchema.parse(req.body)));
  });

  portal.get("/envios", async (req, res) => {
    res.json(
      await c.listarEnviosPortal.ejecutar(
        actorDe(res),
        filtroEnviosPortalSchema.parse(req.query),
        paginacionSchema.parse(req.query),
      ),
    );
  });

  portal.post("/envios", async (req, res) => {
    res.status(201).json(await c.crearEnvioPortal.ejecutar(actorDe(res), crearEnvioPortalSchema.parse(req.body)));
  });

  portal.get("/envios/:id", async (req, res) => {
    res.json(await c.obtenerEnvioPortal.ejecutar(actorDe(res), idUuid.parse(req.params.id)));
  });

  // /repartidor y /portal antes que el panel: el guardia del panel respondería 403 a esos roles.
  privado.use("/repartidor", repartidor);
  privado.use("/portal", portal);
  privado.use(panel);
  return Router().use(publico).use(privado);
}
