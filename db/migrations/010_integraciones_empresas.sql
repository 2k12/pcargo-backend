-- PCargo — v10: integraciones con otras empresas (API con API keys, idempotencia, auditoría y webhooks).
--  * integraciones: empresa con remitente fijo, ciudad de origen, forma de pago por defecto, IPs permitidas y
--    webhook opcional (secreto cifrado con AES-256-GCM; nunca en claro).
--  * api_keys: solo prefijo público y SHA-256 de la key.
--  * api_idempotencia: respuestas reproducibles 24 h por (integración, modo, Idempotency-Key).
--  * api_solicitudes: auditoría (sin key ni body), se purga a los 90 días.
--  * webhook_entregas: outbox persistente de webhooks con reintentos.
--  * envios.integracion_id / referencia_externa: los envíos existentes quedan sin integración = canal PANEL.

CREATE TABLE integraciones (
  id                      UUID PRIMARY KEY,
  nombre                  TEXT        NOT NULL CHECK (length(nombre) BETWEEN 2 AND 80),
  activa                  BOOLEAN     NOT NULL DEFAULT TRUE,
  remitente_nombre        TEXT        NOT NULL,
  remitente_telefono      TEXT        NOT NULL,
  remitente_direccion     TEXT        NOT NULL CHECK (length(remitente_direccion) <= 200),
  ciudad_origen_id        INT         NOT NULL REFERENCES ciudades (id),
  forma_pago_defecto      forma_pago  NOT NULL DEFAULT 'CONTRATO',
  cliente_id              UUID        REFERENCES clientes (id) ON DELETE SET NULL,
  ips_permitidas          TEXT[]      NOT NULL DEFAULT '{}',
  webhook_url             TEXT,
  webhook_eventos         TEXT[],
  webhook_activo          BOOLEAN,
  webhook_secreto_cifrado TEXT,
  webhook_secreto_prefijo TEXT,
  creada_en               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT integraciones_webhook_completo CHECK (
    (webhook_url IS NULL AND webhook_eventos IS NULL AND webhook_activo IS NULL
      AND webhook_secreto_cifrado IS NULL AND webhook_secreto_prefijo IS NULL)
    OR
    (webhook_url IS NOT NULL AND cardinality(webhook_eventos) >= 1 AND webhook_activo IS NOT NULL
      AND webhook_secreto_cifrado IS NOT NULL AND webhook_secreto_prefijo IS NOT NULL)
  ),
  CONSTRAINT integraciones_webhook_eventos_validos CHECK (
    webhook_eventos IS NULL
    OR webhook_eventos <@ ARRAY['envio.creado', 'envio.estado_actualizado', 'envio.evidencia_registrada']::TEXT[]
  )
);

CREATE UNIQUE INDEX integraciones_nombre_key ON integraciones (lower(nombre));

CREATE TABLE api_keys (
  id             UUID PRIMARY KEY,
  integracion_id UUID        NOT NULL REFERENCES integraciones (id) ON DELETE CASCADE,
  nombre         TEXT        NOT NULL CHECK (length(nombre) BETWEEN 2 AND 60),
  modo           TEXT        NOT NULL CHECK (modo IN ('live', 'test')),
  prefijo        TEXT        NOT NULL UNIQUE CHECK (prefijo ~ '^pc_(live|test)_[0-9A-Za-z]{8}$'),
  hash_sha256    TEXT        NOT NULL CHECK (hash_sha256 ~ '^[0-9a-f]{64}$'),
  alcances       TEXT[]      NOT NULL CHECK (
                   cardinality(alcances) >= 1 AND alcances <@ ARRAY['envios:crear', 'envios:leer', 'cotizar']::TEXT[]
                 ),
  creada_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ultimo_uso_en  TIMESTAMPTZ,
  revocada_en    TIMESTAMPTZ
);

CREATE INDEX api_keys_integracion_idx ON api_keys (integracion_id);

COMMENT ON COLUMN api_keys.hash_sha256 IS 'SHA-256 (hex) de la key completa. La key en claro solo se muestra al crearla.';

CREATE TABLE api_idempotencia (
  integracion_id UUID        NOT NULL REFERENCES integraciones (id) ON DELETE CASCADE,
  modo           TEXT        NOT NULL CHECK (modo IN ('live', 'test')),
  clave          TEXT        NOT NULL CHECK (length(clave) BETWEEN 1 AND 255),
  huella         TEXT        NOT NULL,
  estado         TEXT        NOT NULL CHECK (estado IN ('EN_PROCESO', 'COMPLETADA')),
  status         INT,
  -- Texto exacto de la respuesta (no JSONB, que reordena las claves): el replay devuelve el mismo body.
  respuesta      TEXT,
  creado_en      TIMESTAMPTZ NOT NULL,
  actualizado_en TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (integracion_id, modo, clave),
  CONSTRAINT api_idempotencia_completa CHECK (estado = 'EN_PROCESO' OR (status IS NOT NULL AND respuesta IS NOT NULL))
);

CREATE INDEX api_idempotencia_creado_idx ON api_idempotencia (creado_en);

CREATE TABLE api_solicitudes (
  id                 UUID PRIMARY KEY,
  integracion_id     UUID        REFERENCES integraciones (id) ON DELETE CASCADE,
  fecha              TIMESTAMPTZ NOT NULL,
  metodo             TEXT        NOT NULL,
  ruta               TEXT        NOT NULL,
  status             INT         NOT NULL,
  ip                 TEXT        NOT NULL,
  key_prefijo        TEXT,
  idempotency_key    TEXT,
  referencia_externa TEXT,
  duracion_ms        INT         NOT NULL,
  request_id         UUID        NOT NULL
);

CREATE INDEX api_solicitudes_integracion_idx ON api_solicitudes (integracion_id, fecha DESC, id DESC);
CREATE INDEX api_solicitudes_fecha_idx ON api_solicitudes (fecha);

ALTER TABLE envios
  ADD COLUMN integracion_id     UUID REFERENCES integraciones (id),
  ADD COLUMN referencia_externa TEXT
    CONSTRAINT envios_referencia_externa_formato CHECK (referencia_externa ~ '^[A-Za-z0-9._/#-]{1,64}$'),
  ADD CONSTRAINT envios_integracion_referencia_key UNIQUE (integracion_id, referencia_externa),
  ADD CONSTRAINT envios_referencia_con_integracion CHECK ((integracion_id IS NULL) = (referencia_externa IS NULL));

CREATE INDEX idx_envios_integracion ON envios (integracion_id, creado_en DESC) WHERE integracion_id IS NOT NULL;
CREATE INDEX idx_envios_referencia_trgm ON envios USING gin (referencia_externa gin_trgm_ops);

CREATE TABLE webhook_entregas (
  id                 UUID PRIMARY KEY,
  integracion_id     UUID        NOT NULL REFERENCES integraciones (id) ON DELETE CASCADE,
  mensaje_id         TEXT        NOT NULL UNIQUE,
  evento             TEXT        NOT NULL CHECK (evento IN ('envio.creado', 'envio.estado_actualizado', 'envio.evidencia_registrada')),
  envio_id           UUID        REFERENCES envios (id) ON DELETE SET NULL,
  numero_guia        BIGINT,
  cuerpo             TEXT        NOT NULL,
  prueba             BOOLEAN     NOT NULL DEFAULT FALSE,
  estado             TEXT        NOT NULL CHECK (estado IN ('PENDIENTE', 'ENTREGADO', 'FALLIDO')),
  intentos           INT         NOT NULL DEFAULT 0 CHECK (intentos >= 0),
  ultimo_status      INT,
  ultimo_error       TEXT,
  proximo_intento_en TIMESTAMPTZ,
  bloqueado_hasta    TIMESTAMPTZ,
  creado_en          TIMESTAMPTZ NOT NULL,
  entregado_en       TIMESTAMPTZ
);

CREATE INDEX webhook_entregas_pendientes_idx ON webhook_entregas (proximo_intento_en) WHERE estado = 'PENDIENTE';
CREATE INDEX webhook_entregas_integracion_idx ON webhook_entregas (integracion_id, creado_en DESC, id DESC);
