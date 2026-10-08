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

Usuarios semilla: `admin@pcargo.ec / Admin123!` (ADMIN) · `operador@pcargo.ec / Operador123!` (OPERADOR).

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
- **Tarifa por pieza**: `tarifa_base(ruta) × factor(tipo) + max(0, peso − peso_incluido) × 0.50 USD`; subtotal = pieza × cantidad.
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
  (`/publico/*`, `/seguimiento/*`) 60 / min por IP → 429 `DEMASIADAS_SOLICITUDES` con `Retry-After`.

Si Redis cae, la API sigue funcionando sin caché ni límite (falla abierto) y se reconecta sola.
Sin `REDIS_URL` todo funciona en memoria del proceso (`CACHE_DRIVER=none` desactiva la caché).

Endpoints y tipos: ver `../docs/api-contract.md`.
