import { createHmac, randomBytes } from "node:crypto";
import type { ServicioSecretosWebhook } from "../../application/ports/integraciones.js";
import { igualesTiempoConstante } from "./apiKeys.js";

// Firma de webhooks según Standard Webhooks (https://www.standardwebhooks.com):
//   webhook-signature: v1,<base64(HMAC-SHA256(secreto_decodificado, "<id>.<timestamp>.<cuerpo>"))>

const PREFIJO_SECRETO = "whsec_";

export class SecretosWebhookCrypto implements ServicioSecretosWebhook {
  generar(): string {
    return PREFIJO_SECRETO + randomBytes(32).toString("base64");
  }
}

/** Bytes del secreto: lo que va después de `whsec_`, en base64. */
export const bytesSecreto = (secreto: string): Buffer =>
  Buffer.from(secreto.startsWith(PREFIJO_SECRETO) ? secreto.slice(PREFIJO_SECRETO.length) : secreto, "base64");

export function firmarWebhook(secreto: string, id: string, timestamp: number, cuerpo: string): string {
  const firma = createHmac("sha256", bytesSecreto(secreto)).update(`${id}.${timestamp}.${cuerpo}`, "utf8").digest("base64");
  return `v1,${firma}`;
}

/**
 * Verificación del lado de la empresa (también se usa en tests y en la documentación OpenAPI): compara en tiempo
 * constante contra cada firma `v1,` del header (puede traer varias separadas por espacio) y rechaza timestamps
 * con más de `toleranciaSeg` de diferencia (anti-replay).
 */
export function verificarFirmaWebhook(
  secreto: string,
  headers: { id: string; timestamp: string; firma: string },
  cuerpo: string,
  opciones: { ahoraSeg?: number; toleranciaSeg?: number } = {},
): boolean {
  const ts = Number(headers.timestamp);
  if (!Number.isInteger(ts)) return false;
  const ahora = opciones.ahoraSeg ?? Math.floor(Date.now() / 1000);
  if (Math.abs(ahora - ts) > (opciones.toleranciaSeg ?? 300)) return false;
  const esperada = firmarWebhook(secreto, headers.id, ts, cuerpo);
  return headers.firma.split(" ").some((f) => igualesTiempoConstante(f, esperada));
}
