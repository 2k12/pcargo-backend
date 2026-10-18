import { digitosTelefono } from "../cliente/Cliente.js";
import { DomainError } from "../shared/DomainError.js";

// Retención y eliminación de datos personales (LOPDP, contrato v12).

export const RETENCION_MESES = { min: 12, max: 120, defecto: 12 } as const;

export function validarMesesRetencion(meses: number): number {
  if (!Number.isInteger(meses) || meses < RETENCION_MESES.min || meses > RETENCION_MESES.max) {
    throw new DomainError(
      "VALIDACION",
      `El plazo de conservación debe ser un entero entre ${RETENCION_MESES.min} y ${RETENCION_MESES.max} meses`,
    );
  }
  return meses;
}

/** Instante antes del cual un envío terminado (por `actualizadoEn`) está fuera de plazo: `ahora − meses`. */
export function fechaCorte(ahora: Date, meses: number): Date {
  const corte = new Date(ahora);
  const dia = corte.getUTCDate();
  corte.setUTCDate(1);
  corte.setUTCMonth(corte.getUTCMonth() - meses);
  // 31 de marzo − 1 mes = 28/29 de febrero (no 3 de marzo).
  const ultimoDia = new Date(Date.UTC(corte.getUTCFullYear(), corte.getUTCMonth() + 1, 0)).getUTCDate();
  corte.setUTCDate(Math.min(dia, ultimoDia));
  return corte;
}

export interface UltimaDepuracion {
  fecha: Date;
  envios: number;
  clientes: number;
  evidencias: number;
}

export interface ConfiguracionDatos {
  mesesRetencion: number;
  ultimaDepuracion: UltimaDepuracion | null;
}

export const CANALES_SOLICITUD = ["PRESENCIAL", "CORREO", "TELEFONO", "WHATSAPP"] as const;
export type CanalSolicitud = (typeof CANALES_SOLICITUD)[number];

export const NOMBRE_TITULAR = { min: 2, max: 120 } as const;
export const MAX_NOTA_SOLICITUD = 300;

export interface ResultadoSolicitud {
  envios: number;
  clientes: number;
  evidencias: number;
  usuariosDesactivados: number;
  enCurso: number;
}

/** Registro de una solicitud atendida. No guarda el teléfono completo: solo sus 4 últimos dígitos. */
export interface SolicitudDatos {
  id: string;
  tipo: "ELIMINACION";
  nombreTitular: string;
  /** "…4567" */
  telefonoFinal: string;
  canal: CanalSolicitud;
  nota: string | null;
  fecha: Date;
  atendidaPor: string;
  resultado: ResultadoSolicitud;
}

/** Dígitos de un teléfono consultado por el titular: 7 a 15. */
export function digitosTitular(telefono: string): string {
  const digitos = digitosTelefono(telefono ?? "");
  if (digitos.length < 7 || digitos.length > 15) {
    throw new DomainError("VALIDACION", "El teléfono debe tener entre 7 y 15 dígitos");
  }
  return digitos;
}

/** "…4567": lo único del teléfono que queda en el registro de la solicitud. */
export const telefonoFinal = (telefono: string): string => `…${digitosTitular(telefono).slice(-4)}`;

export interface DatosSolicitud {
  telefono: string;
  nombreTitular: string;
  canal: string;
  nota?: string | null;
}

export function normalizarSolicitud(d: DatosSolicitud): {
  digitos: string;
  nombreTitular: string;
  canal: CanalSolicitud;
  nota: string | null;
} {
  const digitos = digitosTitular(d.telefono);
  const nombreTitular = (d.nombreTitular ?? "").trim().replace(/\s+/g, " ");
  if (nombreTitular.length < NOMBRE_TITULAR.min || nombreTitular.length > NOMBRE_TITULAR.max) {
    throw new DomainError(
      "VALIDACION",
      `El nombre del titular debe tener entre ${NOMBRE_TITULAR.min} y ${NOMBRE_TITULAR.max} caracteres`,
    );
  }
  if (!(CANALES_SOLICITUD as readonly string[]).includes(d.canal)) {
    throw new DomainError("VALIDACION", `Canal desconocido: ${d.canal}`);
  }
  const nota = d.nota?.trim() || null;
  if (nota && nota.length > MAX_NOTA_SOLICITUD) {
    throw new DomainError("VALIDACION", `La nota admite hasta ${MAX_NOTA_SOLICITUD} caracteres`);
  }
  return { digitos, nombreTitular, canal: d.canal as CanalSolicitud, nota };
}
