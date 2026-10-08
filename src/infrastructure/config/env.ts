import "dotenv/config";
import { z } from "zod";

const esquema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DB_DRIVER: z.enum(["postgres", "memory"]).default("postgres"),
  DATABASE_URL: z.string().default("postgres://pcargo:pcargo@localhost:5433/pcargo"),
  JWT_SECRET: z.string().min(16, "JWT_SECRET debe tener al menos 16 caracteres"),
  JWT_EXPIRES_IN: z.string().default("8h"),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
});

export type Config = z.infer<typeof esquema>;

export function cargarConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const r = esquema.safeParse(env);
  if (!r.success) {
    throw new Error(`Configuración inválida: ${r.error.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
  }
  return r.data;
}
