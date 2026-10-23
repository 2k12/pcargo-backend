import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrar } from "../../../src/infrastructure/persistence/postgres/migrar.js";
import { sembrar } from "../../../src/infrastructure/persistence/postgres/sembrar.js";
import { ARTICULOS_SEED, TIPOS_CARGA_SEED, USUARIOS_SEED } from "../../../src/infrastructure/persistence/seed-data.js";
import { PgArticuloRestringidoRepository } from "../../../src/infrastructure/persistence/postgres/PgArticulosRestringidos.js";
import {
  ciudadesSemilla,
  InMemoryArticuloRestringidoRepository,
  InMemoryCiudadRepository,
  InMemoryEnvioRepository,
  InMemoryRutaRepository,
  InMemoryTipoCargaRepository,
  InMemoryUsuarioRepository,
} from "../../../src/infrastructure/persistence/memory/InMemoryRepositories.js";
import { PgCiudadRepository, PgEnvioRepository, PgRutaRepository, PgTipoCargaRepository, PgUsuarioRepository } from "../../../src/infrastructure/persistence/postgres/PgRepositories.js";
import { crearPool, type Db } from "../../../src/infrastructure/persistence/postgres/pool.js";
import { InMemoryClienteRepository } from "../../../src/infrastructure/persistence/memory/InMemoryClienteRepository.js";
import { PgClienteRepository } from "../../../src/infrastructure/persistence/postgres/PgClienteRepository.js";
import { contratoRepositorios } from "../../helpers/contrato-repositorios.js";
import { InMemoryCajaRepository } from "../../../src/infrastructure/persistence/memory/InMemoryCaja.js";
import { InMemoryDatosPersonalesRepository } from "../../../src/infrastructure/persistence/memory/InMemoryDatosPersonales.js";
import { PgCajaRepository } from "../../../src/infrastructure/persistence/postgres/PgCaja.js";
import { PgDatosPersonalesRepository } from "../../../src/infrastructure/persistence/postgres/PgDatosPersonales.js";
import {
  InMemoryEntregaWebhookRepository,
  InMemoryIdempotenciaRepository,
  InMemoryIntegracionRepository,
  InMemorySolicitudApiRepository,
} from "../../../src/infrastructure/persistence/memory/InMemoryIntegraciones.js";
import {
  PgEntregaWebhookRepository,
  PgIdempotenciaRepository,
  PgIntegracionRepository,
  PgSolicitudApiRepository,
} from "../../../src/infrastructure/persistence/postgres/PgIntegraciones.js";

contratoRepositorios("memoria", async () => {
  const ciudades = ciudadesSemilla();
  const entregasWebhook = new InMemoryEntregaWebhookRepository();
  const solicitudesApi = new InMemorySolicitudApiRepository();
  const idempotencia = new InMemoryIdempotenciaRepository();
  const integraciones = new InMemoryIntegracionRepository((id) => {
    entregasWebhook.eliminarDeIntegracion(id);
    solicitudesApi.eliminarDeIntegracion(id);
    idempotencia.eliminarDeIntegracion(id);
  });
  // Como en Postgres tras reiniciar: usuarios semilla sin cliente vinculado (el contrato parte sin clientes).
  const usuarios = new InMemoryUsuarioRepository(
    USUARIOS_SEED.map(({ password, ...u }) => ({ ...u, clienteId: null, passwordHash: `hash:${password}`, activo: true })),
  );
  const caja = new InMemoryCajaRepository(usuarios.nombre);
  const envios = new InMemoryEnvioRepository({
    outbox: entregasWebhook,
    nombreIntegracion: integraciones.nombre,
    caja,
    nombreUsuario: usuarios.nombre,
  });
  return {
    integraciones,
    entregasWebhook,
    solicitudesApi,
    idempotencia,
    envios,
    rutas: new InMemoryRutaRepository(ciudades),
    ciudades: new InMemoryCiudadRepository(ciudades),
    clientes: new InMemoryClienteRepository([], { alEliminar: (id) => usuarios.desvincularCliente(id) }),
    tiposCarga: new InMemoryTipoCargaRepository(undefined, { usaTipoCarga: (c) => envios.usaTipoCarga(c) }),
    articulos: new InMemoryArticuloRestringidoRepository(),
    usuarios,
    caja,
    datosPersonales: new InMemoryDatosPersonalesRepository(),
  };
});

const url = process.env.TEST_DATABASE_URL;

// Requiere Postgres (docker compose up -d db). Usa una BD dedicada: ¡se borra en cada test!
describe.skipIf(!url)("PostgreSQL", () => {
  let db: Db;
  /** Artículos tal como los dejó la migración 011 (antes de que el contrato los reinicie). */
  let articulosMigracion: unknown[];

  beforeAll(async () => {
    db = crearPool(url!);
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrar(db, () => {});
    await sembrar(db, 4);
    articulosMigracion = (await new PgArticuloRestringidoRepository(db).listar()).map(({ actualizadoEn: _, ...a }) => a);
  });

  afterAll(async () => {
    await db?.end();
  });

  contratoRepositorios("postgres", async () => {
    // v12: usuarios.cliente_id referencia clientes, así que TRUNCATE clientes CASCADE vaciaría los usuarios: los
    // clientes se borran con DELETE (los usuarios quedan sin cliente) y los usuarios extra de los tests, aparte.
    await db.query(
      `TRUNCATE envios, envio_items, historial_estados, integraciones, api_keys, api_idempotencia, api_solicitudes,
         webhook_entregas, cobros, cierres_caja, solicitudes_datos, configuracion CASCADE`,
    );
    await db.query("DELETE FROM usuarios WHERE NOT (id = ANY($1::uuid[]))", [USUARIOS_SEED.map((u) => u.id)]);
    await db.query("DELETE FROM clientes");
    await db.query("DELETE FROM rutas WHERE origen_id > 4 OR destino_id > 4");
    await db.query("DELETE FROM ciudades WHERE id > 4");
    await db.query("UPDATE ciudades SET activa = TRUE");
    // Catálogo v11: los 7 tipos semilla tal cual, sin tipos extra ni historial, y los artículos de la semilla.
    await db.query("TRUNCATE tipos_carga_historial, articulos_restringidos");
    await db.query("DELETE FROM tipos_carga WHERE NOT (codigo = ANY($1))", [TIPOS_CARGA_SEED.map((t) => t.codigo)]);
    for (const t of TIPOS_CARGA_SEED) {
      await db.query(
        `UPDATE tipos_carga SET nombre = $2, precio = $3, precio_rural = $4, mayoreo_minimo_exclusivo = $5, mayoreo_precio = $6,
           peso_max_kg = $7, activo = $8, orden = $9, actualizado_en = NULL, actualizado_por = NULL WHERE codigo = $1`,
        [t.codigo, t.nombre, t.precio, t.precioRural, t.mayoreo?.minimoExclusivo ?? null, t.mayoreo?.precio ?? null, t.pesoMaxKg, t.activo, t.orden],
      );
    }
    for (const a of ARTICULOS_SEED) await new PgArticuloRestringidoRepository(db).crear(a);
    // Los tests de perfil y usuarios cambian nombre, correo, hash, rol y estado: se restauran los de la semilla
    // (sin cliente vinculado: el contrato parte sin clientes).
    for (const u of USUARIOS_SEED) {
      await db.query(
        "UPDATE usuarios SET nombre = $2, email = $3, password_hash = $4, rol = $5, activo = TRUE, cliente_id = NULL, codigo_acceso_hash = NULL, codigo_acceso_en = NULL WHERE id = $1",
        [u.id, u.nombre, u.email, `hash:${u.password}`, u.rol],
      );
    }
    return {
      envios: new PgEnvioRepository(db),
      rutas: new PgRutaRepository(db),
      ciudades: new PgCiudadRepository(db),
      clientes: new PgClienteRepository(db),
      tiposCarga: new PgTipoCargaRepository(db),
      articulos: new PgArticuloRestringidoRepository(db),
      usuarios: new PgUsuarioRepository(db),
      integraciones: new PgIntegracionRepository(db),
      entregasWebhook: new PgEntregaWebhookRepository(db),
      solicitudesApi: new PgSolicitudApiRepository(db),
      idempotencia: new PgIdempotenciaRepository(db),
      caja: new PgCajaRepository(db),
      datosPersonales: new PgDatosPersonalesRepository(db),
    };
  });

  it("migración 011: siembra los artículos restringidos de la landing igual que ARTICULOS_SEED (modo memoria)", () => {
    expect(articulosMigracion).toEqual(ARTICULOS_SEED.map(({ actualizadoEn: _, ...a }) => a));
  });

  it("migración 011: restricciones del catálogo (código, rangos, nota sin ícono, nombre único)", async () => {
    const insertar = (codigo: string, nombre: string, precio = 3, mayoreo: [number, number] | null = null) =>
      db.query(
        `INSERT INTO tipos_carga (codigo, nombre, precio, peso_max_kg, mayoreo_minimo_exclusivo, mayoreo_precio) VALUES ($1, $2, $3, 10, $4, $5)`,
        [codigo, nombre, precio, mayoreo?.[0] ?? null, mayoreo?.[1] ?? null],
      );
    await expect(insertar("caja", "Caja chica")).rejects.toMatchObject({ code: "23514" });
    await expect(insertar("CAJA", "Caja chica", 1001)).rejects.toMatchObject({ code: "23514" });
    await expect(insertar("CAJA", "Caja chica", 3, [10, 3])).rejects.toMatchObject({ code: "23514" });
    await expect(insertar("CAJA", "SOBRE")).rejects.toMatchObject({ code: "23505" });
    await expect(
      db.query("UPDATE articulos_restringidos SET icono = 'alerta' WHERE categoria = 'NOTA'"),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      db.query("UPDATE articulos_restringidos SET icono = 'cohete' WHERE categoria = 'PROHIBIDO'"),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("db:seed no reactiva, sobrescribe ni vuelve a crear tipos que el ADMIN cambió o eliminó", async () => {
    await db.query("TRUNCATE envios, envio_items, historial_estados CASCADE");
    await db.query("UPDATE tipos_carga SET activo = FALSE, precio = 9.99 WHERE codigo = 'VALIJA'");
    await db.query("DELETE FROM tipos_carga WHERE codigo = 'PLUMON_GRANDE'");
    await db.query("DELETE FROM articulos_restringidos WHERE categoria = 'NOTA'");
    await sembrar(db, 4);
    const tipos = new PgTipoCargaRepository(db);
    expect(await tipos.buscarPorCodigo("VALIJA")).toMatchObject({ activo: false, precio: 9.99 });
    expect(await tipos.buscarPorCodigo("PLUMON_GRANDE")).toBeNull();
    expect((await new PgArticuloRestringidoRepository(db).listar()).some((a) => a.categoria === "NOTA")).toBe(false);
  });

  it("semilla v12: cliente «Textiles Atuntaqui» con consentimiento, repartidor y portal vinculado; idempotente", async () => {
    await db.query("DELETE FROM usuarios WHERE email IN ('repartidor@pcargo.ec', 'portal@pcargo.ec')");
    await sembrar(db, 4);
    await sembrar(db, 4);
    const { rows: clientes } = await db.query("SELECT id, nombre, consentimiento_en FROM clientes WHERE telefono = '0991112233'");
    expect(clientes).toHaveLength(1);
    expect(clientes[0]).toMatchObject({ nombre: "Textiles Atuntaqui", consentimiento_en: expect.any(Date) });
    const usuarios = new PgUsuarioRepository(db);
    expect(await usuarios.buscarPorEmail("repartidor@pcargo.ec")).toMatchObject({ rol: "REPARTIDOR", clienteId: null, activo: true });
    expect(await usuarios.buscarPorEmail("portal@pcargo.ec")).toMatchObject({ rol: "CLIENTE", clienteId: clientes[0].id, activo: true });
    expect((await db.query("SELECT count(*)::int AS n FROM usuarios WHERE email LIKE '%@pcargo.ec'")).rows[0].n).toBe(4);
    // restricciones: rol válido y cliente solo en usuarios CLIENTE
    await expect(db.query("UPDATE usuarios SET rol = 'JEFE' WHERE email = 'admin@pcargo.ec'")).rejects.toMatchObject({ code: "23514" });
    await expect(
      db.query("UPDATE usuarios SET cliente_id = $1 WHERE email = 'admin@pcargo.ec'", [clientes[0].id]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("migración 009: los envíos existentes quedan sin dirección ni evidencia, y las restricciones se cumplen", async () => {
    await db.query("TRUNCATE envios, envio_items, historial_estados CASCADE");
    await db.query("DELETE FROM clientes");
    const id = "00000000-0000-4000-d000-000000000009";
    await db.query(
      `INSERT INTO envios (id, numero_guia, remitente_nombre, remitente_telefono, destinatario_nombre,
         destinatario_telefono, destinatario_direccion, ruta_id, total_piezas, peso_total_kg, costo, forma_pago)
       VALUES ($1, 9, 'Ana', '0991234567', 'Luis', '0987654321', 'Quito', 11, 1, 1, 3, 'PAGADO')`,
      [id],
    );
    const e = (await new PgEnvioRepository(db).buscarPorNumeroGuia(9))!;
    expect(e.toSnapshot().remitente.direccion).toBeNull();
    expect(e.evidencia).toBeNull();
    await expect(db.query("UPDATE envios SET remitente_direccion = repeat('x', 201) WHERE id = $1", [id])).rejects.toMatchObject({ code: "23514" });
    // evidencia a medias (sin clave) o con un tipo no permitido
    await expect(db.query("UPDATE envios SET evidencia_recibido_por = 'Rosa' WHERE id = $1", [id])).rejects.toMatchObject({ code: "23514" });
    await expect(
      db.query(
        `UPDATE envios SET evidencia_recibido_por = 'Rosa', evidencia_tipo = 'image/gif', evidencia_bytes = 1,
           evidencia_subida_en = now(), evidencia_clave = 'k' WHERE id = $1`,
        [id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

// Migración 008 sobre una BD en v7 con datos: los envíos y rutas existentes no se recalculan.
// Usa un esquema aparte (search_path) para no interferir con las pruebas anteriores.
describe.skipIf(!url)("Migración 008 (precio por tipo y zona) sobre datos v7", () => {
  const ESQUEMA = "migracion_v7";
  let db: Db;

  beforeAll(async () => {
    const admin = crearPool(url!);
    await admin.query(`DROP SCHEMA IF EXISTS ${ESQUEMA} CASCADE; CREATE SCHEMA ${ESQUEMA};`);
    await admin.end();
    db = new pg.Pool({ connectionString: url!, max: 2, options: `-c search_path=${ESQUEMA},public` }); // public: extensiones (pg_trgm)

    // Aplica 001..007 a mano y deja datos con la fórmula vieja.
    const dir = join(import.meta.dirname, "..", "..", "..", "db", "migrations");
    await db.query("CREATE TABLE schema_migrations (nombre TEXT PRIMARY KEY, aplicada_en TIMESTAMPTZ NOT NULL DEFAULT now())");
    for (const archivo of (await readdir(dir)).filter((f) => f.endsWith(".sql") && f < "008").sort()) {
      await db.query(await readFile(join(dir, archivo), "utf8"));
      await db.query("INSERT INTO schema_migrations (nombre) VALUES ($1)", [archivo]);
    }
    await db.query(`INSERT INTO ciudades (id, nombre) VALUES (1, 'Ibarra'), (4, 'Quito')`);
    await db.query(`INSERT INTO tipos_carga (codigo, nombre, factor, peso_incluido_kg, peso_max_kg) VALUES
      ('SOBRE', 'Sobre', 1.0, 0.5, 0.5), ('PAQUETE', 'Paquete', 1.4, 2, 30),
      ('CARTON', 'Cartón', 1.6, 2, 40), ('VALIJA', 'Valija', 1.8, 2, 25)`);
    await db.query(`INSERT INTO rutas (id, origen_id, destino_id, tarifa_base, tiempo_estimado_min) VALUES (1, 1, 4, 6.00, 180)`);
    await db.query(`INSERT INTO envios (id, numero_guia, remitente_nombre, remitente_telefono, destinatario_nombre,
        destinatario_telefono, destinatario_direccion, ruta_id, total_piezas, peso_total_kg, costo, forma_pago)
      VALUES ('00000000-0000-4000-d000-000000000001', 1, 'Ana', '0991234567', 'Luis', '0987654321', 'Quito', 1, 3, 15, 33.30, 'PAGADO')`);
    await db.query(`INSERT INTO envio_items (envio_id, linea, tipo_carga, cantidad, peso_unitario_kg, costo_unitario, subtotal)
      VALUES ('00000000-0000-4000-d000-000000000001', 1, 'CARTON', 3, 5, 11.10, 33.30)`);

    await migrar(db, () => {}); // solo aplica 008
  });

  afterAll(async () => {
    await db?.end();
    const admin = crearPool(url!);
    await admin.query(`DROP SCHEMA IF EXISTS ${ESQUEMA} CASCADE`);
    await admin.end();
  });

  it("actualiza los 4 tipos, inserta los 3 nuevos y ajusta pesos máximos (y 011 los deja activos con su orden)", async () => {
    expect(await new PgTipoCargaRepository(db).listar()).toEqual(TIPOS_CARGA_SEED);
    const { rows } = await db.query("SELECT nombre FROM schema_migrations WHERE nombre LIKE '008%'");
    expect(rows).toHaveLength(1);
  });

  it("los envíos existentes quedan URBANA y conservan su costo e ítems guardados", async () => {
    const e = (await new PgEnvioRepository(db).buscarPorNumeroGuia(1))!;
    expect(e.toSnapshot()).toMatchObject({
      zona: "URBANA",
      costo: 33.3,
      items: [{ tipoCarga: "CARTON", cantidad: 3, pesoKg: 5, costoUnitario: 11.1, subtotal: 33.3 }],
    });
  });

  it("la ruta conserva su tarifa_base histórica pero ya no la expone, y se pueden crear rutas sin tarifa", async () => {
    expect((await db.query("SELECT tarifa_base FROM rutas WHERE id = 1")).rows[0].tarifa_base).toBe(6);
    const rutas = new PgRutaRepository(db);
    expect(await rutas.buscarPorId(1)).not.toHaveProperty("tarifaBase");
    await db.query("SELECT setval('rutas_id_seq', 1)");
    const nueva = await rutas.crear({ origenId: 4, destinoId: 1, tiempoEstimadoMin: 180 });
    expect((await db.query("SELECT tarifa_base FROM rutas WHERE id = $1", [nueva.id])).rows[0].tarifa_base).toBeNull();
  });

  it("restricciones: zona válida y mayoreo completo", async () => {
    await expect(db.query("UPDATE envios SET zona = 'CENTRO'")).rejects.toMatchObject({ code: "23514" });
    await expect(db.query("UPDATE tipos_carga SET mayoreo_precio = NULL WHERE codigo = 'TELA'")).rejects.toMatchObject({ code: "23514" });
    await expect(db.query("UPDATE tipos_carga SET precio = 0 WHERE codigo = 'SOBRE'")).rejects.toMatchObject({ code: "23514" });
  });
});

// Migración 015 sobre una BD en v17 con envíos: la fecha de la guía toma el día (Ecuador, UTC−5) del registro.
describe.skipIf(!url)("Migración 015 (fecha de la guía) sobre datos v17", () => {
  const ESQUEMA = "migracion_v17";
  let db: Db;

  beforeAll(async () => {
    const admin = crearPool(url!);
    await admin.query(`DROP SCHEMA IF EXISTS ${ESQUEMA} CASCADE; CREATE SCHEMA ${ESQUEMA};`);
    await admin.end();
    db = new pg.Pool({ connectionString: url!, max: 2, options: `-c search_path=${ESQUEMA},public` });

    const dir = join(import.meta.dirname, "..", "..", "..", "db", "migrations");
    await db.query("CREATE TABLE schema_migrations (nombre TEXT PRIMARY KEY, aplicada_en TIMESTAMPTZ NOT NULL DEFAULT now())");
    for (const archivo of (await readdir(dir)).filter((f) => f.endsWith(".sql") && f < "015").sort()) {
      await db.query(await readFile(join(dir, archivo), "utf8"));
      await db.query("INSERT INTO schema_migrations (nombre) VALUES ($1)", [archivo]);
    }
    await db.query(`INSERT INTO ciudades (id, nombre) VALUES (1, 'Ibarra'), (4, 'Quito')`);
    await db.query(`INSERT INTO rutas (id, origen_id, destino_id, tiempo_estimado_min) VALUES (1, 1, 4, 180)`);
    const envio = (n: number, creadoEn: string) =>
      db.query(
        `INSERT INTO envios (id, numero_guia, remitente_nombre, remitente_telefono, destinatario_nombre,
           destinatario_telefono, destinatario_direccion, ruta_id, total_piezas, peso_total_kg, costo, forma_pago, creado_en)
         VALUES ($1, $2, 'Ana', '0991234567', 'Luis', '0987654321', 'Quito', 1, 1, 1, 3, 'PAGADO', $3)`,
        [`00000000-0000-4000-d015-${String(n).padStart(12, "0")}`, n, creadoEn],
      );
    await envio(1, "2026-03-10T04:59:00Z"); // 2026-03-09 23:59 en Ecuador
    await envio(2, "2026-03-10T05:00:00Z"); // 2026-03-10 00:00 en Ecuador
    await envio(3, "2026-03-11T04:30:00Z"); // 2026-03-10 23:30 en Ecuador (en UTC ya es el 11)

    await migrar(db, () => {}); // solo aplica 015
  });

  afterAll(async () => {
    await db?.end();
    const admin = crearPool(url!);
    await admin.query(`DROP SCHEMA IF EXISTS ${ESQUEMA} CASCADE`);
    await admin.end();
  });

  it("rellena fecha_guia con el día de Ecuador del registro y la deja NOT NULL", async () => {
    const { rows } = await db.query("SELECT numero_guia, fecha_guia FROM envios ORDER BY numero_guia");
    expect(rows.map((r) => [Number(r.numero_guia), r.fecha_guia])).toEqual([
      [1, "2026-03-09"],
      [2, "2026-03-10"],
      [3, "2026-03-10"],
    ]);
    await expect(db.query("UPDATE envios SET fecha_guia = NULL WHERE numero_guia = 1")).rejects.toMatchObject({ code: "23502" });
    const { rows: indices } = await db.query("SELECT 1 FROM pg_indexes WHERE indexname = 'envios_fecha_guia_idx'");
    expect(indices.length).toBeGreaterThan(0);
  });

  it("el repositorio la expone y filtra por ella", async () => {
    const repo = new PgEnvioRepository(db);
    expect((await repo.buscarPorNumeroGuia(3))!.fechaGuia).toBe("2026-03-10");
    const guias = (await repo.listar({ fechaGuiaDesde: "2026-03-10", fechaGuiaHasta: "2026-03-10" })).map((e) => e.numeroGuia);
    expect(guias).toEqual([3, 2]);
  });
});
