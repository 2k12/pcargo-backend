import type { NextFunction, Request, Response } from "express";
import { DomainError } from "../../../domain/shared/DomainError.js";
import { exigirRol, type Actor, type Rol } from "../../../domain/usuario/Usuario.js";

/** Resuelve el actor de un token (verifica el JWT y que el usuario siga activo). */
export interface ResolutorSesion {
  ejecutar(token: string): Promise<Actor>;
}

/**
 * Exige `Authorization: Bearer <JWT>` de un usuario ACTIVO: si el ADMIN lo desactiva, su token deja de valer en la
 * siguiente solicitud (401). El rol y el cliente del actor son los vigentes, no los del token.
 */
export const autenticar =
  (sesion: ResolutorSesion) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const [tipo, token] = (req.headers.authorization ?? "").split(" ");
    if (tipo !== "Bearer" || !token) throw new DomainError("NO_AUTENTICADO", "Falta el token de acceso");
    res.locals.actor = await sesion.ejecutar(token);
    next();
  };

/** Solo los roles indicados; cualquier otro → 403 PROHIBIDO. Va después de `autenticar`. */
export const exigirRoles =
  (...roles: Rol[]) =>
  (_req: Request, res: Response, next: NextFunction): void => {
    exigirRol(actorDe(res), roles);
    next();
  };

/** Devuelve el actor autenticado; solo usar en rutas protegidas por `autenticar`. */
export const actorDe = (res: Response): Actor => res.locals.actor as Actor;
