-- PCargo — v6: clientes frecuentes y su relación con los envíos.

CREATE TABLE clientes (
  id         UUID PRIMARY KEY,
  nombre     TEXT        NOT NULL CHECK (length(trim(nombre)) >= 2),
  telefono   TEXT        NOT NULL,
  direccion  TEXT,
  notas      TEXT,
  creado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- El teléfono identifica al cliente: "099 123 4567" y "0991234567" son el mismo.
CREATE UNIQUE INDEX clientes_telefono_key ON clientes ((regexp_replace(telefono, '[^0-9]', '', 'g')));
CREATE INDEX clientes_nombre_idx ON clientes (lower(nombre));

-- Al eliminar un cliente sus envíos se conservan, sin cliente asociado.
ALTER TABLE envios ADD COLUMN cliente_id UUID REFERENCES clientes (id) ON DELETE SET NULL;
CREATE INDEX envios_cliente_idx ON envios (cliente_id);
