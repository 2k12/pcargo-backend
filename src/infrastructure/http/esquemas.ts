import { z } from "zod";
import { TIPOS_CARGA } from "../../domain/carga/TipoCarga.js";
import { ESTADOS } from "../../domain/envio/EstadoEnvio.js";
import { FORMAS_PAGO } from "../../domain/envio/FormaPago.js";
import { MAX_CANTIDAD, MAX_ITEMS } from "../../domain/tarifa/calcularTarifa.js";

// Validación de forma (tipos/obligatorios). Las reglas de negocio viven en el dominio.

const texto = z.string().trim().min(1, "obligatorio");

export const loginSchema = z.object({
  email: z.email("correo inválido"),
  password: z.string().min(1, "obligatorio"),
});

const itemSchema = z.object({
  tipoCarga: z.enum(TIPOS_CARGA),
  cantidad: z.coerce.number().int().min(1).max(MAX_CANTIDAD),
  pesoKg: z.coerce.number().positive(), // peso por unidad
});

export const cotizacionSchema = z.object({
  rutaId: z.coerce.number().int().positive(),
  items: z.array(itemSchema).min(1, "agregue al menos un ítem").max(MAX_ITEMS),
});

export const crearEnvioSchema = cotizacionSchema.extend({
  remitente: z.object({ nombre: texto, telefono: texto }),
  destinatario: z.object({ nombre: texto, telefono: texto, direccion: texto }),
  formaPago: z.enum(FORMAS_PAGO),
  descripcion: z.string().max(500).nullish(),
});

export const cambioEstadoSchema = z.object({
  estado: z.enum(ESTADOS),
  nota: z.string().max(500).nullish(),
});

export const filtroEnviosSchema = z.object({
  estado: z.enum(ESTADOS).optional(),
  rutaId: z.coerce.number().int().positive().optional(),
  formaPago: z.enum(FORMAS_PAGO).optional(),
  q: z.string().optional(),
});

export const crearRutaSchema = z.object({
  origenId: z.coerce.number().int().positive(),
  destinoId: z.coerce.number().int().positive(),
  tarifaBase: z.coerce.number(),
  tiempoEstimadoMin: z.coerce.number().int(),
});

export const actualizarRutaSchema = z
  .object({
    tarifaBase: z.coerce.number().optional(),
    tiempoEstimadoMin: z.coerce.number().int().optional(),
    activa: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), "Debe enviar al menos un campo");

export const crearCiudadSchema = z.object({ nombre: z.string() });

export const actualizarCiudadSchema = z
  .object({ nombre: z.string().optional(), activa: z.boolean().optional() })
  .refine((v) => v.nombre !== undefined || v.activa !== undefined, "Debe enviar al menos un campo");

export const idNumerico = z.coerce.number().int().positive();
export const idUuid = z.uuid("id inválido");
