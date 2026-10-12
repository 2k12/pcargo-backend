import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { AlmacenArchivos } from "../../application/ports/services.js";

/** Solo segmentos seguros: letras, dígitos, `.`, `_`, `-`, separados por `/` (sin `..` ni rutas absolutas). */
const CLAVE_VALIDA = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/**
 * Almacén en una carpeta local (desarrollo o un servidor con disco persistente). La carpeta es privada:
 * la API la sirve solo a usuarios autenticados, nunca como archivos estáticos.
 */
export class AlmacenDisco implements AlmacenArchivos {
  private readonly raiz: string;

  constructor(carpeta: string) {
    this.raiz = resolve(carpeta);
  }

  /** Ruta absoluta de la clave, garantizando que no se salga de la carpeta raíz. */
  private ruta(clave: string): string {
    if (!CLAVE_VALIDA.test(clave)) throw new Error(`Clave de almacén inválida: ${clave}`);
    const ruta = resolve(this.raiz, ...clave.split("/"));
    const rel = relative(this.raiz, ruta);
    if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) {
      throw new Error(`Clave de almacén fuera de la carpeta: ${clave}`);
    }
    return ruta;
  }

  async guardar(clave: string, bytes: Uint8Array, _tipo: string): Promise<void> {
    const ruta = this.ruta(clave);
    await mkdir(dirname(ruta), { recursive: true });
    await writeFile(ruta, bytes);
  }

  async obtener(clave: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.ruta(clave)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  async eliminar(clave: string): Promise<void> {
    await rm(this.ruta(clave), { force: true });
  }
}
