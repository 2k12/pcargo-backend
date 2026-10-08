import { Redis } from "ioredis";
import type { Cache, LimitadorTasa, ResultadoTasa } from "../../application/ports/cache.js";

/**
 * Cliente Redis pensado para "fallar abierto": sin cola offline y con timeouts cortos, de modo que si Redis
 * cae los comandos fallan rápido y los adaptadores responden como "sin caché" en vez de bloquear la API.
 */
export function crearClienteRedis(url: string): Redis {
  const cliente = new Redis(url, {
    lazyConnect: false,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    commandTimeout: 500,
    retryStrategy: (intentos) => Math.min(intentos * 500, 5000),
  });
  let avisado = false;
  cliente.on("error", (err: Error) => {
    if (!avisado) console.warn(`Redis no disponible (${err.message}); la API sigue sin caché ni límite de tasa.`);
    avisado = true;
  });
  cliente.on("ready", () => {
    if (avisado) console.info("Redis reconectado.");
    avisado = false;
  });
  return cliente;
}

/**
 * Espera a que el cliente esté listo, como mucho `timeoutMs`. Sin cola offline, los comandos enviados antes
 * de conectar fallarían; si Redis no llega a tiempo la API arranca igual (sin caché) y se reconecta sola.
 */
export function esperarRedis(cliente: Redis, timeoutMs = 3000): Promise<boolean> {
  if (cliente.status === "ready") return Promise.resolve(true);
  return new Promise((resolve) => {
    const fin = (listo: boolean) => {
      clearTimeout(temporizador);
      cliente.off("ready", alEstarListo);
      resolve(listo);
    };
    const alEstarListo = () => fin(true);
    const temporizador = setTimeout(() => fin(false), timeoutMs);
    cliente.once("ready", alEstarListo);
  });
}

export class RedisCache implements Cache {
  /** `espacio` aísla las claves de PCargo (y de cada entorno) dentro de un mismo Redis. */
  constructor(
    private readonly redis: Redis,
    private readonly espacio = "pcargo:",
  ) {}

  async obtener<T>(clave: string): Promise<T | undefined> {
    try {
      const json = await this.redis.get(this.espacio + clave);
      return json === null ? undefined : (JSON.parse(json) as T);
    } catch {
      return undefined;
    }
  }

  async guardar<T>(clave: string, valor: T, ttlSeg: number): Promise<void> {
    try {
      await this.redis.set(this.espacio + clave, JSON.stringify(valor), "EX", Math.max(1, Math.ceil(ttlSeg)));
    } catch {
      // Sin Redis no se cachea; la respuesta ya se calculó.
    }
  }

  async invalidar(prefijo: string): Promise<void> {
    try {
      // SCAN (no KEYS) para no bloquear Redis; el espacio de claves de la caché es pequeño.
      let cursor = "0";
      do {
        const [siguiente, claves] = await this.redis.scan(cursor, "MATCH", `${this.espacio}${prefijo}*`, "COUNT", 200);
        if (claves.length) await this.redis.unlink(...claves);
        cursor = siguiente;
      } while (cursor !== "0");
    } catch (err) {
      // Si no se pudo invalidar, el TTL corto de cada entrada acota cuánto tiempo puede verse un dato viejo.
      console.warn(`No se pudo invalidar la caché "${prefijo}": ${(err as Error).message}`);
    }
  }
}

// INCR + EXPIRE atómicos: la ventana arranca con la primera solicitud. Devuelve [cuenta, ttl en ms].
const SCRIPT_VENTANA = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end
return {n, ttl}
`;

/** Ventana fija compartida por todas las instancias de la API. */
export class RedisLimitadorTasa implements LimitadorTasa {
  constructor(
    private readonly redis: Redis,
    private readonly espacio = "pcargo:tasa:",
  ) {}

  async consumir(clave: string, limite: number, ventanaSeg: number): Promise<ResultadoTasa> {
    try {
      const [cuenta, ttlMs] = (await this.redis.eval(SCRIPT_VENTANA, 1, this.espacio + clave, ventanaSeg * 1000)) as [
        number,
        number,
      ];
      return {
        permitido: cuenta <= limite,
        restantes: Math.max(0, limite - cuenta),
        reintentarEnSeg: Math.max(1, Math.ceil(ttlMs / 1000)),
      };
    } catch {
      // Falla abierto: no bloquear a los usuarios porque Redis no responde.
      return { permitido: true, restantes: limite, reintentarEnSeg: ventanaSeg };
    }
  }
}
