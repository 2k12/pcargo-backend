import type {
  CiudadRepository,
  EnvioRepository,
  RutaRepository,
  TipoCargaRepository,
  UsuarioRepository,
} from "../application/ports/repositories.js";
import type { Clock, IdGenerator, PasswordHasher, TokenService } from "../application/ports/services.js";
import { Login } from "../application/use-cases/auth/Login.js";
import { ObtenerPerfil } from "../application/use-cases/auth/ObtenerPerfil.js";
import { ListarCiudades, ListarTiposCarga } from "../application/use-cases/catalogo/Catalogo.js";
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
import { ActualizarRuta, CrearRuta, ListarRutas } from "../application/use-cases/rutas/Rutas.js";
import type { Config } from "./config/env.js";
import {
  InMemoryCiudadRepository,
  InMemoryEnvioRepository,
  InMemoryRutaRepository,
  InMemoryTipoCargaRepository,
  InMemoryUsuarioRepository,
} from "./persistence/memory/InMemoryRepositories.js";
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
import { CryptoIdGenerator, SystemClock } from "./system/adapters.js";

export interface Adaptadores {
  usuarios: UsuarioRepository;
  ciudades: CiudadRepository;
  tiposCarga: TipoCargaRepository;
  rutas: RutaRepository;
  envios: EnvioRepository;
  hasher: PasswordHasher;
  tokens: TokenService;
  clock: Clock;
  ids: IdGenerator;
}

/** Raíz de composición: conecta los casos de uso con los adaptadores concretos. */
export function crearCasosDeUso(a: Adaptadores) {
  const cotizar = new CotizarEnvio(a.rutas, a.tiposCarga);
  return {
    tokens: a.tokens,
    login: new Login(a.usuarios, a.hasher, a.tokens),
    perfil: new ObtenerPerfil(a.usuarios),
    listarCiudades: new ListarCiudades(a.ciudades),
    listarTiposCarga: new ListarTiposCarga(a.tiposCarga),
    catalogoPublico: new ObtenerCatalogoPublico(a.ciudades, a.tiposCarga, a.rutas),
    listarRutas: new ListarRutas(a.rutas),
    crearRuta: new CrearRuta(a.rutas, a.ciudades),
    actualizarRuta: new ActualizarRuta(a.rutas),
    cotizar,
    crearEnvio: new CrearEnvio(a.envios, cotizar, a.ids, a.clock),
    listarEnvios: new ListarEnvios(a.envios, a.rutas),
    obtenerEnvio: new ObtenerEnvio(a.envios, a.rutas),
    cambiarEstado: new CambiarEstadoEnvio(a.envios, a.rutas, a.clock),
    seguimiento: new ConsultarSeguimiento(a.envios, a.rutas),
    resumen: new ObtenerResumen(a.envios, a.rutas),
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
  return {
    usuarios: new InMemoryUsuarioRepository(usuarios),
    ciudades: new InMemoryCiudadRepository(),
    tiposCarga: new InMemoryTipoCargaRepository(),
    rutas: new InMemoryRutaRepository(),
    envios: new InMemoryEnvioRepository(),
    hasher,
    tokens: new JwtTokenService(opciones.jwtSecret),
    clock: new SystemClock(),
    ids: new CryptoIdGenerator(),
    ...opciones,
  };
}

export function adaptadoresPostgres(db: Db, config: Pick<Config, "JWT_SECRET" | "JWT_EXPIRES_IN">): Adaptadores {
  return {
    usuarios: new PgUsuarioRepository(db),
    ciudades: new PgCiudadRepository(db),
    tiposCarga: new PgTipoCargaRepository(db),
    rutas: new PgRutaRepository(db),
    envios: new PgEnvioRepository(db),
    hasher: new BcryptPasswordHasher(),
    tokens: new JwtTokenService(config.JWT_SECRET, config.JWT_EXPIRES_IN),
    clock: new SystemClock(),
    ids: new CryptoIdGenerator(),
  };
}

export async function crearContenedor(config: Config): Promise<{ casos: CasosDeUso; cerrar: () => Promise<void> }> {
  if (config.DB_DRIVER === "memory") {
    return { casos: crearCasosDeUso(await adaptadoresEnMemoria({ jwtSecret: config.JWT_SECRET })), cerrar: async () => {} };
  }
  const db = crearPool(config.DATABASE_URL);
  return { casos: crearCasosDeUso(adaptadoresPostgres(db, config)), cerrar: () => db.end() };
}
