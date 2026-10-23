-- PCargo — v18: fecha de la guía (AAAA-MM-DD, día de Ecuador UTC−5). Al crear desde el panel se puede elegir hoy o
-- hasta 90 días después (lo valida el dominio). El filtro desde/hasta de GET /envios la usa en lugar del registro.
-- Los envíos existentes toman el día (Ecuador) de su fecha de registro. El valor por defecto (hoy en Ecuador) solo
-- cubre inserciones directas en SQL: la aplicación siempre la envía.
ALTER TABLE envios ADD COLUMN fecha_guia DATE;

UPDATE envios SET fecha_guia = ((creado_en AT TIME ZONE 'UTC') - INTERVAL '5 hours')::date;

ALTER TABLE envios
  ALTER COLUMN fecha_guia SET DEFAULT (((now() AT TIME ZONE 'UTC') - INTERVAL '5 hours')::date),
  ALTER COLUMN fecha_guia SET NOT NULL;

-- Listado del panel por día (y reporte diario): rango por fecha de la guía, más recientes primero.
CREATE INDEX envios_fecha_guia_idx ON envios (fecha_guia, creado_en DESC, id DESC);
