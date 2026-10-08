-- PCargo — v7: consentimiento de datos personales de los clientes frecuentes
-- (Ley Orgánica de Protección de Datos Personales, Ecuador).
-- Guarda cuándo aceptó el titular que se conserven sus datos; NULL en los clientes anteriores a v7.

ALTER TABLE clientes ADD COLUMN consentimiento_en TIMESTAMPTZ;
