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
import type { RespuestaGuardada, ResultadoReserva } from "../../../domain/integracion/Idempotencia.js";
import type { ApiKey, Integracion } from "../../../domain/integracion/Integracion.js";
import type { EntregaWebhook } from "../../../domain/integracion/Webhook.js";
import { DomainError } from "../../../domain/shared/DomainError.js";

const copiaKey = (k: ApiKey): ApiKey => ({ ...k, alcances: [...k.alcances] });

const copia = (i: Integracion): Integracion => ({
  ...i,
  remitente: { ...i.remitente },
  ipsPermitidas: [...i.ipsPermitidas],
  webhook: i.webhook && { ...i.webhook, eventos: [...i.webhook.eventos] },
  keys: i.keys.map(copiaKey),
});

const mismoNombre = (a: string, b: string) => a.localeCompare(b, "es", { sensitivity: "accent" }) === 0;

const desc = <T extends { id: string }>(fecha: (x: T) => Date) => (a: T, b: T) =>
  fecha(b).getTime() - fecha(a).getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

export class InMemoryIntegracionRepository implements IntegracionRepository {
  private readonly datos = new Map<string, Integracion>();

  /** Para que el repositorio de envíos en memoria resuelva el nombre actual de la integración. */
  nombre = (id: string): string | null => this.datos.get(id)?.nombre ?? null;

  /** Al eliminar una integración se borran también sus dependientes (como ON DELETE CASCADE). */
  constructor(private readonly alEliminar: (id: string) => void = () => {}) {}

  async listar(): Promise<Integracion[]> {
    return [...this.datos.values()].map(copia).sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
  }

  async buscarPorId(id: string): Promise<Integracion | null> {
    const i = this.datos.get(id);
    return i ? copia(i) : null;
  }

  async existeNombre(nombre: string, excluirId?: string): Promise<boolean> {
    return [...this.datos.values()].some((i) => i.id !== excluirId && mismoNombre(i.nombre, nombre));
  }

  async guardar(integracion: Integracion): Promise<void> {
    if (await this.existeNombre(integracion.nombre, integracion.id)) {
      throw new DomainError("CONFLICTO", `Ya existe una integración llamada ${integracion.nombre}`);
    }
    const keys = this.datos.get(integracion.id)?.keys ?? [];
    this.datos.set(integracion.id, { ...copia(integracion), keys });
  }

  async eliminar(id: string): Promise<void> {
    this.datos.delete(id);
    this.alEliminar(id);
  }

  async crearKey(key: ApiKey): Promise<void> {
    const i = this.datos.get(key.integracionId);
    if (!i) throw new DomainError("NO_ENCONTRADO", "Integración no encontrada");
    if ([...this.datos.values()].some((x) => x.keys.some((k) => k.prefijo === key.prefijo))) {
      throw new DomainError("CONFLICTO", "Prefijo de key repetido; genere otra");
    }
    i.keys.push(copiaKey(key));
  }

  async revocarKey(integracionId: string, keyId: string, fecha: Date): Promise<boolean> {
    const k = this.datos.get(integracionId)?.keys.find((x) => x.id === keyId);
    if (!k) return false;
    k.revocadaEn ??= fecha;
    return true;
  }

  async buscarPorPrefijoKey(prefijo: string): Promise<{ key: ApiKey; integracion: Integracion } | null> {
    for (const i of this.datos.values()) {
      const key = i.keys.find((k) => k.prefijo === prefijo);
      if (key) return { key: copiaKey(key), integracion: copia(i) };
    }
    return null;
  }

  async registrarUsoKey(keyId: string, fecha: Date): Promise<void> {
    for (const i of this.datos.values()) {
      const k = i.keys.find((x) => x.id === keyId);
      if (k) k.ultimoUsoEn = fecha;
    }
  }
}

interface FilaEntrega extends EntregaWebhook {
  bloqueadoHasta: Date | null;
}

function copiaEntrega(e: EntregaWebhook): EntregaWebhook {
  const { bloqueadoHasta: _bloqueo, ...resto } = e as FilaEntrega;
  return { ...resto };
}

export class InMemoryEntregaWebhookRepository implements EntregaWebhookRepository {
  private readonly datos = new Map<string, FilaEntrega>();

  /** Lo usa el repositorio de envíos en memoria para el outbox (en Postgres va en la misma transacción). */
  encolar(entregas: EntregaWebhook[]): void {
    for (const e of entregas) {
      if ([...this.datos.values()].some((x) => x.mensajeId === e.mensajeId)) {
        throw new Error(`webhook-id repetido: ${e.mensajeId}`);
      }
      this.datos.set(e.id, { ...e, bloqueadoHasta: null });
    }
  }

  eliminarDeIntegracion(integracionId: string): void {
    for (const [id, e] of this.datos) if (e.integracionId === integracionId) this.datos.delete(id);
  }

  async crear(entrega: EntregaWebhook): Promise<void> {
    this.encolar([entrega]);
  }

  async actualizar(e: EntregaWebhook): Promise<void> {
    if (this.datos.has(e.id)) this.datos.set(e.id, { ...e, bloqueadoHasta: null });
  }

  async buscarPorId(integracionId: string, id: string): Promise<EntregaWebhook | null> {
    const e = this.datos.get(id);
    return e && e.integracionId === integracionId ? copiaEntrega(e) : null;
  }

  async listarPagina(integracionId: string, f: FiltroEntregas, { pagina, porPagina }: Paginacion) {
    const todas = [...this.datos.values()]
      .filter((e) => e.integracionId === integracionId && (!f.estado || e.estado === f.estado))
      .sort(desc((e) => e.creadoEn));
    const desde = (pagina - 1) * porPagina;
    return { entregas: todas.slice(desde, desde + porPagina).map(copiaEntrega), total: todas.length };
  }

  async tomarPendientes(ahora: Date, limite: number, bloqueoHasta: Date): Promise<EntregaWebhook[]> {
    const listas = [...this.datos.values()]
      .filter(
        (e) =>
          e.estado === "PENDIENTE" &&
          e.proximoIntentoEn !== null &&
          e.proximoIntentoEn <= ahora &&
          (!e.bloqueadoHasta || e.bloqueadoHasta <= ahora),
      )
      .sort((a, b) => a.proximoIntentoEn!.getTime() - b.proximoIntentoEn!.getTime())
      .slice(0, limite);
    for (const e of listas) e.bloqueadoHasta = bloqueoHasta;
    return listas.map(copiaEntrega);
  }
}

export class InMemorySolicitudApiRepository implements SolicitudApiRepository {
  private readonly datos: SolicitudApi[] = [];

  async registrar(s: SolicitudApi): Promise<void> {
    this.datos.push({ ...s });
  }

  eliminarDeIntegracion(integracionId: string): void {
    for (let i = this.datos.length - 1; i >= 0; i--) if (this.datos[i]!.integracionId === integracionId) this.datos.splice(i, 1);
  }

  async listarPagina(integracionId: string, { pagina, porPagina }: Paginacion) {
    const todas = this.datos.filter((s) => s.integracionId === integracionId).sort(desc((s) => s.fecha));
    const desde = (pagina - 1) * porPagina;
    return { solicitudes: todas.slice(desde, desde + porPagina).map((s) => ({ ...s })), total: todas.length };
  }

  async purgarAnteriores(fecha: Date): Promise<number> {
    const antes = this.datos.length;
    for (let i = this.datos.length - 1; i >= 0; i--) if (this.datos[i]!.fecha < fecha) this.datos.splice(i, 1);
    return antes - this.datos.length;
  }
}

interface FilaIdempotencia {
  huella: string;
  estado: "EN_PROCESO" | "COMPLETADA";
  respuesta: RespuestaGuardada | null;
  creadoEn: Date;
}

const claveMapa = (c: ClaveIdempotencia) => `${c.integracionId}\u0000${c.modo}\u0000${c.clave}`;

export class InMemoryIdempotenciaRepository implements IdempotenciaRepository {
  private readonly datos = new Map<string, FilaIdempotencia>();

  eliminarDeIntegracion(integracionId: string): void {
    for (const k of this.datos.keys()) if (k.startsWith(`${integracionId}\u0000`)) this.datos.delete(k);
  }

  // Sin await entre leer y escribir: en un solo hilo la reserva es atómica.
  async reservar(
    c: ClaveIdempotencia,
    huella: string,
    ahora: Date,
    limites: { vigenteDesde: Date; abandonadaAntesDe: Date },
  ): Promise<ResultadoReserva> {
    const k = claveMapa(c);
    const fila = this.datos.get(k);
    const reutilizable =
      !fila ||
      fila.creadoEn < limites.vigenteDesde ||
      (fila.estado === "EN_PROCESO" && fila.creadoEn < limites.abandonadaAntesDe);
    if (reutilizable) {
      this.datos.set(k, { huella, estado: "EN_PROCESO", respuesta: null, creadoEn: ahora });
      return { tipo: "nueva" };
    }
    if (fila.huella !== huella) return { tipo: "conflicto" };
    if (fila.estado === "EN_PROCESO" || !fila.respuesta) return { tipo: "en_proceso" };
    return { tipo: "repetida", respuesta: { ...fila.respuesta } };
  }

  async completar(c: ClaveIdempotencia, respuesta: RespuestaGuardada): Promise<void> {
    const fila = this.datos.get(claveMapa(c));
    if (fila) Object.assign(fila, { estado: "COMPLETADA", respuesta: { ...respuesta } });
  }

  async liberar(c: ClaveIdempotencia): Promise<void> {
    this.datos.delete(claveMapa(c));
  }

  async purgarAnteriores(fecha: Date): Promise<number> {
    let n = 0;
    for (const [k, f] of this.datos) {
      if (f.creadoEn < fecha) {
        this.datos.delete(k);
        n++;
      }
    }
    return n;
  }
}
