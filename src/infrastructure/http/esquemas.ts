import { z } from "zod";
import { TIPOS_CARGA } from "../../domain/carga/TipoCarga.js";
import { ESTADOS } from "../../domain/envio/EstadoEnvio.js";

// Validación de forma (tipos/obligatorios). Las reglas de negocio viven en el dominio.

const texto = z.string().trim().min(1, "obligatorio");

export const loginSchema = z.object({
  email: z.email("correo inválido"),
  password: z.string().min(1, "obligatorio"),
});

export const cotizacionSchema = z.object({
  rutaId: z.coerce.number().int().positive(),
  tipoCarga: z.enum(TIPOS_CARGA),
  pesoKg: z.coerce.number().positive(),
});

export const crearEnvioSchema = cotizacionSchema.extend({
  remitente: z.object({ nombre: texto, telefono: texto }),
  destinatario: z.object({ nombre: texto, telefono: texto, direccion: texto }),
  descripcion: z.string().max(500).nullish(),
});

export const cambioEstadoSchema = z.object({
  estado: z.enum(ESTADOS),
  nota: z.string().max(500).nullish(),
});

export const filtroEnviosSchema = z.object({
  estado: z.enum(ESTADOS).optional(),
  rutaId: z.coerce.number().int().positive().optional(),
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

export const idNumerico = z.coerce.number().int().positive();
export const idUuid = z.uuid("id inválido");
