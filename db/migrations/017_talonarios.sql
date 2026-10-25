-- PCargo — v20: talonarios de guías en blanco.
--  Se reserva un bloque de números de guía consecutivos para imprimir guías vacías (número + QR) que se llenan a mano
--  en carretera y luego se registran como envíos con ese número. El consecutivo automático salta los reservados.
--  La reserva y el alta de envíos se serializan con un bloqueo consultivo (pg_advisory_xact_lock) en la aplicación.

CREATE TABLE talonarios (
  id         UUID PRIMARY KEY,
  desde      BIGINT      NOT NULL,
  hasta      BIGINT      NOT NULL,
  nota       TEXT CHECK (nota IS NULL OR length(nota) BETWEEN 1 AND 120),
  creado_en  TIMESTAMPTZ NOT NULL,
  creado_por TEXT,
  CONSTRAINT talonarios_rango CHECK (desde >= 1 AND hasta <= 999999999999 AND hasta >= desde AND hasta - desde < 50)
);
CREATE INDEX talonarios_creado_idx ON talonarios (creado_en DESC, id DESC);
CREATE INDEX talonarios_hasta_idx ON talonarios (hasta DESC);

-- Una fila por número reservado: la clave primaria garantiza que dos talonarios nunca compartan un número.
CREATE TABLE talonario_guias (
  numero_guia    BIGINT PRIMARY KEY,
  talonario_id   UUID        NOT NULL REFERENCES talonarios (id) ON DELETE CASCADE,
  estado         TEXT        NOT NULL DEFAULT 'DISPONIBLE' CHECK (estado IN ('DISPONIBLE', 'USADA', 'ANULADA')),
  envio_id       UUID UNIQUE REFERENCES envios (id),
  motivo         TEXT CHECK (motivo IS NULL OR length(motivo) BETWEEN 3 AND 200),
  actualizado_en TIMESTAMPTZ,
  CONSTRAINT talonario_guias_estado_datos CHECK (
    (estado = 'DISPONIBLE' AND envio_id IS NULL AND motivo IS NULL AND actualizado_en IS NULL)
    OR (estado = 'USADA' AND envio_id IS NOT NULL AND motivo IS NULL AND actualizado_en IS NOT NULL)
    OR (estado = 'ANULADA' AND envio_id IS NULL AND motivo IS NOT NULL AND actualizado_en IS NOT NULL)
  )
);
CREATE INDEX talonario_guias_talonario_idx ON talonario_guias (talonario_id, numero_guia);
-- Listado de talonarios abiertos (con alguna guía DISPONIBLE).
CREATE INDEX talonario_guias_disponibles_idx ON talonario_guias (talonario_id) WHERE estado = 'DISPONIBLE';

COMMENT ON TABLE talonarios IS 'Bloques de números de guía reservados para guías en blanco (v20).';
COMMENT ON COLUMN talonarios.creado_por IS 'Nombre de quien creó el talonario.';
