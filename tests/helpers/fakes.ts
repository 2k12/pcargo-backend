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
  uuid(): string {
    return `00000000-0000-4000-a000-${String(++this.n).padStart(12, "0")}`;
  }
}

/** Hasher trivial para tests de aplicación (bcrypt real se prueba en integración). */
export const hasherFalso: PasswordHasher = {
  hash: async (p) => `hash:${p}`,
  verificar: async (p, h) => h === `hash:${p}`,
};

export const ADMIN: Actor = { id: USUARIOS_SEED[0]!.id, nombre: USUARIOS_SEED[0]!.nombre, rol: "ADMIN" };
export const OPERADOR: Actor = { id: USUARIOS_SEED[1]!.id, nombre: USUARIOS_SEED[1]!.nombre, rol: "OPERADOR" };
/** v12: repartidor y usuario del portal semilla (vinculado a «Textiles Atuntaqui»). */
export const REPARTIDOR: Actor = { id: USUARIOS_SEED[2]!.id, nombre: USUARIOS_SEED[2]!.nombre, rol: "REPARTIDOR" };
export const PORTAL: Actor = {
  id: USUARIOS_SEED[3]!.id,
  nombre: USUARIOS_SEED[3]!.nombre,
  rol: "CLIENTE",
  clienteId: USUARIOS_SEED[3]!.clienteId,
};

export const solicitudEnvio = (sobrescribir: Record<string, unknown> = {}) => ({
  remitente: { nombre: "María Pérez", telefono: "0991234567" },
  destinatario: { nombre: "Juan Andrade", telefono: "0987654321", direccion: "Av. Amazonas N24-56, Quito" },
  rutaId: 11, // Ibarra → Quito (ver seed-data)
  items: [{ tipoCarga: "PAQUETE", cantidad: 1, pesoKg: 3 }],
  formaPago: "PAGADO",
  descripcion: "Documentos y ropa",
  ...sobrescribir,
});

export const JWT_SECRET_TEST = "secreto-de-pruebas-pcargo-123";

/** Atajo para una solicitud de un solo ítem. */
export const item = (tipoCarga: string, pesoKg: number, cantidad = 1) => ({ items: [{ tipoCarga, cantidad, pesoKg }] });

/** Bytes mínimos con la firma (bytes mágicos) de cada formato, más un relleno. */
export const IMAGENES = {
  jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]),
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]),
  webp: Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x1a, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(6)]),
  /** Un PDF con extensión de imagen: el tipo se valida por contenido. */
  falsa: Buffer.from("%PDF-1.7\n%âãÏÓ\n1 0 obj"),
};
