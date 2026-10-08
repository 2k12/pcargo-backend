import "dotenv/config";
import { z } from "zod";

const esquema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DB_DRIVER: z.enum(["postgres", "memory"]).default("postgres"),
  DATABASE_URL: z.string().default("postgres://pcargo:pcargo@localhost:5433/pcargo"),
  JWT_SECRET: z.string().min(16, "JWT_SECRET debe tener al menos 16 caracteres"),
  JWT_EXPIRES_IN: z.string().default("8h"),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  /** Redis para caché y límite de tasa compartidos entre instancias. Sin él se usan en memoria. */
  REDIS_URL: z.string().optional(),
  /** redis | memory | none. Por defecto: redis si hay REDIS_URL, si no memory. */
  CACHE_DRIVER: z.enum(["redis", "memory", "none"]).optional(),
  /** Saltos de proxy inverso de confianza, para leer la IP real del cliente (0 = ninguno). */
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
});

export type Config = Omit<z.infer<typeof esquema>, "CACHE_DRIVER"> & { CACHE_DRIVER: "redis" | "memory" | "none" };

export function cargarConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const r = esquema.safeParse(env);
  if (!r.success) {
    throw new Error(`Configuración inválida: ${r.error.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
  }
  const config = r.data;
  if (config.CACHE_DRIVER === "redis" && !config.REDIS_URL) {
    throw new Error("Configuración inválida: CACHE_DRIVER=redis requiere REDIS_URL");
  }
  return { ...config, CACHE_DRIVER: config.CACHE_DRIVER ?? (config.REDIS_URL ? "redis" : "memory") };
}
