import { randomBytes } from "node:crypto";
import type { Cache, LimitadorTasa } from "../application/ports/cache.js";
import type {
  CifradorSecretos,
  ClienteWebhook,
  EntregaWebhookRepository,
  IdempotenciaRepository,
  IntegracionRepository,
  ServicioApiKeys,
  ServicioSecretosWebhook,
  SolicitudApiRepository,
} from "../application/ports/integraciones.js";
import type {
  ArticuloRestringidoRepository,
  CajaRepository,
  DatosPersonalesRepository,
  CiudadRepository,
  ClienteRepository,
  EnvioRepository,
  RutaRepository,
  TipoCargaRepository,
  UsuarioRepository,
} from "../application/ports/repositories.js";
import type {
  AlmacenArchivos,
  Clock,
  GeneradorContrasenas,
  IdGenerator,
  PasswordHasher,
  TokenService,
} from "../application/ports/services.js";
import { ResolverSesion } from "../application/use-cases/auth/Sesion.js";
import {
  CerrarCaja,
  ListarCajasPendientes,
  ListarCierresCaja,
  ObtenerCajaPendiente,
  ObtenerCierreCaja,
} from "../application/use-cases/caja/Caja.js";
import {
  ActualizarPoliticaDatos,
  AtenderSolicitudDatos,
  ConsultarTitular,
  ListarSolicitudesDatos,
  ObtenerPoliticaDatos,
} from "../application/use-cases/datos/DatosPersonales.js";
import {
  CrearEnvioPortal,
  ListarEnviosPortal,
  ObtenerEnvioPortal,
  ObtenerResumenPortal,
} from "../application/use-cases/portal/Portal.js";
import {
  AsignarRepartidor,
  BuscarGuiaRepartidor,
  CambiarEstadoRepartidor,
  ListarEnviosRepartidor,
  SubirEvidenciaRepartidor,
} from "../application/use-cases/reparto/Reparto.js";
import {
  ActualizarUsuario,
  CrearAccesoPortal,
  CrearUsuario,
  ListarAccesosCliente,
  ListarRepartidores,
  ListarUsuarios,
} from "../application/use-cases/usuarios/Usuarios.js";
import { Login } from "../application/use-cases/auth/Login.js";
import { ObtenerPerfil } from "../application/use-cases/auth/ObtenerPerfil.js";
import { ActualizarPerfil, CambiarContrasena } from "../application/use-cases/auth/Perfil.js";
import {
  ActualizarCiudad,
  CrearCiudad,
  EliminarCiudad,
  ListarCiudades,
} from "../application/use-cases/catalogo/Catalogo.js";
import {
  ActualizarArticulo,
  CrearArticulo,
  EliminarArticulo,
  ListarArticulos,
  ListarArticulosPublicos,
  ReordenarArticulos,
} from "../application/use-cases/catalogo/ArticulosRestringidos.js";
import {
  ActualizarTipoCarga,
  CrearTipoCarga,
  EliminarTipoCarga,
  LeerTiposCarga,
  ListarHistorialTiposCarga,
  ListarTiposCarga,
  ReordenarTiposCarga,
} from "../application/use-cases/catalogo/TiposCarga.js";
import {
  ActualizarCliente,
  CrearCliente,
  EliminarCliente,
  ListarClientes,
} from "../application/use-cases/clientes/Clientes.js";
import { ObtenerCatalogoPublico } from "../application/use-cases/catalogo/CatalogoPublico.js";
import { ObtenerResumen } from "../application/use-cases/dashboard/ObtenerResumen.js";
import {
  CambiarEstadoEnvio,
  ConsultarSeguimiento,
  ListarEnvios,
  ObtenerEnvio,
} from "../application/use-cases/envios/ConsultasEnvio.js";
import { CotizarEnvio } from "../application/use-cases/envios/CotizarEnvio.js";
import { CrearEnvio } from "../application/use-cases/envios/CrearEnvio.js";
import { ObtenerEvidencia, SubirEvidencia } from "../application/use-cases/envios/EvidenciaEntrega.js";
import {
  ActualizarIntegracion,
  ConfigurarWebhook,
  CrearApiKey,
  CrearIntegracion,
  EliminarIntegracion,
  EliminarWebhook,
  EnviarWebhookPrueba,
  ListarEntregasWebhook,
  ListarIntegraciones,
  ListarSolicitudesApi,
  ObtenerIntegracion,
  ReintentarEntregaWebhook,
  RevocarApiKey,
  RotarSecretoWebhook,
} from "../application/use-cases/integraciones/AdminIntegraciones.js";
import {
  AutenticarApiKey,
  CoberturaApi,
  ConsultarEnvioApi,
  CotizarApi,
  CrearEnvioApi,
  CrearLoteApi,
  RegistrarSolicitudApi,
} from "../application/use-cases/integraciones/ApiEmpresas.js";
import { EmisorWebhooks } from "../application/use-cases/integraciones/EmisorWebhooks.js";
import { EjecutarIdempotente } from "../application/use-cases/integraciones/Idempotencia.js";
import { DespacharWebhooks, PurgarRegistrosApi } from "../application/use-cases/integraciones/Webhooks.js";
import { ActualizarRuta, CrearRuta, ListarRutas } from "../application/use-cases/rutas/Rutas.js";
import { MemoryCache, MemoryLimitadorTasa, SinCache } from "./cache/memoria.js";
import {
  claveCatalogo,
  claveGuia,
  conCache,
  ESPACIOS,
  invalidaTras,
  RutaRepositoryEnCache,
  TTL,
} from "./cache/decoradores.js";
import { crearClienteRedis, esperarRedis, RedisCache, RedisLimitadorTasa } from "./cache/redis.js";
import type { Config } from "./config/env.js";
import {
  ciudadesSemilla,
  InMemoryArticuloRestringidoRepository,
  InMemoryCiudadRepository,
  InMemoryEnvioRepository,
  InMemoryRutaRepository,
  InMemoryTipoCargaRepository,
  InMemoryUsuarioRepository,
} from "./persistence/memory/InMemoryRepositories.js";
import { InMemoryClienteRepository } from "./persistence/memory/InMemoryClienteRepository.js";
import { InMemoryCajaRepository } from "./persistence/memory/InMemoryCaja.js";
import { InMemoryDatosPersonalesRepository } from "./persistence/memory/InMemoryDatosPersonales.js";
import { PgCajaRepository } from "./persistence/postgres/PgCaja.js";
import { PgDatosPersonalesRepository } from "./persistence/postgres/PgDatosPersonales.js";
import {
  InMemoryEntregaWebhookRepository,
  InMemoryIdempotenciaRepository,
  InMemoryIntegracionRepository,
  InMemorySolicitudApiRepository,
} from "./persistence/memory/InMemoryIntegraciones.js";
import { PgArticuloRestringidoRepository } from "./persistence/postgres/PgArticulosRestringidos.js";
import { PgClienteRepository } from "./persistence/postgres/PgClienteRepository.js";
import {
  PgEntregaWebhookRepository,
  PgIdempotenciaRepository,
  PgIntegracionRepository,
  PgSolicitudApiRepository,
} from "./persistence/postgres/PgIntegraciones.js";
import {
  PgCiudadRepository,
  PgEnvioRepository,
  PgRutaRepository,
  PgTipoCargaRepository,
  PgUsuarioRepository,
} from "./persistence/postgres/PgRepositories.js";
import { crearPool, type Db } from "./persistence/postgres/pool.js";
import { CLIENTES_SEED, USUARIOS_SEED } from "./persistence/seed-data.js";
import { BcryptPasswordHasher, GeneradorContrasenasCrypto, JwtTokenService } from "./security/adapters.js";
import { ServicioApiKeysCrypto } from "./security/apiKeys.js";
import { CifradorAesGcm, CifradorNoConfigurado, leerClaveCifrado } from "./security/cifrado.js";
import { SecretosWebhookCrypto } from "./security/firmaWebhook.js";
import { AlmacenDisco } from "./storage/AlmacenDisco.js";
import { AlmacenMemoria } from "./storage/AlmacenMemoria.js";
import { AlmacenR2 } from "./storage/AlmacenR2.js";
import { CryptoIdGenerator, SystemClock } from "./system/adapters.js";
import { ClienteWebhookFetch } from "./webhooks/ClienteWebhookFetch.js";

export interface Adaptadores {
  usuarios: UsuarioRepository;
  ciudades: CiudadRepository;
  tiposCarga: TipoCargaRepository;
  /** «Qué no transportamos» de la landing (v11). */
  articulos: ArticuloRestringidoRepository;
  rutas: RutaRepository;
  envios: EnvioRepository;
  clientes: ClienteRepository;
  /** Almacén privado de archivos (fotos de evidencia de entrega). */
  almacen: AlmacenArchivos;
  hasher: PasswordHasher;
  tokens: TokenService;
  clock: Clock;
  ids: IdGenerator;
  // ── Integraciones con empresas (v10) ──
  integraciones: IntegracionRepository;
  entregasWebhook: EntregaWebhookRepository;
  solicitudesApi: SolicitudApiRepository;
  idempotencia: IdempotenciaRepository;
  apiKeys: ServicioApiKeys;
  cifrador: CifradorSecretos;
  secretosWebhook: ServicioSecretosWebhook;
  clienteWebhook: ClienteWebhook;
  // ── v12 ──
  /** Cobros y cierres de caja. */
  caja: CajaRepository;
  /** Plazo de conservación declarado y solicitudes del titular (LOPDP). */
  datosPersonales: DatosPersonalesRepository;
  contrasenas: GeneradorContrasenas;
}

export interface OpcionesCasos {
  /** URL pública del frontend (`seguimientoUrl` de la API para empresas). */
  publicUrl?: string;
  /** WEBHOOKS_PERMITIR_HTTP: admite webhooks http:// (solo desarrollo). */
  webhooksPermitirHttp?: boolean;
}

/**
 * Raíz de composición: conecta los casos de uso con los adaptadores concretos.
 * Con `cache` (Redis o memoria) las lecturas frecuentes se cachean y las escrituras invalidan lo afectado.
 */
export function crearCasosDeUso(a: Adaptadores, cache: Cache = new SinCache(), opciones: OpcionesCasos = {}) {
  const rutas = new RutaRepositoryEnCache(a.rutas, cache);
  const cotizar = new CotizarEnvio(rutas, a.tiposCarga);
  // Renombrar o desactivar ciudades/rutas cambia nombres y disponibilidad en todas las vistas cacheadas.
  const trasCambioCatalogo = [ESPACIOS.catalogo, ESPACIOS.dashboard, ESPACIOS.seguimiento];
  const enCatalogo = (activa?: boolean) => (activa === undefined ? "todas" : String(activa));
  // Tipos de carga (v11): cambian el panel, el catálogo público, el cotizador, la cobertura de la API de empresas
  // (todos leen el catálogo vigente o el espacio `catalogo:`) y la lista de tipos del dashboard (porTipo).
  const trasCambioTipos = [ESPACIOS.catalogo, ESPACIOS.dashboard];
  const depsCatalogo = { tipos: a.tiposCarga, ids: a.ids, clock: a.clock };
  const depsArticulos = { articulos: a.articulos, ids: a.ids, clock: a.clock };

  const publicUrl = opciones.publicUrl ?? "http://localhost:5173";
  // Webhooks de los envíos de empresas: se encolan en la misma transacción que el cambio del envío (outbox).
  const emisor = new EmisorWebhooks(a.integraciones, a.ids, a.clock, publicUrl);
  // Un solo CrearEnvio (misma tarifa y reglas) para el panel y la API de empresas.
  const crearEnvioBase = new CrearEnvio(a.envios, cotizar, a.ids, a.clock, a.clientes, emisor);
  const crearEnvioApi = new CrearEnvioApi(crearEnvioBase, a.envios, rutas, publicUrl);
  const deps = {
    integraciones: a.integraciones,
    ciudades: a.ciudades,
    clientes: a.clientes,
    envios: a.envios,
    ids: a.ids,
    clock: a.clock,
  };
  const depsEntrega = {
    integraciones: a.integraciones,
    entregas: a.entregasWebhook,
    cliente: a.clienteWebhook,
    cifrador: a.cifrador,
    clock: a.clock,
  };
  const depsWebhook = {
    ...deps,
    cifrador: a.cifrador,
    secretos: a.secretosWebhook,
    permitirHttp: opciones.webhooksPermitirHttp ?? false,
  };

  // v12: un solo cambio de estado y una sola subida de evidencia para el panel y la app del repartidor.
  const cambiarEstadoBase = new CambiarEstadoEnvio(a.envios, rutas, a.clock, emisor, { cobros: a.caja, ids: a.ids });
  const subirEvidenciaBase = new SubirEvidencia(a.envios, rutas, a.almacen, a.ids, a.clock, emisor);
  const depsUsuarios = { usuarios: a.usuarios, clientes: a.clientes, hasher: a.hasher, ids: a.ids, clock: a.clock };
  const depsDatos = {
    envios: a.envios,
    clientes: a.clientes,
    usuarios: a.usuarios,
    datos: a.datosPersonales,
    almacen: a.almacen,
    ids: a.ids,
    clock: a.clock,
  };
  // Anonimizar borra nombres (porCliente del dashboard, al eliminar clientes) y notas del historial (seguimiento).
  const trasAnonimizar = [ESPACIOS.dashboard, ESPACIOS.seguimiento];

  return {
    tokens: a.tokens,
    /** Actor de cada solicitud autenticada (usuario activo, rol y cliente vigentes). */
    sesion: new ResolverSesion(a.tokens, a.usuarios),
    login: new Login(a.usuarios, a.hasher, a.tokens),
    perfil: new ObtenerPerfil(a.usuarios),
    // Ninguna lectura cacheada muestra nombres de operadores: editar el perfil no invalida cachés.
    actualizarPerfil: new ActualizarPerfil(a.usuarios, a.tokens),
    cambiarContrasena: new CambiarContrasena(a.usuarios, a.hasher),
    listarCiudades: conCache(new ListarCiudades(a.ciudades), cache, {
      clave: (f) => claveCatalogo(`ciudades:${enCatalogo(f?.activa)}`),
      ttlSeg: TTL.catalogo,
    }),
    crearCiudad: invalidaTras(new CrearCiudad(a.ciudades), cache, trasCambioCatalogo),
    actualizarCiudad: invalidaTras(new ActualizarCiudad(a.ciudades), cache, trasCambioCatalogo),
    eliminarCiudad: invalidaTras(new EliminarCiudad(a.ciudades, rutas), cache, trasCambioCatalogo),
    // El permiso (`todos` solo ADMIN) se comprueba ANTES de la lectura cacheada, que solo varía según `todos`.
    listarTiposCarga: new ListarTiposCarga(
      conCache(new LeerTiposCarga(a.tiposCarga), cache, {
        clave: (todos) => claveCatalogo(`tipos-carga:${todos ? "todos" : "activos"}`),
        ttlSeg: TTL.tiposCarga,
      }),
    ),
    crearTipoCarga: invalidaTras(new CrearTipoCarga(depsCatalogo), cache, trasCambioTipos),
    actualizarTipoCarga: invalidaTras(new ActualizarTipoCarga(depsCatalogo), cache, trasCambioTipos),
    eliminarTipoCarga: invalidaTras(new EliminarTipoCarga(depsCatalogo, a.envios), cache, trasCambioTipos),
    reordenarTiposCarga: invalidaTras(new ReordenarTiposCarga(depsCatalogo), cache, trasCambioTipos),
    historialTiposCarga: new ListarHistorialTiposCarga(a.tiposCarga),
    articulosPublicos: conCache(new ListarArticulosPublicos(a.articulos), cache, {
      clave: () => claveCatalogo("articulos-restringidos"),
      ttlSeg: TTL.catalogo,
    }),
    listarArticulos: new ListarArticulos(a.articulos),
    crearArticulo: invalidaTras(new CrearArticulo(depsArticulos), cache, [ESPACIOS.catalogo]),
    actualizarArticulo: invalidaTras(new ActualizarArticulo(depsArticulos), cache, [ESPACIOS.catalogo]),
    eliminarArticulo: invalidaTras(new EliminarArticulo(a.articulos), cache, [ESPACIOS.catalogo]),
    reordenarArticulos: invalidaTras(new ReordenarArticulos(depsArticulos), cache, [ESPACIOS.catalogo]),
    catalogoPublico: conCache(new ObtenerCatalogoPublico(a.ciudades, a.tiposCarga, rutas), cache, {
      clave: () => claveCatalogo("publico"),
      ttlSeg: TTL.catalogo,
    }),
    listarRutas: conCache(new ListarRutas(rutas), cache, {
      clave: (f) => claveCatalogo(`rutas:${enCatalogo(f?.activa)}`),
      ttlSeg: TTL.catalogo,
    }),
    crearRuta: invalidaTras(new CrearRuta(rutas, a.ciudades), cache, trasCambioCatalogo),
    actualizarRuta: invalidaTras(new ActualizarRuta(rutas), cache, trasCambioCatalogo),
    // Las cotizaciones no se cachean: se calculan con el catálogo de tipos vigente en cada solicitud.
    cotizar,
    crearEnvio: invalidaTras(crearEnvioBase, cache, [ESPACIOS.dashboard]),
    // Los nombres de clientes aparecen en el resumen: sus escrituras invalidan el dashboard.
    listarClientes: new ListarClientes(a.clientes, a.envios, a.usuarios),
    crearCliente: invalidaTras(new CrearCliente(a.clientes, a.ids, a.clock), cache, [ESPACIOS.dashboard]),
    actualizarCliente: invalidaTras(new ActualizarCliente(a.clientes, a.envios, a.clock, a.usuarios), cache, [
      ESPACIOS.dashboard,
    ]),
    eliminarCliente: invalidaTras(new EliminarCliente(a.clientes), cache, [ESPACIOS.dashboard]),
    listarEnvios: new ListarEnvios(a.envios, rutas),
    obtenerEnvio: new ObtenerEnvio(a.envios, rutas),
    cambiarEstado: invalidaTras(cambiarEstadoBase, cache, [ESPACIOS.dashboard, ESPACIOS.seguimiento]),
    // La evidencia no aparece en el seguimiento público ni en el dashboard: no invalida cachés.
    subirEvidencia: subirEvidenciaBase,
    obtenerEvidencia: new ObtenerEvidencia(a.envios, a.almacen),
    seguimiento: conCache(new ConsultarSeguimiento(a.envios, rutas), cache, {
      clave: (guia) => `${ESPACIOS.seguimiento}${claveGuia(guia)}`,
      ttlSeg: TTL.seguimiento,
    }),
    resumen: conCache(new ObtenerResumen(a.envios, rutas, a.clientes, a.clock, a.tiposCarga), cache, {
      clave: (f) =>
        `${ESPACIOS.dashboard}resumen:${f?.clienteId ?? "todos"}:${f?.canal ?? ""}:${f?.integracionId ?? ""}:${f?.desde ?? ""}:${f?.hasta ?? ""}`,
      ttlSeg: TTL.dashboard,
    }),

    // ── Administración de integraciones (ADMIN). El nombre de la integración sale en el dashboard (porCanal).
    listarIntegraciones: new ListarIntegraciones(deps),
    obtenerIntegracion: new ObtenerIntegracion(deps),
    crearIntegracion: new CrearIntegracion(deps),
    actualizarIntegracion: invalidaTras(new ActualizarIntegracion(deps), cache, [ESPACIOS.dashboard]),
    eliminarIntegracion: invalidaTras(new EliminarIntegracion(deps), cache, [ESPACIOS.dashboard]),
    crearApiKey: new CrearApiKey(deps, a.apiKeys),
    revocarApiKey: new RevocarApiKey(deps),
    configurarWebhook: new ConfigurarWebhook(depsWebhook),
    rotarSecretoWebhook: new RotarSecretoWebhook(depsWebhook),
    eliminarWebhook: new EliminarWebhook(deps),
    enviarWebhookPrueba: new EnviarWebhookPrueba({ ...deps, ...depsEntrega }, publicUrl),
    listarEntregasWebhook: new ListarEntregasWebhook({ ...deps, entregas: a.entregasWebhook }),
    reintentarEntregaWebhook: new ReintentarEntregaWebhook({ ...deps, ...depsEntrega }),
    listarSolicitudesApi: new ListarSolicitudesApi({ ...deps, solicitudes: a.solicitudesApi }),

    // ── API para empresas (/api/v1/integraciones, con API key).
    autenticarApiKey: new AutenticarApiKey(a.integraciones, a.apiKeys, a.clock),
    registrarSolicitudApi: new RegistrarSolicitudApi(a.solicitudesApi, a.ids),
    ejecutarIdempotente: new EjecutarIdempotente(a.idempotencia, a.clock),
    // Sin caché propia: lee rutas (cacheadas, se invalidan con el catálogo) y los tipos activos vigentes.
    coberturaApi: new CoberturaApi(rutas, a.ciudades, a.tiposCarga),
    cotizarApi: new CotizarApi(rutas, cotizar),
    crearEnvioApi: invalidaTras(crearEnvioApi, cache, [ESPACIOS.dashboard]),
    crearLoteApi: invalidaTras(new CrearLoteApi(crearEnvioApi), cache, [ESPACIOS.dashboard]),
    consultarEnvioApi: new ConsultarEnvioApi(a.envios, rutas, publicUrl),

    // ── Usuarios y accesos al portal (v12). Ninguna lectura cacheada muestra usuarios.
    listarUsuarios: new ListarUsuarios(depsUsuarios),
    crearUsuario: new CrearUsuario(depsUsuarios),
    actualizarUsuario: new ActualizarUsuario(depsUsuarios),
    listarRepartidores: new ListarRepartidores(a.usuarios),
    listarAccesosCliente: new ListarAccesosCliente(depsUsuarios),
    crearAccesoPortal: new CrearAccesoPortal(depsUsuarios, a.contrasenas),

    // ── Asignación y app del repartidor (v12). Los cambios de estado y cobros invalidan dashboard y seguimiento.
    asignarRepartidor: invalidaTras(new AsignarRepartidor(a.envios, a.usuarios, a.clock), cache, [ESPACIOS.dashboard]),
    listarEnviosRepartidor: new ListarEnviosRepartidor(a.envios, rutas, a.clock),
    buscarGuiaRepartidor: new BuscarGuiaRepartidor(a.envios, rutas),
    cambiarEstadoRepartidor: invalidaTras(new CambiarEstadoRepartidor(cambiarEstadoBase), cache, [
      ESPACIOS.dashboard,
      ESPACIOS.seguimiento,
    ]),
    subirEvidenciaRepartidor: new SubirEvidenciaRepartidor(subirEvidenciaBase),

    // ── Caja (v12): no hay lecturas cacheadas de cobros ni cierres.
    listarCajasPendientes: new ListarCajasPendientes(a.caja, a.usuarios),
    obtenerCajaPendiente: new ObtenerCajaPendiente(a.caja, a.usuarios),
    cerrarCaja: new CerrarCaja(a.caja, a.usuarios, a.ids, a.clock),
    listarCierresCaja: new ListarCierresCaja(a.caja),
    obtenerCierreCaja: new ObtenerCierreCaja(a.caja),

    // ── Datos personales (v12/v13, ADMIN). Sin depuración automática: solo se anonimiza a pedido del titular.
    obtenerPoliticaDatos: new ObtenerPoliticaDatos(depsDatos),
    actualizarPoliticaDatos: new ActualizarPoliticaDatos(depsDatos),
    consultarTitular: new ConsultarTitular(depsDatos),
    atenderSolicitudDatos: invalidaTras(new AtenderSolicitudDatos(depsDatos), cache, trasAnonimizar),
    listarSolicitudesDatos: new ListarSolicitudesDatos(depsDatos),

    // ── Portal de clientes empresa (v12): lecturas por cliente, sin caché; cotizar y catálogo reutilizan los públicos.
    resumenPortal: new ObtenerResumenPortal(a.envios, a.clientes, a.clock),
    listarEnviosPortal: new ListarEnviosPortal(a.envios, rutas),
    obtenerEnvioPortal: new ObtenerEnvioPortal(a.envios, rutas),
    crearEnvioPortal: invalidaTras(new CrearEnvioPortal(crearEnvioBase, a.clientes), cache, [ESPACIOS.dashboard]),

    // ── Tareas de fondo: solo las ejecuta el despachador de main.ts (o un test, de forma explícita).
    despacharWebhooks: new DespacharWebhooks(depsEntrega),
    purgarRegistrosApi: new PurgarRegistrosApi(a.solicitudesApi, a.idempotencia, a.clock),
  };
}

export type CasosDeUso = ReturnType<typeof crearCasosDeUso>;

/** Cifrador de secretos de webhooks: con clave → AES-256-GCM; sin ella → error claro (503) al configurar webhooks. */
export function crearCifrador(clave: string | undefined): CifradorSecretos {
  return clave ? new CifradorAesGcm(leerClaveCifrado(clave)) : new CifradorNoConfigurado();
}

export async function adaptadoresEnMemoria(
  opciones: { jwtSecret: string; rondasBcrypt?: number; webhooksPermitirHttp?: boolean } & Partial<Adaptadores>,
): Promise<Adaptadores> {
  const { jwtSecret, rondasBcrypt, webhooksPermitirHttp, ...sobrescribir } = opciones;
  const hasher = opciones.hasher ?? new BcryptPasswordHasher(rondasBcrypt ?? 10);
  const usuarios = new InMemoryUsuarioRepository(
    await Promise.all(
      USUARIOS_SEED.map(async ({ password, ...u }) => ({
        ...u,
        passwordHash: await hasher.hash(password),
        activo: true,
      })),
    ),
  );
  // Ciudades y rutas comparten la misma lista para que renombrar/desactivar se refleje en las rutas.
  const ciudades = ciudadesSemilla();
  // Integraciones: eliminar una borra sus dependientes (como ON DELETE CASCADE); el repo de envíos resuelve el
  // nombre actual de la integración y encola los webhooks en el outbox al guardar.
  const entregasWebhook = new InMemoryEntregaWebhookRepository();
  const solicitudesApi = new InMemorySolicitudApiRepository();
  const idempotencia = new InMemoryIdempotenciaRepository();
  const integraciones = new InMemoryIntegracionRepository((id) => {
    entregasWebhook.eliminarDeIntegracion(id);
    solicitudesApi.eliminarDeIntegracion(id);
    idempotencia.eliminarDeIntegracion(id);
  });
  // Caja: el repo de envíos registra los cobros al guardar (como la transacción de Postgres).
  const caja = new InMemoryCajaRepository(usuarios.nombre);
  const envios = new InMemoryEnvioRepository({
    outbox: entregasWebhook,
    nombreIntegracion: integraciones.nombre,
    caja,
    nombreUsuario: usuarios.nombre,
  });
  return {
    usuarios,
    ciudades: new InMemoryCiudadRepository(ciudades),
    // Como la FK de envio_items en Postgres: no se elimina un tipo que algún envío usa.
    tiposCarga: new InMemoryTipoCargaRepository(undefined, { usaTipoCarga: (c) => envios.usaTipoCarga(c) }),
    articulos: new InMemoryArticuloRestringidoRepository(),
    rutas: new InMemoryRutaRepository(ciudades),
    envios,
    // Eliminar un cliente desactiva y desvincula sus usuarios del portal (en Postgres, en la misma transacción).
    clientes: new InMemoryClienteRepository(CLIENTES_SEED, { alEliminar: (id) => usuarios.desvincularCliente(id) }),
    almacen: new AlmacenMemoria(),
    hasher,
    tokens: new JwtTokenService(jwtSecret),
    clock: new SystemClock(),
    ids: new CryptoIdGenerator(),
    integraciones,
    entregasWebhook,
    solicitudesApi,
    idempotencia,
    apiKeys: new ServicioApiKeysCrypto(),
    // Datos en RAM: si no se indica otro cifrador basta una clave efímera (se pierde junto con los datos).
    cifrador: new CifradorAesGcm(randomBytes(32)),
    secretosWebhook: new SecretosWebhookCrypto(),
    clienteWebhook: new ClienteWebhookFetch({ permitirHttp: webhooksPermitirHttp ?? false }),
    caja,
    datosPersonales: new InMemoryDatosPersonalesRepository(),
    contrasenas: new GeneradorContrasenasCrypto(),
    ...sobrescribir,
  };
}

export function adaptadoresPostgres(
  db: Db,
  config: Pick<Config, "JWT_SECRET" | "JWT_EXPIRES_IN"> &
    Partial<Pick<Config, "INTEGRACIONES_CLAVE_CIFRADO" | "WEBHOOKS_PERMITIR_HTTP">>,
  almacen: AlmacenArchivos = new AlmacenMemoria(),
): Adaptadores {
  return {
    usuarios: new PgUsuarioRepository(db),
    ciudades: new PgCiudadRepository(db),
    tiposCarga: new PgTipoCargaRepository(db),
    articulos: new PgArticuloRestringidoRepository(db),
    rutas: new PgRutaRepository(db),
    envios: new PgEnvioRepository(db),
    clientes: new PgClienteRepository(db),
    almacen,
    hasher: new BcryptPasswordHasher(),
    tokens: new JwtTokenService(config.JWT_SECRET, config.JWT_EXPIRES_IN),
    clock: new SystemClock(),
    ids: new CryptoIdGenerator(),
    integraciones: new PgIntegracionRepository(db),
    entregasWebhook: new PgEntregaWebhookRepository(db),
    solicitudesApi: new PgSolicitudApiRepository(db),
    idempotencia: new PgIdempotenciaRepository(db),
    apiKeys: new ServicioApiKeysCrypto(),
    cifrador: crearCifrador(config.INTEGRACIONES_CLAVE_CIFRADO),
    secretosWebhook: new SecretosWebhookCrypto(),
    clienteWebhook: new ClienteWebhookFetch({ permitirHttp: config.WEBHOOKS_PERMITIR_HTTP ?? false }),
    caja: new PgCajaRepository(db),
    datosPersonales: new PgDatosPersonalesRepository(db),
    contrasenas: new GeneradorContrasenasCrypto(),
  };
}

/** Caché y limitador de tasa según `CACHE_DRIVER`. Con Redis se comparten entre todas las instancias de la API. */
export async function crearCacheYLimitador(config: Pick<Config, "CACHE_DRIVER" | "REDIS_URL">): Promise<{
  cache: Cache;
  limitador: LimitadorTasa;
  cerrar: () => Promise<void>;
}> {
  if (config.CACHE_DRIVER === "redis" && config.REDIS_URL) {
    const redis = crearClienteRedis(config.REDIS_URL);
    await esperarRedis(redis);
    return {
      cache: new RedisCache(redis),
      limitador: new RedisLimitadorTasa(redis),
      cerrar: async () => {
        await redis.quit().catch(() => redis.disconnect());
      },
    };
  }
  const cache = config.CACHE_DRIVER === "none" ? new SinCache() : new MemoryCache();
  return { cache, limitador: new MemoryLimitadorTasa(), cerrar: async () => {} };
}

/** Almacén de archivos según `STORAGE_DRIVER` (cargarConfig ya validó las credenciales de R2). */
export function crearAlmacen(
  config: Pick<
    Config,
    "STORAGE_DRIVER" | "STORAGE_LOCAL_DIR" | "R2_ACCOUNT_ID" | "R2_ACCESS_KEY_ID" | "R2_SECRET_ACCESS_KEY" | "R2_BUCKET"
  >,
): AlmacenArchivos {
  switch (config.STORAGE_DRIVER) {
    case "r2":
      return AlmacenR2.desdeConfig({
        accountId: config.R2_ACCOUNT_ID!,
        accessKeyId: config.R2_ACCESS_KEY_ID!,
        secretAccessKey: config.R2_SECRET_ACCESS_KEY!,
        bucket: config.R2_BUCKET!,
      });
    case "local":
      return new AlmacenDisco(config.STORAGE_LOCAL_DIR);
    case "memory":
      return new AlmacenMemoria();
  }
}

export async function crearContenedor(
  config: Config,
): Promise<{ casos: CasosDeUso; limitador: LimitadorTasa; cerrar: () => Promise<void> }> {
  const { cache, limitador, cerrar: cerrarCache } = await crearCacheYLimitador(config);
  const almacen = crearAlmacen(config);
  const opcionesCasos = { publicUrl: config.PUBLIC_URL, webhooksPermitirHttp: config.WEBHOOKS_PERMITIR_HTTP };
  if (config.DB_DRIVER === "memory") {
    const adaptadores = await adaptadoresEnMemoria({
      jwtSecret: config.JWT_SECRET,
      almacen,
      webhooksPermitirHttp: config.WEBHOOKS_PERMITIR_HTTP,
      ...(config.INTEGRACIONES_CLAVE_CIFRADO ? { cifrador: crearCifrador(config.INTEGRACIONES_CLAVE_CIFRADO) } : {}),
    });
    return { casos: crearCasosDeUso(adaptadores, cache, opcionesCasos), limitador, cerrar: cerrarCache };
  }
  const db = crearPool(config.DATABASE_URL);
  return {
    casos: crearCasosDeUso(adaptadoresPostgres(db, config, almacen), cache, opcionesCasos),
    limitador,
    cerrar: async () => {
      await Promise.all([db.end(), cerrarCache()]);
    },
  };
}
