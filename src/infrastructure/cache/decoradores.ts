import type { Cache } from "../../application/ports/cache.js";
import type { CambiosRuta, NuevaRuta, RutaRepository } from "../../application/ports/repositories.js";
import type { Ruta } from "../../domain/ruta/Ruta.js";

// Decoradores que añaden caché en la raíz de composición sin tocar los casos de uso ni el dominio.

type Caso = { ejecutar(...args: any[]): Promise<unknown> };
/** Conserva la firma exacta de `ejecutar` (incluidos parámetros opcionales) del caso decorado. */
type Decorado<C extends Caso> = Pick<C, "ejecutar">;
type Args<C extends Caso> = Parameters<C["ejecutar"]>;
type Resultado<C extends Caso> = Awaited<ReturnType<C["ejecutar"]>>;

/** Espacios de claves. Invalidar un espacio borra todas sus entradas. */
export const ESPACIOS = {
  /** Ciudades, tipos de carga, rutas, artículos restringidos y catálogo público: cambian poco y se leen mucho. */
  catalogo: "catalogo:",
  /** Resumen del dashboard: recorre todos los envíos, es la consulta más cara. */
  dashboard: "dashboard:",
  /** Rastreo público por número de guía. */
  seguimiento: "seguimiento:",
} as const;

/**
 * Versión de la forma de los datos del catálogo (tipos de carga, rutas). Va dentro de la clave para que, al
 * desplegar un cambio de contrato, la API nunca lea entradas con la forma vieja que queden en un Redis
 * compartido (p. ej. tipos con `factor` o rutas con `tarifaBase` de v7, o tipos sin `activo` de v8). Invalidar
 * `catalogo:` las borra todas.
 */
export const VERSION_CATALOGO = "v11";

/** Clave dentro del espacio del catálogo: `catalogo:v11:<nombre>`. */
export const claveCatalogo = (nombre: string): string => `${ESPACIOS.catalogo}${VERSION_CATALOGO}:${nombre}`;

/** TTL en segundos: acotan cuánto puede verse un dato viejo si una invalidación falla. */
export const TTL = { catalogo: 300, tiposCarga: 3600, dashboard: 60, seguimiento: 60 } as const;

/** Lectura con caché (cache-aside). Los errores no se cachean. */
export function conCache<C extends Caso>(
  caso: C,
  cache: Cache,
  opciones: { clave: (...args: Args<C>) => string; ttlSeg: number },
): Decorado<C> {
  const ejecutar = async (...args: Args<C>): Promise<Resultado<C>> => {
    const clave = opciones.clave(...args);
    const guardado = await cache.obtener<Resultado<C>>(clave);
    if (guardado !== undefined) return guardado;
    const resultado = (await caso.ejecutar(...args)) as Resultado<C>;
    await cache.guardar(clave, resultado, opciones.ttlSeg);
    return resultado;
  };
  return { ejecutar } as Decorado<C>;
}

/** Escritura que invalida los espacios afectados cuando termina bien. */
export function invalidaTras<C extends Caso>(caso: C, cache: Cache, espacios: string[]): Decorado<C> {
  const ejecutar = async (...args: Args<C>): Promise<Resultado<C>> => {
    const resultado = (await caso.ejecutar(...args)) as Resultado<C>;
    await Promise.all(espacios.map((e) => cache.invalidar(e)));
    return resultado;
  };
  return { ejecutar } as Decorado<C>;
}

/** Normaliza una guía para la clave de caché: sin espacios ni ceros a la izquierda ("0040425" = "40425"). */
export const claveGuia = (texto: string): string =>
  String(texto ?? "")
    .replace(/\s+/g, "")
    .replace(/^0+(?=\d)/, "");

const filtroActiva = (filtro?: { activa?: boolean }): string => (filtro?.activa === undefined ? "todas" : String(filtro.activa));

/**
 * Repositorio de rutas con caché: los casos de uso de envíos consultan todas las rutas en cada listado
 * para resolver los nombres de origen y destino. Sus escrituras invalidan todo el catálogo.
 */
export class RutaRepositoryEnCache implements RutaRepository {
  constructor(
    private readonly interno: RutaRepository,
    private readonly cache: Cache,
    private readonly ttlSeg: number = TTL.catalogo,
  ) {}

  private async leer<T>(clave: string, cargar: () => Promise<T>): Promise<T> {
    const guardado = await this.cache.obtener<T>(claveCatalogo(clave));
    if (guardado !== undefined) return guardado;
    const valor = await cargar();
    await this.cache.guardar(claveCatalogo(clave), valor, this.ttlSeg);
    return valor;
  }

  listar(filtro?: { activa?: boolean }): Promise<Ruta[]> {
    return this.leer(`repo-rutas:${filtroActiva(filtro)}`, () => this.interno.listar(filtro));
  }

  async buscarPorId(id: number): Promise<Ruta | null> {
    // Reutiliza el listado completo cacheado: hay pocas rutas y evita una entrada por id.
    return (await this.listar()).find((r) => r.id === id) ?? null;
  }

  existe(origenId: number, destinoId: number): Promise<boolean> {
    return this.interno.existe(origenId, destinoId);
  }

  usaCiudad(ciudadId: number): Promise<boolean> {
    return this.interno.usaCiudad(ciudadId);
  }

  async crear(datos: NuevaRuta): Promise<Ruta> {
    const ruta = await this.interno.crear(datos);
    await this.cache.invalidar(ESPACIOS.catalogo);
    return ruta;
  }

  async actualizar(id: number, cambios: CambiosRuta): Promise<Ruta> {
    const ruta = await this.interno.actualizar(id, cambios);
    await this.cache.invalidar(ESPACIOS.catalogo);
    return ruta;
  }
}
