import type { Envio } from "../../../domain/envio/Envio.js";
import type { EventoWebhook } from "../../../domain/integracion/Integracion.js";
import type { EntregaWebhook } from "../../../domain/integracion/Webhook.js";
import type { Ruta } from "../../../domain/ruta/Ruta.js";
import { toEnvioApiDTO, type EnvioApiDTO } from "../../dto/IntegracionDTO.js";
import type { IntegracionRepository } from "../../ports/integraciones.js";
import type { Clock, IdGenerator } from "../../ports/services.js";

export interface CuerpoWebhook {
  type: EventoWebhook;
  timestamp: string;
  data: EnvioApiDTO | (Record<string, unknown> & { prueba: true });
}

/** `msg_<32 hex>`: identificador del mensaje (header `webhook-id`), igual en todos los reintentos. */
export const nuevoMensajeId = (ids: IdGenerator): string => `msg_${ids.uuid().replace(/-/g, "")}`;

/**
 * Decide qué webhooks dispara un cambio de un envío y arma las entregas (outbox). Solo los envíos de una
 * integración con webhook activo suscrito al evento generan entregas; el cuerpo se congela al encolar.
 */
export class EmisorWebhooks {
  constructor(
    private readonly integraciones: IntegracionRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly publicUrl: string,
  ) {}

  async entregasPara(envio: Envio, ruta: Ruta | undefined, evento: EventoWebhook): Promise<EntregaWebhook[]> {
    const integracionId = envio.integracionId;
    if (!integracionId) return [];
    const integracion = await this.integraciones.buscarPorId(integracionId);
    const webhook = integracion?.webhook;
    if (!webhook?.activo || !webhook.eventos.includes(evento)) return [];
    const ahora = this.clock.ahora();
    const cuerpo: CuerpoWebhook = {
      type: evento,
      timestamp: ahora.toISOString(),
      data: toEnvioApiDTO(envio, ruta, { publicUrl: this.publicUrl, conHistorial: true }),
    };
    return [
      {
        id: this.ids.uuid(),
        integracionId,
        mensajeId: nuevoMensajeId(this.ids),
        evento,
        envioId: envio.id,
        numeroGuia: envio.numeroGuia,
        cuerpo: JSON.stringify(cuerpo),
        prueba: false,
        estado: "PENDIENTE",
        intentos: 0,
        ultimoStatus: null,
        ultimoError: null,
        proximoIntentoEn: ahora,
        creadoEn: ahora,
        entregadoEn: null,
      },
    ];
  }
}
