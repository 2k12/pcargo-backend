import type { ModoKey } from "./Integracion.js";

// Formato de las API keys: pc_live_<prefijo>_<secreto> | pc_test_<prefijo>_<secreto>
// prefijo: 8 caracteres base62 (identifica la key; se guarda en claro) · secreto: 32 base62 (solo se guarda su hash).

export const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const LARGO_PREFIJO = 8;
export const LARGO_SECRETO = 32;

const FORMATO = /^pc_(live|test)_([0-9A-Za-z]{8})_([0-9A-Za-z]{32})$/;

export interface ApiKeyDesarmada {
  modo: ModoKey;
  /** `pc_live_Ab3dE6gH`: lo que se guarda y se muestra en el panel. */
  prefijo: string;
}

/** `null` si el texto no tiene el formato de una key (no revela por qué). */
export function desarmarApiKey(texto: string): ApiKeyDesarmada | null {
  if (typeof texto !== "string" || texto.length > 64) return null;
  const m = FORMATO.exec(texto);
  if (!m) return null;
  const modo = m[1] as ModoKey;
  return { modo, prefijo: `pc_${modo}_${m[2]}` };
}

export const armarApiKey = (modo: ModoKey, prefijo8: string, secreto32: string): string =>
  `pc_${modo}_${prefijo8}_${secreto32}`;
