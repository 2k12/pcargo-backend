import type { NextFunction, Request, RequestHandler, Response } from "express";
import multer from "multer";
import { MAX_BYTES_EVIDENCIA } from "../../../domain/envio/Evidencia.js";
import { DomainError } from "../../../domain/shared/DomainError.js";

const MENSAJES: Partial<Record<multer.ErrorCode, string>> = {
  LIMIT_FILE_SIZE: "La foto no puede pesar más de 5 MB",
  LIMIT_FILE_COUNT: "Solo se admite una foto",
  LIMIT_UNEXPECTED_FILE: "Campo de archivo inesperado (use \"foto\")",
  LIMIT_FIELD_VALUE: "Un campo del formulario es demasiado largo",
};

/**
 * `multipart/form-data` con un único archivo en memoria (como máximo 5 MB, el campo `name`).
 * Los errores de multer/busboy (tamaño, campo inesperado, formulario mal formado) se responden como
 * 400 VALIDACION con el formato de error uniforme, en vez de 413/500 genéricos.
 */
export function subirArchivo(campo: string, maxBytes = MAX_BYTES_EVIDENCIA): RequestHandler {
  const subida = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1, fields: 10, fieldSize: 10 * 1024, parts: 12 },
  }).single(campo);
  return (req: Request, res: Response, next: NextFunction) => {
    subida(req, res, (err?: unknown) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        return next(new DomainError("VALIDACION", MENSAJES[err.code] ?? `Formulario inválido: ${err.message}`));
      }
      next(new DomainError("VALIDACION", "Formulario multipart mal formado"));
    });
  };
}

/** Bytes del archivo subido (o `null` si no se adjuntó). */
export const bytesSubidos = (req: Request): Uint8Array | null =>
  req.file ? new Uint8Array(req.file.buffer.buffer, req.file.buffer.byteOffset, req.file.buffer.length) : null;
