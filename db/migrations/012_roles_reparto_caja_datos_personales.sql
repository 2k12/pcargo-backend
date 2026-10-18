-- PCargo — v12: usuarios REPARTIDOR y CLIENTE, asignación de repartidor, cierre de caja, retención y eliminación
-- de datos personales (LOPDP) y portal de clientes empresa.

-- ── Roles ────────────────────────────────────────────────────────────────────
-- El enum rol_usuario pasa a TEXT + CHECK: un valor agregado con ALTER TYPE ... ADD VALUE no se puede usar en la
-- misma transacción (cada migración corre en una) y así los roles futuros no exigen cambiar un tipo.
ALTER TABLE usuarios ALTER COLUMN rol DROP DEFAULT;
ALTER TABLE usuarios ALTER COLUMN rol TYPE TEXT USING rol::text;
ALTER TABLE usuarios ALTER COLUMN rol SET DEFAULT 'OPERADOR';
DROP TYPE rol_usuario;

-- Un usuario CLIENTE se vincula a un cliente frecuente; al eliminar el cliente queda en NULL (y la aplicación lo
-- desactiva en la misma transacción). Los demás roles nunca tienen cliente.
ALTER TABLE usuarios
  ADD COLUMN cliente_id UUID REFERENCES clientes (id) ON DELETE SET NULL,
  ADD CONSTRAINT usuarios_rol_valido CHECK (rol IN ('ADMIN', 'OPERADOR', 'REPARTIDOR', 'CLIENTE')),
  ADD CONSTRAINT usuarios_cliente_solo_portal CHECK (cliente_id IS NULL OR rol = 'CLIENTE');
CREATE INDEX usuarios_cliente_idx ON usuarios (cliente_id) WHERE cliente_id IS NOT NULL;
CREATE INDEX usuarios_nombre_idx ON usuarios (lower(nombre), id);

-- ── Envíos: repartidor asignado y anonimización ─────────────────────────────
ALTER TABLE envios
  ADD COLUMN repartidor_id  UUID REFERENCES usuarios (id),
  ADD COLUMN asignado_en    TIMESTAMPTZ,
  ADD COLUMN anonimizado_en TIMESTAMPTZ,
  ADD CONSTRAINT envios_asignacion_completa CHECK ((repartidor_id IS NULL) = (asignado_en IS NULL));
CREATE INDEX envios_repartidor_idx ON envios (repartidor_id, estado) WHERE repartidor_id IS NOT NULL;
-- Depuración diaria: envíos terminados con datos personales, por fecha de su último cambio.
CREATE INDEX envios_retencion_idx ON envios (actualizado_en)
  WHERE anonimizado_en IS NULL AND estado IN ('ENTREGADO', 'CANCELADO');

COMMENT ON COLUMN envios.anonimizado_en IS 'Cuándo se eliminaron sus datos personales (plazo de conservación o solicitud del titular).';

-- ── Caja ─────────────────────────────────────────────────────────────────────
CREATE TABLE cierres_caja (
  id           UUID PRIMARY KEY,
  usuario_id   UUID          NOT NULL REFERENCES usuarios (id),
  recibido_por UUID          NOT NULL REFERENCES usuarios (id),
  fecha        TIMESTAMPTZ   NOT NULL,
  esperado     NUMERIC(12,2) NOT NULL,
  entregado    NUMERIC(12,2) NOT NULL CHECK (entregado >= 0),
  diferencia   NUMERIC(12,2) NOT NULL,
  cantidad     INT           NOT NULL CHECK (cantidad > 0),
  nota         TEXT CHECK (nota IS NULL OR length(nota) <= 300),
  por_tipo     JSONB         NOT NULL,
  CONSTRAINT cierres_caja_nota_si_diferencia CHECK (diferencia = 0 OR nota IS NOT NULL)
);
CREATE INDEX cierres_caja_fecha_idx ON cierres_caja (fecha DESC, id DESC);
CREATE INDEX cierres_caja_usuario_idx ON cierres_caja (usuario_id, fecha DESC);

-- Cobros automáticos: ORIGEN (envío PAGADO del panel), CONTRA_ENTREGA (AL_COBRO entregado) y DEVOLUCION (negativo).
CREATE TABLE cobros (
  id          UUID PRIMARY KEY,
  tipo        TEXT          NOT NULL CHECK (tipo IN ('ORIGEN', 'CONTRA_ENTREGA', 'DEVOLUCION')),
  monto       NUMERIC(12,2) NOT NULL,
  envio_id    UUID          NOT NULL REFERENCES envios (id),
  numero_guia BIGINT        NOT NULL,
  forma_pago  TEXT          NOT NULL,
  usuario_id  UUID          NOT NULL REFERENCES usuarios (id),
  fecha       TIMESTAMPTZ   NOT NULL,
  cierre_id   UUID REFERENCES cierres_caja (id),
  CONSTRAINT cobros_monto_signo CHECK ((tipo = 'DEVOLUCION') = (monto < 0) OR monto = 0),
  CONSTRAINT cobros_envio_tipo_key UNIQUE (envio_id, tipo)
);
CREATE INDEX cobros_pendientes_idx ON cobros (usuario_id, fecha, id) WHERE cierre_id IS NULL;
CREATE INDEX cobros_cierre_idx ON cobros (cierre_id) WHERE cierre_id IS NOT NULL;

-- ── Datos personales ─────────────────────────────────────────────────────────
-- Configuración clave/valor (política de retención y última depuración).
CREATE TABLE configuracion (
  clave          TEXT PRIMARY KEY,
  valor          JSONB       NOT NULL,
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Registro de las solicitudes de eliminación atendidas: sin el teléfono completo (solo sus 4 últimos dígitos).
CREATE TABLE solicitudes_datos (
  id             UUID PRIMARY KEY,
  tipo           TEXT        NOT NULL DEFAULT 'ELIMINACION' CHECK (tipo = 'ELIMINACION'),
  nombre_titular TEXT        NOT NULL CHECK (length(nombre_titular) BETWEEN 2 AND 120),
  telefono_final TEXT        NOT NULL CHECK (telefono_final ~ '^…[0-9]{4}$'),
  canal          TEXT        NOT NULL CHECK (canal IN ('PRESENCIAL', 'CORREO', 'TELEFONO', 'WHATSAPP')),
  nota           TEXT CHECK (nota IS NULL OR length(nota) <= 300),
  fecha          TIMESTAMPTZ NOT NULL,
  atendida_por   TEXT        NOT NULL,
  resultado      JSONB       NOT NULL
);
CREATE INDEX solicitudes_datos_fecha_idx ON solicitudes_datos (fecha DESC, id DESC);
