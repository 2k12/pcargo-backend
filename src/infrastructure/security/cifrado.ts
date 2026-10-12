import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { CifradorSecretos } from "../../application/ports/integraciones.js";
import { DomainError } from "../../domain/shared/DomainError.js";

// Cifrado en reposo de los secretos de webhooks: AES-256-GCM con la clave INTEGRACIONES_CLAVE_CIFRADO.
// Formato: "v1:" + base64(iv[12] | tag[16] | texto cifrado).

const VERSION = "v1:";
const LARGO_IV = 12;
const LARGO_TAG = 16;

/**
 * Interpreta la clave: 32 bytes en hex (64 caracteres) o en base64 (44 caracteres con relleno).
 * Lanza un Error con instrucciones si no tiene ese formato.
 */
export function leerClaveCifrado(texto: string): Buffer {
  const t = texto.trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return Buffer.from(t, "hex");
  if (/^[A-Za-z0-9+/]{43}=$/.test(t)) {
    const b = Buffer.from(t, "base64");
    if (b.length === 32) return b;
  }
  throw new Error(
    "INTEGRACIONES_CLAVE_CIFRADO debe ser una clave de 32 bytes en base64 o hex. " +
      'Genérela con: node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'base64\'))"',
  );
}

export class CifradorAesGcm implements CifradorSecretos {
  private readonly clave: Buffer;

  constructor(clave: Buffer) {
    if (clave.length !== 32) throw new Error("La clave de cifrado debe medir 32 bytes");
    this.clave = Buffer.from(clave);
  }

  cifrar(texto: string): string {
    const iv = randomBytes(LARGO_IV);
    const cipher = createCipheriv("aes-256-gcm", this.clave, iv);
    const cifrado = Buffer.concat([cipher.update(texto, "utf8"), cipher.final()]);
    return VERSION + Buffer.concat([iv, cipher.getAuthTag(), cifrado]).toString("base64");
  }

  descifrar(valor: string): string {
    if (!valor.startsWith(VERSION)) throw new Error("Formato de secreto cifrado desconocido");
    const datos = Buffer.from(valor.slice(VERSION.length), "base64");
    if (datos.length < LARGO_IV + LARGO_TAG) throw new Error("Secreto cifrado incompleto");
    const decipher = createDecipheriv("aes-256-gcm", this.clave, datos.subarray(0, LARGO_IV));
    decipher.setAuthTag(datos.subarray(LARGO_IV, LARGO_IV + LARGO_TAG));
    // Si la clave no es la misma o el dato fue alterado, final() lanza (autenticación GCM).
    return Buffer.concat([decipher.update(datos.subarray(LARGO_IV + LARGO_TAG)), decipher.final()]).toString("utf8");
  }
}

/** Sin INTEGRACIONES_CLAVE_CIFRADO: la API funciona, pero configurar webhooks responde un error claro (503). */
export class CifradorNoConfigurado implements CifradorSecretos {
  private error(): DomainError {
    return new DomainError(
      "SERVICIO_NO_CONFIGURADO",
      "El servidor no tiene INTEGRACIONES_CLAVE_CIFRADO: no se pueden configurar webhooks",
    );
  }
  cifrar(): string {
    throw this.error();
  }
  descifrar(): string {
    throw this.error();
  }
}
