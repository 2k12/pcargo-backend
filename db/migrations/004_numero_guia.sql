-- PCargo — v4: el número de la guía física (solo dígitos) reemplaza al código PC-XXXXXXXX.
-- Se guarda como entero, así 0040425 y 40425 son la misma guía.

ALTER TABLE envios ADD COLUMN numero_guia BIGINT;

-- Los envíos existentes reciben un consecutivo según su fecha de registro.
UPDATE envios e
   SET numero_guia = t.n
  FROM (SELECT id, row_number() OVER (ORDER BY creado_en, id) AS n FROM envios) t
 WHERE t.id = e.id;

ALTER TABLE envios ALTER COLUMN numero_guia SET NOT NULL;
ALTER TABLE envios ADD CONSTRAINT envios_numero_guia_key UNIQUE (numero_guia);
ALTER TABLE envios ADD CONSTRAINT envios_numero_guia_rango CHECK (numero_guia BETWEEN 1 AND 999999999999);

ALTER TABLE envios DROP COLUMN codigo;
