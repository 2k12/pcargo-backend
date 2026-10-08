import type { Clock, IdGenerator, PasswordHasher } from "../../src/application/ports/services.js";
import type { Actor } from "../../src/domain/usuario/Usuario.js";
import { USUARIOS_SEED } from "../../src/infrastructure/persistence/seed-data.js";

export class FakeClock implements Clock {
  constructor(private actual = new Date("2026-10-01T12:00:00Z")) {}
  ahora(): Date {
    return new Date(this.actual);
  }
  avanzar(minutos: number): void {
    this.actual = new Date(this.actual.getTime() + minutos * 60_000);
  }
}

export class SecuenciaIds implements IdGenerator {
  private n = 0;
  constructor(private readonly codigos: string[] = []) {}
  uuid(): string {
    return `00000000-0000-4000-a000-${String(++this.n).padStart(12, "0")}`;
  }
  codigoSeguimiento(): string {
    return this.codigos.shift() ?? `PC-TEST${String(++this.n).padStart(4, "0")}`;
  }
}

/** Hasher trivial para tests de aplicación (bcrypt real se prueba en integración). */
export const hasherFalso: PasswordHasher = {
  hash: async (p) => `hash:${p}`,
  verificar: async (p, h) => h === `hash:${p}`,
};

export const ADMIN: Actor = { id: USUARIOS_SEED[0]!.id, nombre: USUARIOS_SEED[0]!.nombre, rol: "ADMIN" };
export const OPERADOR: Actor = { id: USUARIOS_SEED[1]!.id, nombre: USUARIOS_SEED[1]!.nombre, rol: "OPERADOR" };

export const solicitudEnvio = (sobrescribir: Record<string, unknown> = {}) => ({
  remitente: { nombre: "María Pérez", telefono: "0991234567" },
  destinatario: { nombre: "Juan Andrade", telefono: "0987654321", direccion: "Av. Amazonas N24-56, Quito" },
  rutaId: 11, // Ibarra → Quito (ver seed-data)
  tipoCarga: "PAQUETE",
  pesoKg: 3,
  descripcion: "Documentos y ropa",
  ...sobrescribir,
});

export const JWT_SECRET_TEST = "secreto-de-pruebas-pcargo-123";
