import { DomainError, redondear2 } from "../shared/DomainError.js";

// Catálogo configurable de tipos de carga (contrato v11). Los códigos ya no son una lista fija: los crea el ADMIN.
// Semilla: SOBRE, PAQUETE, CARTON, VALIJA, TELA, PLUMON_PEQUENO, PLUMON_GRANDE.

/** Código del tipo: único e inmutable (lo guardan los envíos). */
export type TipoCargaCodigo = string;

/** `^[A-Z][A-Z0-9_]{1,29}$`: 2 a 30 caracteres, mayúsculas, dígitos y guion bajo, empieza por letra. */
export const CODIGO_TIPO_CARGA = /^[A-Z][A-Z0-9_]{1,29}$/;
export const NOMBRE_TIPO_CARGA = { min: 2, max: 40 } as const;
/** Tope de precios (USD) y del peso máximo (kg). */
export const MAX_PRECIO_TIPO = 1000;
export const MAX_PESO_TIPO = 1000;
export const MAYOREO_MINIMO = { min: 1, max: 9999 } as const;

/** Precio por volumen: con MÁS de `minimoExclusivo` unidades del tipo en el envío, todas cuestan `precio`. */
export interface Mayoreo {
  minimoExclusivo: number;
  precio: number;
}

/** Lo que se necesita para cotizar y lo que se publica (landing, API de empresas). */
export interface TipoCargaPublico {
  codigo: TipoCargaCodigo;
  nombre: string;
  /** Precio por unidad (USD) en zona urbana. */
  precio: number;
  /** Precio por unidad en zona rural; null = el mismo que en zona urbana. */
  precioRural: number | null;
  /** Precio por volumen (no depende de la zona); null = no aplica. */
  mayoreo: Mayoreo | null;
  pesoMaxKg: number;
}

export interface TipoCarga extends TipoCargaPublico {
  /** Un tipo inactivo no se ofrece ni se puede usar en cotizaciones o envíos nuevos. */
  activo: boolean;
  /** Orden de presentación. */
  orden: number;
  actualizadoEn: Date | null;
  /** Nombre del usuario que hizo el último cambio. */
  actualizadoPor: string | null;
}

/** Datos editables por el ADMIN (todo salvo el código, el orden y la auditoría). */
export interface DatosTipoCarga {
  nombre: string;
  precio: number;
  precioRural: number | null;
  mayoreo: Mayoreo | null;
  pesoMaxKg: number;
  activo?: boolean;
}

export const aTipoCargaPublico = (t: TipoCargaPublico): TipoCargaPublico => ({
  codigo: t.codigo,
  nombre: t.nombre,
  precio: t.precio,
  precioRural: t.precioRural,
  mayoreo: t.mayoreo ? { minimoExclusivo: t.mayoreo.minimoExclusivo, precio: t.mayoreo.precio } : null,
  pesoMaxKg: t.pesoMaxKg,
});

const invalido = (mensaje: string) => new DomainError("VALIDACION", mensaje);

/** ¿Tiene como máximo 2 decimales? (tolera el error de representación binaria de 0.1, 1.15, …). */
const dosDecimales = (n: number): boolean => Math.abs(redondear2(n) - n) < 1e-9;

/** > 0, ≤ máximo y con 2 decimales como máximo. Devuelve el valor redondeado a 2 decimales. */
function validarMonto(valor: unknown, campo: string, max: number): number {
  if (typeof valor !== "number" || !Number.isFinite(valor) || valor <= 0 || valor > max) {
    throw invalido(`${campo}: debe ser mayor que 0 y como máximo ${max}`);
  }
  if (!dosDecimales(valor)) throw invalido(`${campo}: use como máximo 2 decimales`);
  return redondear2(valor);
}

export function validarCodigoTipoCarga(codigo: unknown): TipoCargaCodigo {
  if (typeof codigo !== "string" || !CODIGO_TIPO_CARGA.test(codigo)) {
    throw invalido("codigo: 2 a 30 caracteres en MAYÚSCULAS, dígitos o _, empezando por una letra (p. ej. CAJA_GRANDE)");
  }
  return codigo;
}

/**
 * Valida y normaliza los datos de un tipo de carga (nombre sin espacios sobrantes, montos a 2 decimales).
 * Reglas del contrato v11: precios > 0 y ≤ 1000; `mayoreo.minimoExclusivo` entero 1–9999 y `mayoreo.precio` menor
 * que `precio`; `pesoMaxKg` > 0 y ≤ 1000.
 */
export function normalizarDatosTipoCarga(d: DatosTipoCarga): Required<DatosTipoCarga> {
  const nombre = typeof d.nombre === "string" ? d.nombre.trim().replace(/\s+/g, " ") : "";
  if (nombre.length < NOMBRE_TIPO_CARGA.min || nombre.length > NOMBRE_TIPO_CARGA.max) {
    throw invalido(`nombre: de ${NOMBRE_TIPO_CARGA.min} a ${NOMBRE_TIPO_CARGA.max} caracteres`);
  }
  const precio = validarMonto(d.precio, "precio", MAX_PRECIO_TIPO);
  const precioRural =
    d.precioRural === null || d.precioRural === undefined ? null : validarMonto(d.precioRural, "precioRural", MAX_PRECIO_TIPO);
  let mayoreo: Mayoreo | null = null;
  if (d.mayoreo !== null && d.mayoreo !== undefined) {
    const { minimoExclusivo } = d.mayoreo;
    if (
      typeof minimoExclusivo !== "number" ||
      !Number.isInteger(minimoExclusivo) ||
      minimoExclusivo < MAYOREO_MINIMO.min ||
      minimoExclusivo > MAYOREO_MINIMO.max
    ) {
      throw invalido(`mayoreo.minimoExclusivo: entero de ${MAYOREO_MINIMO.min} a ${MAYOREO_MINIMO.max}`);
    }
    const precioMayoreo = validarMonto(d.mayoreo.precio, "mayoreo.precio", MAX_PRECIO_TIPO);
    if (precioMayoreo >= precio) throw invalido("mayoreo.precio: debe ser menor que el precio por unidad");
    mayoreo = { minimoExclusivo, precio: precioMayoreo };
  }
  const pesoMaxKg = validarMonto(d.pesoMaxKg, "pesoMaxKg", MAX_PESO_TIPO);
  if (d.activo !== undefined && typeof d.activo !== "boolean") throw invalido("activo: debe ser true o false");
  return { nombre, precio, precioRural, mayoreo, pesoMaxKg, activo: d.activo ?? true };
}

/**
 * Tipo que se puede usar en una cotización o un envío nuevo. Código inexistente → 422 VALIDACION;
 * inactivo → 422 TIPO_CARGA_INACTIVO.
 */
export function exigirTipoUsable(tipo: TipoCarga | null | undefined, codigo: string): TipoCarga {
  if (!tipo) throw new DomainError("VALIDACION", `Tipo de carga desconocido: ${codigo}`, { regla: true });
  if (!tipo.activo) {
    throw new DomainError("TIPO_CARGA_INACTIVO", `${tipo.nombre} (${tipo.codigo}) no está disponible por ahora`);
  }
  return tipo;
}

/** Debe quedar al menos un tipo activo en el catálogo. */
export function exigirAlgunoActivo(tipos: Pick<TipoCarga, "activo">[]): void {
  if (!tipos.some((t) => t.activo)) {
    throw new DomainError("CONFLICTO", "Debe quedar al menos un tipo de carga activo");
  }
}

// ── Historial de cambios ─────────────────────────────────────────────────────

export const ACCIONES_TIPO_CARGA = ["CREADO", "MODIFICADO", "ACTIVADO", "DESACTIVADO", "ELIMINADO"] as const;
export type AccionTipoCarga = (typeof ACCIONES_TIPO_CARGA)[number];

export interface CambioCampo {
  campo: string;
  antes: unknown;
  despues: unknown;
}

export interface CambioTipoCarga {
  id: string;
  codigo: TipoCargaCodigo;
  fecha: Date;
  usuarioId: string | null;
  /** Nombre del usuario en el momento del cambio. */
  usuario: string | null;
  accion: AccionTipoCarga;
  cambios: CambioCampo[];
}

/** Campos que se comparan en el historial, en este orden. */
const CAMPOS_HISTORIAL = ["nombre", "precio", "precioRural", "mayoreo", "pesoMaxKg", "activo", "orden"] as const;

const valorCampo = (t: TipoCarga, campo: (typeof CAMPOS_HISTORIAL)[number]): unknown =>
  campo === "mayoreo" ? (t.mayoreo ? { ...t.mayoreo } : null) : t[campo];

const iguales = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Diferencias campo a campo. `antes = null` (alta) lista todos los campos con `antes: null`;
 * `despues = null` (eliminación) los lista con `despues: null`.
 */
export function diferenciasTipoCarga(antes: TipoCarga | null, despues: TipoCarga | null): CambioCampo[] {
  const cambios: CambioCampo[] = [];
  for (const campo of CAMPOS_HISTORIAL) {
    const a = antes ? valorCampo(antes, campo) : null;
    const d = despues ? valorCampo(despues, campo) : null;
    if (!iguales(a, d)) cambios.push({ campo, antes: a, despues: d });
  }
  return cambios;
}

/** ACTIVADO/DESACTIVADO si solo cambió `activo`; si cambió algo más, MODIFICADO. */
export function accionDeCambios(cambios: CambioCampo[]): AccionTipoCarga {
  const activo = cambios.find((c) => c.campo === "activo");
  if (activo && cambios.length === 1) return activo.despues ? "ACTIVADO" : "DESACTIVADO";
  return "MODIFICADO";
}

export function validarPeso(tipo: TipoCargaPublico, pesoKg: number): void {
  if (!Number.isFinite(pesoKg) || pesoKg <= 0) {
    throw new DomainError("PESO_INVALIDO", "El peso debe ser mayor a 0 kg");
  }
  if (pesoKg > tipo.pesoMaxKg) {
    throw new DomainError(
      "PESO_INVALIDO",
      `${tipo.nombre}: peso máximo permitido ${tipo.pesoMaxKg} kg`,
    );
  }
}
