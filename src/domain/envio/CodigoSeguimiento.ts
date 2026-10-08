export const PATRON_CODIGO = /^PC-[A-Z0-9]{8}$/;
// Sin 0/O/1/I para evitar confusiones al dictar el código por teléfono.
const ALFABETO = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generarCodigoSeguimiento(aleatorio: () => number = Math.random): string {
  let sufijo = "";
  for (let i = 0; i < 8; i++) sufijo += ALFABETO[Math.floor(aleatorio() * ALFABETO.length)];
  return `PC-${sufijo}`;
}

export const normalizarCodigo = (codigo: string): string => codigo.trim().toUpperCase();
