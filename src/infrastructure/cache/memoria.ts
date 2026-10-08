import type { Cache, LimitadorTasa, ResultadoTasa } from "../../application/ports/cache.js";
import type { Clock } from "../../application/ports/services.js";

const relojSistema: Clock = { ahora: () => new Date() };

/** Caché en memoria del proceso (desarrollo sin Docker y tests). Guarda JSON para imitar a Redis. */
export class MemoryCache implements Cache {
  private readonly datos = new Map<string, { json: string; expiraEn: number }>();

  constructor(private readonly reloj: Clock = relojSistema) {}

  async obtener<T>(clave: string): Promise<T | undefined> {
    const e = this.datos.get(clave);
    if (!e) return undefined;
    if (e.expiraEn <= this.reloj.ahora().getTime()) {
      this.datos.delete(clave);
      return undefined;
    }
    return JSON.parse(e.json) as T;
  }

  async guardar<T>(clave: string, valor: T, ttlSeg: number): Promise<void> {
    this.datos.set(clave, { json: JSON.stringify(valor), expiraEn: this.reloj.ahora().getTime() + ttlSeg * 1000 });
  }

  async invalidar(prefijo: string): Promise<void> {
    for (const clave of this.datos.keys()) if (clave.startsWith(prefijo)) this.datos.delete(clave);
  }
}

/** Sin caché: siempre falla la búsqueda. Útil para desactivarla por configuración. */
export class SinCache implements Cache {
  async obtener<T>(_clave: string): Promise<T | undefined> {
    return undefined;
  }
  async guardar<T>(_clave: string, _valor: T, _ttlSeg: number): Promise<void> {}
  async invalidar(_prefijo: string): Promise<void> {}
}

/** Ventana fija en memoria. Solo vale para una instancia; con varias réplicas usar Redis. */
export class MemoryLimitadorTasa implements LimitadorTasa {
  private readonly ventanas = new Map<string, { cuenta: number; reiniciaEn: number }>();

  constructor(private readonly reloj: Clock = relojSistema) {}

  async consumir(clave: string, limite: number, ventanaSeg: number): Promise<ResultadoTasa> {
    const ahora = this.reloj.ahora().getTime();
    let v = this.ventanas.get(clave);
    if (!v || v.reiniciaEn <= ahora) {
      v = { cuenta: 0, reiniciaEn: ahora + ventanaSeg * 1000 };
      this.ventanas.set(clave, v);
    }
    v.cuenta++;
    return {
      permitido: v.cuenta <= limite,
      restantes: Math.max(0, limite - v.cuenta),
      reintentarEnSeg: Math.max(1, Math.ceil((v.reiniciaEn - ahora) / 1000)),
    };
  }
}
