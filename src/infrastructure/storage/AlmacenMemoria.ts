import type { AlmacenArchivos } from "../../application/ports/services.js";

/** Almacén en memoria del proceso: tests y `DB_DRIVER=memory`. Se pierde al reiniciar. */
export class AlmacenMemoria implements AlmacenArchivos {
  private readonly archivos = new Map<string, { bytes: Uint8Array; tipo: string }>();

  async guardar(clave: string, bytes: Uint8Array, tipo: string): Promise<void> {
    this.archivos.set(clave, { bytes: new Uint8Array(bytes), tipo });
  }

  async obtener(clave: string): Promise<Uint8Array | null> {
    const a = this.archivos.get(clave);
    return a ? new Uint8Array(a.bytes) : null;
  }

  async eliminar(clave: string): Promise<void> {
    this.archivos.delete(clave);
  }

  /** Claves guardadas (para verificar en tests que se borra la foto reemplazada). */
  claves(): string[] {
    return [...this.archivos.keys()];
  }
}
