import { z } from "zod";
import { CODIGO_TIPO_CARGA } from "../../domain/carga/TipoCarga.js";
import { CATEGORIAS_ARTICULO, ICONOS_ARTICULO } from "../../domain/catalogo/ArticuloRestringido.js";
import { ESTADOS } from "../../domain/envio/EstadoEnvio.js";
import { RECIBIDO_POR } from "../../domain/envio/Evidencia.js";
import { MAX_DIRECCION_REMITENTE } from "../../domain/envio/Envio.js";
import { FORMAS_PAGO } from "../../domain/envio/FormaPago.js";
import { MAX_CANTIDAD, MAX_ITEMS } from "../../domain/tarifa/calcularTarifa.js";
import { ZONAS } from "../../domain/tarifa/Zona.js";
import { NOMBRE_USUARIO, ROLES } from "../../domain/usuario/Usuario.js";
import { CANALES_SOLICITUD } from "../../domain/datos/DatosPersonales.js";
import {
  ALCANCES,
  CANALES,
  EVENTOS_WEBHOOK,
  MAX_IPS_PERMITIDAS,
  MAX_URL_WEBHOOK,
  MODOS_KEY,
  NOMBRE_INTEGRACION,
  NOMBRE_KEY,
} from "../../domain/integracion/Integracion.js";
import { ESTADOS_ENTREGA } from "../../domain/integracion/Webhook.js";
import { esIpOCidrValido } from "../security/redes.js";

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

/**
 * Código de tipo de carga (v11: configurable). Aquí solo la forma; que exista (422 VALIDACION) y esté activo
 * (422 TIPO_CARGA_INACTIVO) lo comprueba el caso de uso contra el catálogo vigente.
 */
export const codigoTipoCargaSchema = z.string().regex(CODIGO_TIPO_CARGA, "código de tipo de carga inválido");

const itemSchema = z.object({
  tipoCarga: codigoTipoCargaSchema,
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
  canal: z.enum(CANALES).optional(),
  integracionId: z.uuid("integración inválida").optional(),
  // v12: un id de repartidor, o "ninguno" para los envíos sin asignar
  repartidorId: z
    .union([z.literal("ninguno"), z.uuid("repartidor inválido")])
    .optional()
    .transform((v) => (v === "ninguno" ? null : v)),
  q: z.string().optional(),
});

export const paginacionSchema = z.object({
  pagina: z.coerce.number().int().min(1).default(1),
  porPagina: z.coerce.number().int().min(1).max(100).default(20),
});

export const filtroResumenSchema = z.object({
  clienteId: z.uuid("cliente inválido").optional(),
  canal: z.enum(CANALES).optional(),
  integracionId: z.uuid("integración inválida").optional(),
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

// ── Integraciones (administración, ADMIN) ────────────────────────────────────

const remitenteIntegracionSchema = z.strictObject({
  nombre: z.string().max(200),
  telefono: z.string().max(40),
  direccion: z.string().max(300),
});

const ipsSchema = z
  .array(z.string().max(60).refine(esIpOCidrValido, "IP o rango CIDR inválido (IPv4/IPv6)"))
  .max(MAX_IPS_PERMITIDAS);

const camposIntegracion = {
  nombre: z.string().max(NOMBRE_INTEGRACION.max * 2),
  activa: z.boolean().optional(),
  remitente: remitenteIntegracionSchema,
  ciudadOrigenId: z.number().int().positive(),
  formaPagoPorDefecto: z.enum(FORMAS_PAGO).optional(),
  clienteId: z.uuid("cliente inválido").nullish(),
  ipsPermitidas: ipsSchema.optional(),
};

export const crearIntegracionSchema = z.strictObject(camposIntegracion);

export const actualizarIntegracionSchema = z
  .strictObject(camposIntegracion)
  .partial()
  .refine((v) => Object.values(v).some((x) => x !== undefined), "Debe enviar al menos un campo");

export const crearApiKeySchema = z.strictObject({
  nombre: z.string().max(NOMBRE_KEY.max * 2),
  modo: z.enum(MODOS_KEY),
  alcances: z.array(z.enum(ALCANCES)).min(1, "al menos un alcance").max(ALCANCES.length * 2),
});

export const webhookSchema = z.strictObject({
  url: z.string().max(MAX_URL_WEBHOOK),
  eventos: z.array(z.enum(EVENTOS_WEBHOOK)).min(1, "al menos un evento").max(EVENTOS_WEBHOOK.length * 2),
  activo: z.boolean(),
});

export const filtroEntregasSchema = z.object({ estado: z.enum(ESTADOS_ENTREGA).optional() });

// ── Catálogo configurable (v11, ADMIN) ───────────────────────────────────────
// Forma y tipos; los rangos (precios ≤ 1000 con 2 decimales, mayoreo < precio, nombre 2–40…) los valida el dominio.

const mayoreoSchema = z.strictObject({ minimoExclusivo: z.number(), precio: z.number() });

const camposTipoCarga = {
  nombre: z.string().max(200),
  precio: z.number(),
  precioRural: z.number().nullable(),
  mayoreo: mayoreoSchema.nullable(),
  pesoMaxKg: z.number(),
  activo: z.boolean().optional(),
};

export const crearTipoCargaSchema = z.strictObject({
  codigo: z.string().max(60),
  ...camposTipoCarga,
  // por comodidad, omitirlos equivale a null (sin precio rural / sin mayoreo)
  precioRural: camposTipoCarga.precioRural.optional().transform((v) => v ?? null),
  mayoreo: camposTipoCarga.mayoreo.optional().transform((v) => v ?? null),
});

// `codigo` es inmutable: enviarlo (o cualquier otro campo desconocido) → 400.
export const actualizarTipoCargaSchema = z
  .strictObject(camposTipoCarga)
  .partial()
  .refine((v) => Object.values(v).some((x) => x !== undefined), "Debe enviar al menos un campo");

export const ordenTiposCargaSchema = z.strictObject({
  codigos: z
    .array(z.string().max(60))
    .min(1)
    .max(500)
    .refine((c) => new Set(c).size === c.length, "los códigos no se pueden repetir"),
});

export const filtroHistorialTiposSchema = z.object({ codigo: z.string().max(60).optional() });

export const listarTiposCargaSchema = z.object({
  todos: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
});

const camposArticulo = {
  categoria: z.enum(CATEGORIAS_ARTICULO),
  titulo: z.string().max(200),
  detalle: z.string().max(600).nullish(),
  icono: z.enum(ICONOS_ARTICULO).nullish(),
  activo: z.boolean().optional(),
};

export const crearArticuloSchema = z.strictObject(camposArticulo);

export const actualizarArticuloSchema = z
  .strictObject(camposArticulo)
  .partial()
  .refine((v) => Object.values(v).some((x) => x !== undefined), "Debe enviar al menos un campo");

export const ordenArticulosSchema = z.strictObject({
  categoria: z.enum(CATEGORIAS_ARTICULO),
  ids: z
    .array(z.uuid("id inválido"))
    .max(500)
    .refine((ids) => new Set(ids).size === ids.length, "los ids no se pueden repetir"),
});

// ── v12: usuarios, reparto, caja, datos personales y portal ──────────────────
// Forma y tipos; las reglas (política de contraseñas, CLIENTE con cliente, rangos) viven en el dominio.

const booleanoQuery = z
  .enum(["true", "false"])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === "true"));

export const filtroUsuariosSchema = z.object({
  rol: z.enum(ROLES).optional(),
  activo: booleanoQuery,
});

export const crearUsuarioSchema = z.strictObject({
  nombre: z.string().max(200),
  email: z.email("correo inválido"),
  password: z.string().max(200),
  rol: z.enum(ROLES),
  clienteId: z.uuid("cliente inválido").nullish(),
});

// `clienteId` no se cambia por aquí (strict → 400).
export const actualizarUsuarioSchema = z
  .strictObject({
    nombre: z.string().max(200).optional(),
    email: z.email("correo inválido").optional(),
    password: z.string().max(200).optional(),
    rol: z.enum(ROLES).optional(),
    activo: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), "Debe enviar al menos un campo");

export const crearAccesoPortalSchema = z.strictObject({
  nombre: z.string().max(200),
  email: z.email("correo inválido"),
});

export const asignarRepartidorSchema = z.strictObject({
  envioIds: z
    .array(z.uuid("id de envío inválido"))
    .min(1, "indique al menos un envío")
    .max(100, "máximo 100 envíos")
    .refine((ids) => new Set(ids).size === ids.length, "los envíos no se pueden repetir"),
  repartidorId: z.uuid("repartidor inválido").nullable(),
});

export const vistaRepartidorSchema = z.object({
  vista: z.enum(["pendientes", "hoy"]).default("pendientes"),
});

export const cambioEstadoRepartidorSchema = z.object({
  estado: z.enum(["EN_REPARTO", "ENTREGADO", "NO_ENTREGADO", "NOVEDAD"]),
  nota: z.string().max(500).nullish(),
});

export const cierreCajaSchema = z.strictObject({
  usuarioId: z.uuid("usuario inválido"),
  montoEntregado: z
    .number()
    .min(0, "debe ser mayor o igual a 0")
    .refine((n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6, "hasta 2 decimales"),
  nota: z.string().max(300).nullish(),
});

export const filtroCierresSchema = z.object({
  usuarioId: z.uuid("usuario inválido").optional(),
  desde: z.string().optional(),
  hasta: z.string().optional(),
});

export const titularSchema = z.object({ telefono: z.string().min(1, "obligatorio").max(40) });

export const solicitudDatosSchema = z.strictObject({
  telefono: z.string().max(40),
  nombreTitular: z.string().max(200),
  canal: z.enum(CANALES_SOLICITUD),
  nota: z.string().max(300).nullish(),
});

export const filtroResumenPortalSchema = z.object({
  desde: z.string().optional(),
  hasta: z.string().optional(),
});

export const filtroEnviosPortalSchema = z.object({
  estado: z.enum(ESTADOS).optional(),
  q: z.string().optional(),
});

// El remitente es el cliente: remitente, clienteId, numeroGuia o una forma de pago no admitida → 400.
export const crearEnvioPortalSchema = cotizacionSchema
  .extend({
    destinatario: z.object({ nombre: texto, telefono: texto, direccion: texto }),
    formaPago: z.enum(["CONTRATO", "AL_COBRO"]).optional(),
    descripcion: z.string().max(500).nullish(),
  })
  .strict();
