import { randomInt, randomUUID } from "node:crypto";
import type { Clock, IdGenerator } from "../../application/ports/services.js";
import { generarCodigoSeguimiento } from "../../domain/envio/CodigoSeguimiento.js";

export class SystemClock implements Clock {
  ahora(): Date {
    return new Date();
  }
}

export class CryptoIdGenerator implements IdGenerator {
  uuid(): string {
    return randomUUID();
  }
  codigoSeguimiento(): string {
    return generarCodigoSeguimiento(() => randomInt(0, 1_000_000) / 1_000_000);
  }
}
