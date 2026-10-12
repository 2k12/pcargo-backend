import type { Cache, LimitadorTasa } from "../application/ports/cache.js";
import type {
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
  IdGenerator,
  PasswordHasher,
  TokenService,
} from "../application/ports/services.js";
import { Login } from "../application/use-cases/auth/Login.js";
import { ObtenerPerfil } from "../application/use-cases/auth/ObtenerPerfil.js";
import { ActualizarPerfil, CambiarContrasena } from "../application/use-cases/auth/Perfil.js";
import {
  ActualizarCiudad,
  CrearCiudad,
  EliminarCiudad,
  ListarCiudades,
  ListarTiposCarga,
} from "../application/use-cases/catalogo/Catalogo.js";
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
  InMemoryCiudadRepository,
  InMemoryEnvioRepository,
  InMemoryRutaRepository,
  InMemoryTipoCargaRepository,
  InMemoryUsuarioRepository,
} from "./persistence/memory/InMemoryRepositories.js";
import { InMemoryClienteRepository } from "./persistence/memory/InMemoryClienteRepository.js";
import { PgClienteRepository } from "./persistence/postgres/PgClienteRepository.js";
import {
  PgCiudadRepository,
  PgEnvioRepository,
  PgRutaRepository,
  PgTipoCargaRepository,
  PgUsuarioRepository,
} from "./persistence/postgres/PgRepositories.js";
import { crearPool, type Db } from "./persistence/postgres/pool.js";
import { USUARIOS_SEED } from "./persistence/seed-data.js";
import { BcryptPasswordHasher, JwtTokenService } from "./security/adapters.js";
import { AlmacenDisco } from "./storage/AlmacenDisco.js";
import { AlmacenMemoria } from "./storage/AlmacenMemoria.js";
import { AlmacenR2 } from "./storage/AlmacenR2.js";
import { CryptoIdGenerator, SystemClock } from "./system/adapters.js";

export interface Adaptadores {
  usuarios: UsuarioRepository;
  ciudades: CiudadRepository;
  tiposCarga: TipoCargaRepository;
  rutas: RutaRepository;
  envios: EnvioRepository;
  clientes: ClienteRepository;
  /** Almacén privado de archivos (fotos de evidencia de entrega). */
  almacen: AlmacenArchivos;
  hasher: PasswordHasher;
  tokens: TokenService;
  clock: Clock;
  ids: IdGenerator;
}

/**
 * Raíz de composición: conecta los casos de uso con los adaptadores concretos.
 * Con `cache` (Redis o memoria) las lecturas frecuentes se cachean y las escrituras invalidan lo afectado.
 */
export function crearCasosDeUso(a: Adaptadores, cache: Cache = new SinCache()) {
  const rutas = new RutaRepositoryEnCache(a.rutas, cache);
  const cotizar = new CotizarEnvio(rutas, a.tiposCarga);
  // Renombrar o desactivar ciudades/rutas cambia nombres y disponibilidad en todas las vistas cacheadas.
  const trasCambioCatalogo = [ESPACIOS.catalogo, ESPACIOS.dashboard, ESPACIOS.seguimiento];
  const enCatalogo = (activa?: boolean) => (activa === undefined ? "todas" : String(activa));
  return {
    tokens: a.tokens,
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
    listarTiposCarga: conCache(new ListarTiposCarga(a.tiposCarga), cache, {
      clave: () => claveCatalogo("tipos-carga"),
      ttlSeg: TTL.tiposCarga,
    }),
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
    crearEnvio: invalidaTras(new CrearEnvio(a.envios, cotizar, a.ids, a.clock, a.clientes), cache, [ESPACIOS.dashboard]),
    // Los nombres de clientes aparecen en el resumen: sus escrituras invalidan el dashboard.
    listarClientes: new ListarClientes(a.clientes, a.envios),
    crearCliente: invalidaTras(new CrearCliente(a.clientes, a.ids, a.clock), cache, [ESPACIOS.dashboard]),
    actualizarCliente: invalidaTras(new ActualizarCliente(a.clientes, a.envios, a.clock), cache, [ESPACIOS.dashboard]),
    eliminarCliente: invalidaTras(new EliminarCliente(a.clientes), cache, [ESPACIOS.dashboard]),
    listarEnvios: new ListarEnvios(a.envios, rutas),
    obtenerEnvio: new ObtenerEnvio(a.envios, rutas),
    cambiarEstado: invalidaTras(new CambiarEstadoEnvio(a.envios, rutas, a.clock), cache, [
      ESPACIOS.dashboard,
      ESPACIOS.seguimiento,
    ]),
    // La evidencia no aparece en el seguimiento público ni en el dashboard: no invalida cachés.
    subirEvidencia: new SubirEvidencia(a.envios, rutas, a.almacen, a.ids, a.clock),
    obtenerEvidencia: new ObtenerEvidencia(a.envios, a.almacen),
    seguimiento: conCache(new ConsultarSeguimiento(a.envios, rutas), cache, {
      clave: (guia) => `${ESPACIOS.seguimiento}${claveGuia(guia)}`,
      ttlSeg: TTL.seguimiento,
    }),
    resumen: conCache(new ObtenerResumen(a.envios, rutas, a.clientes, a.clock), cache, {
      clave: (f) => `${ESPACIOS.dashboard}resumen:${f?.clienteId ?? "todos"}:${f?.desde ?? ""}:${f?.hasta ?? ""}`,
      ttlSeg: TTL.dashboard,
    }),
  };
}

export type CasosDeUso = ReturnType<typeof crearCasosDeUso>;

export async function adaptadoresEnMemoria(
  opciones: { jwtSecret: string; rondasBcrypt?: number } & Partial<Adaptadores>,
): Promise<Adaptadores> {
  const hasher = opciones.hasher ?? new BcryptPasswordHasher(opciones.rondasBcrypt ?? 10);
  const usuarios = await Promise.all(
    USUARIOS_SEED.map(async ({ password, ...u }) => ({
      ...u,
      passwordHash: await hasher.hash(password),
      activo: true,
    })),
  );
  // Ciudades y rutas comparten la misma lista para que renombrar/desactivar se refleje en las rutas.
  const ciudades = ciudadesSemilla();
  return {
    usuarios: new InMemoryUsuarioRepository(usuarios),
    ciudades: new InMemoryCiudadRepository(ciudades),
    tiposCarga: new InMemoryTipoCargaRepository(),
    rutas: new InMemoryRutaRepository(ciudades),
    envios: new InMemoryEnvioRepository(),
    clientes: new InMemoryClienteRepository(),
    almacen: new AlmacenMemoria(),
    hasher,
    tokens: new JwtTokenService(opciones.jwtSecret),
    clock: new SystemClock(),
    ids: new CryptoIdGenerator(),
    ...opciones,
  };
}

export function adaptadoresPostgres(
  db: Db,
  config: Pick<Config, "JWT_SECRET" | "JWT_EXPIRES_IN">,
  almacen: AlmacenArchivos = new AlmacenMemoria(),
): Adaptadores {
  return {
    usuarios: new PgUsuarioRepository(db),
    ciudades: new PgCiudadRepository(db),
    tiposCarga: new PgTipoCargaRepository(db),
    rutas: new PgRutaRepository(db),
    envios: new PgEnvioRepository(db),
    clientes: new PgClienteRepository(db),
    almacen,
    hasher: new BcryptPasswordHasher(),
    tokens: new JwtTokenService(config.JWT_SECRET, config.JWT_EXPIRES_IN),
    clock: new SystemClock(),
    ids: new CryptoIdGenerator(),
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
  if (config.DB_DRIVER === "memory") {
    const adaptadores = await adaptadoresEnMemoria({ jwtSecret: config.JWT_SECRET, almacen });
    return { casos: crearCasosDeUso(adaptadores, cache), limitador, cerrar: cerrarCache };
  }
  const db = crearPool(config.DATABASE_URL);
  return {
    casos: crearCasosDeUso(adaptadoresPostgres(db, config, almacen), cache),
    limitador,
    cerrar: async () => {
      await Promise.all([db.end(), cerrarCache()]);
    },
  };
}
