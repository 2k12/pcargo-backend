import { z } from "zod";
import { TIPOS_CARGA } from "../../domain/carga/TipoCarga.js";
import { ESTADOS } from "../../domain/envio/EstadoEnvio.js";
import { RECIBIDO_POR } from "../../domain/envio/Evidencia.js";
import { MAX_DIRECCION_REMITENTE } from "../../domain/envio/Envio.js";
import { FORMAS_PAGO } from "../../domain/envio/FormaPago.js";
import { MAX_CANTIDAD, MAX_ITEMS } from "../../domain/tarifa/calcularTarifa.js";
import { ZONAS } from "../../domain/tarifa/Zona.js";
import { NOMBRE_USUARIO } from "../../domain/usuario/Usuario.js";

// Validación de forma (tipos/obligatorios). Las reglas de negocio viven en el dominio.

const texto = z.string().trim().min(1, "obligatorio");

export const loginSchema = z.object({
  email: z.email("correo inválido"),
  password: z.string().min(1, "obligatorio"),
});

// Perfil propio: solo nombre y email; cualquier otro campo (p. ej. rol) → 400.
export const actualizarPerfilSchema = z
  .strictObject({
    nombre: z.string().trim().min(NOMBRE_USUARIO.min).max(NOMBRE_USUARIO.max).optional(),
    email: z.email("correo inválido").optional(),
  })
  .refine((v) => v.nombre !== undefined || v.email !== undefined, "Debe enviar al menos un campo (nombre o email)");

// La política de la contraseña nueva (largo, letra y número, distinta) vive en el dominio.
export const cambiarContrasenaSchema = z.object({
  actual: z.string().min(1, "obligatorio").max(200),
  nueva: z.string().max(200),
});

export const evidenciaSchema = z.object({
  recibidoPor: z
    .string({ error: "obligatorio" })
    .trim()
    .min(RECIBIDO_POR.min, `mínimo ${RECIBIDO_POR.min} caracteres`)
    .max(RECIBIDO_POR.max, `máximo ${RECIBIDO_POR.max} caracteres`),
});

const itemSchema = z.object({
  tipoCarga: z.enum(TIPOS_CARGA),
  cantidad: z.coerce.number().int().min(1).max(MAX_CANTIDAD),
  pesoKg: z.coerce.number().positive(), // peso por unidad
});

export const cotizacionSchema = z.object({
  rutaId: z.coerce.number().int().positive(),
  items: z.array(itemSchema).min(1, "agregue al menos un ítem").max(MAX_ITEMS),
  zona: z.enum(ZONAS).optional(), // por defecto URBANA (lo aplica el caso de uso)
});

export const crearEnvioSchema = cotizacionSchema.extend({
  // dirección del remitente: opcional (0–200); vacía → null (lo aplica el dominio)
  remitente: z.object({
    nombre: texto,
    telefono: texto,
    direccion: z.string().trim().max(MAX_DIRECCION_REMITENTE).nullish(),
  }),
  destinatario: z.object({ nombre: texto, telefono: texto, direccion: texto }),
  formaPago: z.enum(FORMAS_PAGO),
  descripcion: z.string().max(500).nullish(),
  // guía física: texto (admite ceros a la izquierda) o número; el dominio valida el formato
  numeroGuia: z.union([z.string().max(40), z.number()]).nullish(),
  clienteId: z.uuid("cliente inválido").nullish(),
  guardarCliente: z.boolean().optional(),
  // el caso de uso exige `true` junto con guardarCliente (422); sin guardarCliente se ignora
  consentimientoCliente: z.unknown().optional(),
});

export const cambioEstadoSchema = z.object({
  estado: z.enum(ESTADOS),
  nota: z.string().max(500).nullish(),
});

export const filtroEnviosSchema = z.object({
  estado: z.enum(ESTADOS).optional(),
  rutaId: z.coerce.number().int().positive().optional(),
  formaPago: z.enum(FORMAS_PAGO).optional(),
  clienteId: z.uuid("cliente inválido").optional(),
  q: z.string().optional(),
});

export const paginacionSchema = z.object({
  pagina: z.coerce.number().int().min(1).default(1),
  porPagina: z.coerce.number().int().min(1).max(100).default(20),
});

export const filtroResumenSchema = z.object({
  clienteId: z.uuid("cliente inválido").optional(),
  desde: z.string().optional(),
  hasta: z.string().optional(),
});

const opcional = z.string().max(300).nullish();

const datosClienteSchema = z.object({
  nombre: z.string().max(200),
  telefono: z.string().max(40),
  direccion: opcional,
  notas: opcional,
});

// `consentimiento` es una regla de negocio (LOPDP): el caso de uso exige `true` y responde 422 si no.
const consentimiento = z.unknown().optional();

export const crearClienteSchema = datosClienteSchema.extend({ consentimiento });

export const actualizarClienteSchema = datosClienteSchema
  .partial()
  .extend({ consentimiento })
  .refine((v) => Object.values(v).some((x) => x !== undefined), "Debe enviar al menos un campo");

export const crearRutaSchema = z.object({
  origenId: z.coerce.number().int().positive(),
  destinoId: z.coerce.number().int().positive(),
  tiempoEstimadoMin: z.coerce.number().int(),
});

export const actualizarRutaSchema = z
  .object({
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
