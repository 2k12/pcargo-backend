-- PCargo — esquema inicial
-- Gestión de encomiendas a domicilio en las rutas Ibarra / Atuntaqui / Otavalo / Quito.

CREATE TYPE rol_usuario  AS ENUM ('ADMIN', 'OPERADOR');
CREATE TYPE estado_envio AS ENUM ('REGISTRADO', 'EN_TRANSITO', 'EN_REPARTO', 'ENTREGADO', 'CANCELADO');

CREATE TABLE usuarios (
  id            UUID PRIMARY KEY,
  nombre        TEXT        NOT NULL,
  email         TEXT        NOT NULL UNIQUE,
  password_hash TEXT        NOT NULL,
  rol           rol_usuario NOT NULL DEFAULT 'OPERADOR',
  activo        BOOLEAN     NOT NULL DEFAULT TRUE,
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ciudades (
  id     SERIAL PRIMARY KEY,
  nombre TEXT NOT NULL UNIQUE
);

-- Catálogo de lo que se transporta: sobres, paquetes, cartones, valijas.
CREATE TABLE tipos_carga (
  codigo           TEXT PRIMARY KEY,
  nombre           TEXT         NOT NULL,
  factor           NUMERIC(4,2) NOT NULL CHECK (factor > 0),
  peso_incluido_kg NUMERIC(6,2) NOT NULL CHECK (peso_incluido_kg >= 0),
  peso_max_kg      NUMERIC(6,2) NOT NULL CHECK (peso_max_kg > 0)
);

CREATE TABLE rutas (
  id                  SERIAL PRIMARY KEY,
  origen_id           INT          NOT NULL REFERENCES ciudades(id),
  destino_id          INT          NOT NULL REFERENCES ciudades(id),
  tarifa_base         NUMERIC(8,2) NOT NULL CHECK (tarifa_base > 0),
  tiempo_estimado_min INT          NOT NULL CHECK (tiempo_estimado_min > 0),
  activa              BOOLEAN      NOT NULL DEFAULT TRUE,
  UNIQUE (origen_id, destino_id)
);

CREATE TABLE envios (
  id                     UUID PRIMARY KEY,
  codigo                 VARCHAR(11)   NOT NULL UNIQUE,
  remitente_nombre       TEXT          NOT NULL,
  remitente_telefono     TEXT          NOT NULL,
  destinatario_nombre    TEXT          NOT NULL,
  destinatario_telefono  TEXT          NOT NULL,
  destinatario_direccion TEXT          NOT NULL,
  ruta_id                INT           NOT NULL REFERENCES rutas(id),
  tipo_carga             TEXT          NOT NULL REFERENCES tipos_carga(codigo),
  peso_kg                NUMERIC(6,2)  NOT NULL CHECK (peso_kg > 0),
  descripcion            TEXT,
  costo                  NUMERIC(10,2) NOT NULL CHECK (costo >= 0),
  estado                 estado_envio  NOT NULL DEFAULT 'REGISTRADO',
  creado_por             UUID REFERENCES usuarios(id),
  creado_en              TIMESTAMPTZ   NOT NULL DEFAULT now(),
  actualizado_en         TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX idx_envios_estado    ON envios (estado);
CREATE INDEX idx_envios_ruta      ON envios (ruta_id);
CREATE INDEX idx_envios_creado_en ON envios (creado_en DESC);

CREATE TABLE historial_estados (
  id         BIGSERIAL PRIMARY KEY,
  envio_id   UUID         NOT NULL REFERENCES envios(id) ON DELETE CASCADE,
  estado     estado_envio NOT NULL,
  nota       TEXT,
  usuario_id UUID REFERENCES usuarios(id),
  fecha      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_historial_envio ON historial_estados (envio_id, fecha);
