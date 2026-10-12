import "dotenv/config";
import { join, resolve } from "node:path";
import { z } from "zod";

/** <raíz del backend>/storage, igual desde src/ (tsx) y dist/ (build). */
export const CARPETA_STORAGE_DEFECTO = join(import.meta.dirname, "..", "..", "..", "storage");

const opcionalNoVacio = z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().optional());

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
  /** Almacén de archivos (evidencias de entrega): local | r2 | memory. Por defecto local (memory con DB_DRIVER=memory). */
  STORAGE_DRIVER: opcionalNoVacio.pipe(z.enum(["local", "r2", "memory"]).optional()),
  /** Carpeta del almacén local; relativa al directorio de trabajo. Por defecto <backend>/storage. */
  STORAGE_LOCAL_DIR: opcionalNoVacio,
  /** Cloudflare R2 (obligatorias con STORAGE_DRIVER=r2). */
  R2_ACCOUNT_ID: opcionalNoVacio,
  R2_ACCESS_KEY_ID: opcionalNoVacio,
  R2_SECRET_ACCESS_KEY: opcionalNoVacio,
  R2_BUCKET: opcionalNoVacio,
});

type StorageDriver = "local" | "r2" | "memory";

export type Config = Omit<z.infer<typeof esquema>, "CACHE_DRIVER" | "STORAGE_DRIVER" | "STORAGE_LOCAL_DIR"> & {
  CACHE_DRIVER: "redis" | "memory" | "none";
  STORAGE_DRIVER: StorageDriver;
  /** Ruta absoluta. */
  STORAGE_LOCAL_DIR: string;
};

const VARIABLES_R2 = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"] as const;

export function cargarConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const r = esquema.safeParse(env);
  if (!r.success) {
    throw new Error(`Configuración inválida: ${r.error.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
  }
  const config = r.data;
  if (config.CACHE_DRIVER === "redis" && !config.REDIS_URL) {
    throw new Error("Configuración inválida: CACHE_DRIVER=redis requiere REDIS_URL");
  }
  const storage: StorageDriver = config.STORAGE_DRIVER ?? (config.DB_DRIVER === "memory" ? "memory" : "local");
  if (storage === "r2") {
    const faltan = VARIABLES_R2.filter((v) => !config[v]);
    if (faltan.length) {
      throw new Error(`Configuración inválida: STORAGE_DRIVER=r2 requiere ${faltan.join(", ")}`);
    }
  }
  return {
    ...config,
    CACHE_DRIVER: config.CACHE_DRIVER ?? (config.REDIS_URL ? "redis" : "memory"),
    STORAGE_DRIVER: storage,
    STORAGE_LOCAL_DIR: config.STORAGE_LOCAL_DIR ? resolve(config.STORAGE_LOCAL_DIR) : CARPETA_STORAGE_DEFECTO,
  };
}
