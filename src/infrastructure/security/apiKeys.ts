import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ApiKeyGenerada, ServicioApiKeys } from "../../application/ports/integraciones.js";
import { armarApiKey, BASE62, LARGO_PREFIJO, LARGO_SECRETO } from "../../domain/integracion/ApiKeyFormato.js";
import type { ModoKey } from "../../domain/integracion/Integracion.js";

/**
 * Texto base62 aleatorio criptográficamente seguro. Usa muestreo con rechazo (descarta bytes ≥ 248) para que
 * los 62 símbolos sean equiprobables (sin sesgo de módulo).
 */
export function base62Aleatorio(largo: number): string {
  let resultado = "";
  while (resultado.length < largo) {
    for (const b of randomBytes(largo * 2)) {
      if (b < 248) resultado += BASE62[b % 62];
      if (resultado.length === largo) break;
    }
  }
  return resultado;
}

export const sha256Hex = (texto: string): string => createHash("sha256").update(texto, "utf8").digest("hex");

/** Comparación en tiempo constante; largos distintos → false (los hashes SHA-256 hex siempre miden 64). */
export function igualesTiempoConstante(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) {
    timingSafeEqual(ba, ba); // mismo trabajo aunque no coincida el largo
    return false;
  }
  return timingSafeEqual(ba, bb);
}

export class ServicioApiKeysCrypto implements ServicioApiKeys {
  generar(modo: ModoKey): ApiKeyGenerada {
    const prefijo8 = base62Aleatorio(LARGO_PREFIJO);
    const key = armarApiKey(modo, prefijo8, base62Aleatorio(LARGO_SECRETO));
    return { key, prefijo: `pc_${modo}_${prefijo8}`, hash: sha256Hex(key) };
  }

  hashear(key: string): string {
    return sha256Hex(key);
  }

  coinciden(hashA: string, hashB: string): boolean {
    return igualesTiempoConstante(hashA, hashB);
  }
}
