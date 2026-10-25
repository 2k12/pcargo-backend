import { DomainError } from "../shared/DomainError.js";

// Evidencia de entrega (contrato v9): foto de la parte de la guía firmada por quien recibe + su nombre.
// v19: por partes. El nombre y la foto se cargan juntos o por separado; al menos uno existe si hay evidencia.

export const TIPOS_IMAGEN = ["image/jpeg", "image/png", "image/webp"] as const;
export type TipoImagen = (typeof TIPOS_IMAGEN)[number];

/** Tamaño máximo de la foto: 5 MB. */
export const MAX_BYTES_EVIDENCIA = 5 * 1024 * 1024;
export const RECIBIDO_POR = { min: 2, max: 120 } as const;

export const EXTENSION_IMAGEN: Record<TipoImagen, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export interface EvidenciaEntrega {
  /** Nombre de quien recibió el envío (`null` si aún no se cargó). */
  recibidoPor: string | null;
  /** Tipo de la foto (`null` si solo hay nombre). */
  tipo: TipoImagen | null;
  /** Tamaño de la foto (`null` si solo hay nombre). */
  bytes: number | null;
  /** Última modificación. */
  subidaEn: Date;
  /** Operador de la última modificación. */
  subidaPor: { id: string; nombre: string } | null;
  /** Clave del archivo en el almacén privado (`null` si solo hay nombre). Nunca sale en la API. */
  clave: string | null;
}

/** Foto ya validada y con su clave en el almacén. */
export interface FotoEvidencia {
  tipo: TipoImagen;
  bytes: number;
  clave: string;
}

const empiezaCon = (b: Uint8Array, firma: number[], desde = 0): boolean =>
  b.length >= desde + firma.length && firma.every((x, i) => b[desde + i] === x);

/**
 * Tipo real de la imagen según sus bytes mágicos (no se confía en la cabecera Content-Type).
 * JPEG: FF D8 FF · PNG: 89 50 4E 47 0D 0A 1A 0A · WebP: "RIFF" ???? "WEBP".
 */
export function detectarTipoImagen(b: Uint8Array): TipoImagen | null {
  if (empiezaCon(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (empiezaCon(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (empiezaCon(b, [0x52, 0x49, 0x46, 0x46]) && empiezaCon(b, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
}

/** Valida la foto (presencia, tamaño y tipo por contenido) y devuelve su tipo. */
export function validarFotoEvidencia(bytes: Uint8Array | null | undefined): TipoImagen {
  if (!bytes || bytes.length === 0) throw new DomainError("VALIDACION", "Debe adjuntar la foto de la guía firmada");
  if (bytes.length > MAX_BYTES_EVIDENCIA) {
    throw new DomainError("VALIDACION", "La foto no puede pesar más de 5 MB");
  }
  const tipo = detectarTipoImagen(bytes);
  if (!tipo) throw new DomainError("VALIDACION", "La foto debe ser una imagen JPEG, PNG o WebP");
  return tipo;
}

/** Nombre de quien recibió: 2–120 caracteres (espacios colapsados). */
export function normalizarRecibidoPor(nombre: string | null | undefined): string {
  const limpio = (nombre ?? "").trim().replace(/\s+/g, " ");
  if (limpio.length < RECIBIDO_POR.min || limpio.length > RECIBIDO_POR.max) {
    throw new DomainError(
      "VALIDACION",
      `El nombre de quien recibió debe tener entre ${RECIBIDO_POR.min} y ${RECIBIDO_POR.max} caracteres`,
    );
  }
  return limpio;
}

/** Clave en el almacén: `evidencias/<envioId>/<uuid>.<ext>`. */
export const claveEvidencia = (envioId: string, uuid: string, tipo: TipoImagen): string =>
  `evidencias/${envioId}/${uuid}.${EXTENSION_IMAGEN[tipo]}`;
