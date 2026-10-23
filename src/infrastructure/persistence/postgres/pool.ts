import pg from "pg";

// NUMERIC llega como string por defecto; lo convertimos a number (montos y pesos son pequeños).
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number.parseFloat(v));
// DATE llegaría como Date en la zona horaria del proceso; se deja como texto `AAAA-MM-DD` (fecha de la guía, v18).
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export type Db = pg.Pool;

export const crearPool = (connectionString: string): pg.Pool => new pg.Pool({ connectionString, max: 10 });
