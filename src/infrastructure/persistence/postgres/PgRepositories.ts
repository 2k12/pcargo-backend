import type {
  CambiosCiudad,
  CambiosRuta,
  CiudadRepository,
  EnvioRepository,
  FiltroEnvios,
  NuevaRuta,
  RutaRepository,
  TipoCargaRepository,
  UsuarioRepository,
} from "../../../application/ports/repositories.js";
import type { TipoCarga, TipoCargaCodigo } from "../../../domain/carga/TipoCarga.js";
import { Envio, type EventoHistorial, type ItemEnvio } from "../../../domain/envio/Envio.js";
import type { EstadoEnvio } from "../../../domain/envio/EstadoEnvio.js";
import type { FormaPago } from "../../../domain/envio/FormaPago.js";
import type { Ciudad, Ruta } from "../../../domain/ruta/Ruta.js";
import type { Usuario, UsuarioConCredenciales } from "../../../domain/usuario/Usuario.js";
import type { Db } from "./pool.js";

export class PgUsuarioRepository implements UsuarioRepository {
  constructor(private readonly db: Db) {}

  async buscarPorEmail(email: string): Promise<UsuarioConCredenciales | null> {
    const { rows } = await this.db.query(
      `SELECT id, nombre, email, rol, password_hash AS "passwordHash", activo
         FROM usuarios WHERE email = $1`,
      [email],
    );
    return rows[0] ?? null;
  }

  async buscarPorId(id: string): Promise<Usuario | null> {
    const { rows } = await this.db.query(
      "SELECT id, nombre, email, rol FROM usuarios WHERE id = $1 AND activo",
      [id],
    );
    return rows[0] ?? null;
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
    await this.db.query("DELETE FROM ciudades WHERE id = $1", [id]);
  }
}

export class PgTipoCargaRepository implements TipoCargaRepository {
  private static readonly SELECT = `SELECT codigo, nombre, factor, peso_incluido_kg AS "pesoIncluidoKg",
    peso_max_kg AS "pesoMaxKg" FROM tipos_carga`;

  constructor(private readonly db: Db) {}

  async listar(): Promise<TipoCarga[]> {
    return (await this.db.query(`${PgTipoCargaRepository.SELECT} ORDER BY factor`)).rows;
  }

  async buscarPorCodigo(codigo: TipoCargaCodigo): Promise<TipoCarga | null> {
    return (await this.db.query(`${PgTipoCargaRepository.SELECT} WHERE codigo = $1`, [codigo])).rows[0] ?? null;
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
  tarifa_base: number;
  tiempo_estimado_min: number;
  activa: boolean;
}

const SELECT_RUTA = `
  SELECT r.id, r.origen_id, o.nombre AS origen_nombre, o.activa AS origen_activa,
         r.destino_id, d.nombre AS destino_nombre, d.activa AS destino_activa,
         r.tarifa_base, r.tiempo_estimado_min, r.activa
    FROM rutas r
    JOIN ciudades o ON o.id = r.origen_id
    JOIN ciudades d ON d.id = r.destino_id`;

const aRuta = (r: RutaRow): Ruta => ({
  id: r.id,
  origen: { id: r.origen_id, nombre: r.origen_nombre, activa: r.origen_activa },
  destino: { id: r.destino_id, nombre: r.destino_nombre, activa: r.destino_activa },
  tarifaBase: r.tarifa_base,
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
      `INSERT INTO rutas (origen_id, destino_id, tarifa_base, tiempo_estimado_min)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [d.origenId, d.destinoId, d.tarifaBase, d.tiempoEstimadoMin],
    );
    return (await this.buscarPorId(rows[0]!.id))!;
  }

  async actualizar(id: number, c: CambiosRuta): Promise<Ruta> {
    await this.db.query(
      `UPDATE rutas SET tarifa_base = COALESCE($2, tarifa_base),
                        tiempo_estimado_min = COALESCE($3, tiempo_estimado_min),
                        activa = COALESCE($4, activa)
        WHERE id = $1`,
      [id, c.tarifaBase ?? null, c.tiempoEstimadoMin ?? null, c.activa ?? null],
    );
    return (await this.buscarPorId(id))!;
  }
}

interface EnvioRow {
  id: string;
  codigo: string;
  remitente_nombre: string;
  remitente_telefono: string;
  destinatario_nombre: string;
  destinatario_telefono: string;
  destinatario_direccion: string;
  ruta_id: number;
  descripcion: string | null;
  costo: number;
  forma_pago: FormaPago;
  estado: EstadoEnvio;
  creado_por: string | null;
  creado_en: Date;
  actualizado_en: Date;
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
  async guardar(envio: Envio): Promise<void> {
    const s = envio.toSnapshot();
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const upsert = await client.query<{ nuevo: boolean }>(
        `INSERT INTO envios (id, codigo, remitente_nombre, remitente_telefono, destinatario_nombre,
            destinatario_telefono, destinatario_direccion, ruta_id, total_piezas, peso_total_kg, descripcion,
            costo, forma_pago, estado, creado_por, creado_en, actualizado_en)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (id) DO UPDATE SET estado = EXCLUDED.estado, actualizado_en = EXCLUDED.actualizado_en
         RETURNING (xmax = 0) AS nuevo`,
        [
          s.id, s.codigo, s.remitente.nombre, s.remitente.telefono, s.destinatario.nombre,
          s.destinatario.telefono, s.destinatario.direccion, s.rutaId, envio.totalPiezas, envio.pesoTotalKg,
          s.descripcion, s.costo, s.formaPago, s.estado, s.creadoPor, s.creadoEn, s.actualizadoEn,
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
      await client.query("COMMIT");
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

  async buscarPorCodigo(codigo: string): Promise<Envio | null> {
    return (await this.consultar("WHERE e.codigo = $1", [codigo]))[0] ?? null;
  }

  async existeCodigo(codigo: string): Promise<boolean> {
    const { rowCount } = await this.db.query("SELECT 1 FROM envios WHERE codigo = $1", [codigo]);
    return (rowCount ?? 0) > 0;
  }

  async listar(f: FiltroEnvios = {}): Promise<Envio[]> {
    const cond: string[] = [];
    const params: unknown[] = [];
    if (f.estado) cond.push(`e.estado = $${params.push(f.estado)}`);
    if (f.rutaId) cond.push(`e.ruta_id = $${params.push(f.rutaId)}`);
    if (f.formaPago) cond.push(`e.forma_pago = $${params.push(f.formaPago)}`);
    if (f.q?.trim()) {
      const i = params.push(`%${f.q.trim()}%`);
      cond.push(`(e.codigo ILIKE $${i} OR e.remitente_nombre ILIKE $${i} OR e.destinatario_nombre ILIKE $${i})`);
    }
    return this.consultar(cond.length ? `WHERE ${cond.join(" AND ")}` : "", params);
  }

  private async consultar(where: string, params: unknown[]): Promise<Envio[]> {
    const { rows } = await this.db.query<EnvioRow>(
      `SELECT e.* FROM envios e ${where} ORDER BY e.creado_en DESC`,
      params,
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
        codigo: r.codigo,
        remitente: { nombre: r.remitente_nombre, telefono: r.remitente_telefono },
        destinatario: {
          nombre: r.destinatario_nombre,
          telefono: r.destinatario_telefono,
          direccion: r.destinatario_direccion,
        },
        rutaId: r.ruta_id,
        items: itemsPorEnvio.get(r.id) ?? [],
        formaPago: r.forma_pago,
        descripcion: r.descripcion,
        costo: r.costo,
        estado: r.estado,
        creadoPor: r.creado_por,
        creadoEn: r.creado_en,
        actualizadoEn: r.actualizado_en,
        historial: porEnvio.get(r.id) ?? [],
      }),
    );
  }
}
