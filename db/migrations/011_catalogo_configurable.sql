-- PCargo — v11: catálogo configurable por el ADMIN.
--  * tipos_carga: activo, actualizado_en, actualizado_por (orden ya existe desde 008 y se respeta tal cual).
--    Los tipos existentes quedan activos. Reglas del contrato como restricciones (NOT VALID: no se revalidan
--    filas antiguas, pero se exigen en toda inserción o cambio).
--  * tipos_carga_historial: alta, cambios, (des)activación y eliminación, con diff campo a campo. Sin FK al tipo:
--    el historial sobrevive a la eliminación.
--  * articulos_restringidos: «Qué no transportamos» de la landing, sembrado con la lista publicada en v9
--    (9 prohibidos, 3 condicionados, 2 notas). Mismos ids y textos que ARTICULOS_SEED (seed-data.ts).
-- Los envíos ya registrados no se tocan: conservan costo_unitario, subtotal y costo.

ALTER TABLE tipos_carga
  ADD COLUMN IF NOT EXISTS orden SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN activo          BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN actualizado_en  TIMESTAMPTZ,
  ADD COLUMN actualizado_por TEXT;

ALTER TABLE tipos_carga
  ADD CONSTRAINT tipos_carga_codigo_formato CHECK (codigo ~ '^[A-Z][A-Z0-9_]{1,29}$') NOT VALID,
  ADD CONSTRAINT tipos_carga_nombre_largo CHECK (char_length(nombre) BETWEEN 2 AND 40) NOT VALID,
  ADD CONSTRAINT tipos_carga_rangos CHECK (
    precio <= 1000
    AND (precio_rural IS NULL OR precio_rural <= 1000)
    AND peso_max_kg <= 1000
    AND (mayoreo_minimo_exclusivo IS NULL OR mayoreo_minimo_exclusivo BETWEEN 1 AND 9999)
    AND (mayoreo_precio IS NULL OR mayoreo_precio < precio)
  ) NOT VALID;

-- Nombre único sin distinguir mayúsculas (409 CONFLICTO).
CREATE UNIQUE INDEX tipos_carga_nombre_unico ON tipos_carga (lower(nombre));
-- Para saber rápido si un tipo se usa en algún envío (y para la FK al eliminar).
CREATE INDEX IF NOT EXISTS idx_envio_items_tipo_carga ON envio_items (tipo_carga);

CREATE TABLE tipos_carga_historial (
  id             UUID PRIMARY KEY,
  secuencia      BIGINT GENERATED ALWAYS AS IDENTITY,
  codigo         TEXT        NOT NULL,
  fecha          TIMESTAMPTZ NOT NULL DEFAULT now(),
  usuario_id     UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  usuario_nombre TEXT,
  accion         TEXT        NOT NULL
    CONSTRAINT tipos_carga_historial_accion CHECK (accion IN ('CREADO', 'MODIFICADO', 'ACTIVADO', 'DESACTIVADO', 'ELIMINADO')),
  cambios        JSONB       NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX idx_tipos_carga_historial_fecha  ON tipos_carga_historial (fecha DESC, secuencia DESC);
CREATE INDEX idx_tipos_carga_historial_codigo ON tipos_carga_historial (codigo, fecha DESC, secuencia DESC);

CREATE TABLE articulos_restringidos (
  id              UUID PRIMARY KEY,
  categoria       TEXT        NOT NULL
    CONSTRAINT articulos_categoria_valida CHECK (categoria IN ('PROHIBIDO', 'CONDICIONADO', 'NOTA')),
  titulo          TEXT        NOT NULL CONSTRAINT articulos_titulo_largo CHECK (char_length(titulo) BETWEEN 2 AND 80),
  detalle         TEXT        NOT NULL DEFAULT '' CONSTRAINT articulos_detalle_largo CHECK (char_length(detalle) <= 300),
  icono           TEXT
    CONSTRAINT articulos_icono_valido CHECK (icono IS NULL OR icono IN (
      'dinero', 'documento', 'joya', 'arma', 'explosivo', 'fuego', 'quimico', 'droga', 'animal',
      'prohibido', 'perecible', 'liquido', 'fragil', 'bateria', 'planta', 'medicina', 'electronico', 'alerta')),
  activo          BOOLEAN     NOT NULL DEFAULT TRUE,
  orden           INT         NOT NULL DEFAULT 0,
  actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_por TEXT,
  CONSTRAINT articulos_nota_sin_icono CHECK (categoria <> 'NOTA' OR icono IS NULL)
);

CREATE INDEX idx_articulos_restringidos_orden ON articulos_restringidos (categoria, orden);

-- Lista publicada en la landing (v9). En las notas, el texto publicado es titulo || ' ' || detalle.
INSERT INTO articulos_restringidos (id, categoria, orden, titulo, detalle, icono) VALUES
  ('00000000-0000-4000-8011-000000000001', 'PROHIBIDO', 1, 'Dinero en efectivo', 'Billetes ni monedas, en ninguna cantidad.', 'dinero'),
  ('00000000-0000-4000-8011-000000000002', 'PROHIBIDO', 2, 'Cheques y títulos valores', 'Cheques, letras, pagarés y otros documentos de valor negociable.', 'documento'),
  ('00000000-0000-4000-8011-000000000003', 'PROHIBIDO', 3, 'Joyas y metales preciosos', 'Oro, plata, piedras preciosas y alhajas.', 'joya'),
  ('00000000-0000-4000-8011-000000000004', 'PROHIBIDO', 4, 'Armas y municiones', 'Armas de cualquier tipo, municiones y sus partes.', 'arma'),
  ('00000000-0000-4000-8011-000000000005', 'PROHIBIDO', 5, 'Explosivos y pirotecnia', 'Pólvora, fuegos artificiales y material explosivo.', 'explosivo'),
  ('00000000-0000-4000-8011-000000000006', 'PROHIBIDO', 6, 'Sustancias peligrosas', 'Líquidos inflamables, gases, corrosivos y tóxicos.', 'fuego'),
  ('00000000-0000-4000-8011-000000000007', 'PROHIBIDO', 7, 'Drogas y sustancias fiscalizadas', 'Estupefacientes, psicotrópicos y sustancias sujetas a fiscalización.', 'droga'),
  ('00000000-0000-4000-8011-000000000008', 'PROHIBIDO', 8, 'Animales vivos', 'Mascotas, aves ni ningún otro animal.', 'animal'),
  ('00000000-0000-4000-8011-000000000009', 'PROHIBIDO', 9, 'Mercadería ilícita', 'Productos falsificados, de contrabando o de comercio prohibido.', 'prohibido'),
  ('00000000-0000-4000-8011-000000000010', 'CONDICIONADO', 1, 'Perecibles', 'Solo bien embalados y para entrega en el mismo día.', 'perecible'),
  ('00000000-0000-4000-8011-000000000011', 'CONDICIONADO', 2, 'Líquidos no peligrosos', 'Solo en envase sellado.', 'liquido'),
  ('00000000-0000-4000-8011-000000000012', 'CONDICIONADO', 3, 'Objetos frágiles', 'Con embalaje adecuado y declarando el contenido.', 'fragil'),
  ('00000000-0000-4000-8011-000000000013', 'NOTA', 1, 'Declara siempre el contenido real de tu envío.', 'Podemos pedir revisar un paquete antes de recibirlo.', NULL),
  ('00000000-0000-4000-8011-000000000014', 'NOTA', 2, 'No entregamos en apartados postales.', '', NULL);
