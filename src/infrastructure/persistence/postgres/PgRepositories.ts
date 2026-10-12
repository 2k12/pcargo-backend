import type {
  CambiosCiudad,
  CambiosRuta,
  CiudadRepository,
  EnvioRepository,
  FiltroEnvios,
  Paginacion,
  NuevaRuta,
  RutaRepository,
  TipoCargaRepository,
  UsuarioRepository,
} from "../../../application/ports/repositories.js";
import type { TipoCarga, TipoCargaCodigo } from "../../../domain/carga/TipoCarga.js";
import { Envio, type EventoHistorial, type ItemEnvio } from "../../../domain/envio/Envio.js";
import type { EstadoEnvio } from "../../../domain/envio/EstadoEnvio.js";
import type { EvidenciaEntrega, TipoImagen } from "../../../domain/envio/Evidencia.js";
import type { FormaPago } from "../../../domain/envio/FormaPago.js";
import type { Ciudad, Ruta } from "../../../domain/ruta/Ruta.js";
import type { Zona } from "../../../domain/tarifa/Zona.js";
import type { CambiosPerfil, Usuario, UsuarioConCredenciales } from "../../../domain/usuario/Usuario.js";
import { DomainError } from "../../../domain/shared/DomainError.js";
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

  async buscarCredencialesPorId(id: string): Promise<UsuarioConCredenciales | null> {
    const { rows } = await this.db.query(
      `SELECT id, nombre, email, rol, password_hash AS "passwordHash", activo
         FROM usuarios WHERE id = $1 AND activo`,
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
    try {
      const { rows } = await this.db.query<Usuario>(
        `UPDATE usuarios SET nombre = COALESCE($2, nombre), email = COALESCE($3, email)
          WHERE id = $1 RETURNING id, nombre, email, rol`,
        [id, c.nombre ?? null, c.email ?? null],
      );
      return rows[0]!;
    } catch (e) {
      // Dos usuarios tomando el mismo correo a la vez: decide la restricción UNIQUE.
      if ((e as { code?: string }).code === "23505") {
        throw new DomainError("CONFLICTO", "Ese correo ya está registrado por otro usuario");
      }
      throw e;
    }
  }

  async actualizarPasswordHash(id: string, passwordHash: string): Promise<void> {
    await this.db.query("UPDATE usuarios SET password_hash = $2 WHERE id = $1", [id, passwordHash]);
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

interface TipoCargaRow {
  codigo: TipoCargaCodigo;
  nombre: string;
  precio: number;
  precio_rural: number | null;
  mayoreo_minimo_exclusivo: number | null;
  mayoreo_precio: number | null;
  peso_max_kg: number;
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
});

export class PgTipoCargaRepository implements TipoCargaRepository {
  private static readonly SELECT = `SELECT codigo, nombre, precio, precio_rural, mayoreo_minimo_exclusivo,
    mayoreo_precio, peso_max_kg FROM tipos_carga`;

  constructor(private readonly db: Db) {}

  async listar(): Promise<TipoCarga[]> {
    const { rows } = await this.db.query<TipoCargaRow>(`${PgTipoCargaRepository.SELECT} ORDER BY orden, codigo`);
    return rows.map(aTipoCarga);
  }

  async buscarPorCodigo(codigo: TipoCargaCodigo): Promise<TipoCarga | null> {
    const { rows } = await this.db.query<TipoCargaRow>(`${PgTipoCargaRepository.SELECT} WHERE codigo = $1`, [codigo]);
    return rows[0] ? aTipoCarga(rows[0]) : null;
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
    const ev = s.evidencia ?? null;
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const upsert = await client.query<{ nuevo: boolean }>(
        `INSERT INTO envios (id, numero_guia, remitente_nombre, remitente_telefono, destinatario_nombre,
            destinatario_telefono, destinatario_direccion, ruta_id, total_piezas, peso_total_kg, descripcion,
            costo, forma_pago, estado, creado_por, creado_en, actualizado_en, cliente_id, zona,
            remitente_direccion, evidencia_recibido_por, evidencia_tipo, evidencia_bytes, evidencia_subida_en,
            evidencia_subida_por, evidencia_clave)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
         ON CONFLICT (id) DO UPDATE SET estado = EXCLUDED.estado, actualizado_en = EXCLUDED.actualizado_en,
            evidencia_recibido_por = EXCLUDED.evidencia_recibido_por, evidencia_tipo = EXCLUDED.evidencia_tipo,
            evidencia_bytes = EXCLUDED.evidencia_bytes, evidencia_subida_en = EXCLUDED.evidencia_subida_en,
            evidencia_subida_por = EXCLUDED.evidencia_subida_por, evidencia_clave = EXCLUDED.evidencia_clave
         RETURNING (xmax = 0) AS nuevo`,
        [
          s.id, s.numeroGuia, s.remitente.nombre, s.remitente.telefono, s.destinatario.nombre,
          s.destinatario.telefono, s.destinatario.direccion, s.rutaId, envio.totalPiezas, envio.pesoTotalKg,
          s.descripcion, s.costo, s.formaPago, s.estado, s.creadoPor, s.creadoEn, s.actualizadoEn,
          s.clienteId ?? null, s.zona, s.remitente.direccion,
          ev?.recibidoPor ?? null, ev?.tipo ?? null, ev?.bytes ?? null, ev?.subidaEn ?? null,
          ev?.subidaPor?.id ?? null, ev?.clave ?? null,
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
      // Carrera entre dos registros con el mismo número de guía: la restricción UNIQUE decide.
      if ((e as { code?: string; constraint?: string }).code === "23505" && (e as { constraint?: string }).constraint === "envios_numero_guia_key") {
        throw new DomainError("CONFLICTO", `La guía ${s.numeroGuia} ya está registrada`);
      }
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

  async existeNumeroGuia(numeroGuia: number): Promise<boolean> {
    const { rowCount } = await this.db.query("SELECT 1 FROM envios WHERE numero_guia = $1", [numeroGuia]);
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
    if (f.q?.trim()) {
      const i = params.push(`%${f.q.trim()}%`);
      const porGuia = f.numeroGuia ? `e.numero_guia = $${params.push(f.numeroGuia)} OR ` : "";
      cond.push(`(${porGuia}e.remitente_nombre ILIKE $${i} OR e.destinatario_nombre ILIKE $${i})`);
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
      `SELECT e.*, ue.nombre AS evidencia_subida_por_nombre
         FROM envios e LEFT JOIN usuarios ue ON ue.id = e.evidencia_subida_por
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
        estado: r.estado,
        creadoPor: r.creado_por,
        creadoEn: r.creado_en,
        actualizadoEn: r.actualizado_en,
        historial: porEnvio.get(r.id) ?? [],
        evidencia: aEvidencia(r),
      }),
    );
  }
}
