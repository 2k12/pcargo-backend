import { randomUUID } from "node:crypto";
import type { Clock, IdGenerator } from "../../application/ports/services.js";

export class SystemClock implements Clock {
  ahora(): Date {
    return new Date();
  }
}

export class CryptoIdGenerator implements IdGenerator {
  uuid(): string {
    return randomUUID();
  }
}
