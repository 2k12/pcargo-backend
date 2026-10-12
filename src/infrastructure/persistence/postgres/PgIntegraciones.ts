import type pg from "pg";
import type {
  ClaveIdempotencia,
  EntregaWebhookRepository,
  FiltroEntregas,
  IdempotenciaRepository,
  IntegracionRepository,
  SolicitudApi,
  SolicitudApiRepository,
} from "../../../application/ports/integraciones.js";
import type { Paginacion } from "../../../application/ports/repositories.js";
import type { FormaPago } from "../../../domain/envio/FormaPago.js";
import type { ResultadoReserva, RespuestaGuardada } from "../../../domain/integracion/Idempotencia.js";
import type { Alcance, ApiKey, EventoWebhook, Integracion, ModoKey } from "../../../domain/integracion/Integracion.js";
import type { EntregaWebhook, EstadoEntrega } from "../../../domain/integracion/Webhook.js";
import { DomainError } from "../../../domain/shared/DomainError.js";
import type { Db } from "./pool.js";

interface IntegracionRow {
  id: string;
  nombre: string;
  activa: boolean;
  remitente_nombre: string;
  remitente_telefono: string;
  remitente_direccion: string;
  ciudad_origen_id: number;
  forma_pago_defecto: FormaPago;
  cliente_id: string | null;
  ips_permitidas: string[];
  webhook_url: string | null;
  webhook_eventos: EventoWebhook[] | null;
  webhook_activo: boolean | null;
  webhook_secreto_cifrado: string | null;
  webhook_secreto_prefijo: string | null;
  creada_en: Date;
}

interface KeyRow {
  id: string;
  integracion_id: string;
  nombre: string;
  modo: ModoKey;
  prefijo: string;
  hash_sha256: string;
  alcances: Alcance[];
  creada_en: Date;
  ultimo_uso_en: Date | null;
  revocada_en: Date | null;
}

const aKey = (r: KeyRow): ApiKey => ({
  id: r.id,
  integracionId: r.integracion_id,
  nombre: r.nombre,
  modo: r.modo,
  prefijo: r.prefijo,
  hash: r.hash_sha256,
  alcances: r.alcances,
  creadaEn: r.creada_en,
  ultimoUsoEn: r.ultimo_uso_en,
  revocadaEn: r.revocada_en,
});

const aIntegracion = (r: IntegracionRow, keys: ApiKey[]): Integracion => ({
  id: r.id,
  nombre: r.nombre,
  activa: r.activa,
  remitente: { nombre: r.remitente_nombre, telefono: r.remitente_telefono, direccion: r.remitente_direccion },
  ciudadOrigenId: r.ciudad_origen_id,
  formaPagoPorDefecto: r.forma_pago_defecto,
  clienteId: r.cliente_id,
  ipsPermitidas: r.ips_permitidas,
  webhook:
    r.webhook_url === null
      ? null
      : {
          url: r.webhook_url,
          eventos: r.webhook_eventos ?? [],
          activo: r.webhook_activo ?? false,
          secretoCifrado: r.webhook_secreto_cifrado ?? "",
          secretoPrefijo: r.webhook_secreto_prefijo ?? "",
        },
  creadaEn: r.creada_en,
  keys,
});

const esUnico = (e: unknown, restriccion?: string): boolean =>
  (e as { code?: string }).code === "23505" && (!restriccion || (e as { constraint?: string }).constraint === restriccion);

export class PgIntegracionRepository implements IntegracionRepository {
  constructor(private readonly db: Db) {}

  private async consultar(where: string, params: unknown[]): Promise<Integracion[]> {
    const { rows } = await this.db.query<IntegracionRow>(`SELECT * FROM integraciones ${where} ORDER BY lower(nombre), id`, params);
    if (rows.length === 0) return [];
    const keys = await this.db.query<KeyRow>(
      "SELECT * FROM api_keys WHERE integracion_id = ANY($1::uuid[]) ORDER BY creada_en, id",
      [rows.map((r) => r.id)],
    );
    const porIntegracion = new Map<string, ApiKey[]>();
    for (const k of keys.rows) {
      const lista = porIntegracion.get(k.integracion_id) ?? [];
      lista.push(aKey(k));
      porIntegracion.set(k.integracion_id, lista);
    }
    return rows.map((r) => aIntegracion(r, porIntegracion.get(r.id) ?? []));
  }

  listar(): Promise<Integracion[]> {
    return this.consultar("", []);
  }

  async buscarPorId(id: string): Promise<Integracion | null> {
    return (await this.consultar("WHERE id = $1", [id]))[0] ?? null;
  }

  async existeNombre(nombre: string, excluirId?: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      "SELECT 1 FROM integraciones WHERE lower(nombre) = lower($1) AND id IS DISTINCT FROM $2::uuid",
      [nombre, excluirId ?? null],
    );
    return (rowCount ?? 0) > 0;
  }

  async guardar(i: Integracion): Promise<void> {
    const w = i.webhook;
    try {
      await this.db.query(
        `INSERT INTO integraciones (id, nombre, activa, remitente_nombre, remitente_telefono, remitente_direccion,
            ciudad_origen_id, forma_pago_defecto, cliente_id, ips_permitidas, webhook_url, webhook_eventos,
            webhook_activo, webhook_secreto_cifrado, webhook_secreto_prefijo, creada_en)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (id) DO UPDATE SET nombre = EXCLUDED.nombre, activa = EXCLUDED.activa,
            remitente_nombre = EXCLUDED.remitente_nombre, remitente_telefono = EXCLUDED.remitente_telefono,
            remitente_direccion = EXCLUDED.remitente_direccion, ciudad_origen_id = EXCLUDED.ciudad_origen_id,
            forma_pago_defecto = EXCLUDED.forma_pago_defecto, cliente_id = EXCLUDED.cliente_id,
            ips_permitidas = EXCLUDED.ips_permitidas, webhook_url = EXCLUDED.webhook_url,
            webhook_eventos = EXCLUDED.webhook_eventos, webhook_activo = EXCLUDED.webhook_activo,
            webhook_secreto_cifrado = EXCLUDED.webhook_secreto_cifrado,
            webhook_secreto_prefijo = EXCLUDED.webhook_secreto_prefijo`,
        [
          i.id, i.nombre, i.activa, i.remitente.nombre, i.remitente.telefono, i.remitente.direccion, i.ciudadOrigenId,
          i.formaPagoPorDefecto, i.clienteId, i.ipsPermitidas, w?.url ?? null, w?.eventos ?? null, w?.activo ?? null,
          w?.secretoCifrado ?? null, w?.secretoPrefijo ?? null, i.creadaEn,
        ],
      );
    } catch (e) {
      if (esUnico(e, "integraciones_nombre_key")) {
        throw new DomainError("CONFLICTO", `Ya existe una integración llamada ${i.nombre}`);
      }
      throw e;
    }
  }

  async eliminar(id: string): Promise<void> {
    try {
      await this.db.query("DELETE FROM integraciones WHERE id = $1", [id]);
    } catch (e) {
      if ((e as { code?: string }).code === "23503") {
        throw new DomainError("CONFLICTO", "La integración tiene envíos registrados: desactívela en lugar de eliminarla");
      }
      throw e;
    }
  }

  async crearKey(k: ApiKey): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO api_keys (id, integracion_id, nombre, modo, prefijo, hash_sha256, alcances, creada_en)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [k.id, k.integracionId, k.nombre, k.modo, k.prefijo, k.hash, k.alcances, k.creadaEn],
      );
    } catch (e) {
      if (esUnico(e)) throw new DomainError("CONFLICTO", "Prefijo de key repetido; genere otra");
      throw e;
    }
  }

  async revocarKey(integracionId: string, keyId: string, fecha: Date): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE api_keys SET revocada_en = COALESCE(revocada_en, $3) WHERE id = $2 AND integracion_id = $1`,
      [integracionId, keyId, fecha],
    );
    return (rowCount ?? 0) > 0;
  }

  async buscarPorPrefijoKey(prefijo: string): Promise<{ key: ApiKey; integracion: Integracion } | null> {
    const { rows } = await this.db.query<KeyRow>("SELECT * FROM api_keys WHERE prefijo = $1", [prefijo]);
    if (!rows[0]) return null;
    const integracion = await this.buscarPorId(rows[0].integracion_id);
    return integracion ? { key: aKey(rows[0]), integracion } : null;
  }

  async registrarUsoKey(keyId: string, fecha: Date): Promise<void> {
    await this.db.query("UPDATE api_keys SET ultimo_uso_en = $2 WHERE id = $1", [keyId, fecha]);
  }
}

interface EntregaRow {
  id: string;
  integracion_id: string;
  mensaje_id: string;
  evento: EventoWebhook;
  envio_id: string | null;
  numero_guia: string | number | null;
  cuerpo: string;
  prueba: boolean;
  estado: EstadoEntrega;
  intentos: number;
  ultimo_status: number | null;
  ultimo_error: string | null;
  proximo_intento_en: Date | null;
  creado_en: Date;
  entregado_en: Date | null;
}

const aEntrega = (r: EntregaRow): EntregaWebhook => ({
  id: r.id,
  integracionId: r.integracion_id,
  mensajeId: r.mensaje_id,
  evento: r.evento,
  envioId: r.envio_id,
  numeroGuia: r.numero_guia === null ? null : Number(r.numero_guia),
  cuerpo: r.cuerpo,
  prueba: r.prueba,
  estado: r.estado,
  intentos: r.intentos,
  ultimoStatus: r.ultimo_status,
  ultimoError: r.ultimo_error,
  proximoIntentoEn: r.proximo_intento_en,
  creadoEn: r.creado_en,
  entregadoEn: r.entregado_en,
});

/** Inserta entregas con el cliente dado (permite hacerlo dentro de la transacción del envío). */
export async function insertarEntregas(cliente: Pick<pg.PoolClient, "query">, entregas: EntregaWebhook[]): Promise<void> {
  for (const e of entregas) {
    await cliente.query(
      `INSERT INTO webhook_entregas (id, integracion_id, mensaje_id, evento, envio_id, numero_guia, cuerpo, prueba,
          estado, intentos, ultimo_status, ultimo_error, proximo_intento_en, creado_en, entregado_en)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        e.id, e.integracionId, e.mensajeId, e.evento, e.envioId, e.numeroGuia, e.cuerpo, e.prueba, e.estado,
        e.intentos, e.ultimoStatus, e.ultimoError, e.proximoIntentoEn, e.creadoEn, e.entregadoEn,
      ],
    );
  }
}

export class PgEntregaWebhookRepository implements EntregaWebhookRepository {
  constructor(private readonly db: Db) {}

  async crear(entrega: EntregaWebhook): Promise<void> {
    await insertarEntregas(this.db, [entrega]);
  }

  async actualizar(e: EntregaWebhook): Promise<void> {
    await this.db.query(
      `UPDATE webhook_entregas SET estado = $2, intentos = $3, ultimo_status = $4, ultimo_error = $5,
          proximo_intento_en = $6, entregado_en = $7, bloqueado_hasta = NULL
        WHERE id = $1`,
      [e.id, e.estado, e.intentos, e.ultimoStatus, e.ultimoError, e.proximoIntentoEn, e.entregadoEn],
    );
  }

  async buscarPorId(integracionId: string, id: string): Promise<EntregaWebhook | null> {
    const { rows } = await this.db.query<EntregaRow>(
      "SELECT * FROM webhook_entregas WHERE id = $1 AND integracion_id = $2",
      [id, integracionId],
    );
    return rows[0] ? aEntrega(rows[0]) : null;
  }

  async listarPagina(integracionId: string, f: FiltroEntregas, { pagina, porPagina }: Paginacion) {
    const params: unknown[] = [integracionId];
    const estado = f.estado ? ` AND estado = $${params.push(f.estado)}` : "";
    const where = `WHERE integracion_id = $1${estado}`;
    const [conteo, filas] = await Promise.all([
      this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM webhook_entregas ${where}`, params),
      this.db.query<EntregaRow>(
        `SELECT * FROM webhook_entregas ${where} ORDER BY creado_en DESC, id DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, porPagina, (pagina - 1) * porPagina],
      ),
    ]);
    return { entregas: filas.rows.map(aEntrega), total: conteo.rows[0]!.n };
  }

  /**
   * Reserva con `FOR UPDATE SKIP LOCKED` y un "arriendo" (`bloqueado_hasta`): varios procesos pueden despachar a
   * la vez sin tomar la misma entrega, y si uno muere a mitad del envío la entrega vuelve a quedar libre al vencer.
   */
  async tomarPendientes(ahora: Date, limite: number, bloqueoHasta: Date): Promise<EntregaWebhook[]> {
    const { rows } = await this.db.query<EntregaRow>(
      `UPDATE webhook_entregas SET bloqueado_hasta = $3
        WHERE id IN (
          SELECT id FROM webhook_entregas
           WHERE estado = 'PENDIENTE' AND proximo_intento_en <= $1
             AND (bloqueado_hasta IS NULL OR bloqueado_hasta <= $1)
           ORDER BY proximo_intento_en
           LIMIT $2
           FOR UPDATE SKIP LOCKED)
        RETURNING *`,
      [ahora, limite, bloqueoHasta],
    );
    return rows.map(aEntrega).sort((a, b) => a.proximoIntentoEn!.getTime() - b.proximoIntentoEn!.getTime());
  }
}

interface SolicitudRow {
  id: string;
  integracion_id: string | null;
  fecha: Date;
  metodo: string;
  ruta: string;
  status: number;
  ip: string;
  key_prefijo: string | null;
  idempotency_key: string | null;
  referencia_externa: string | null;
  duracion_ms: number;
  request_id: string;
}

const aSolicitud = (r: SolicitudRow): SolicitudApi => ({
  id: r.id,
  integracionId: r.integracion_id,
  fecha: r.fecha,
  metodo: r.metodo,
  ruta: r.ruta,
  status: r.status,
  ip: r.ip,
  keyPrefijo: r.key_prefijo,
  idempotencyKey: r.idempotency_key,
  referenciaExterna: r.referencia_externa,
  duracionMs: r.duracion_ms,
  requestId: r.request_id,
});

export class PgSolicitudApiRepository implements SolicitudApiRepository {
  constructor(private readonly db: Db) {}

  async registrar(s: SolicitudApi): Promise<void> {
    await this.db.query(
      `INSERT INTO api_solicitudes (id, integracion_id, fecha, metodo, ruta, status, ip, key_prefijo, idempotency_key,
          referencia_externa, duracion_ms, request_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        s.id, s.integracionId, s.fecha, s.metodo, s.ruta, s.status, s.ip, s.keyPrefijo, s.idempotencyKey,
        s.referenciaExterna, s.duracionMs, s.requestId,
      ],
    );
  }

  async listarPagina(integracionId: string, { pagina, porPagina }: Paginacion) {
    const [conteo, filas] = await Promise.all([
      this.db.query<{ n: number }>("SELECT count(*)::int AS n FROM api_solicitudes WHERE integracion_id = $1", [integracionId]),
      this.db.query<SolicitudRow>(
        `SELECT * FROM api_solicitudes WHERE integracion_id = $1 ORDER BY fecha DESC, id DESC LIMIT $2 OFFSET $3`,
        [integracionId, porPagina, (pagina - 1) * porPagina],
      ),
    ]);
    return { solicitudes: filas.rows.map(aSolicitud), total: conteo.rows[0]!.n };
  }

  async purgarAnteriores(fecha: Date): Promise<number> {
    return (await this.db.query("DELETE FROM api_solicitudes WHERE fecha < $1", [fecha])).rowCount ?? 0;
  }
}

interface IdempotenciaRow {
  huella: string;
  estado: "EN_PROCESO" | "COMPLETADA";
  status: number | null;
  respuesta: string | null;
}

export class PgIdempotenciaRepository implements IdempotenciaRepository {
  constructor(private readonly db: Db) {}

  /**
   * Una sola sentencia atómica: inserta la reserva o, si ya existía vencida/abandonada, la toma. Si no se pudo
   * (existe y está vigente) se lee la fila para decidir entre replay, conflicto o "en proceso".
   */
  async reservar(
    c: ClaveIdempotencia,
    huella: string,
    ahora: Date,
    limites: { vigenteDesde: Date; abandonadaAntesDe: Date },
  ): Promise<ResultadoReserva> {
    const tomada = await this.db.query(
      `INSERT INTO api_idempotencia (integracion_id, modo, clave, huella, estado, creado_en, actualizado_en)
       VALUES ($1, $2, $3, $4, 'EN_PROCESO', $5, $5)
       ON CONFLICT (integracion_id, modo, clave) DO UPDATE
          SET huella = EXCLUDED.huella, estado = 'EN_PROCESO', status = NULL, respuesta = NULL,
              creado_en = EXCLUDED.creado_en, actualizado_en = EXCLUDED.actualizado_en
        WHERE api_idempotencia.creado_en < $6
           OR (api_idempotencia.estado = 'EN_PROCESO' AND api_idempotencia.creado_en < $7)
       RETURNING 1`,
      [c.integracionId, c.modo, c.clave, huella, ahora, limites.vigenteDesde, limites.abandonadaAntesDe],
    );
    if ((tomada.rowCount ?? 0) > 0) return { tipo: "nueva" };
    const { rows } = await this.db.query<IdempotenciaRow>(
      "SELECT huella, estado, status, respuesta FROM api_idempotencia WHERE integracion_id = $1 AND modo = $2 AND clave = $3",
      [c.integracionId, c.modo, c.clave],
    );
    const fila = rows[0];
    if (!fila) return this.reservar(c, huella, ahora, limites); // se liberó entre ambas consultas
    if (fila.huella !== huella) return { tipo: "conflicto" };
    if (fila.estado === "EN_PROCESO" || fila.status === null || fila.respuesta === null) return { tipo: "en_proceso" };
    return { tipo: "repetida", respuesta: { status: fila.status, cuerpo: fila.respuesta } };
  }

  async completar(c: ClaveIdempotencia, r: RespuestaGuardada, ahora: Date): Promise<void> {
    await this.db.query(
      `UPDATE api_idempotencia SET estado = 'COMPLETADA', status = $4, respuesta = $5, actualizado_en = $6
        WHERE integracion_id = $1 AND modo = $2 AND clave = $3`,
      [c.integracionId, c.modo, c.clave, r.status, r.cuerpo, ahora],
    );
  }

  async liberar(c: ClaveIdempotencia): Promise<void> {
    await this.db.query("DELETE FROM api_idempotencia WHERE integracion_id = $1 AND modo = $2 AND clave = $3", [
      c.integracionId,
      c.modo,
      c.clave,
    ]);
  }

  async purgarAnteriores(fecha: Date): Promise<number> {
    return (await this.db.query("DELETE FROM api_idempotencia WHERE creado_en < $1", [fecha])).rowCount ?? 0;
  }
}
