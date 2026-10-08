// Puertos de caché y limitación de tasa. Adaptadores: Redis (producción, compartido entre instancias)
// y memoria (desarrollo sin Docker y tests). Ambos deben "fallar abierto": si el almacén no responde,
// la API sigue funcionando sin caché ni límite en vez de devolver errores.

export interface Cache {
  /** `undefined` si la clave no existe, expiró o el almacén no está disponible. */
  obtener<T>(clave: string): Promise<T | undefined>;
  /** Guarda un valor serializable a JSON durante `ttlSeg` segundos. */
  guardar<T>(clave: string, valor: T, ttlSeg: number): Promise<void>;
  /** Borra todas las claves que empiezan por `prefijo` (p. ej. "catalogo:"). */
  invalidar(prefijo: string): Promise<void>;
}

export interface ResultadoTasa {
  permitido: boolean;
  /** Solicitudes que aún caben en la ventana actual. */
  restantes: number;
  /** Segundos hasta que se reinicia la ventana. */
  reintentarEnSeg: number;
}

export interface LimitadorTasa {
  /** Cuenta una solicitud de `clave` en una ventana fija de `ventanaSeg` segundos. */
  consumir(clave: string, limite: number, ventanaSeg: number): Promise<ResultadoTasa>;
}
