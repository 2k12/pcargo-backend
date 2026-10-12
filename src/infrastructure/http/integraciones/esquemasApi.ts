import { z } from "zod";
import { CODIGO_TIPO_CARGA } from "../../../domain/carga/TipoCarga.js";
import { FORMAS_PAGO } from "../../../domain/envio/FormaPago.js";
import { REFERENCIA_EXTERNA } from "../../../domain/integracion/EnvioExterno.js";
import { MAX_CANTIDAD, MAX_ITEMS } from "../../../domain/tarifa/calcularTarifa.js";
import { ZONAS } from "../../../domain/tarifa/Zona.js";

// Esquemas ESTRICTOS de la API para empresas: un campo desconocido → 400 VALIDACION. Sin coerciones: los tipos
// deben venir bien en el JSON (a diferencia del panel, donde se toleran números como texto).

const texto = (max: number) => z.string().trim().min(1, "obligatorio").max(max);

const itemSchema = z.strictObject({
  // v11: catálogo configurable. Inexistente → 422 VALIDACION; inactivo → 422 TIPO_CARGA_INACTIVO (ver /cobertura).
  tipoCarga: z.string().regex(CODIGO_TIPO_CARGA, "código de tipo de carga inválido (consulte GET /cobertura)"),
  cantidad: z.number().int().min(1).max(MAX_CANTIDAD),
  pesoKg: z.number().positive().max(1000),
});

const itemsSchema = z.array(itemSchema).min(1, "agregue al menos un ítem").max(MAX_ITEMS);

export const cotizarApiSchema = z.strictObject({
  destino: z.strictObject({ ciudad: texto(60) }),
  items: itemsSchema,
  zona: z.enum(ZONAS).optional(),
});

export const nuevoEnvioApiSchema = z.strictObject({
  referenciaExterna: z.string().regex(REFERENCIA_EXTERNA, "1 a 64 caracteres (letras, dígitos y . _ - / #)"),
  destinatario: z.strictObject({
    nombre: texto(120),
    telefono: texto(20),
    direccion: texto(300),
    ciudad: texto(60),
  }),
  items: itemsSchema,
  zona: z.enum(ZONAS).optional(),
  formaPago: z.enum(FORMAS_PAGO).optional(),
  descripcion: z.string().max(500).nullish(),
});

/** El lote se valida en dos pasos: la envoltura aquí y cada elemento por separado (su error va en su resultado). */
export const loteApiSchema = z.strictObject({
  envios: z.array(z.unknown()).min(1, "el lote debe tener al menos un envío").max(100, "máximo 100 envíos por lote"),
});
