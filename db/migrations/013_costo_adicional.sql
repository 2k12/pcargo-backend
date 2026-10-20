-- PCargo — v15: costo adicional opcional al crear un envío desde el panel (recargo acordado en USD).
-- Ya está incluido en `costo`; se guarda aparte para mostrarlo. Los envíos anteriores quedan en 0.
ALTER TABLE envios
  ADD COLUMN costo_adicional NUMERIC(10, 2) NOT NULL DEFAULT 0,
  ADD CONSTRAINT envios_costo_adicional_valido CHECK (costo_adicional >= 0 AND costo_adicional <= 9999.99);
