-- Paginación del listado de envíos en el servidor (contrato v5).
-- El listado ordena por (creado_en DESC, id DESC): el id desempata envíos con la misma fecha para que
-- LIMIT/OFFSET no repita ni salte filas entre páginas, y este índice sirve ese orden sin ordenar en memoria.
CREATE INDEX IF NOT EXISTS idx_envios_creado_en_id ON envios (creado_en DESC, id DESC);
DROP INDEX IF EXISTS idx_envios_creado_en;

-- Búsqueda por remitente/destinatario (ILIKE '%texto%'): con muchos registros un índice trigram evita
-- recorrer toda la tabla. pg_trgm es una extensión "trusted" (PostgreSQL 13+): el dueño de la BD puede crearla.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_envios_remitente_trgm ON envios USING gin (remitente_nombre gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_envios_destinatario_trgm ON envios USING gin (destinatario_nombre gin_trgm_ops);
