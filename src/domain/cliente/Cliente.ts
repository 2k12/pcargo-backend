import { DomainError } from "../shared/DomainError.js";

/** Cliente frecuente: alguien con quien ya se trabaja y que se reutiliza al registrar envíos. */
export interface Cliente {
  id: string;
  nombre: string;
  telefono: string;
  /** Dirección habitual (se usa para autocompletar cuando el cliente es el destinatario). */
  direccion: string | null;
  notas: string | null;
  creadoEn: Date;
}

export interface DatosCliente {
  nombre: string;
  telefono: string;
  direccion?: string | null;
  notas?: string | null;
}

const TELEFONO = /^\+?[0-9 ]{7,15}$/;

/** Solo los dígitos: "099 123 4567" y "0991234567" son el mismo teléfono (identifica al cliente). */
export const digitosTelefono = (telefono: string): string => telefono.replace(/\D/g, "");

const opcional = (v: string | null | undefined): string | null => v?.trim() || null;

/** Valida y limpia los datos de un cliente. */
export function normalizarCliente(d: DatosCliente): Required<DatosCliente> {
  const nombre = d.nombre?.trim().replace(/\s+/g, " ") ?? "";
  if (nombre.length < 2) throw new DomainError("VALIDACION", "El nombre del cliente es obligatorio");
  if (nombre.length > 120) throw new DomainError("VALIDACION", "El nombre del cliente es demasiado largo");
  const telefono = d.telefono?.trim().replace(/[-\s]+/g, " ") ?? "";
  if (!TELEFONO.test(telefono)) throw new DomainError("VALIDACION", "El teléfono del cliente no es válido");
  return { nombre, telefono, direccion: opcional(d.direccion), notas: opcional(d.notas) };
}
