import { VIGENCIA_IDEMPOTENCIA_MS } from "../../../domain/integracion/Idempotencia.js";
import {
  recortarError,
  registrarIntento,
  type EntregaWebhook,
  type ResultadoEnvioWebhook,
} from "../../../domain/integracion/Webhook.js";
import type {
  CifradorSecretos,
  ClienteWebhook,
  EntregaWebhookRepository,
  IdempotenciaRepository,
  IntegracionRepository,
  SolicitudApiRepository,
} from "../../ports/integraciones.js";
import type { Clock } from "../../ports/services.js";

export interface DependenciasEntrega {
  integraciones: IntegracionRepository;
  entregas: EntregaWebhookRepository;
  cliente: ClienteWebhook;
  cifrador: CifradorSecretos;
  clock: Clock;
}

/**
 * Un intento de entrega: firma con el secreto ACTUAL del webhook y envía a su URL actual. Si el webhook ya no
 * existe (o está inactivo, salvo en el evento de prueba) la entrega queda FALLIDO sin más reintentos.
 */
export async function intentarEntrega(e: EntregaWebhook, d: DependenciasEntrega): Promise<EntregaWebhook> {
  const webhook = (await d.integraciones.buscarPorId(e.integracionId))?.webhook ?? null;
  const ahora = d.clock.ahora();
  let resultado: ResultadoEnvioWebhook;
  let definitivo = false;
  if (!webhook || (!webhook.activo && !e.prueba)) {
    resultado = { ok: false, status: null, error: "El webhook de la integración fue eliminado o desactivado" };
    definitivo = true;
  } else {
    let secreto: string | null = null;
    try {
      secreto = d.cifrador.descifrar(webhook.secretoCifrado);
    } catch (err) {
      resultado = { ok: false, status: null, error: `No se pudo descifrar el secreto: ${(err as Error).message}` };
    }
    resultado ??= await d.cliente.enviar({
      url: webhook.url,
      id: e.mensajeId,
      timestamp: Math.floor(ahora.getTime() / 1000),
      cuerpo: e.cuerpo,
      secreto: secreto!,
    });
  }
  const r = { ...resultado, error: resultado.error && recortarError(resultado.error) };
  let nueva = registrarIntento(e, r, ahora);
  if (definitivo && nueva.estado === "PENDIENTE") nueva = { ...nueva, estado: "FALLIDO", proximoIntentoEn: null };
  await d.entregas.actualizar(nueva);
  return nueva;
}

/** Envía las entregas pendientes vencidas. Lo invoca el despachador periódico (nunca corre solo en los tests). */
export class DespacharWebhooks {
  constructor(
    private readonly d: DependenciasEntrega,
    private readonly opciones: { lote?: number; bloqueoMs?: number } = {},
  ) {}

  /** Devuelve cuántas entregas intentó. */
  async ejecutar(): Promise<number> {
    const ahora = this.d.clock.ahora();
    const lote = this.opciones.lote ?? 20;
    // El bloqueo cubre el peor caso del lote (10 s por envío, en paralelo) con margen.
    const bloqueoHasta = new Date(ahora.getTime() + (this.opciones.bloqueoMs ?? 2 * 60_000));
    const pendientes = await this.d.entregas.tomarPendientes(ahora, lote, bloqueoHasta);
    await Promise.allSettled(pendientes.map((e) => intentarEntrega(e, this.d)));
    return pendientes.length;
  }
}

export const RETENCION_AUDITORIA_MS = 90 * 24 * 60 * 60 * 1000;

/** Purga la auditoría de más de 90 días y las claves de idempotencia vencidas (24 h). */
export class PurgarRegistrosApi {
  constructor(
    private readonly solicitudes: SolicitudApiRepository,
    private readonly idempotencia: IdempotenciaRepository,
    private readonly clock: Clock,
  ) {}

  async ejecutar(): Promise<{ solicitudes: number; idempotencia: number }> {
    const ahora = this.clock.ahora().getTime();
    const [solicitudes, idempotencia] = await Promise.all([
      this.solicitudes.purgarAnteriores(new Date(ahora - RETENCION_AUDITORIA_MS)),
      this.idempotencia.purgarAnteriores(new Date(ahora - VIGENCIA_IDEMPOTENCIA_MS)),
    ]);
    return { solicitudes, idempotencia };
  }
}
