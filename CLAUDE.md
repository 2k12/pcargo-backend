# PCargo backend — convenciones

API REST de PCargo con **arquitectura hexagonal** (puertos y adaptadores). Contrato: `../docs/api-contract.md`.
Requisitos: `../docs/srs/SRS-PCargo.json` (actualízalo con cada cambio, ver `../CLAUDE.md`).

## Capas

```
src/
├── domain/          reglas puras: Envio (agregado), EstadoEnvio, calcularTarifa, TipoCarga, Ruta, Usuario
├── application/     casos de uso (clases con ejecutar()), ports/ (interfaces), dto/
├── infrastructure/
│   ├── http/        adaptador de entrada: express, esquemas zod, middlewares (auth JWT, errores)
│   ├── persistence/ adaptadores de salida: postgres/ (pg + migrar/sembrar) y memory/
│   ├── security/    bcrypt, JWT
│   ├── system/      reloj, generador de ids/códigos
│   └── container.ts raíz de composición
├── cli/db.ts        migrate | seed | setup
└── main.ts
```

Regla: `domain` no importa nada externo; `application` solo `domain` + sus puertos; la infraestructura implementa puertos.

## Comandos

- `pnpm dev` (Postgres) / `pnpm dev:memory` (sin BD, datos semilla en RAM)
- `pnpm db:setup` — migraciones (`db/migrations/*.sql`) + datos semilla idempotentes
- `pnpm test` · `pnpm test:unit` · `pnpm test:integration` · `pnpm test:coverage` · `pnpm lint`

## Convenciones

- ESM + TypeScript: imports relativos con extensión `.js`.
- Errores de negocio con `DomainError(code, msg)`; mapeo a HTTP en `infrastructure/http/middlewares/errores.ts`.
- Validación de forma con Zod en el borde HTTP; reglas de negocio en el dominio.
- Nueva persistencia: implementar en memoria y en Postgres y cubrir en `tests/helpers/contrato-repositorios.ts`.
- Migraciones nuevas: `db/migrations/NNN_descripcion.sql`; no editar migraciones ya aplicadas.
- Datos semilla en un solo lugar: `src/infrastructure/persistence/seed-data.ts`.
