import {
  ABANDONO_IDEMPOTENCIA_MS,
  VIGENCIA_IDEMPOTENCIA_MS,
  type RespuestaGuardada,
} from "../../../domain/integracion/Idempotencia.js";
import { DomainError } from "../../../domain/shared/DomainError.js";
import type { ClaveIdempotencia, IdempotenciaRepository } from "../../ports/integraciones.js";
import type { Clock } from "../../ports/services.js";

/**
 * Ejecuta una operación una sola vez por (integración, modo, Idempotency-Key):
 * - primera vez → ejecuta y guarda la respuesta (incluidas las de error de negocio);
 * - misma clave y misma huella en 24 h → devuelve la respuesta guardada sin ejecutar nada;
 * - misma clave con otra huella → 422 IDEMPOTENCIA_CONFLICTO; mientras la primera sigue → 409 IDEMPOTENCIA_EN_PROCESO.
 * Si la operación falla con un error inesperado se libera la clave para poder reintentar.
 */
export class EjecutarIdempotente {
  constructor(
    private readonly repo: IdempotenciaRepository,
    private readonly clock: Clock,
  ) {}

  async ejecutar(
    clave: ClaveIdempotencia,
    huella: string,
    procesar: () => Promise<RespuestaGuardada>,
  ): Promise<{ respuesta: RespuestaGuardada; repetida: boolean }> {
    const ahora = this.clock.ahora();
    const reserva = await this.repo.reservar(clave, huella, ahora, {
      vigenteDesde: new Date(ahora.getTime() - VIGENCIA_IDEMPOTENCIA_MS),
      abandonadaAntesDe: new Date(ahora.getTime() - ABANDONO_IDEMPOTENCIA_MS),
    });
    switch (reserva.tipo) {
      case "repetida":
        return { respuesta: reserva.respuesta, repetida: true };
      case "conflicto":
        throw new DomainError(
          "IDEMPOTENCIA_CONFLICTO",
          "Esta Idempotency-Key ya se usó con un cuerpo distinto; use una clave nueva para otra solicitud",
        );
      case "en_proceso":
        throw new DomainError("IDEMPOTENCIA_EN_PROCESO", "Una solicitud con esta Idempotency-Key aún está en proceso");
      case "nueva":
        break;
    }
    let respuesta: RespuestaGuardada;
    try {
      respuesta = await procesar();
    } catch (e) {
      await this.repo.liberar(clave).catch(() => undefined);
      throw e;
    }
    await this.repo.completar(clave, respuesta, this.clock.ahora());
    return { respuesta, repetida: false };
  }
}
