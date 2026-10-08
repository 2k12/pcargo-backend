-- PCargo — v2: envíos con varios ítems (cantidad por tipo), forma de pago y estados NO_ENTREGADO / NOVEDAD.

ALTER TYPE estado_envio ADD VALUE IF NOT EXISTS 'NO_ENTREGADO';
ALTER TYPE estado_envio ADD VALUE IF NOT EXISTS 'NOVEDAD';

CREATE TYPE forma_pago AS ENUM ('PAGADO', 'AL_COBRO', 'CONTRATO', 'SEGURO');

-- Ítems: p. ej. 5 paquetes de 2 kg + 20 cartones de 8 kg. Inmutables tras registrar el envío.
CREATE TABLE envio_items (
  id               BIGSERIAL PRIMARY KEY,
  envio_id         UUID          NOT NULL REFERENCES envios(id) ON DELETE CASCADE,
  linea            SMALLINT      NOT NULL CHECK (linea > 0),
  tipo_carga       TEXT          NOT NULL REFERENCES tipos_carga(codigo),
  cantidad         INT           NOT NULL CHECK (cantidad BETWEEN 1 AND 999),
  peso_unitario_kg NUMERIC(6,2)  NOT NULL CHECK (peso_unitario_kg > 0),
  costo_unitario   NUMERIC(10,2) NOT NULL CHECK (costo_unitario >= 0),
  subtotal         NUMERIC(10,2) NOT NULL CHECK (subtotal >= 0),
  UNIQUE (envio_id, linea)
);

-- Los envíos existentes (1 pieza) pasan a tener un ítem con cantidad 1.
INSERT INTO envio_items (envio_id, linea, tipo_carga, cantidad, peso_unitario_kg, costo_unitario, subtotal)
SELECT id, 1, tipo_carga, 1, peso_kg, costo, costo FROM envios;

ALTER TABLE envios ADD COLUMN forma_pago forma_pago NOT NULL DEFAULT 'PAGADO';
ALTER TABLE envios ALTER COLUMN forma_pago DROP DEFAULT;

-- Totales desnormalizados para listados y reportes.
ALTER TABLE envios ADD COLUMN total_piezas INT NOT NULL DEFAULT 1 CHECK (total_piezas > 0);
ALTER TABLE envios ALTER COLUMN total_piezas DROP DEFAULT;
ALTER TABLE envios RENAME COLUMN peso_kg TO peso_total_kg;
ALTER TABLE envios ALTER COLUMN peso_total_kg TYPE NUMERIC(10,2);
ALTER TABLE envios DROP COLUMN tipo_carga;

CREATE INDEX idx_envios_forma_pago ON envios (forma_pago);
CREATE INDEX idx_envio_items_envio ON envio_items (envio_id);
