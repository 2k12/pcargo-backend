-- PCargo — v21: número del sistema y guía física separados.
--  * `envios.guia_fisica`: número impreso en una guía de papel antigua (preimpresa). Opcional y único entre envíos;
--    puede coincidir con el `numero_guia` de otro envío (son numeraciones distintas).
--  * `secuencia_guias`: contador propio del consecutivo automático. El siguiente número es el menor n > ultimo que no
--    está ocupado por ningún envío ni talonario; luego ultimo = n (un talonario toma el primer bloque contiguo libre y
--    ultimo pasa a su final). Se lee y actualiza bajo el bloqueo consultivo de números de guía (pg_advisory_xact_lock).
--  Los envíos existentes no cambian (guia_fisica NULL) y el contador arranca en 0: la numeración del sistema vuelve a
--  ser corta (1, 2, 3…) saltando los números ya ocupados.

ALTER TABLE envios ADD COLUMN guia_fisica BIGINT;
ALTER TABLE envios ADD CONSTRAINT envios_guia_fisica_rango CHECK (guia_fisica IS NULL OR guia_fisica BETWEEN 1 AND 999999999999);
CREATE UNIQUE INDEX envios_guia_fisica_key ON envios (guia_fisica) WHERE guia_fisica IS NOT NULL;

CREATE TABLE secuencia_guias (
  id     SMALLINT PRIMARY KEY CHECK (id = 1),
  ultimo BIGINT   NOT NULL CHECK (ultimo >= 0)
);
INSERT INTO secuencia_guias (id, ultimo) VALUES (1, 0);

COMMENT ON COLUMN envios.guia_fisica IS 'Número de la guía física antigua (v21), único; NULL si no tuvo.';
COMMENT ON TABLE secuencia_guias IS 'Contador del consecutivo automático de números de guía (v21), una sola fila.';
