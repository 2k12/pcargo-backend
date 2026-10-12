import { BlockList, isIP } from "node:net";

// Direcciones IP y rangos CIDR (IPv4/IPv6) con node:net BlockList: lista de IPs permitidas por integración
// y bloqueo de destinos privados para los webhooks (anti-SSRF).

type Familia = "ipv4" | "ipv6";

/** "::ffff:10.0.0.1" (IPv4 mapeada en IPv6, como la reporta Node en sockets dual-stack) → "10.0.0.1". */
export function normalizarIp(ip: string): string {
  const t = ip.trim().replace(/^\[|\]$/g, "");
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(t);
  return m ? m[1]! : t;
}

const familia = (ip: string): Familia | null => {
  const v = isIP(ip);
  return v === 4 ? "ipv4" : v === 6 ? "ipv6" : null;
};

interface Entrada {
  ip: string;
  prefijo: number | null;
  familia: Familia;
}

/** Interpreta "203.0.113.7", "203.0.113.0/24", "2001:db8::1" o "2001:db8::/32"; null si no es válida. */
export function parsearIpOCidr(texto: string): Entrada | null {
  const [ipTexto, prefijoTexto, ...resto] = texto.trim().split("/");
  if (resto.length || !ipTexto) return null;
  const ip = normalizarIp(ipTexto);
  const f = familia(ip);
  if (!f) return null;
  if (prefijoTexto === undefined) return { ip, prefijo: null, familia: f };
  if (!/^\d{1,3}$/.test(prefijoTexto)) return null;
  const prefijo = Number(prefijoTexto);
  if (prefijo > (f === "ipv4" ? 32 : 128)) return null;
  return { ip, prefijo, familia: f };
}

export const esIpOCidrValido = (texto: string): boolean => parsearIpOCidr(texto) !== null;

function crearLista(entradas: string[]): BlockList {
  const lista = new BlockList();
  for (const texto of entradas) {
    const e = parsearIpOCidr(texto);
    if (!e) continue;
    if (e.prefijo === null) lista.addAddress(e.ip, e.familia);
    else lista.addSubnet(e.ip, e.prefijo, e.familia);
  }
  return lista;
}

const cacheListas = new Map<string, BlockList>();

/** ¿`ip` está en la lista? Lista vacía = cualquier IP. */
export function ipPermitida(ip: string | undefined, permitidas: string[]): boolean {
  if (permitidas.length === 0) return true;
  if (!ip) return false;
  const normal = normalizarIp(ip);
  const f = familia(normal);
  if (!f) return false;
  const clave = permitidas.join(",");
  let lista = cacheListas.get(clave);
  if (!lista) {
    if (cacheListas.size > 500) cacheListas.clear();
    lista = crearLista(permitidas);
    cacheListas.set(clave, lista);
  }
  return lista.check(normal, f);
}

/**
 * Rangos que un webhook nunca debe alcanzar: privados, loopback, link-local (incluye 169.254.169.254, metadatos
 * de la nube), CGNAT, multicast, reservados y de documentación, en IPv4 e IPv6 (fc00::/7 incluye fd00::/8).
 */
const RANGOS_NO_PUBLICOS: [string, number, Familia][] = [
  ["0.0.0.0", 8, "ipv4"],
  ["10.0.0.0", 8, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["169.254.0.0", 16, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.0.0.0", 24, "ipv4"],
  ["192.0.2.0", 24, "ipv4"],
  ["192.88.99.0", 24, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["198.18.0.0", 15, "ipv4"],
  ["198.51.100.0", 24, "ipv4"],
  ["203.0.113.0", 24, "ipv4"],
  ["224.0.0.0", 4, "ipv4"],
  ["240.0.0.0", 4, "ipv4"],
  ["::", 128, "ipv6"],
  ["::1", 128, "ipv6"],
  ["::ffff:0:0", 96, "ipv6"],
  ["64:ff9b::", 96, "ipv6"],
  ["64:ff9b:1::", 48, "ipv6"],
  ["100::", 64, "ipv6"],
  ["2001::", 23, "ipv6"],
  ["2001:db8::", 32, "ipv6"],
  ["2002::", 16, "ipv6"],
  ["fc00::", 7, "ipv6"],
  ["fe80::", 10, "ipv6"],
  ["fec0::", 10, "ipv6"],
  ["ff00::", 8, "ipv6"],
];

/**
 * Una lista por familia: BlockList compara las IPv4 también contra las reglas IPv6 que las contienen
 * (p. ej. ::ffff:0:0/96 abarca TODAS las IPv4), así que mezclar familias bloquearía cualquier IPv4.
 */
const NO_PUBLICAS: Record<Familia, BlockList> = { ipv4: new BlockList(), ipv6: new BlockList() };
for (const [ip, prefijo, f] of RANGOS_NO_PUBLICOS) NO_PUBLICAS[f].addSubnet(ip, prefijo, f);

/** ¿Es una dirección pública enrutable en internet? (las IPv4 mapeadas en IPv6 se evalúan como IPv4). */
export function esIpPublica(ip: string): boolean {
  const normal = normalizarIp(ip);
  const f = familia(normal);
  if (!f) return false;
  return !NO_PUBLICAS[f].check(normal, f);
}
