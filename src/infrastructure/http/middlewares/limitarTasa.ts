import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { LimitadorTasa } from "../../../application/ports/cache.js";

export interface ReglaTasa {
  /** Prefijo de la clave en el almacén, p. ej. "login". */
  nombre: string;
  limite: number;
  ventanaSeg: number;
  /** Qué identifica al cliente; por defecto su IP. `res.locals.actor` está disponible tras `autenticar`. */
  clave?: (req: Request, res: Response) => string;
}

/** Límites de la API. Protegen el login de fuerza bruta y los endpoints públicos de abuso. */
export const REGLAS = {
  /** Por IP y correo: varios operadores pueden salir a internet por la misma IP de la oficina. */
  login: {
    nombre: "login",
    limite: 10,
    ventanaSeg: 15 * 60,
    clave: (req: Request) => `${req.ip}:${String(req.body?.email ?? "").trim().toLowerCase()}`,
  },
  /** Landing y rastreo público (cotizar, catálogo, seguimiento). */
  publico: { nombre: "publico", limite: 60, ventanaSeg: 60 },
  /** Cambio de contraseña: por usuario autenticado (frena adivinar la actual con un token robado). */
  contrasena: {
    nombre: "contrasena",
    limite: 10,
    ventanaSeg: 15 * 60,
    clave: (req: Request, res: Response) => String((res.locals.actor as { id?: string } | undefined)?.id ?? req.ip),
  },
} satisfies Record<string, ReglaTasa>;

/** Responde 429 `DEMASIADAS_SOLICITUDES` con `Retry-After` cuando se supera la regla. */
export function limitarTasa(limitador: LimitadorTasa, regla: ReglaTasa): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const cliente = regla.clave?.(req, res) ?? req.ip ?? "desconocido";
    const r = await limitador.consumir(`${regla.nombre}:${cliente}`, regla.limite, regla.ventanaSeg);
    res.setHeader("RateLimit-Limit", regla.limite);
    res.setHeader("RateLimit-Remaining", r.restantes);
    res.setHeader("RateLimit-Reset", r.reintentarEnSeg);
    if (r.permitido) return next();
    res.setHeader("Retry-After", r.reintentarEnSeg);
    res.status(429).json({
      error: {
        code: "DEMASIADAS_SOLICITUDES",
        message: `Demasiadas solicitudes. Intenta de nuevo en ${Math.ceil(r.reintentarEnSeg / 60)} min.`,
      },
    });
  };
}
