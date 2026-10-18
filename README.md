# PCargo — Backend

API de gestión de encomiendas a domicilio (Ibarra · Atuntaqui · Otavalo · Quito).
Node + TypeScript + Express 5 + PostgreSQL, con **arquitectura hexagonal**.

## Puesta en marcha

```bash
cp .env.example .env
pnpm install

# Con PostgreSQL (desde la raíz del workspace: docker compose up -d db)
pnpm db:setup
pnpm dev                # http://localhost:3000/api

# Sin base de datos (demo con datos semilla en memoria)
pnpm dev:memory
```

Usuarios semilla: `admin@pcargo.ec / Admin123!` (ADMIN) · `operador@pcargo.ec / Operador123!` (OPERADOR) ·
`repartidor@pcargo.ec / Repartidor123!` (REPARTIDOR) · `portal@pcargo.ec / Portal123!` (CLIENTE, cliente «Textiles Atuntaqui»).

## Modelo de datos

```
usuarios ──┐
           │ creado_por / usuario_id
ciudades ─< rutas >─ ciudades         tipos_carga (SOBRE, PAQUETE, CARTON, VALIJA)
             │                              │
             └──────────< envios >───┐      │
                            │        └──< envio_items >┘   (tipo, cantidad, peso/u, subtotal)
                            └──< historial_estados          (estado, nota, fecha, usuario)
```

- **Ítems**: un envío lleva varias líneas (p. ej. 5 paquetes + 20 cartones); `peso` es por unidad.
- **Precio por unidad según el tipo** (v8; la ruta no influye, sin recargo por peso): sobre, paquete, cartón, valija y
  plumón pequeño 3.00; plumón grande 4.00; rollo de tela 1.25 (zona urbana) / 1.50 (zona rural), y si el envío suma
  más de 50 rollos, todos a 1.00 sin importar la zona. `zona` (`URBANA` | `RURAL`) se guarda en el envío.
  Subtotal = precio × cantidad. El peso por unidad solo se valida contra el máximo del tipo.
- **Forma de pago**: `PAGADO`, `AL_COBRO`, `CONTRATO`, `SEGURO`.
- **Estados**: `REGISTRADO → EN_TRANSITO → EN_REPARTO → ENTREGADO | NO_ENTREGADO | NOVEDAD`, `REGISTRADO → CANCELADO`;
  `NO_ENTREGADO → EN_REPARTO` (reintento); `NOVEDAD` se resuelve a reparto/entregado/no entregado. NO_ENTREGADO y NOVEDAD exigen motivo.
- Cada cambio guarda **fecha y operador**; la API expone `registro` y la última gestión de `entrega`.

## Tests

```bash
pnpm test                       # unitarios + integración HTTP + contrato de repos en memoria
TEST_DATABASE_URL=postgres://pcargo:pcargo@localhost:5433/pcargo_test pnpm test   # + contrato contra Postgres
TEST_REDIS_URL=redis://localhost:6380 pnpm test                                   # + caché y límite de tasa con Redis real
```

## Redis

`docker compose up -d redis` (puerto 6380) y `REDIS_URL=redis://localhost:6380`. Se usa para:

- **Caché** de lecturas frecuentes: catálogo (ciudades, tipos de carga, rutas, catálogo público; 5 min), resumen del
  dashboard (60 s) y rastreo público (60 s). Las escrituras invalidan lo afectado al instante; el TTL solo acota el caso
  en que una invalidación falle.
- **Límite de tasa** compartido entre instancias: login 10 intentos / 15 min por IP y correo; endpoints públicos
  (`/publico/*`, `/seguimiento/*`) 60 / min por IP; cambio de contraseña 10 / 15 min por usuario → 429
  `DEMASIADAS_SOLICITUDES` con `Retry-After`.

Si Redis cae, la API sigue funcionando sin caché ni límite (falla abierto) y se reconecta sola.
Sin `REDIS_URL` todo funciona en memoria del proceso (`CACHE_DRIVER=none` desactiva la caché).

## Archivos (evidencia de entrega)

Las fotos de la guía firmada se guardan en un almacén **privado** (`STORAGE_DRIVER`); la API las sirve solo con token
(`GET /envios/:id/evidencia`, `Cache-Control: private, no-store`) y la clave del archivo nunca sale en la API.

| driver | uso | variables |
|---|---|---|
| `local` (por defecto) | desarrollo o servidor con disco persistente | `STORAGE_LOCAL_DIR` (por defecto `backend/storage/`, ignorada por git) |
| `r2` | producción: bucket privado de Cloudflare R2 (API S3) | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` (obligatorias) |
| `memory` | tests y `DB_DRIVER=memory` (por defecto en ese modo) | — |

## API para empresas (integraciones)

Otras empresas ingresan envíos desde sus sistemas en `/api/v1/integraciones` (especificación OpenAPI 3.1 pública en
`GET /api/v1/integraciones/openapi.json`). El ADMIN crea la **integración** (remitente fijo, ciudad de origen, forma de
pago por defecto, IPs permitidas) y sus **API keys** en `/api/integraciones`.

- **Keys** `pc_live_<8>_<32>` / `pc_test_<8>_<32>` (base62, `crypto.randomBytes`): se muestran una vez; se guarda el
  prefijo y el SHA-256, y se comparan en tiempo constante. Alcances `envios:crear`, `envios:leer`, `cotizar`. Las keys de
  prueba validan y cotizan igual pero no guardan nada. El JWT del panel no sirve en esta API ni la key en el panel.
- **Seguridad**: IPs/CIDR permitidas (IPv4/IPv6), 120 solicitudes/min por integración, body ≤ 1 MB, esquemas estrictos,
  `X-Request-Id` en cada respuesta y auditoría de cada solicitud (sin key ni body; se purga a los 90 días).
- **Idempotencia**: `POST /envios` y `/envios/lote` exigen `Idempotency-Key`; misma clave + mismo cuerpo en 24 h →
  misma respuesta con `Idempotent-Replayed: true`.
- **Webhooks** (Standard Webhooks): `envio.creado`, `envio.estado_actualizado`, `envio.evidencia_registrada`, firmados
  con HMAC-SHA256 (`webhook-signature: v1,...`). Se encolan en la BD en la misma transacción que el cambio del envío
  (outbox) y los envía un despachador en proceso (`WEBHOOKS_DESPACHADOR`, cada `WEBHOOKS_INTERVALO_SEG` s; con varias
  instancias se reparten la cola con `FOR UPDATE SKIP LOCKED`). Reintentos: 1 min, 5 min, 30 min, 2 h, 6 h, 12 h, 24 h.
  Anti-SSRF: solo `https://` y destinos con IP pública (`WEBHOOKS_PERMITIR_HTTP=true` lo relaja, solo en desarrollo).
  El secreto `whsec_...` se guarda cifrado con `INTEGRACIONES_CLAVE_CIFRADO` (obligatoria para configurar webhooks).

| variable | por defecto | uso |
|---|---|---|
| `PUBLIC_URL` | `http://localhost:5173` | `seguimientoUrl` de las respuestas |
| `INTEGRACIONES_CLAVE_CIFRADO` | — | 32 bytes base64/hex; inválida → el servidor no arranca |
| `WEBHOOKS_PERMITIR_HTTP` | `false` | solo desarrollo |
| `WEBHOOKS_DESPACHADOR` / `WEBHOOKS_INTERVALO_SEG` | `true` / `15` | despachador de webhooks |

Endpoints y tipos: ver `../docs/api-contract.md`.
