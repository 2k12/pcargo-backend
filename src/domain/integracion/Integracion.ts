import { FORMAS_PAGO, esFormaPago, type FormaPago } from "../envio/FormaPago.js";
import { DomainError } from "../shared/DomainError.js";

// Integraciones con otras empresas (contrato v10). Una integración es una empresa que ingresa envíos desde su
// sistema con API keys propias; el origen de esos envíos lo fija la key, nunca el body.

export const CANALES = ["PANEL", "API"] as const;
export type Canal = (typeof CANALES)[number];

export interface OrigenEnvio {
  canal: Canal;
  integracionId: string | null;
  /** Nombre actual de la integración (null en el panel). */
  integracion: string | null;
}

export const ORIGEN_PANEL: OrigenEnvio = { canal: "PANEL", integracionId: null, integracion: null };

export const ALCANCES = ["envios:crear", "envios:leer", "cotizar"] as const;
export type Alcance = (typeof ALCANCES)[number];
export const esAlcance = (v: unknown): v is Alcance => (ALCANCES as readonly unknown[]).includes(v);

export const MODOS_KEY = ["live", "test"] as const;
export type ModoKey = (typeof MODOS_KEY)[number];

export const EVENTOS_WEBHOOK = ["envio.creado", "envio.estado_actualizado", "envio.evidencia_registrada"] as const;
export type EventoWebhook = (typeof EVENTOS_WEBHOOK)[number];
export const esEventoWebhook = (v: unknown): v is EventoWebhook => (EVENTOS_WEBHOOK as readonly unknown[]).includes(v);

export const NOMBRE_INTEGRACION = { min: 2, max: 80 } as const;
export const NOMBRE_KEY = { min: 2, max: 60 } as const;
export const MAX_IPS_PERMITIDAS = 50;
export const MAX_URL_WEBHOOK = 2048;
export const FORMA_PAGO_INTEGRACION_DEFECTO: FormaPago = "CONTRATO";

export interface RemitenteIntegracion {
  nombre: string;
  telefono: string;
  direccion: string;
}

export interface WebhookIntegracion {
  url: string;
  eventos: EventoWebhook[];
  activo: boolean;
  /** Secreto `whsec_...` cifrado (AES-256-GCM); nunca se guarda en claro. */
  secretoCifrado: string;
  /** Primeros caracteres del secreto para reconocerlo en el panel, p. ej. "whsec_ab12". */
  secretoPrefijo: string;
}

export interface ApiKey {
  id: string;
  integracionId: string;
  nombre: string;
  modo: ModoKey;
  /** `pc_live_<8 base62>`; identifica la key sin revelar el secreto. */
  prefijo: string;
  /** SHA-256 (hex) de la key completa. */
  hash: string;
  alcances: Alcance[];
  creadaEn: Date;
  ultimoUsoEn: Date | null;
  revocadaEn: Date | null;
}

export interface Integracion {
  id: string;
  nombre: string;
  activa: boolean;
  remitente: RemitenteIntegracion;
  ciudadOrigenId: number;
  formaPagoPorDefecto: FormaPago;
  clienteId: string | null;
  /** IPv4/IPv6 o CIDR; vacía = cualquier IP. */
  ipsPermitidas: string[];
  webhook: WebhookIntegracion | null;
  creadaEn: Date;
  /** Incluye las revocadas. */
  keys: ApiKey[];
}

export interface DatosIntegracion {
  nombre: string;
  activa?: boolean;
  remitente: RemitenteIntegracion;
  ciudadOrigenId: number;
  formaPagoPorDefecto?: string;
  clienteId?: string | null;
  ipsPermitidas?: string[];
}

const TELEFONO = /^\+?[0-9 ]{7,15}$/;

const colapsar = (s: string): string => (s ?? "").trim().replace(/\s+/g, " ");

export function normalizarNombreIntegracion(nombre: string): string {
  const n = colapsar(nombre);
  if (n.length < NOMBRE_INTEGRACION.min || n.length > NOMBRE_INTEGRACION.max) {
    throw new DomainError(
      "VALIDACION",
      `El nombre de la integración debe tener entre ${NOMBRE_INTEGRACION.min} y ${NOMBRE_INTEGRACION.max} caracteres`,
    );
  }
  return n;
}

export function normalizarRemitenteIntegracion(r: RemitenteIntegracion): RemitenteIntegracion {
  const nombre = colapsar(r?.nombre);
  const telefono = (r?.telefono ?? "").trim();
  const direccion = colapsar(r?.direccion);
  if (nombre.length < 2 || nombre.length > 120) {
    throw new DomainError("VALIDACION", "El nombre del remitente debe tener entre 2 y 120 caracteres");
  }
  if (!TELEFONO.test(telefono)) throw new DomainError("VALIDACION", "El teléfono del remitente no es válido");
  if (direccion.length < 2 || direccion.length > 200) {
    throw new DomainError("VALIDACION", "La dirección del remitente debe tener entre 2 y 200 caracteres");
  }
  return { nombre, telefono, direccion };
}

export function normalizarFormaPago(forma: string | undefined): FormaPago {
  const f = forma ?? FORMA_PAGO_INTEGRACION_DEFECTO;
  if (!esFormaPago(f)) {
    throw new DomainError("VALIDACION", `Forma de pago desconocida: ${f} (use ${FORMAS_PAGO.join(", ")})`);
  }
  return f;
}

/**
 * Normaliza la lista de IPs/CIDR (sin espacios, sin repetidos). El formato de cada entrada lo valida la
 * infraestructura (`node:net`), que es la que luego compara las direcciones.
 */
export function normalizarIps(ips: string[] | undefined): string[] {
  const lista = [...new Set((ips ?? []).map((ip) => ip.trim()).filter(Boolean))];
  if (lista.length > MAX_IPS_PERMITIDAS) {
    throw new DomainError("VALIDACION", `Máximo ${MAX_IPS_PERMITIDAS} IPs o rangos permitidos`);
  }
  return lista;
}

export function normalizarNombreKey(nombre: string): string {
  const n = colapsar(nombre);
  if (n.length < NOMBRE_KEY.min || n.length > NOMBRE_KEY.max) {
    throw new DomainError("VALIDACION", `El nombre de la key debe tener entre ${NOMBRE_KEY.min} y ${NOMBRE_KEY.max} caracteres`);
  }
  return n;
}

export function normalizarAlcances(alcances: string[]): Alcance[] {
  const lista = [...new Set(alcances)];
  if (lista.length === 0) throw new DomainError("VALIDACION", "La key debe tener al menos un alcance");
  for (const a of lista) if (!esAlcance(a)) throw new DomainError("VALIDACION", `Alcance desconocido: ${a}`);
  return lista as Alcance[];
}

export function normalizarEventos(eventos: string[]): EventoWebhook[] {
  const lista = [...new Set(eventos)];
  if (lista.length === 0) throw new DomainError("VALIDACION", "El webhook debe tener al menos un evento");
  for (const e of lista) if (!esEventoWebhook(e)) throw new DomainError("VALIDACION", `Evento desconocido: ${e}`);
  return lista as EventoWebhook[];
}

/**
 * La URL del webhook debe ser https (http solo si se permite en desarrollo), sin usuario/contraseña ni fragmento.
 * El destino real (DNS → IP pública) se comprueba antes de cada envío (anti-SSRF).
 */
export function validarUrlWebhook(url: string, permitirHttp: boolean): string {
  const texto = (url ?? "").trim();
  if (texto.length === 0 || texto.length > MAX_URL_WEBHOOK) {
    throw new DomainError("VALIDACION", `La URL del webhook es obligatoria (máximo ${MAX_URL_WEBHOOK} caracteres)`);
  }
  let u: URL;
  try {
    u = new URL(texto);
  } catch {
    throw new DomainError("VALIDACION", "La URL del webhook no es válida");
  }
  if (u.protocol !== "https:" && !(permitirHttp && u.protocol === "http:")) {
    throw new DomainError("VALIDACION", "La URL del webhook debe usar https://");
  }
  if (u.username || u.password) throw new DomainError("VALIDACION", "La URL del webhook no puede incluir credenciales");
  if (u.hash) throw new DomainError("VALIDACION", "La URL del webhook no puede tener fragmento (#)");
  return u.toString();
}

/** Una key sirve si no está revocada y tiene el alcance pedido. */
export const keyActiva = (k: ApiKey): boolean => k.revocadaEn === null;

export function exigirAlcance(key: Pick<ApiKey, "alcances">, alcance: Alcance | null): void {
  if (alcance && !key.alcances.includes(alcance)) {
    throw new DomainError("ALCANCE_INSUFICIENTE", `La API key no tiene el alcance "${alcance}"`);
  }
}

/** Compara nombres de ciudad sin distinguir mayúsculas ni tildes ("QUITO" = "quito", "Cayambé" = "cayambe"). */
export const normalizarNombreCiudad = (s: string): string =>
  colapsar(s)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
