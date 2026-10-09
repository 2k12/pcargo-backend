-- PCargo — v8: precio por unidad según el tipo de carga; la ruta ya no influye en el precio.
--  * tipos_carga: precio (urbano), precio rural opcional y precio por volumen (mayoreo) opcional.
--    Las columnas factor y peso_incluido_kg dejan de usarse: se conservan (nullable) por historial.
--  * Nuevos tipos TELA, PLUMON_PEQUENO, PLUMON_GRANDE; pesos máximos: paquete 50 kg, cartón 35 kg.
--  * envios.zona (URBANA | RURAL); los envíos existentes quedan URBANA y conservan su costo guardado.
--  * rutas.tarifa_base pasa a ser opcional (no se borra para no perder el dato histórico).
-- envio_items.tipo_carga es FK a tipos_carga(codigo): al insertar los tipos nuevos ya son válidos.

ALTER TABLE tipos_carga
  ADD COLUMN precio                   NUMERIC(8,2),
  ADD COLUMN precio_rural             NUMERIC(8,2),
  ADD COLUMN mayoreo_minimo_exclusivo INT,
  ADD COLUMN mayoreo_precio           NUMERIC(8,2),
  ADD COLUMN orden                    SMALLINT NOT NULL DEFAULT 0,
  ALTER COLUMN factor           DROP NOT NULL,
  ALTER COLUMN peso_incluido_kg DROP NOT NULL;

INSERT INTO tipos_carga
  (codigo, nombre, precio, precio_rural, mayoreo_minimo_exclusivo, mayoreo_precio, peso_max_kg, orden)
VALUES
  ('SOBRE',          'Sobre',          3.00, NULL, NULL, NULL,  0.5, 1),
  ('PAQUETE',        'Paquete',        3.00, NULL, NULL, NULL, 50,   2),
  ('CARTON',         'Cartón',         3.00, NULL, NULL, NULL, 35,   3),
  ('VALIJA',         'Valija',         3.00, NULL, NULL, NULL, 25,   4),
  ('TELA',           'Rollo de tela',  1.25, 1.50, 50,   1.00, 50,   5),
  ('PLUMON_PEQUENO', 'Plumón pequeño', 3.00, NULL, NULL, NULL, 50,   6),
  ('PLUMON_GRANDE',  'Plumón grande',  4.00, NULL, NULL, NULL, 50,   7)
ON CONFLICT (codigo) DO UPDATE SET
  nombre                   = EXCLUDED.nombre,
  precio                   = EXCLUDED.precio,
  precio_rural             = EXCLUDED.precio_rural,
  mayoreo_minimo_exclusivo = EXCLUDED.mayoreo_minimo_exclusivo,
  mayoreo_precio           = EXCLUDED.mayoreo_precio,
  peso_max_kg              = EXCLUDED.peso_max_kg,
  orden                    = EXCLUDED.orden;

-- Cualquier otro tipo que existiera fuera del catálogo conocido conserva un precio válido.
UPDATE tipos_carga SET precio = 3.00 WHERE precio IS NULL;

ALTER TABLE tipos_carga
  ALTER COLUMN precio SET NOT NULL,
  ADD CONSTRAINT tipos_carga_precio_positivo CHECK (precio > 0),
  ADD CONSTRAINT tipos_carga_precio_rural_positivo CHECK (precio_rural IS NULL OR precio_rural > 0),
  ADD CONSTRAINT tipos_carga_mayoreo_completo CHECK (
    (mayoreo_minimo_exclusivo IS NULL AND mayoreo_precio IS NULL) OR
    (mayoreo_minimo_exclusivo IS NOT NULL AND mayoreo_precio IS NOT NULL
     AND mayoreo_minimo_exclusivo >= 0 AND mayoreo_precio > 0)
  );

COMMENT ON COLUMN tipos_carga.factor IS 'Obsoleto desde v8 (precio por tipo); se conserva por historial.';
COMMENT ON COLUMN tipos_carga.peso_incluido_kg IS 'Obsoleto desde v8 (sin recargo por peso); se conserva por historial.';

ALTER TABLE envios
  ADD COLUMN zona TEXT NOT NULL DEFAULT 'URBANA'
  CONSTRAINT envios_zona_valida CHECK (zona IN ('URBANA', 'RURAL'));

ALTER TABLE rutas ALTER COLUMN tarifa_base DROP NOT NULL;
COMMENT ON COLUMN rutas.tarifa_base IS 'Obsoleto desde v8: la ruta no influye en el precio. Se conserva por historial.';
