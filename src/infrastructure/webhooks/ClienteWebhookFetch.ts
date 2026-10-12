import { lookup } from "node:dns/promises";
import type { ClienteWebhook, MensajeWebhook } from "../../application/ports/integraciones.js";
import { TIMEOUT_WEBHOOK_MS, type ResultadoEnvioWebhook } from "../../domain/integracion/Webhook.js";
import { firmarWebhook } from "../security/firmaWebhook.js";
import { esIpPublica, normalizarIp } from "../security/redes.js";
import { isIP } from "node:net";

export type ResolverDns = (host: string) => Promise<string[]>;

const resolverSistema: ResolverDns = async (host) => (await lookup(host, { all: true, verbatim: true })).map((r) => r.address);

export interface OpcionesClienteWebhook {
  /** WEBHOOKS_PERMITIR_HTTP (solo desarrollo): acepta http:// y desactiva el bloqueo de IPs no públicas. */
  permitirHttp: boolean;
  timeoutMs?: number;
  resolver?: ResolverDns;
}

/**
 * Envía webhooks firmados con `fetch`:
 * - anti-SSRF: antes de cada envío resuelve el DNS y rechaza destinos privados, loopback, link-local o de
 *   metadatos (todas las direcciones resueltas deben ser públicas);
 * - no sigue redirecciones (`redirect: "manual"`; una 3xx cuenta como fallo);
 * - timeout de 10 s; solo 2xx es éxito. Nunca lanza.
 */
export class ClienteWebhookFetch implements ClienteWebhook {
  private readonly resolver: ResolverDns;

  constructor(private readonly opciones: OpcionesClienteWebhook) {
    this.resolver = opciones.resolver ?? resolverSistema;
  }

  /** null si el destino es aceptable; si no, el motivo. */
  async verificarDestino(url: URL): Promise<string | null> {
    const permitido = url.protocol === "https:" || (this.opciones.permitirHttp && url.protocol === "http:");
    if (!permitido) return "La URL del webhook debe usar https://";
    if (url.username || url.password) return "La URL del webhook no puede incluir credenciales";
    if (this.opciones.permitirHttp) return null;
    const host = normalizarIp(url.hostname);
    let direcciones: string[];
    if (isIP(host)) {
      direcciones = [host];
    } else {
      try {
        direcciones = await this.resolver(host);
      } catch {
        return `No se pudo resolver el dominio ${url.hostname}`;
      }
    }
    if (direcciones.length === 0) return `No se pudo resolver el dominio ${url.hostname}`;
    if (!direcciones.every(esIpPublica)) return "El destino del webhook resuelve a una dirección no pública (bloqueado)";
    return null;
  }

  async enviar(m: MensajeWebhook): Promise<ResultadoEnvioWebhook> {
    let url: URL;
    try {
      url = new URL(m.url);
    } catch {
      return { ok: false, status: null, error: "URL del webhook inválida" };
    }
    const rechazo = await this.verificarDestino(url);
    if (rechazo) return { ok: false, status: null, error: rechazo };
    const timeoutMs = this.opciones.timeoutMs ?? TIMEOUT_WEBHOOK_MS;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "PCargo-Webhooks/1.0",
          "webhook-id": m.id,
          "webhook-timestamp": String(m.timestamp),
          "webhook-signature": firmarWebhook(m.secreto, m.id, m.timestamp, m.cuerpo),
        },
        body: m.cuerpo,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      await res.body?.cancel().catch(() => undefined); // no se lee la respuesta
      const ok = res.status >= 200 && res.status < 300;
      if (ok) return { ok, status: res.status, error: null };
      const error = res.status >= 300 && res.status < 400 ? `Redirección no permitida (HTTP ${res.status})` : `HTTP ${res.status}`;
      return { ok: false, status: res.status, error };
    } catch (e) {
      const nombre = (e as Error).name;
      if (nombre === "TimeoutError" || nombre === "AbortError") {
        return { ok: false, status: null, error: `Sin respuesta en ${Math.round(timeoutMs / 1000)} s` };
      }
      const causa = (e as { cause?: { code?: string; message?: string } }).cause;
      return { ok: false, status: null, error: `Error de red: ${causa?.code ?? causa?.message ?? (e as Error).message}` };
    }
  }
}
