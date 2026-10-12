-- PCargo — v9: dirección opcional del remitente y evidencia de entrega.
--  * envios.remitente_direccion: opcional (0–200), sale en la guía imprimible.
--  * envios.evidencia_*: metadatos de la foto de la guía firmada (el archivo vive en el almacén privado:
--    Cloudflare R2 o disco local) y nombre de quien recibió. O están todos o ninguno.

ALTER TABLE envios
  ADD COLUMN remitente_direccion TEXT
    CONSTRAINT envios_remitente_direccion_largo CHECK (remitente_direccion IS NULL OR length(remitente_direccion) <= 200),
  ADD COLUMN evidencia_recibido_por TEXT,
  ADD COLUMN evidencia_tipo         TEXT,
  ADD COLUMN evidencia_bytes        INT,
  ADD COLUMN evidencia_subida_en    TIMESTAMPTZ,
  ADD COLUMN evidencia_subida_por   UUID REFERENCES usuarios (id),
  ADD COLUMN evidencia_clave        TEXT;

ALTER TABLE envios
  ADD CONSTRAINT envios_evidencia_tipo_valido CHECK (
    evidencia_tipo IS NULL OR evidencia_tipo IN ('image/jpeg', 'image/png', 'image/webp')
  ),
  ADD CONSTRAINT envios_evidencia_completa CHECK (
    (evidencia_clave IS NULL AND evidencia_recibido_por IS NULL AND evidencia_tipo IS NULL
      AND evidencia_bytes IS NULL AND evidencia_subida_en IS NULL)
    OR
    (evidencia_clave IS NOT NULL AND evidencia_recibido_por IS NOT NULL AND evidencia_tipo IS NOT NULL
      AND evidencia_bytes > 0 AND evidencia_subida_en IS NOT NULL)
  );

COMMENT ON COLUMN envios.evidencia_clave IS 'Clave del archivo en el almacén privado (evidencias/<envioId>/<uuid>.<ext>). No se expone en la API.';
