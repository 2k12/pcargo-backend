import { ESTADOS } from "../../../domain/envio/EstadoEnvio.js";
import { FORMAS_PAGO } from "../../../domain/envio/FormaPago.js";
import { ALCANCES, EVENTOS_WEBHOOK } from "../../../domain/integracion/Integracion.js";
import { MAX_CANTIDAD, MAX_ITEMS } from "../../../domain/tarifa/calcularTarifa.js";
import { ZONAS } from "../../../domain/tarifa/Zona.js";

// Especificación OpenAPI 3.1 de la API para empresas (escrita a mano a partir del contrato v11).
// Se sirve en GET /api/v1/integraciones/openapi.json (pública).

const ref = (nombre: string) => ({ $ref: `#/components/schemas/${nombre}` });
const respuestaRef = (nombre: string) => ({ $ref: `#/components/responses/${nombre}` });
const json = (schema: object, extra: object = {}) => ({ content: { "application/json": { schema, ...extra } } });

const DESCRIPCION = `API para que otras empresas (tiendas en línea, distribuidores) ingresen pedidos de envío en PCargo
(encomiendas Ibarra · Atuntaqui · Otavalo · Quito) y consulten su estado.

## Autenticación
Todas las operaciones (salvo este documento) exigen \`Authorization: Bearer <api key>\`. Las keys tienen el formato
\`pc_live_<prefijo 8>_<secreto 32>\` (producción) o \`pc_test_<prefijo 8>_<secreto 32>\` (pruebas) y las entrega PCargo
una sola vez. Sin key, con formato inválido, inexistente o revocada → 401 \`API_KEY_INVALIDA\`. Integración desactivada → 403
\`INTEGRACION_INACTIVA\`; IP fuera de la lista permitida → 403 \`IP_NO_PERMITIDA\`; key sin el alcance → 403 \`ALCANCE_INSUFICIENTE\`.

**Keys de prueba (\`pc_test_\`)**: hacen todas las validaciones y cotizan igual, pero no guardan nada: la respuesta lleva
\`prueba: true\`, \`numeroGuia: 0\` e \`id: "prueba_<uuid>"\`; consultar un envío con key de prueba responde 404.

## Límites
120 solicitudes por minuto por integración (cabeceras \`RateLimit-Limit\`, \`RateLimit-Remaining\`, \`RateLimit-Reset\`;
al superarlo 429 \`DEMASIADAS_SOLICITUDES\` con \`Retry-After\`). Cuerpo JSON de hasta 1 MB. Los esquemas son estrictos:
un campo desconocido → 400 \`VALIDACION\`. Cada respuesta lleva \`X-Request-Id\` (inclúyalo al reportar un problema).

## Idempotencia
\`POST /envios\` y \`POST /envios/lote\` exigen el header \`Idempotency-Key\` (1–255 caracteres ASCII visibles; p. ej. un UUID
por pedido). Repetir la misma clave con el mismo cuerpo (comparado como JSON canónico) durante 24 h devuelve la misma
respuesta con \`Idempotent-Replayed: true\` sin crear nada. Misma clave con otro cuerpo → 422 \`IDEMPOTENCIA_CONFLICTO\`;
mientras la primera solicitud sigue en proceso → 409 \`IDEMPOTENCIA_EN_PROCESO\`. Las claves de las keys de prueba y de
producción son independientes.

## Webhooks (Standard Webhooks)
Si PCargo configuró un webhook para su integración, recibirá \`POST <su url>\` con \`Content-Type: application/json\` y el
cuerpo \`{ "type": <evento>, "timestamp": <ISO 8601>, "data": EnvioApi }\` para los eventos ${EVENTOS_WEBHOOK.map((e) => `\`${e}\``).join(", ")}.
Cabeceras: \`webhook-id\` (id del mensaje, igual en los reintentos: úselo para descartar duplicados), \`webhook-timestamp\`
(segundos Unix) y \`webhook-signature: v1,<firma>\`.

**Verificación de la firma**: \`firma = base64(HMAC-SHA256(clave, "<webhook-id>.<webhook-timestamp>.<cuerpo exacto>"))\`, donde
\`clave\` son los bytes de decodificar en base64 lo que sigue a \`whsec_\` en su secreto. Compare en tiempo constante con cada
firma \`v1,\` del header (puede haber varias separadas por espacio) y rechace timestamps con más de 5 min de diferencia.
Las librerías oficiales de https://www.standardwebhooks.com hacen todo esto. Ejemplo en Node.js:

\`\`\`js
const crypto = require("node:crypto");
function verificar(secreto, headers, cuerpo) {
  const clave = Buffer.from(secreto.replace(/^whsec_/, ""), "base64");
  const firmado = \`\${headers["webhook-id"]}.\${headers["webhook-timestamp"]}.\${cuerpo}\`;
  const esperada = "v1," + crypto.createHmac("sha256", clave).update(firmado).digest("base64");
  const edad = Math.abs(Date.now() / 1000 - Number(headers["webhook-timestamp"]));
  return edad <= 300 && headers["webhook-signature"].split(" ").some((f) =>
    f.length === esperada.length && crypto.timingSafeEqual(Buffer.from(f), Buffer.from(esperada)));
}
\`\`\`

Responda 2xx en menos de 10 s. Si no, se reintenta tras 1 min, 5 min, 30 min, 2 h, 6 h, 12 h y 24 h (8 intentos en total);
luego la entrega queda fallida y PCargo puede reenviarla. No se siguen redirecciones.`;

const error = (codigos: string[]) => ({
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message"],
      properties: {
        code: { type: "string", enum: codigos },
        message: { type: "string" },
      },
      additionalProperties: true,
    },
  },
});

/** v11: los tipos de carga son configurables; la lista vigente (solo activos) está en GET /cobertura. */
const tipoCarga = {
  type: "string",
  pattern: "^[A-Z][A-Z0-9_]{1,29}$",
  description:
    "Código de un tipo de carga activo (p. ej. SOBRE, PAQUETE, CARTON). Consulte la lista vigente en `GET /cobertura` " +
    "(`tiposCarga`). Inexistente → 422 `VALIDACION`; desactivado → 422 `TIPO_CARGA_INACTIVO`.",
};

const tipoCargaPublico = {
  type: "object",
  required: ["codigo", "nombre", "precio", "precioRural", "mayoreo", "pesoMaxKg"],
  properties: {
    codigo: { type: "string" },
    nombre: { type: "string" },
    precio: { type: "number", description: "USD por unidad, zona urbana" },
    precioRural: { type: ["number", "null"], description: "USD por unidad en zona rural; null = el mismo precio" },
    mayoreo: {
      type: ["object", "null"],
      required: ["minimoExclusivo", "precio"],
      description: "Con MÁS de `minimoExclusivo` unidades del tipo en el envío, todas cuestan `precio`.",
      properties: { minimoExclusivo: { type: "integer" }, precio: { type: "number" } },
    },
    pesoMaxKg: { type: "number", description: "Peso máximo por unidad (kg)" },
  },
};

const item = {
  type: "object",
  additionalProperties: false,
  required: ["tipoCarga", "cantidad", "pesoKg"],
  properties: {
    tipoCarga,
    cantidad: { type: "integer", minimum: 1, maximum: MAX_CANTIDAD },
    pesoKg: { type: "number", exclusiveMinimum: 0, description: "Peso por unidad (kg); no puede superar el máximo del tipo." },
  },
};

const itemEnvio = {
  type: "object",
  required: ["tipoCarga", "cantidad", "pesoKg", "costoUnitario", "subtotal"],
  properties: {
    tipoCarga: { type: "string" },
    cantidad: { type: "integer" },
    pesoKg: { type: "number" },
    costoUnitario: { type: "number" },
    subtotal: { type: "number" },
  },
};

const envioApi = {
  type: "object",
  required: [
    "id", "numeroGuia", "referenciaExterna", "prueba", "estado", "origen", "destino", "destinatario", "items",
    "totalPiezas", "pesoTotalKg", "zona", "costo", "formaPago", "descripcion", "seguimientoUrl", "entrega",
    "evidencia", "creadoEn", "actualizadoEn",
  ],
  properties: {
    id: { type: "string", description: "uuid; en modo prueba `prueba_<uuid>`" },
    numeroGuia: { type: "integer", description: "Número de guía de PCargo (0 en modo prueba)" },
    referenciaExterna: { type: "string" },
    prueba: { type: "boolean" },
    estado: { type: "string", enum: [...ESTADOS] },
    origen: { type: "string", description: "Ciudad de origen" },
    destino: { type: "string", description: "Ciudad de destino" },
    destinatario: {
      type: "object",
      required: ["nombre", "telefono", "direccion"],
      properties: { nombre: { type: "string" }, telefono: { type: "string" }, direccion: { type: "string" } },
    },
    items: { type: "array", items: itemEnvio },
    totalPiezas: { type: "integer" },
    pesoTotalKg: { type: "number" },
    zona: { type: "string", enum: [...ZONAS] },
    costo: { type: "number", description: "USD" },
    formaPago: { type: "string", enum: [...FORMAS_PAGO] },
    descripcion: { type: ["string", "null"] },
    seguimientoUrl: { type: "string", format: "uri" },
    entrega: {
      type: ["object", "null"],
      required: ["resultado", "fecha", "nota"],
      properties: {
        resultado: { type: "string", enum: ["ENTREGADO", "NO_ENTREGADO", "NOVEDAD"] },
        fecha: { type: "string", format: "date-time" },
        nota: { type: ["string", "null"] },
      },
    },
    evidencia: {
      type: ["object", "null"],
      required: ["recibidoPor", "subidaEn"],
      properties: { recibidoPor: { type: "string" }, subidaEn: { type: "string", format: "date-time" } },
    },
    creadoEn: { type: "string", format: "date-time" },
    actualizadoEn: { type: "string", format: "date-time" },
    historial: {
      type: "array",
      items: {
        type: "object",
        required: ["estado", "nota", "fecha"],
        properties: {
          estado: { type: "string", enum: [...ESTADOS] },
          nota: { type: ["string", "null"] },
          fecha: { type: "string", format: "date-time" },
        },
      },
    },
  },
};

const nuevoEnvioApi = {
  type: "object",
  additionalProperties: false,
  required: ["referenciaExterna", "destinatario", "items"],
  properties: {
    referenciaExterna: {
      type: "string",
      pattern: "^[A-Za-z0-9._\\-/#]{1,64}$",
      description: "Su número de pedido. Único por integración (repetido → 409 CONFLICTO con `error.envio`).",
    },
    destinatario: {
      type: "object",
      additionalProperties: false,
      required: ["nombre", "telefono", "direccion", "ciudad"],
      properties: {
        nombre: { type: "string", minLength: 1, maxLength: 120 },
        telefono: { type: "string", description: "7 a 15 dígitos (admite + y espacios)" },
        direccion: { type: "string", minLength: 1, maxLength: 300 },
        ciudad: { type: "string", description: "Nombre de la ciudad (sin distinguir mayúsculas ni tildes). Ver /cobertura." },
      },
    },
    items: { type: "array", minItems: 1, maxItems: MAX_ITEMS, items: item },
    zona: { type: "string", enum: [...ZONAS], default: "URBANA" },
    formaPago: { type: "string", enum: [...FORMAS_PAGO], description: "Por defecto la de su integración." },
    descripcion: { type: ["string", "null"], maxLength: 500 },
  },
};

const ERRORES_AUTH = ["API_KEY_INVALIDA"];
const ERRORES_PROHIBIDO = ["INTEGRACION_INACTIVA", "IP_NO_PERMITIDA", "ALCANCE_INSUFICIENTE"];

const respuestasComunes = {
  "400": respuestaRef("Validacion"),
  "401": respuestaRef("NoAutenticado"),
  "403": respuestaRef("Prohibido"),
  "429": respuestaRef("DemasiadasSolicitudes"),
};

const idempotencyKey = { $ref: "#/components/parameters/IdempotencyKey" };
const replayHeader = { "Idempotent-Replayed": { $ref: "#/components/headers/IdempotentReplayed" } };

export function especificacionOpenApi(): object {
  return {
    openapi: "3.1.0",
    info: {
      title: "PCargo — API para empresas",
      version: "1.1.0",
      description: DESCRIPCION,
      contact: { name: "PCargo" },
    },
    servers: [{ url: "/api/v1/integraciones", description: "Este servidor" }],
    security: [{ apiKey: [] }],
    tags: [{ name: "Cobertura" }, { name: "Cotización" }, { name: "Envíos" }],
    paths: {
      "/cobertura": {
        get: {
          tags: ["Cobertura"],
          operationId: "obtenerCobertura",
          summary: "Ciudades a las que se puede enviar desde su ciudad de origen y tipos de carga disponibles",
          description: "Alcance: cualquiera.",
          responses: {
            "200": { description: "Cobertura", ...json(ref("Cobertura")) },
            "401": respuestasComunes["401"],
            "403": respuestasComunes["403"],
            "429": respuestasComunes["429"],
          },
        },
      },
      "/cotizar": {
        post: {
          tags: ["Cotización"],
          operationId: "cotizar",
          summary: "Cotiza un envío (precio por unidad según tipo de carga y zona)",
          description: "Alcance: `cotizar`.",
          requestBody: { required: true, ...json(ref("SolicitudCotizacion")) },
          responses: {
            "200": { description: "Cotización", ...json(ref("Cotizacion")) },
            ...respuestasComunes,
            "422": respuestaRef("NoProcesable"),
          },
        },
      },
      "/envios": {
        post: {
          tags: ["Envíos"],
          operationId: "crearEnvio",
          summary: "Crea un envío",
          description:
            "Alcance: `envios:crear`. El remitente, la ciudad de origen y (si no la indica) la forma de pago son los de su integración. " +
            "El número de guía es consecutivo automático.",
          parameters: [idempotencyKey],
          requestBody: { required: true, ...json(ref("NuevoEnvioApi")) },
          responses: {
            "201": { description: "Envío creado", headers: replayHeader, ...json(ref("EnvioApi")) },
            ...respuestasComunes,
            "409": respuestaRef("Conflicto"),
            "422": respuestaRef("NoProcesable"),
          },
        },
      },
      "/envios/lote": {
        post: {
          tags: ["Envíos"],
          operationId: "crearLote",
          summary: "Crea hasta 100 envíos (no atómico)",
          description:
            "Alcance: `envios:crear`. Cada elemento se procesa por separado y en orden; la respuesta trae el resultado de cada uno " +
            "(los válidos se crean aunque otros fallen).",
          parameters: [idempotencyKey],
          requestBody: {
            required: true,
            ...json({
              type: "object",
              additionalProperties: false,
              required: ["envios"],
              properties: { envios: { type: "array", minItems: 1, maxItems: 100, items: ref("NuevoEnvioApi") } },
            }),
          },
          responses: {
            "200": { description: "Resultado por elemento", headers: replayHeader, ...json(ref("ResultadoLote")) },
            ...respuestasComunes,
            "409": respuestaRef("Conflicto"),
            "422": respuestaRef("NoProcesable"),
          },
        },
      },
      "/envios/{referenciaExterna}": {
        get: {
          tags: ["Envíos"],
          operationId: "consultarEnvio",
          summary: "Consulta un envío propio por su número de pedido (con historial)",
          description: "Alcance: `envios:leer`. Codifique en la URL los caracteres `/` (%2F) y `#` (%23).",
          parameters: [
            {
              name: "referenciaExterna",
              in: "path",
              required: true,
              schema: { type: "string", pattern: "^[A-Za-z0-9._\\-/#]{1,64}$" },
            },
          ],
          responses: {
            "200": { description: "Envío", ...json(ref("EnvioApi")) },
            ...respuestasComunes,
            "404": respuestaRef("NoEncontrado"),
          },
        },
      },
      "/openapi.json": {
        get: {
          operationId: "openapi",
          summary: "Este documento",
          security: [],
          responses: { "200": { description: "Especificación OpenAPI 3.1", ...json({ type: "object" }) } },
        },
      },
    },
    webhooks: Object.fromEntries(
      EVENTOS_WEBHOOK.map((evento) => [
        evento,
        {
          post: {
            summary: `Evento ${evento}`,
            description: "Enviado a la URL configurada por PCargo. Verifique la firma (ver descripción general) y responda 2xx en ≤ 10 s.",
            parameters: [
              { name: "webhook-id", in: "header", required: true, schema: { type: "string" } },
              { name: "webhook-timestamp", in: "header", required: true, schema: { type: "string", description: "segundos Unix" } },
              { name: "webhook-signature", in: "header", required: true, schema: { type: "string", example: "v1,K5oZfzN95Z9UVu1EsfQmfVNQhnkZ2pj9o9NDN/H/pI4=" } },
            ],
            requestBody: {
              required: true,
              ...json({
                type: "object",
                required: ["type", "timestamp", "data"],
                properties: {
                  type: { type: "string", const: evento },
                  timestamp: { type: "string", format: "date-time" },
                  data: ref("EnvioApi"),
                },
              }),
            },
            responses: { "2XX": { description: "Recibido" } },
          },
        },
      ]),
    ),
    components: {
      securitySchemes: {
        apiKey: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "pc_live_<prefijo>_<secreto> | pc_test_<prefijo>_<secreto>",
          description: `Alcances posibles de una key: ${ALCANCES.map((a) => `\`${a}\``).join(", ")}.`,
        },
      },
      parameters: {
        IdempotencyKey: {
          name: "Idempotency-Key",
          in: "header",
          required: true,
          description: "Obligatorio. 1–255 caracteres ASCII visibles; la respuesta se reproduce durante 24 h.",
          schema: { type: "string", minLength: 1, maxLength: 255, pattern: "^[\\x21-\\x7E]+$" },
        },
      },
      headers: {
        IdempotentReplayed: {
          description: "`true` si la respuesta se reprodujo por una Idempotency-Key ya usada.",
          schema: { type: "string", enum: ["true"] },
        },
        XRequestId: { description: "Identificador de la solicitud (uuid).", schema: { type: "string", format: "uuid" } },
      },
      responses: {
        Validacion: { description: "Datos inválidos (VALIDACION)", ...json(error(["VALIDACION"])) },
        NoAutenticado: { description: "API key inválida o revocada", ...json(error(ERRORES_AUTH)) },
        Prohibido: { description: "Integración inactiva, IP no permitida o alcance insuficiente", ...json(error(ERRORES_PROHIBIDO)) },
        NoEncontrado: { description: "No existe (o no es de su integración)", ...json(error(["NO_ENCONTRADO"])) },
        Conflicto: {
          description:
            "Referencia externa repetida (`error.envio = { numeroGuia, referenciaExterna }`) o Idempotency-Key en proceso",
          ...json(error(["CONFLICTO", "IDEMPOTENCIA_EN_PROCESO"])),
        },
        NoProcesable: {
          description: "Regla de negocio incumplida",
          ...json(error(["RUTA_NO_DISPONIBLE", "PESO_INVALIDO", "TIPO_CARGA_INACTIVO", "IDEMPOTENCIA_CONFLICTO", "VALIDACION"])),
        },
        DemasiadasSolicitudes: {
          description: "Límite de tasa superado (120/min por integración)",
          headers: { "Retry-After": { schema: { type: "integer" } } },
          ...json(error(["DEMASIADAS_SOLICITUDES"])),
        },
      },
      schemas: {
        ItemSolicitud: item,
        ItemEnvio: itemEnvio,
        TipoCarga: tipoCargaPublico,
        Cobertura: {
          type: "object",
          required: ["origen", "destinos", "tiposCarga"],
          properties: {
            origen: { type: "string" },
            destinos: {
              type: "array",
              items: {
                type: "object",
                required: ["ciudad", "tiempoEstimadoMin"],
                properties: { ciudad: { type: "string" }, tiempoEstimadoMin: { type: "integer" } },
              },
            },
            tiposCarga: { type: "array", items: ref("TipoCarga"), description: "Tipos de carga activos, en orden de presentación" },
          },
        },
        SolicitudCotizacion: {
          type: "object",
          additionalProperties: false,
          required: ["destino", "items"],
          properties: {
            destino: {
              type: "object",
              additionalProperties: false,
              required: ["ciudad"],
              properties: { ciudad: { type: "string" } },
            },
            items: { type: "array", minItems: 1, maxItems: MAX_ITEMS, items: item },
            zona: { type: "string", enum: [...ZONAS], default: "URBANA" },
          },
        },
        Cotizacion: {
          type: "object",
          required: ["costo", "zona", "totalPiezas", "pesoTotalKg", "items"],
          properties: {
            costo: { type: "number", description: "USD" },
            zona: { type: "string", enum: [...ZONAS] },
            totalPiezas: { type: "integer" },
            pesoTotalKg: { type: "number" },
            items: {
              type: "array",
              items: {
                allOf: [
                  itemEnvio,
                  { type: "object", required: ["mayoreo"], properties: { mayoreo: { type: "boolean" } } },
                ],
              },
            },
          },
        },
        NuevoEnvioApi: nuevoEnvioApi,
        EnvioApi: envioApi,
        ResultadoLote: {
          type: "object",
          required: ["resultados", "creados", "fallidos"],
          properties: {
            resultados: {
              type: "array",
              items: {
                oneOf: [
                  {
                    type: "object",
                    required: ["indice", "ok", "envio"],
                    properties: { indice: { type: "integer" }, ok: { const: true }, envio: ref("EnvioApi") },
                  },
                  {
                    type: "object",
                    required: ["indice", "ok", "error"],
                    properties: {
                      indice: { type: "integer" },
                      ok: { const: false },
                      error: {
                        type: "object",
                        required: ["code", "message"],
                        properties: { code: { type: "string" }, message: { type: "string" } },
                        additionalProperties: true,
                      },
                    },
                  },
                ],
              },
            },
            creados: { type: "integer" },
            fallidos: { type: "integer" },
          },
        },
      },
    },
  };
}
