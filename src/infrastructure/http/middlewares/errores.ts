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
};

export function manejarErrores(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof DomainError) {
    res.status(STATUS[err.code]).json({ error: { code: err.code, message: err.message } });
    return;
  }
  if (err instanceof ZodError) {
    const message = err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    res.status(400).json({ error: { code: "VALIDACION", message } });
    return;
  }
  if (err instanceof SyntaxError && "body" in err) {
    res.status(400).json({ error: { code: "VALIDACION", message: "JSON mal formado" } });
    return;
  }
  console.error(err);
  res.status(500).json({ error: { code: "ERROR_INTERNO", message: "Error interno del servidor" } });
}

export function noEncontrado(_req: Request, res: Response): void {
  res.status(404).json({ error: { code: "NO_ENCONTRADO", message: "Recurso no encontrado" } });
}
