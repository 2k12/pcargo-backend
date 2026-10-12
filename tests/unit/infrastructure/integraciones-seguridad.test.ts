import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { desarmarApiKey } from "../../../src/domain/integracion/ApiKeyFormato.js";
import { DomainError } from "../../../src/domain/shared/DomainError.js";
import { base62Aleatorio, igualesTiempoConstante, ServicioApiKeysCrypto, sha256Hex } from "../../../src/infrastructure/security/apiKeys.js";
import { CifradorAesGcm, CifradorNoConfigurado, leerClaveCifrado } from "../../../src/infrastructure/security/cifrado.js";
import {
  firmarWebhook,
  SecretosWebhookCrypto,
  verificarFirmaWebhook,
} from "../../../src/infrastructure/security/firmaWebhook.js";
import { esIpOCidrValido, esIpPublica, ipPermitida } from "../../../src/infrastructure/security/redes.js";
import { ClienteWebhookFetch } from "../../../src/infrastructure/webhooks/ClienteWebhookFetch.js";
import { cargarConfig } from "../../../src/infrastructure/config/env.js";

describe("Generación y verificación de API keys", () => {
  const servicio = new ServicioApiKeysCrypto();

  it("genera pc_live_/pc_test_ con prefijo 8 + secreto 32 base62 y guarda solo el SHA-256", () => {
    for (const modo of ["live", "test"] as const) {
      const g = servicio.generar(modo);
      expect(g.key).toMatch(new RegExp(`^pc_${modo}_[0-9A-Za-z]{8}_[0-9A-Za-z]{32}$`));
      expect(desarmarApiKey(g.key)).toEqual({ modo, prefijo: g.prefijo });
      expect(g.key.startsWith(`${g.prefijo}_`)).toBe(true);
      expect(g.hash).toBe(sha256Hex(g.key));
      expect(g.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(g.hash).not.toContain(g.key.slice(-32));
    }
  });

  it("las keys no se repiten y usan los 62 símbolos", () => {
    const keys = new Set(Array.from({ length: 200 }, () => servicio.generar("live").key));
    expect(keys.size).toBe(200);
    const muestra = base62Aleatorio(20_000);
    expect(muestra).toMatch(/^[0-9A-Za-z]+$/);
    expect(new Set(muestra).size).toBe(62);
  });

  it("compara hashes en tiempo constante", () => {
    const h = servicio.hashear("pc_live_x");
    expect(servicio.coinciden(h, sha256Hex("pc_live_x"))).toBe(true);
    expect(servicio.coinciden(h, sha256Hex("pc_live_y"))).toBe(false);
    expect(igualesTiempoConstante("abc", "abcd")).toBe(false);
  });
});

describe("IPs permitidas (CIDR IPv4/IPv6 con BlockList)", () => {
  it("valida IPs y rangos", () => {
    for (const ok of ["203.0.113.7", "203.0.113.0/24", "0.0.0.0/0", "2001:db8::1", "2001:db8::/32", "::/0"]) {
      expect(esIpOCidrValido(ok)).toBe(true);
    }
    for (const malo of ["203.0.113.256", "203.0.113.0/33", "2001:db8::/129", "10.0.0.0/8/1", "tienda.example", "", "10.0.0.0/x"]) {
      expect(esIpOCidrValido(malo)).toBe(false);
    }
  });

  it("lista vacía = cualquier IP; si no, solo las incluidas (IPv4 mapeada en IPv6 cuenta como IPv4)", () => {
    expect(ipPermitida("198.51.100.9", [])).toBe(true);
    const lista = ["203.0.113.0/24", "2001:db8:abcd::/48", "192.0.2.10"];
    expect(ipPermitida("203.0.113.200", lista)).toBe(true);
    expect(ipPermitida("::ffff:203.0.113.5", lista)).toBe(true);
    expect(ipPermitida("192.0.2.10", lista)).toBe(true);
    expect(ipPermitida("192.0.2.11", lista)).toBe(false);
    expect(ipPermitida("2001:db8:abcd:12::1", lista)).toBe(true);
    expect(ipPermitida("2001:db8:abce::1", lista)).toBe(false);
    expect(ipPermitida(undefined, lista)).toBe(false);
    expect(ipPermitida("basura", lista)).toBe(false);
  });
});

describe("Anti-SSRF: direcciones no públicas", () => {
  it("bloquea privadas, loopback, link-local, metadatos, CGNAT, ULA y multicast; permite públicas", () => {
    for (const ip of [
      "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1",
      "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fd00::1", "fc00::1", "fe80::1", "ff02::1",
      "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a9fe:a9fe",
    ]) {
      expect(esIpPublica(ip), ip).toBe(false);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
      expect(esIpPublica(ip), ip).toBe(true);
    }
  });

  it("el cliente de webhooks rechaza destinos que resuelven a IPs no públicas sin llegar a conectarse", async () => {
    const resolver = async (host: string) => (host === "interno.example" ? ["93.184.216.34", "10.0.0.5"] : ["169.254.169.254"]);
    const cliente = new ClienteWebhookFetch({ permitirHttp: false, resolver });
    const m = { id: "msg_1", timestamp: 1, cuerpo: "{}", secreto: "whsec_AAAA" };
    for (const url of ["https://interno.example/h", "https://metadatos.example/h", "https://127.0.0.1/h", "https://[::1]/h", "https://[fd00::1]/h"]) {
      const r = await cliente.enviar({ ...m, url });
      expect(r, url).toEqual({ ok: false, status: null, error: expect.stringMatching(/no pública/) });
    }
    expect(await cliente.enviar({ ...m, url: "http://tienda.example/h" })).toMatchObject({ ok: false, error: expect.stringMatching(/https/) });
    const sinDns = new ClienteWebhookFetch({ permitirHttp: false, resolver: async () => { throw new Error("ENOTFOUND"); } });
    expect(await sinDns.enviar({ ...m, url: "https://no-existe.example/h" })).toMatchObject({ ok: false, error: expect.stringMatching(/resolver/) });
  });
});

describe("Firma Standard Webhooks", () => {
  it("coincide con el vector de prueba de la especificación", () => {
    // Vector publicado por Standard Webhooks / Svix.
    const secreto = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
    const firma = firmarWebhook(secreto, "msg_p5jXN8AQM9LWM0D4loKWxJek", 1614265330, '{"test": 2432232314}');
    expect(firma).toBe("v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
  });

  it("verifica (varias firmas, tolerancia de tiempo) y rechaza cuerpos o secretos alterados", () => {
    const secreto = new SecretosWebhookCrypto().generar();
    expect(secreto).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    const ts = 1_800_000_000;
    const firma = firmarWebhook(secreto, "msg_1", ts, '{"a":1}');
    const h = { id: "msg_1", timestamp: String(ts), firma: `v1,otra ${firma}` };
    expect(verificarFirmaWebhook(secreto, h, '{"a":1}', { ahoraSeg: ts + 10 })).toBe(true);
    expect(verificarFirmaWebhook(secreto, h, '{"a":2}', { ahoraSeg: ts })).toBe(false);
    expect(verificarFirmaWebhook(new SecretosWebhookCrypto().generar(), h, '{"a":1}', { ahoraSeg: ts })).toBe(false);
    expect(verificarFirmaWebhook(secreto, h, '{"a":1}', { ahoraSeg: ts + 301 })).toBe(false);
  });
});

describe("Cifrado de secretos (AES-256-GCM)", () => {
  const claveB64 = Buffer.alloc(32, 7).toString("base64");

  it("cifra y descifra; cada cifrado es distinto; otra clave o un dato alterado fallan", () => {
    const c = new CifradorAesGcm(leerClaveCifrado(claveB64));
    const a = c.cifrar("whsec_secreto");
    const b = c.cifrar("whsec_secreto");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^v1:/);
    expect(a).not.toContain("secreto");
    expect(c.descifrar(a)).toBe("whsec_secreto");
    expect(() => new CifradorAesGcm(Buffer.alloc(32, 8)).descifrar(a)).toThrow();
    const alterado = Buffer.from(a.slice(3), "base64");
    alterado[alterado.length - 1]! ^= 1;
    expect(() => c.descifrar(`v1:${alterado.toString("base64")}`)).toThrow();
  });

  it("acepta la clave en base64 o hex de 32 bytes y rechaza otras con instrucciones", () => {
    expect(leerClaveCifrado(claveB64)).toHaveLength(32);
    expect(leerClaveCifrado("ab".repeat(32))).toHaveLength(32);
    expect(() => leerClaveCifrado("corta")).toThrow(/randomBytes\(32\)/);
    expect(() => leerClaveCifrado(Buffer.alloc(16).toString("base64"))).toThrow();
  });

  it("sin clave configurada: error claro SERVICIO_NO_CONFIGURADO", () => {
    expect(() => new CifradorNoConfigurado().cifrar()).toThrow(DomainError);
    expect(() => new CifradorNoConfigurado().cifrar()).toThrow(/INTEGRACIONES_CLAVE_CIFRADO/);
  });

  it("la configuración rechaza una clave inválida al arrancar y aplica valores por defecto", () => {
    const base = { JWT_SECRET: "x".repeat(20), DB_DRIVER: "memory" };
    expect(() => cargarConfig({ ...base, INTEGRACIONES_CLAVE_CIFRADO: "no-es-una-clave" })).toThrow(/INTEGRACIONES_CLAVE_CIFRADO/);
    const c = cargarConfig({ ...base, INTEGRACIONES_CLAVE_CIFRADO: claveB64 });
    expect(c).toMatchObject({
      PUBLIC_URL: "http://localhost:5173",
      WEBHOOKS_PERMITIR_HTTP: false,
      WEBHOOKS_DESPACHADOR: true,
      WEBHOOKS_INTERVALO_SEG: 15,
    });
    expect(cargarConfig({ ...base, WEBHOOKS_PERMITIR_HTTP: "true", WEBHOOKS_DESPACHADOR: "false" })).toMatchObject({
      WEBHOOKS_PERMITIR_HTTP: true,
      WEBHOOKS_DESPACHADOR: false,
    });
  });
});

describe("Cliente de webhooks contra un servidor local", () => {
  let servidor: Server;
  let base: string;
  const recibidos: { url: string; headers: Record<string, string | string[] | undefined>; cuerpo: string }[] = [];

  beforeAll(async () => {
    servidor = createServer((req, res) => {
      let cuerpo = "";
      req.on("data", (c) => (cuerpo += c));
      req.on("end", () => {
        recibidos.push({ url: req.url ?? "", headers: req.headers, cuerpo });
        if (req.url === "/redirige") return void res.writeHead(302, { Location: "/ok" }).end();
        if (req.url === "/lento") return void setTimeout(() => res.writeHead(200).end(), 500);
        if (req.url === "/error") return void res.writeHead(500).end("falló");
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => servidor.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((r) => servidor.close(() => r())));

  it("envía firmado; 3xx cuenta como fallo y no se sigue; timeout; no 2xx", async () => {
    const secreto = new SecretosWebhookCrypto().generar();
    const cliente = new ClienteWebhookFetch({ permitirHttp: true, timeoutMs: 200 });
    const ts = Math.floor(Date.now() / 1000);
    const m = { id: "msg_abc", timestamp: ts, cuerpo: '{"type":"envio.creado"}', secreto };

    expect(await cliente.enviar({ ...m, url: `${base}/ok` })).toEqual({ ok: true, status: 204, error: null });
    const r = recibidos.at(-1)!;
    expect(r.headers["webhook-id"]).toBe("msg_abc");
    expect(r.headers["content-type"]).toBe("application/json");
    expect(
      verificarFirmaWebhook(secreto, { id: "msg_abc", timestamp: String(r.headers["webhook-timestamp"]), firma: String(r.headers["webhook-signature"]) }, r.cuerpo),
    ).toBe(true);

    const antes = recibidos.length;
    expect(await cliente.enviar({ ...m, url: `${base}/redirige` })).toEqual({ ok: false, status: 302, error: expect.stringMatching(/Redirección/) });
    expect(recibidos.length).toBe(antes + 1); // no se siguió la redirección a /ok
    expect(await cliente.enviar({ ...m, url: `${base}/lento` })).toEqual({ ok: false, status: null, error: expect.stringMatching(/Sin respuesta/) });
    expect(await cliente.enviar({ ...m, url: `${base}/error` })).toEqual({ ok: false, status: 500, error: "HTTP 500" });
    // sin WEBHOOKS_PERMITIR_HTTP un servidor local queda bloqueado
    const estricto = new ClienteWebhookFetch({ permitirHttp: false });
    expect((await estricto.enviar({ ...m, url: `${base.replace("http", "https")}/ok` })).error).toMatch(/no pública/);
  });
});
