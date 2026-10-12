import type { ApiKey, Integracion, ModoKey } from "../../domain/integracion/Integracion.js";
import type { RespuestaGuardada, ResultadoReserva } from "../../domain/integracion/Idempotencia.js";
import type { EntregaWebhook, EstadoEntrega, ResultadoEnvioWebhook } from "../../domain/integracion/Webhook.js";
import type { Paginacion } from "./repositories.js";

// Puertos del módulo de integraciones con otras empresas (contrato v10).

export interface IntegracionRepository {
  /** Ordenadas por nombre, con sus keys (incluidas las revocadas). */
  listar(): Promise<Integracion[]>;
  buscarPorId(id: string): Promise<Integracion | null>;
  /** Sin distinguir mayúsculas; `excluirId` permite conservar el propio nombre. */
  existeNombre(nombre: string, excluirId?: string): Promise<boolean>;
  /** Alta o actualización de los datos y el webhook (las keys se gestionan aparte). Nombre repetido → CONFLICTO. */
  guardar(integracion: Integracion): Promise<void>;
  /** Borra la integración con sus keys, auditoría, idempotencia y entregas. */
  eliminar(id: string): Promise<void>;
  crearKey(key: ApiKey): Promise<void>;
  /** Marca la key como revocada (si no lo estaba). `false` si no existe en esa integración. */
  revocarKey(integracionId: string, keyId: string, fecha: Date): Promise<boolean>;
  /** Key por su prefijo público (`pc_live_Ab3dE6gH`), con su integración. */
  buscarPorPrefijoKey(prefijo: string): Promise<{ key: ApiKey; integracion: Integracion } | null>;
  registrarUsoKey(keyId: string, fecha: Date): Promise<void>;
}

export interface FiltroEntregas {
  estado?: EstadoEntrega;
}

export interface EntregaWebhookRepository {
  /** Encola entregas fuera de una transacción de envío (p. ej. el evento de prueba). */
  crear(entrega: EntregaWebhook): Promise<void>;
  /** Guarda estado, intentos y resultado tras un intento; libera el bloqueo. */
  actualizar(entrega: EntregaWebhook): Promise<void>;
  buscarPorId(integracionId: string, id: string): Promise<EntregaWebhook | null>;
  /** Recientes primero (orden estable por id). */
  listarPagina(integracionId: string, filtro: FiltroEntregas, p: Paginacion): Promise<{ entregas: EntregaWebhook[]; total: number }>;
  /**
   * Reserva hasta `limite` entregas PENDIENTES vencidas (`proximoIntentoEn <= ahora`) para un despachador,
   * bloqueándolas hasta `bloqueoHasta` para que otro proceso no las tome a la vez.
   */
  tomarPendientes(ahora: Date, limite: number, bloqueoHasta: Date): Promise<EntregaWebhook[]>;
}

export interface SolicitudApi {
  id: string;
  integracionId: string | null;
  fecha: Date;
  metodo: string;
  ruta: string;
  status: number;
  ip: string;
  keyPrefijo: string | null;
  idempotencyKey: string | null;
  referenciaExterna: string | null;
  duracionMs: number;
  requestId: string;
}

export interface SolicitudApiRepository {
  registrar(s: SolicitudApi): Promise<void>;
  /** Recientes primero. */
  listarPagina(integracionId: string, p: Paginacion): Promise<{ solicitudes: SolicitudApi[]; total: number }>;
  /** Borra las anteriores a `fecha`; devuelve cuántas. */
  purgarAnteriores(fecha: Date): Promise<number>;
}

export interface ClaveIdempotencia {
  integracionId: string;
  /** Las keys de prueba y las reales no comparten respuestas. */
  modo: ModoKey;
  clave: string;
}

export interface IdempotenciaRepository {
  /**
   * Reserva la clave de forma atómica. Si ya existía y sigue vigente: misma huella → la respuesta guardada
   * (o "en_proceso" si aún no termina); otra huella → "conflicto". Si estaba vencida o abandonada se reutiliza.
   */
  reservar(
    c: ClaveIdempotencia,
    huella: string,
    ahora: Date,
    limites: { vigenteDesde: Date; abandonadaAntesDe: Date },
  ): Promise<ResultadoReserva>;
  completar(c: ClaveIdempotencia, respuesta: RespuestaGuardada, ahora: Date): Promise<void>;
  /** Libera una reserva cuya solicitud falló por un error inesperado (se puede reintentar con la misma clave). */
  liberar(c: ClaveIdempotencia): Promise<void>;
  purgarAnteriores(fecha: Date): Promise<number>;
}

// ── Servicios ────────────────────────────────────────────────────────────────

export interface ApiKeyGenerada {
  /** La key completa: se muestra una sola vez. */
  key: string;
  prefijo: string;
  hash: string;
}

export interface ServicioApiKeys {
  generar(modo: ModoKey): ApiKeyGenerada;
  hashear(key: string): string;
  /** Comparación en tiempo constante de dos hashes. */
  coinciden(hashA: string, hashB: string): boolean;
}

/** Cifrado simétrico autenticado de secretos en reposo (secretos de webhooks). */
export interface CifradorSecretos {
  /** Lanza DomainError("SERVICIO_NO_CONFIGURADO") si el servidor no tiene clave de cifrado. */
  cifrar(texto: string): string;
  descifrar(cifrado: string): string;
}

export interface ServicioSecretosWebhook {
  /** `whsec_<base64 de 32 bytes aleatorios>`. */
  generar(): string;
}

export interface MensajeWebhook {
  url: string;
  /** `webhook-id`. */
  id: string;
  /** `webhook-timestamp` (segundos Unix). */
  timestamp: number;
  cuerpo: string;
  /** Secreto en claro (`whsec_...`) con que se firma. */
  secreto: string;
}

/** Envía un webhook firmado. Nunca lanza: los fallos (red, SSRF, timeout, no 2xx) vienen en el resultado. */
export interface ClienteWebhook {
  enviar(m: MensajeWebhook): Promise<ResultadoEnvioWebhook>;
}
