-- PCargo — v19: evidencia de entrega por partes.
--  El nombre de quien recibió y la foto de la guía firmada se cargan juntos o por separado (también después de
--  marcar ENTREGADO). Si hay evidencia (evidencia_subida_en no nulo) existe al menos el nombre o la foto; los
--  metadatos de la foto (clave, tipo, bytes) van juntos.

ALTER TABLE envios DROP CONSTRAINT envios_evidencia_completa;

ALTER TABLE envios
  ADD CONSTRAINT envios_evidencia_completa CHECK (
    (evidencia_subida_en IS NULL AND evidencia_recibido_por IS NULL AND evidencia_clave IS NULL
      AND evidencia_tipo IS NULL AND evidencia_bytes IS NULL)
    OR
    (evidencia_subida_en IS NOT NULL
      AND (evidencia_recibido_por IS NOT NULL OR evidencia_clave IS NOT NULL)
      AND (
        (evidencia_clave IS NULL AND evidencia_tipo IS NULL AND evidencia_bytes IS NULL)
        OR (evidencia_clave IS NOT NULL AND evidencia_tipo IS NOT NULL AND evidencia_bytes > 0)
      ))
  );
