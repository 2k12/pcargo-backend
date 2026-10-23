import type {
  CambiosUsuarioRepo,
  FiltroUsuarios,
  CambiosCiudad,
  CambiosRuta,
  CiudadRepository,
  EnvioRepository,
  EstadisticaIntegracion,
  FiltroEnvios,
  OpcionesGuardarEnvio,
  Paginacion,
  NuevaRuta,
  RutaRepository,
  TipoCargaRepository,
  UsuarioRepository,
} from "../../../application/ports/repositories.js";
import type { AccionTipoCarga, CambioCampo, CambioTipoCarga, TipoCarga, TipoCargaCodigo } from "../../../domain/carga/TipoCarga.js";
import { Envio, type EventoHistorial, type ItemEnvio } from "../../../domain/envio/Envio.js";
import type { EstadoEnvio } from "../../../domain/envio/EstadoEnvio.js";
import type { EvidenciaEntrega, TipoImagen } from "../../../domain/envio/Evidencia.js";
import type { FormaPago } from "../../../domain/envio/FormaPago.js";
import type { Ciudad, Ruta } from "../../../domain/ruta/Ruta.js";
import type { Zona } from "../../../domain/tarifa/Zona.js";
import type { CambiosPerfil, Usuario, UsuarioAdmin, UsuarioConCredenciales } from "../../../domain/usuario/Usuario.js";
import type { MovimientosCaja } from "../../../domain/caja/Caja.js";
import { DomainError } from "../../../domain/shared/DomainError.js";
import { insertarEntregas } from "./PgIntegraciones.js";
import type pg from "pg";
import type { Db } from "./pool.js";

const COLUMNAS_USUARIO = `id, nombre, email, rol, cliente_id AS "clienteId"`;
const COLUMNAS_ADMIN = `${COLUMNAS_USUARIO}, activo, creado_en AS "creadoEn"`;

/** Correo repetido en una carrera: decide la restricción UNIQUE. */
function traducirCorreoRepetido(e: unknown): never {
  if ((e as { code?: string }).code === "23505") {
    throw new DomainError("CONFLICTO", "Ese correo ya está registrado por otro usuario");
  }
  throw e;
}

export class PgUsuarioRepository implements UsuarioRepository {
  constructor(private readonly db: Db) {}

  async buscarPorEmail(email: string): Promise<UsuarioConCredenciales | null> {
    const { rows } = await this.db.query(
      `SELECT ${COLUMNAS_USUARIO}, password_hash AS "passwordHash", activo FROM usuarios WHERE email = $1`,
      [email],
    );
    return rows[0] ?? null;
  }

  async buscarPorId(id: string): Promise<Usuario | null> {
    const { rows } = await this.db.query(`SELECT ${COLUMNAS_USUARIO} FROM usuarios WHERE id = $1 AND activo`, [id]);
    return rows[0] ?? null;
  }

  async buscarCredencialesPorId(id: string): Promise<UsuarioConCredenciales | null> {
    const { rows } = await this.db.query(
      `SELECT ${COLUMNAS_USUARIO}, password_hash AS "passwordHash", activo FROM usuarios WHERE id = $1 AND activo`,
      [id],
    );
    return rows[0] ?? null;
  }

  async existeEmail(email: string, excluirId?: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      "SELECT 1 FROM usuarios WHERE email = $1 AND id IS DISTINCT FROM $2::uuid",
      [email, excluirId ?? null],
    );
    return (rowCount ?? 0) > 0;
  }

  async actualizarPerfil(id: string, c: CambiosPerfil): Promise<Usuario> {
    const { rows } = await this.db
      .query<Usuario>(
        `UPDATE usuarios SET nombre = COALESCE($2, nombre), email = COALESCE($3, email)
          WHERE id = $1 RETURNING ${COLUMNAS_USUARIO}`,
        [id, c.nombre ?? null, c.email ?? null],
      )
      .catch(traducirCorreoRepetido);
    return rows[0]!;
  }

  async actualizarPasswordHash(id: string, passwordHash: string): Promise<void> {
    await this.db.query("UPDATE usuarios SET password_hash = $2 WHERE id = $1", [id, passwordHash]);
  }

  async listar(f: FiltroUsuarios = {}): Promise<UsuarioAdmin[]> {
    const cond: string[] = [];
    const params: unknown[] = [];
    if (f.rol) cond.push(`rol = $${params.push(f.rol)}`);
    if (f.activo !== undefined) cond.push(`activo = $${params.push(f.activo)}`);
    if (f.clienteId) cond.push(`cliente_id = $${params.push(f.clienteId)}`);
    const where = cond.length ? `WHERE ${cond.join(" AND ")}` : "";
    const { rows } = await this.db.query<UsuarioAdmin>(
      `SELECT ${COLUMNAS_ADMIN} FROM usuarios ${where} ORDER BY lower(nombre), id`,
      params,
    );
    return rows;
  }

  async obtener(id: string): Promise<UsuarioAdmin | null> {
    const { rows } = await this.db.query<UsuarioAdmin>(`SELECT ${COLUMNAS_ADMIN} FROM usuarios WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  async crear(u: UsuarioAdmin & { passwordHash: string }): Promise<void> {
    await this.db
      .query(
        `INSERT INTO usuarios (id, nombre, email, password_hash, rol, activo, creado_en, cliente_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [u.id, u.nombre, u.email, u.passwordHash, u.rol, u.activo, u.creadoEn, u.clienteId],
      )
      .catch(traducirCorreoRepetido);
  }

  async actualizar(id: string, c: CambiosUsuarioRepo): Promise<UsuarioAdmin> {
    const { rows } = await this.db
      .query<UsuarioAdmin>(
        `UPDATE usuarios SET nombre = COALESCE($2, nombre), email = COALESCE($3, email), rol = COALESCE($4, rol),
                activo = COALESCE($5, activo), password_hash = COALESCE($6, password_hash)
          WHERE id = $1 RETURNING ${COLUMNAS_ADMIN}`,
        [id, c.nombre ?? null, c.email ?? null, c.rol ?? null, c.activo ?? null, c.passwordHash ?? null],
      )
      .catch(traducirCorreoRepetido);
    if (!rows[0]) throw new DomainError("NO_ENCONTRADO", "Usuario no encontrado");
    return rows[0];
  }

  async accesosPortalPorCliente(): Promise<Map<string, number>> {
    const { rows } = await this.db.query<{ id: string; n: number }>(
      `SELECT cliente_id AS id, count(*)::int AS n FROM usuarios
        WHERE rol = 'CLIENTE' AND activo AND cliente_id IS NOT NULL GROUP BY cliente_id`,
    );
    return new Map(rows.map((r) => [r.id, r.n]));
  }

  async buscarPorCodigoAcceso(huella: string): Promise<UsuarioConCredenciales | null> {
    const { rows } = await this.db.query(
      `SELECT ${COLUMNAS_USUARIO}, password_hash AS "passwordHash", activo FROM usuarios WHERE codigo_acceso_hash = $1`,
      [huella],
    );
    return rows[0] ?? null;
  }

  async codigoAccesoActivoDesde(id: string): Promise<Date | null> {
    const { rows } = await this.db.query<{ en: Date | null }>(
      "SELECT codigo_acceso_en AS en FROM usuarios WHERE id = $1",
      [id],
    );
    return rows[0]?.en ?? null;
  }

  async guardarCodigoAcceso(id: string, huella: string, en: Date): Promise<void> {
    await this.db
      .query("UPDATE usuarios SET codigo_acceso_hash = $2, codigo_acceso_en = $3 WHERE id = $1", [id, huella, en])
      .catch((e: unknown) => {
        if ((e as { code?: string }).code === "23505") {
          throw new DomainError("CONFLICTO", "Ese código no está disponible, elige otro");
        }
        throw e;
      });
  }

  async quitarCodigoAcceso(id: string): Promise<void> {
    await this.db.query("UPDATE usuarios SET codigo_acceso_hash = NULL, codigo_acceso_en = NULL WHERE id = $1", [id]);
  }
}

export class PgCiudadRepository implements CiudadRepository {
  constructor(private readonly db: Db) {}

  async listar(filtro: { activa?: boolean } = {}): Promise<Ciudad[]> {
    const where = filtro.activa === undefined ? "" : "WHERE activa = $1";
    const params = filtro.activa === undefined ? [] : [filtro.activa];
    return (await this.db.query(`SELECT id, nombre, activa FROM ciudades ${where} ORDER BY nombre`, params)).rows;
  }

  async buscarPorId(id: number): Promise<Ciudad | null> {
    return (await this.db.query("SELECT id, nombre, activa FROM ciudades WHERE id = $1", [id])).rows[0] ?? null;
  }

  async existeNombre(nombre: string, excluirId?: number): Promise<boolean> {
    const { rowCount } = await this.db.query(
      "SELECT 1 FROM ciudades WHERE lower(nombre) = lower($1) AND id <> COALESCE($2, -1)",
      [nombre, excluirId ?? null],
    );
    return (rowCount ?? 0) > 0;
  }

  async crear(nombre: string): Promise<Ciudad> {
    return (await this.db.query("INSERT INTO ciudades (nombre) VALUES ($1) RETURNING id, nombre, activa", [nombre]))
      .rows[0];
  }

  async actualizar(id: number, c: CambiosCiudad): Promise<Ciudad> {
    return (
      await this.db.query(
        `UPDATE ciudades SET nombre = COALESCE($2, nombre), activa = COALESCE($3, activa)
          WHERE id = $1 RETURNING id, nombre, activa`,
        [id, c.nombre ?? null, c.activa ?? null],
      )
    ).rows[0];
  }

  async eliminar(id: number): Promise<void> {
    try {
      await this.db.query("DELETE FROM ciudades WHERE id = $1", [id]);
    } catch (e) {
      // Otra tabla la referencia (p. ej. la ciudad de origen de una integración).
      if ((e as { code?: string }).code === "23503") {
        throw new DomainError("CONFLICTO", "La ciudad está en uso (por ejemplo, como origen de una integración): desactívela");
      }
      throw e;
    }
  }
}

interface TipoCargaRow {
  codigo: TipoCargaCodigo;
  nombre: string;
  precio: number;
  precio_rural: number | null;
  mayoreo_minimo_exclusivo: number | null;
  mayoreo_precio: number | null;
  peso_max_kg: number;
  activo: boolean;
  orden: number;
  actualizado_en: Date | null;
  actualizado_por: string | null;
}

const aTipoCarga = (r: TipoCargaRow): TipoCarga => ({
  codigo: r.codigo,
  nombre: r.nombre,
  precio: r.precio,
  precioRural: r.precio_rural,
  mayoreo:
    r.mayoreo_minimo_exclusivo === null || r.mayoreo_precio === null
      ? null
      : { minimoExclusivo: r.mayoreo_minimo_exclusivo, precio: r.mayoreo_precio },
  pesoMaxKg: r.peso_max_kg,
  activo: r.activo,
  orden: r.orden,
  actualizadoEn: r.actualizado_en,
  actualizadoPor: r.actualizado_por,
});

interface CambioTipoCargaRow {
  id: string;
  codigo: string;
  fecha: Date;
  usuario_id: string | null;
  usuario_nombre: string | null;
  accion: AccionTipoCarga;
  cambios: CambioCampo[];
}

const codigoPg = (e: unknown): string | undefined => (e as { code?: string } | null)?.code;

/** Ejecuta `fn` en una transacción (BEGIN/COMMIT; ROLLBACK si lanza). */
export async function enTransaccion<T>(db: Db, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const r = await fn(client);
    await client.query("COMMIT");
    return r;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function insertarCambios(client: pg.PoolClient, cambios: CambioTipoCarga[]): Promise<void> {
  for (const c of cambios) {
    await client.query(
      `INSERT INTO tipos_carga_historial (id, codigo, fecha, usuario_id, usuario_nombre, accion, cambios)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [c.id, c.codigo, c.fecha, c.usuarioId, c.usuario, c.accion, JSON.stringify(c.cambios)],
    );
  }
}

/**
 * Bloquea las filas de los tipos activos: dos administradores que desactivan (o eliminan) tipos distintos a la vez
 * se serializan y el segundo ve el resultado del primero, así el catálogo nunca queda sin tipos activos.
 */
async function bloquearActivos(client: pg.PoolClient): Promise<void> {
  await client.query("SELECT codigo FROM tipos_carga WHERE activo FOR UPDATE");
}

async function exigirAlgunoActivoPg(client: pg.PoolClient): Promise<void> {
  const { rows } = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM tipos_carga WHERE activo");
  if (rows[0]!.n === 0) throw new DomainError("CONFLICTO", "Debe quedar al menos un tipo de carga activo");
}

export class PgTipoCargaRepository implements TipoCargaRepository {
  private static readonly SELECT = `SELECT codigo, nombre, precio, precio_rural, mayoreo_minimo_exclusivo,
    mayoreo_precio, peso_max_kg, activo, orden, actualizado_en, actualizado_por FROM tipos_carga`;

  constructor(private readonly db: Db) {}

  async listar(filtro: { activos?: boolean } = {}): Promise<TipoCarga[]> {
    const where = filtro.activos ? "WHERE activo" : "";
    const { rows } = await this.db.query<TipoCargaRow>(`${PgTipoCargaRepository.SELECT} ${where} ORDER BY orden, codigo`);
    return rows.map(aTipoCarga);
  }

  async buscarPorCodigo(codigo: TipoCargaCodigo): Promise<TipoCarga | null> {
    const { rows } = await this.db.query<TipoCargaRow>(`${PgTipoCargaRepository.SELECT} WHERE codigo = $1`, [codigo]);
    return rows[0] ? aTipoCarga(rows[0]) : null;
  }

  async existeNombre(nombre: string, excluirCodigo?: TipoCargaCodigo): Promise<boolean> {
    const { rowCount } = await this.db.query(
      "SELECT 1 FROM tipos_carga WHERE lower(nombre) = lower($1) AND codigo IS DISTINCT FROM $2",
      [nombre, excluirCodigo ?? null],
    );
    return (rowCount ?? 0) > 0;
  }

  async crear(t: TipoCarga, cambio: CambioTipoCarga): Promise<void> {
    try {
      await enTransaccion(this.db, async (client) => {
        await client.query(
          `INSERT INTO tipos_carga (codigo, nombre, precio, precio_rural, mayoreo_minimo_exclusivo, mayoreo_precio,
             peso_max_kg, activo, orden, actualizado_en, actualizado_por)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            t.codigo, t.nombre, t.precio, t.precioRural, t.mayoreo?.minimoExclusivo ?? null, t.mayoreo?.precio ?? null,
            t.pesoMaxKg, t.activo, t.orden, t.actualizadoEn, t.actualizadoPor,
          ],
        );
        await insertarCambios(client, [cambio]);
      });
    } catch (e) {
      // Carrera entre dos altas con el mismo código o nombre: deciden la PK y el índice único.
      if (codigoPg(e) === "23505") throw new DomainError("CONFLICTO", "Ya existe un tipo de carga con ese código o nombre");
      throw e;
    }
  }

  async actualizar(tipos: TipoCarga[], cambios: CambioTipoCarga[]): Promise<void> {
    try {
      await enTransaccion(this.db, async (client) => {
        await bloquearActivos(client);
        for (const t of tipos) {
          const { rowCount } = await client.query(
            `UPDATE tipos_carga SET nombre = $2, precio = $3, precio_rural = $4, mayoreo_minimo_exclusivo = $5,
               mayoreo_precio = $6, peso_max_kg = $7, activo = $8, orden = $9, actualizado_en = $10, actualizado_por = $11
             WHERE codigo = $1`,
            [
              t.codigo, t.nombre, t.precio, t.precioRural, t.mayoreo?.minimoExclusivo ?? null, t.mayoreo?.precio ?? null,
              t.pesoMaxKg, t.activo, t.orden, t.actualizadoEn, t.actualizadoPor,
            ],
          );
          if (!rowCount) throw new DomainError("NO_ENCONTRADO", `No existe el tipo de carga ${t.codigo}`);
        }
        await exigirAlgunoActivoPg(client);
        await insertarCambios(client, cambios);
      });
    } catch (e) {
      if (codigoPg(e) === "23505") throw new DomainError("CONFLICTO", "Ya existe un tipo de carga con ese nombre");
      throw e;
    }
  }

  async eliminar(codigo: TipoCargaCodigo, cambio: CambioTipoCarga): Promise<void> {
    try {
      await enTransaccion(this.db, async (client) => {
        await bloquearActivos(client);
        await client.query("DELETE FROM tipos_carga WHERE codigo = $1", [codigo]);
        await exigirAlgunoActivoPg(client);
        await insertarCambios(client, [cambio]);
      });
    } catch (e) {
      // Un envío registrado entre la comprobación y el borrado: la FK de envio_items lo impide.
      if (codigoPg(e) === "23503") {
        throw new DomainError("CONFLICTO", "El tipo de carga se usa en envíos registrados; desactívelo");
      }
      throw e;
    }
  }

  async listarHistorial(
    filtro: { codigo?: TipoCargaCodigo },
    { pagina, porPagina }: Paginacion,
  ): Promise<{ cambios: CambioTipoCarga[]; total: number }> {
    const where = filtro.codigo ? "WHERE codigo = $1" : "";
    const params: unknown[] = filtro.codigo ? [filtro.codigo] : [];
    const total = await this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM tipos_carga_historial ${where}`, params);
    const { rows } = await this.db.query<CambioTipoCargaRow>(
      `SELECT id, codigo, fecha, usuario_id, usuario_nombre, accion, cambios FROM tipos_carga_historial ${where}
        ORDER BY fecha DESC, secuencia DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, porPagina, (pagina - 1) * porPagina],
    );
    return {
      total: total.rows[0]!.n,
      cambios: rows.map((r) => ({
        id: r.id,
        codigo: r.codigo,
        fecha: r.fecha,
        usuarioId: r.usuario_id,
        usuario: r.usuario_nombre,
        accion: r.accion,
        cambios: r.cambios,
      })),
    };
  }
}

interface RutaRow {
  id: number;
  origen_id: number;
  origen_nombre: string;
  origen_activa: boolean;
  destino_id: number;
  destino_nombre: string;
  destino_activa: boolean;
  tiempo_estimado_min: number;
  activa: boolean;
}

const SELECT_RUTA = `
  SELECT r.id, r.origen_id, o.nombre AS origen_nombre, o.activa AS origen_activa,
         r.destino_id, d.nombre AS destino_nombre, d.activa AS destino_activa,
         r.tiempo_estimado_min, r.activa
    FROM rutas r
    JOIN ciudades o ON o.id = r.origen_id
    JOIN ciudades d ON d.id = r.destino_id`;

const aRuta = (r: RutaRow): Ruta => ({
  id: r.id,
  origen: { id: r.origen_id, nombre: r.origen_nombre, activa: r.origen_activa },
  destino: { id: r.destino_id, nombre: r.destino_nombre, activa: r.destino_activa },
  tiempoEstimadoMin: r.tiempo_estimado_min,
  activa: r.activa,
});

export class PgRutaRepository implements RutaRepository {
  constructor(private readonly db: Db) {}

  async listar(filtro: { activa?: boolean } = {}): Promise<Ruta[]> {
    const where = filtro.activa === undefined ? "" : "WHERE r.activa = $1";
    const params = filtro.activa === undefined ? [] : [filtro.activa];
    const { rows } = await this.db.query<RutaRow>(`${SELECT_RUTA} ${where} ORDER BY r.origen_id, r.destino_id`, params);
    return rows.map(aRuta);
  }

  async buscarPorId(id: number): Promise<Ruta | null> {
    const { rows } = await this.db.query<RutaRow>(`${SELECT_RUTA} WHERE r.id = $1`, [id]);
    return rows[0] ? aRuta(rows[0]) : null;
  }

  async existe(origenId: number, destinoId: number): Promise<boolean> {
    const { rowCount } = await this.db.query(
      "SELECT 1 FROM rutas WHERE origen_id = $1 AND destino_id = $2",
      [origenId, destinoId],
    );
    return (rowCount ?? 0) > 0;
  }

  async usaCiudad(ciudadId: number): Promise<boolean> {
    const { rowCount } = await this.db.query(
      "SELECT 1 FROM rutas WHERE origen_id = $1 OR destino_id = $1 LIMIT 1",
      [ciudadId],
    );
    return (rowCount ?? 0) > 0;
  }

  async crear(d: NuevaRuta): Promise<Ruta> {
    const { rows } = await this.db.query<{ id: number }>(
      `INSERT INTO rutas (origen_id, destino_id, tiempo_estimado_min)
       VALUES ($1, $2, $3) RETURNING id`,
      [d.origenId, d.destinoId, d.tiempoEstimadoMin],
    );
    return (await this.buscarPorId(rows[0]!.id))!;
  }

  async actualizar(id: number, c: CambiosRuta): Promise<Ruta> {
    await this.db.query(
      `UPDATE rutas SET tiempo_estimado_min = COALESCE($2, tiempo_estimado_min),
                        activa = COALESCE($3, activa)
        WHERE id = $1`,
      [id, c.tiempoEstimadoMin ?? null, c.activa ?? null],
    );
    return (await this.buscarPorId(id))!;
  }
}

interface EnvioRow {
  id: string;
  numero_guia: number;
  cliente_id: string | null;
  remitente_nombre: string;
  remitente_telefono: string;
  remitente_direccion: string | null;
  destinatario_nombre: string;
  destinatario_telefono: string;
  destinatario_direccion: string;
  ruta_id: number;
  zona: Zona;
  descripcion: string | null;
  costo: number;
  costo_adicional: number | null;
  /** DATE como texto `AAAA-MM-DD` (ver pool.ts). */
  fecha_guia: string | null;
  forma_pago: FormaPago;
  estado: EstadoEnvio;
  creado_por: string | null;
  creado_en: Date;
  actualizado_en: Date;
  evidencia_recibido_por: string | null;
  evidencia_tipo: TipoImagen | null;
  evidencia_bytes: number | null;
  evidencia_subida_en: Date | null;
  evidencia_subida_por: string | null;
  evidencia_subida_por_nombre: string | null;
  evidencia_clave: string | null;
  integracion_id: string | null;
  integracion_nombre: string | null;
  referencia_externa: string | null;
  repartidor_id: string | null;
  repartidor_nombre: string | null;
  asignado_en: Date | null;
  anonimizado_en: Date | null;
}

const aEvidencia = (r: EnvioRow): EvidenciaEntrega | null =>
  r.evidencia_clave
    ? {
        recibidoPor: r.evidencia_recibido_por!,
        tipo: r.evidencia_tipo!,
        bytes: r.evidencia_bytes!,
        subidaEn: r.evidencia_subida_en!,
        subidaPor: r.evidencia_subida_por
          ? { id: r.evidencia_subida_por, nombre: r.evidencia_subida_por_nombre ?? "" }
          : null,
        clave: r.evidencia_clave,
      }
    : null;

/**
 * Cobros del envío en su misma transacción. Una anulación borra el cobro ORIGEN si sigue pendiente; si otro proceso ya
 * lo cerró (el UPDATE del cierre lo bloquea hasta confirmar), registra la devolución en su lugar.
 */
async function aplicarMovimientosCaja(client: Pick<pg.PoolClient, "query">, m: MovimientosCaja | undefined): Promise<void> {
  if (!m) return;
  const insertar = async (c: MovimientosCaja["cobros"][number]) => {
    await client.query(
      `INSERT INTO cobros (id, tipo, monto, envio_id, numero_guia, forma_pago, usuario_id, fecha, cierre_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL)`,
      [c.id, c.tipo, c.monto, c.envioId, c.numeroGuia, c.formaPago, c.usuario.id, c.fecha],
    );
  };
  for (const c of m.cobros) await insertar(c);
  for (const a of m.anulaciones) {
    const { rowCount } = await client.query("DELETE FROM cobros WHERE id = $1 AND cierre_id IS NULL", [a.cobroId]);
    if (!rowCount) {
      const { rowCount: existe } = await client.query("SELECT 1 FROM cobros WHERE id = $1", [a.cobroId]);
      if (existe) await insertar(a.siYaCerrado);
    }
  }
}

interface ItemRow {
  envio_id: string;
  tipo_carga: TipoCargaCodigo;
  cantidad: number;
  peso_unitario_kg: number;
  costo_unitario: number;
  subtotal: number;
}

interface HistorialRow {
  envio_id: string;
  estado: EstadoEnvio;
  nota: string | null;
  fecha: Date;
  usuario_id: string | null;
  usuario_nombre: string | null;
}

export class PgEnvioRepository implements EnvioRepository {
  constructor(private readonly db: Db) {}

  /** Upsert del agregado; ítems solo al crear (son inmutables); eventos de historial nuevos. Todo en una transacción. */
  async guardar(envio: Envio, opciones: OpcionesGuardarEnvio = {}): Promise<void> {
    const s = envio.toSnapshot();
    const ev = s.evidencia ?? null;
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const upsert = await client.query<{ nuevo: boolean; anonimizado_en: Date | null }>(
        `INSERT INTO envios (id, numero_guia, remitente_nombre, remitente_telefono, destinatario_nombre,
            destinatario_telefono, destinatario_direccion, ruta_id, total_piezas, peso_total_kg, descripcion,
            costo, forma_pago, estado, creado_por, creado_en, actualizado_en, cliente_id, zona,
            remitente_direccion, evidencia_recibido_por, evidencia_tipo, evidencia_bytes, evidencia_subida_en,
            evidencia_subida_por, evidencia_clave, integracion_id, referencia_externa, anonimizado_en, costo_adicional,
            fecha_guia)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,
            $31)
         ON CONFLICT (id) DO UPDATE SET estado = EXCLUDED.estado, actualizado_en = EXCLUDED.actualizado_en,
            evidencia_recibido_por = EXCLUDED.evidencia_recibido_por, evidencia_tipo = EXCLUDED.evidencia_tipo,
            evidencia_bytes = EXCLUDED.evidencia_bytes, evidencia_subida_en = EXCLUDED.evidencia_subida_en,
            evidencia_subida_por = EXCLUDED.evidencia_subida_por, evidencia_clave = EXCLUDED.evidencia_clave,
            -- Los datos personales solo cambian al anonimizar (y una vez anonimizados no vuelven).
            remitente_nombre = CASE WHEN envios.anonimizado_en IS NULL AND EXCLUDED.anonimizado_en IS NOT NULL
              THEN EXCLUDED.remitente_nombre ELSE envios.remitente_nombre END,
            remitente_telefono = CASE WHEN envios.anonimizado_en IS NULL AND EXCLUDED.anonimizado_en IS NOT NULL
              THEN EXCLUDED.remitente_telefono ELSE envios.remitente_telefono END,
            remitente_direccion = CASE WHEN envios.anonimizado_en IS NULL AND EXCLUDED.anonimizado_en IS NOT NULL
              THEN EXCLUDED.remitente_direccion ELSE envios.remitente_direccion END,
            destinatario_nombre = CASE WHEN envios.anonimizado_en IS NULL AND EXCLUDED.anonimizado_en IS NOT NULL
              THEN EXCLUDED.destinatario_nombre ELSE envios.destinatario_nombre END,
            destinatario_telefono = CASE WHEN envios.anonimizado_en IS NULL AND EXCLUDED.anonimizado_en IS NOT NULL
              THEN EXCLUDED.destinatario_telefono ELSE envios.destinatario_telefono END,
            destinatario_direccion = CASE WHEN envios.anonimizado_en IS NULL AND EXCLUDED.anonimizado_en IS NOT NULL
              THEN EXCLUDED.destinatario_direccion ELSE envios.destinatario_direccion END,
            descripcion = CASE WHEN envios.anonimizado_en IS NULL AND EXCLUDED.anonimizado_en IS NOT NULL
              THEN EXCLUDED.descripcion ELSE envios.descripcion END,
            anonimizado_en = COALESCE(envios.anonimizado_en, EXCLUDED.anonimizado_en)
         RETURNING (xmax = 0) AS nuevo, anonimizado_en`,
        [
          s.id, s.numeroGuia, s.remitente.nombre, s.remitente.telefono, s.destinatario.nombre,
          s.destinatario.telefono, s.destinatario.direccion, s.rutaId, envio.totalPiezas, envio.pesoTotalKg,
          s.descripcion, s.costo, s.formaPago, s.estado, s.creadoPor, s.creadoEn, s.actualizadoEn,
          s.clienteId ?? null, s.zona, s.remitente.direccion,
          ev?.recibidoPor ?? null, ev?.tipo ?? null, ev?.bytes ?? null, ev?.subidaEn ?? null,
          ev?.subidaPor?.id ?? null, ev?.clave ?? null, s.integracionId ?? null, s.referenciaExterna ?? null,
          s.anonimizadoEn ?? null, s.costoAdicional, s.fechaGuia,
        ],
      );
      if (upsert.rows[0]?.nuevo) {
        for (const [i, it] of s.items.entries()) {
          await client.query(
            `INSERT INTO envio_items (envio_id, linea, tipo_carga, cantidad, peso_unitario_kg, costo_unitario, subtotal)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [s.id, i + 1, it.tipoCarga, it.cantidad, it.pesoKg, it.costoUnitario, it.subtotal],
          );
        }
      }
      const { rows } = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM historial_estados WHERE envio_id = $1",
        [s.id],
      );
      for (const ev of s.historial.slice(rows[0]!.n)) {
        await client.query(
          "INSERT INTO historial_estados (envio_id, estado, nota, usuario_id, fecha) VALUES ($1,$2,$3,$4,$5)",
          [s.id, ev.estado, ev.nota, ev.usuario?.id ?? null, ev.fecha],
        );
      }
      // Anonimizado (v12): las notas del historial también son datos personales.
      if (upsert.rows[0]?.anonimizado_en) {
        await client.query("UPDATE historial_estados SET nota = NULL WHERE envio_id = $1 AND nota IS NOT NULL", [s.id]);
      }
      // Outbox: los webhooks quedan encolados solo si el cambio del envío se confirma.
      await insertarEntregas(client, opciones.webhooks ?? []);
      // Caja: los cobros se registran solo si el cambio del envío se confirma.
      await aplicarMovimientosCaja(client, opciones.caja);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      // Carrera entre dos registros con el mismo número de guía: la restricción UNIQUE decide.
      if ((e as { code?: string; constraint?: string }).code === "23505" && (e as { constraint?: string }).constraint === "envios_numero_guia_key") {
        throw new DomainError("CONFLICTO", `La guía ${s.numeroGuia} ya está registrada`);
      }
      if ((e as { code?: string; constraint?: string }).code === "23505" && (e as { constraint?: string }).constraint === "envios_integracion_referencia_key") {
        throw new DomainError("CONFLICTO", `Ya existe un envío con la referencia ${s.referenciaExterna}`);
      }
      if ((e as { constraint?: string }).constraint === "cobros_envio_tipo_key") {
        throw new DomainError("CONFLICTO", "El envío ya tiene ese cobro registrado");
      }
      throw e;
    } finally {
      client.release();
    }
  }

  async asignarRepartidor(envioIds: string[], repartidorId: string | null, fecha: Date): Promise<number> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      // Bloquea los envíos: un cambio de estado concurrente espera y la comprobación se hace sobre lo vigente.
      const { rows } = await client.query<{ id: string; estado: EstadoEnvio; numero_guia: number }>(
        "SELECT id, estado, numero_guia FROM envios WHERE id = ANY($1::uuid[]) FOR UPDATE",
        [envioIds],
      );
      const faltante = envioIds.find((id) => !rows.some((r) => r.id === id));
      if (faltante) throw new DomainError("NO_ENCONTRADO", `Envío no encontrado: ${faltante}`);
      const final = rows.find((r) => r.estado === "ENTREGADO" || r.estado === "CANCELADO");
      if (final) {
        throw new DomainError("ESTADO_INVALIDO", `La guía ${final.numero_guia} está ${final.estado}: no se puede asignar`);
      }
      const { rowCount } = await client.query(
        "UPDATE envios SET repartidor_id = $2, asignado_en = $3 WHERE id = ANY($1::uuid[])",
        [envioIds, repartidorId, repartidorId ? fecha : null],
      );
      await client.query("COMMIT");
      return rowCount ?? 0;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async buscarPorId(id: string): Promise<Envio | null> {
    return (await this.consultar("WHERE e.id = $1", [id]))[0] ?? null;
  }

  async buscarPorNumeroGuia(numeroGuia: number): Promise<Envio | null> {
    return (await this.consultar("WHERE e.numero_guia = $1", [numeroGuia]))[0] ?? null;
  }

  async buscarPorReferencia(integracionId: string, referenciaExterna: string): Promise<Envio | null> {
    return (await this.consultar("WHERE e.integracion_id = $1 AND e.referencia_externa = $2", [integracionId, referenciaExterna]))[0] ?? null;
  }

  async estadisticasPorIntegracion(): Promise<Map<string, EstadisticaIntegracion>> {
    const { rows } = await this.db.query<{ id: string; n: number; ultimo: Date }>(
      `SELECT integracion_id AS id, count(*)::int AS n, max(creado_en) AS ultimo
         FROM envios WHERE integracion_id IS NOT NULL GROUP BY integracion_id`,
    );
    return new Map(rows.map((r) => [r.id, { envios: r.n, ultimoEnvio: r.ultimo }]));
  }

  async existeNumeroGuia(numeroGuia: number): Promise<boolean> {
    const { rowCount } = await this.db.query("SELECT 1 FROM envios WHERE numero_guia = $1", [numeroGuia]);
    return (rowCount ?? 0) > 0;
  }

  async usaTipoCarga(codigo: TipoCargaCodigo): Promise<boolean> {
    const { rowCount } = await this.db.query("SELECT 1 FROM envio_items WHERE tipo_carga = $1 LIMIT 1", [codigo]);
    return (rowCount ?? 0) > 0;
  }

  async siguienteNumeroGuia(): Promise<number> {
    const { rows } = await this.db.query<{ n: number }>("SELECT COALESCE(MAX(numero_guia), 0) + 1 AS n FROM envios");
    return Number(rows[0]!.n);
  }

  async listar(f: FiltroEnvios = {}): Promise<Envio[]> {
    const { where, params } = this.condiciones(f);
    return this.consultar(where, params);
  }

  async listarPagina(f: FiltroEnvios, { pagina, porPagina }: Paginacion): Promise<{ envios: Envio[]; total: number }> {
    const { where, params } = this.condiciones(f);
    const [conteo, envios] = await Promise.all([
      this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM envios e ${where}`, params),
      this.consultar(where, params, { limite: porPagina, desde: (pagina - 1) * porPagina }),
    ]);
    return { envios, total: conteo.rows[0]!.n };
  }

  private condiciones(f: FiltroEnvios): { where: string; params: unknown[] } {
    const cond: string[] = [];
    const params: unknown[] = [];
    if (f.estado) cond.push(`e.estado = $${params.push(f.estado)}`);
    if (f.rutaId) cond.push(`e.ruta_id = $${params.push(f.rutaId)}`);
    if (f.formaPago) cond.push(`e.forma_pago = $${params.push(f.formaPago)}`);
    if (f.clienteId) cond.push(`e.cliente_id = $${params.push(f.clienteId)}`);
    if (f.canal) cond.push(f.canal === "API" ? "e.integracion_id IS NOT NULL" : "e.integracion_id IS NULL");
    if (f.integracionId) cond.push(`e.integracion_id = $${params.push(f.integracionId)}`);
    if (f.repartidorId === null) cond.push("e.repartidor_id IS NULL");
    else if (f.repartidorId) cond.push(`e.repartidor_id = $${params.push(f.repartidorId)}`);
    if (f.estados) cond.push(`e.estado::text = ANY($${params.push(f.estados)}::text[])`);
    if (f.actualizadoDesde) cond.push(`e.actualizado_en >= $${params.push(f.actualizadoDesde)}`);
    if (f.registradoDesde) cond.push(`e.creado_en >= $${params.push(f.registradoDesde)}`);
    if (f.registradoHasta) cond.push(`e.creado_en < $${params.push(f.registradoHasta)}`);
    if (f.fechaGuiaDesde) cond.push(`e.fecha_guia >= $${params.push(f.fechaGuiaDesde)}::date`);
    if (f.fechaGuiaHasta) cond.push(`e.fecha_guia <= $${params.push(f.fechaGuiaHasta)}::date`);
    if (f.telefono) {
      const i = params.push(f.telefono);
      cond.push(
        `(regexp_replace(e.remitente_telefono, '[^0-9]', '', 'g') = $${i} OR regexp_replace(e.destinatario_telefono, '[^0-9]', '', 'g') = $${i})`,
      );
    }
    if (f.q?.trim()) {
      // Los comodines de LIKE en el texto buscado se escapan: "%" o "_" se buscan literalmente.
      const i = params.push(`%${f.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      const porGuia = f.numeroGuia ? `e.numero_guia = $${params.push(f.numeroGuia)} OR ` : "";
      cond.push(
        `(${porGuia}e.remitente_nombre ILIKE $${i} OR e.destinatario_nombre ILIKE $${i} OR e.referencia_externa ILIKE $${i})`,
      );
    }
    return { where: cond.length ? `WHERE ${cond.join(" AND ")}` : "", params };
  }

  /** `id` desempata envíos con la misma fecha para que las páginas no repitan ni salten filas. */
  private async consultar(
    where: string,
    params: unknown[],
    pagina?: { limite: number; desde: number },
  ): Promise<Envio[]> {
    const p = [...params];
    const limite = pagina ? ` LIMIT $${p.push(pagina.limite)} OFFSET $${p.push(pagina.desde)}` : "";
    const { rows } = await this.db.query<EnvioRow>(
      `SELECT e.*, ue.nombre AS evidencia_subida_por_nombre, ig.nombre AS integracion_nombre,
              ur.nombre AS repartidor_nombre
         FROM envios e LEFT JOIN usuarios ue ON ue.id = e.evidencia_subida_por
         LEFT JOIN integraciones ig ON ig.id = e.integracion_id
         LEFT JOIN usuarios ur ON ur.id = e.repartidor_id
       ${where} ORDER BY e.creado_en DESC, e.id DESC${limite}`,
      p,
    );
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const itemsRes = await this.db.query<ItemRow>(
      `SELECT envio_id, tipo_carga, cantidad, peso_unitario_kg, costo_unitario, subtotal
         FROM envio_items WHERE envio_id = ANY($1::uuid[]) ORDER BY envio_id, linea`,
      [ids],
    );
    const itemsPorEnvio = new Map<string, ItemEnvio[]>();
    for (const it of itemsRes.rows) {
      const lista = itemsPorEnvio.get(it.envio_id) ?? [];
      lista.push({
        tipoCarga: it.tipo_carga,
        cantidad: it.cantidad,
        pesoKg: it.peso_unitario_kg,
        costoUnitario: it.costo_unitario,
        subtotal: it.subtotal,
      });
      itemsPorEnvio.set(it.envio_id, lista);
    }
    const hist = await this.db.query<HistorialRow>(
      `SELECT h.envio_id, h.estado, h.nota, h.fecha, h.usuario_id, u.nombre AS usuario_nombre
         FROM historial_estados h LEFT JOIN usuarios u ON u.id = h.usuario_id
        WHERE h.envio_id = ANY($1::uuid[]) ORDER BY h.fecha, h.id`,
      [ids],
    );
    const porEnvio = new Map<string, EventoHistorial[]>();
    for (const h of hist.rows) {
      const lista = porEnvio.get(h.envio_id) ?? [];
      lista.push({
        estado: h.estado,
        nota: h.nota,
        fecha: h.fecha,
        usuario: h.usuario_id ? { id: h.usuario_id, nombre: h.usuario_nombre ?? "" } : null,
      });
      porEnvio.set(h.envio_id, lista);
    }
    return rows.map((r) =>
      Envio.reconstruir({
        id: r.id,
        numeroGuia: Number(r.numero_guia),
        clienteId: r.cliente_id,
        remitente: { nombre: r.remitente_nombre, telefono: r.remitente_telefono, direccion: r.remitente_direccion },
        destinatario: {
          nombre: r.destinatario_nombre,
          telefono: r.destinatario_telefono,
          direccion: r.destinatario_direccion,
        },
        rutaId: r.ruta_id,
        items: itemsPorEnvio.get(r.id) ?? [],
        zona: r.zona,
        formaPago: r.forma_pago,
        descripcion: r.descripcion,
        costo: r.costo,
        costoAdicional: r.costo_adicional ?? 0,
        fechaGuia: r.fecha_guia,
        estado: r.estado,
        creadoPor: r.creado_por,
        creadoEn: r.creado_en,
        actualizadoEn: r.actualizado_en,
        historial: porEnvio.get(r.id) ?? [],
        evidencia: aEvidencia(r),
        integracionId: r.integracion_id,
        integracionNombre: r.integracion_nombre,
        referenciaExterna: r.referencia_externa,
        repartidor: r.repartidor_id ? { id: r.repartidor_id, nombre: r.repartidor_nombre ?? "" } : null,
        asignadoEn: r.asignado_en,
        anonimizadoEn: r.anonimizado_en,
      }),
    );
  }
}
