import type { NextFunction, Request, Response } from "express";
import type { TokenService } from "../../../application/ports/services.js";
import { DomainError } from "../../../domain/shared/DomainError.js";
import type { Actor } from "../../../domain/usuario/Usuario.js";

export const autenticar =
  (tokens: TokenService) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const [tipo, token] = (req.headers.authorization ?? "").split(" ");
    if (tipo !== "Bearer" || !token) throw new DomainError("NO_AUTENTICADO", "Falta el token de acceso");
    res.locals.actor = tokens.verificar(token);
    next();
  };

/** Devuelve el actor autenticado; solo usar en rutas protegidas por `autenticar`. */
export const actorDe = (res: Response): Actor => res.locals.actor as Actor;
