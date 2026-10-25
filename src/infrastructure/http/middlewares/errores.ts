import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { DomainError, type ErrorCode } from "../../../domain/shared/DomainError.js";

const STATUS: Record<ErrorCode, number> = {
  VALIDACION: 400,
  NO_AUTENTICADO: 401,
  CREDENCIALES_INVALIDAS: 401,
  PROHIBIDO: 403,
  NO_ENCONTRADO: 404,
  CONFLICTO: 409,
  TRANSICION_INVALIDA: 422,
  PESO_INVALIDO: 422,
  RUTA_INACTIVA: 422,
  ESTADO_INVALIDO: 422,
  CONTRASENA_INCORRECTA: 422,
  API_KEY_INVALIDA: 401,
  ALCANCE_INSUFICIENTE: 403,
  IP_NO_PERMITIDA: 403,
  INTEGRACION_INACTIVA: 403,
  IDEMPOTENCIA_CONFLICTO: 422,
  IDEMPOTENCIA_EN_PROCESO: 409,
  RUTA_NO_DISPONIBLE: 422,
  SERVICIO_NO_CONFIGURADO: 503,
  TIPO_CARGA_INACTIVO: 422,
  SIN_COBROS: 422,
  GUIA_ANULADA: 422,
};

export interface RespuestaError {
  status: number;
  body: { error: { code: string; message: string } & Record<string, unknown> };
}

/** Traduce un error conocido (de negocio, de forma o del parser de JSON) a status + body; null si es inesperado. */
export function respuestaDeError(err: unknown): RespuestaError | null {
  if (err instanceof DomainError) {
    // VALIDACION de una regla de negocio (datos bien formados pero no admitidos) → 422
    const status = err.code === "VALIDACION" && err.regla ? 422 : STATUS[err.code];
    return { status, body: { error: { code: err.code, message: err.message, ...(err.detalles ?? {}) } } };
  }
  if (err instanceof ZodError) {
    const message = err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    return { status: 400, body: { error: { code: "VALIDACION", message } } };
  }
  const tipo = (err as { type?: string } | null)?.type;
  if (tipo === "entity.too.large") {
    return { status: 400, body: { error: { code: "VALIDACION", message: "El cuerpo de la solicitud es demasiado grande" } } };
  }
  if ((err instanceof SyntaxError && "body" in err) || tipo === "entity.parse.failed") {
    return { status: 400, body: { error: { code: "VALIDACION", message: "JSON mal formado" } } };
  }
  return null;
}

export function manejarErrores(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const r = respuestaDeError(err);
  if (r) {
    res.status(r.status).json(r.body);
    return;
  }
  console.error(err);
  res.status(500).json({ error: { code: "ERROR_INTERNO", message: "Error interno del servidor" } });
}

export function noEncontrado(_req: Request, res: Response): void {
  res.status(404).json({ error: { code: "NO_ENCONTRADO", message: "Recurso no encontrado" } });
}
