import type {
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
  ArticuloRestringidoRepository,
} from "../../../application/ports/repositories.js";
import { exigirAlgunoActivo, type CambioTipoCarga, type TipoCarga, type TipoCargaCodigo } from "../../../domain/carga/TipoCarga.js";
import { compararArticulos, type ArticuloRestringido } from "../../../domain/catalogo/ArticuloRestringido.js";
import { Envio, type EnvioProps } from "../../../domain/envio/Envio.js";
import type { EntregaWebhook } from "../../../domain/integracion/Webhook.js";
import type { Ciudad, Ruta } from "../../../domain/ruta/Ruta.js";
import { DomainError } from "../../../domain/shared/DomainError.js";
import type { CambiosPerfil, Usuario, UsuarioConCredenciales } from "../../../domain/usuario/Usuario.js";
import { ARTICULOS_SEED, CIUDADES, RUTAS_SEED, TIPOS_CARGA_SEED } from "../seed-data.js";

// Adaptadores en memoria: usados en tests y en `DB_DRIVER=memory` (demo sin Postgres).

export class InMemoryUsuarioRepository implements UsuarioRepository {
  constructor(private readonly usuarios: UsuarioConCredenciales[] = []) {}

  async buscarPorEmail(email: string): Promise<UsuarioConCredenciales | null> {
    return this.usuarios.find((u) => u.email === email) ?? null;
  }

  async buscarPorId(id: string): Promise<Usuario | null> {
    const u = this.usuarios.find((x) => x.id === id && x.activo);
    return u ? { id: u.id, nombre: u.nombre, email: u.email, rol: u.rol } : null;
  }

  async buscarCredencialesPorId(id: string): Promise<UsuarioConCredenciales | null> {
    const u = this.usuarios.find((x) => x.id === id && x.activo);
    return u ? { ...u } : null;
  }

  async existeEmail(email: string, excluirId?: string): Promise<boolean> {
    return this.usuarios.some((u) => u.id !== excluirId && u.email === email);
  }

  async actualizarPerfil(id: string, cambios: CambiosPerfil): Promise<Usuario> {
    const u = this.usuarios.find((x) => x.id === id)!;
    if (cambios.email !== undefined && (await this.existeEmail(cambios.email, id))) {
      throw new DomainError("CONFLICTO", "Ese correo ya está registrado por otro usuario");
    }
    if (cambios.nombre !== undefined) u.nombre = cambios.nombre;
    if (cambios.email !== undefined) u.email = cambios.email;
    return { id: u.id, nombre: u.nombre, email: u.email, rol: u.rol };
  }

  async actualizarPasswordHash(id: string, passwordHash: string): Promise<void> {
    const u = this.usuarios.find((x) => x.id === id);
    if (u) u.passwordHash = passwordHash;
  }
}

/** Copia mutable de las ciudades semilla. Compártala entre el repo de ciudades y el de rutas. */
export const ciudadesSemilla = (): Ciudad[] => CIUDADES.map((c) => ({ ...c }));

const mismoNombre = (a: string, b: string) => a.localeCompare(b, "es", { sensitivity: "accent" }) === 0;

export class InMemoryCiudadRepository implements CiudadRepository {
  /** `ciudades` se muta en sitio para que el repo de rutas vea los cambios. */
  constructor(private readonly ciudades: Ciudad[] = ciudadesSemilla()) {}

  async listar(filtro: { activa?: boolean } = {}): Promise<Ciudad[]> {
    return this.ciudades
      .filter((c) => filtro.activa === undefined || c.activa === filtro.activa)
      .map((c) => ({ ...c }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
  }

  async buscarPorId(id: number): Promise<Ciudad | null> {
    const c = this.ciudades.find((x) => x.id === id);
    return c ? { ...c } : null;
  }

  async existeNombre(nombre: string, excluirId?: number): Promise<boolean> {
    return this.ciudades.some((c) => c.id !== excluirId && mismoNombre(c.nombre, nombre));
  }

  async crear(nombre: string): Promise<Ciudad> {
    const ciudad = { id: Math.max(0, ...this.ciudades.map((c) => c.id)) + 1, nombre, activa: true };
    this.ciudades.push(ciudad);
    return { ...ciudad };
  }

  async actualizar(id: number, cambios: CambiosCiudad): Promise<Ciudad> {
    const c = this.ciudades.find((x) => x.id === id)!;
    if (cambios.nombre !== undefined) c.nombre = cambios.nombre;
    if (cambios.activa !== undefined) c.activa = cambios.activa;
    return { ...c };
  }

  async eliminar(id: number): Promise<void> {
    const i = this.ciudades.findIndex((c) => c.id === id);
    if (i >= 0) this.ciudades.splice(i, 1);
  }
}

/** Copia profunda: quien lee el catálogo no puede alterar la semilla ni el estado guardado. */
const copiaTipo = (t: TipoCarga): TipoCarga => ({
  ...t,
  mayoreo: t.mayoreo && { ...t.mayoreo },
  actualizadoEn: t.actualizadoEn && new Date(t.actualizadoEn),
});
const copiaCambio = (c: CambioTipoCarga): CambioTipoCarga => structuredClone(c);
const mismoNombreTipo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export interface OpcionesTipoCargaMemoria {
  /** ¿Algún envío usa el tipo? (en Postgres lo garantiza la FK de envio_items). */
  usaTipoCarga?: (codigo: TipoCargaCodigo) => Promise<boolean>;
}

export class InMemoryTipoCargaRepository implements TipoCargaRepository {
  private tipos: TipoCarga[];
  private readonly historial: CambioTipoCarga[] = [];

  constructor(
    semilla: readonly TipoCarga[] = TIPOS_CARGA_SEED,
    private readonly opciones: OpcionesTipoCargaMemoria = {},
  ) {
    this.tipos = semilla.map(copiaTipo);
  }

  async listar(filtro: { activos?: boolean } = {}): Promise<TipoCarga[]> {
    return this.tipos
      .filter((t) => !filtro.activos || t.activo)
      .sort((a, b) => a.orden - b.orden || (a.codigo < b.codigo ? -1 : a.codigo > b.codigo ? 1 : 0))
      .map(copiaTipo);
  }

  async buscarPorCodigo(codigo: TipoCargaCodigo): Promise<TipoCarga | null> {
    const t = this.tipos.find((x) => x.codigo === codigo);
    return t ? copiaTipo(t) : null;
  }

  async existeNombre(nombre: string, excluirCodigo?: TipoCargaCodigo): Promise<boolean> {
    return this.tipos.some((t) => t.codigo !== excluirCodigo && mismoNombreTipo(t.nombre, nombre));
  }

  async crear(tipo: TipoCarga, cambio: CambioTipoCarga): Promise<void> {
    if (this.tipos.some((t) => t.codigo === tipo.codigo)) {
      throw new DomainError("CONFLICTO", `Ya existe un tipo de carga con el código ${tipo.codigo}`);
    }
    if (await this.existeNombre(tipo.nombre)) throw new DomainError("CONFLICTO", `Ya existe un tipo de carga llamado ${tipo.nombre}`);
    this.tipos.push(copiaTipo(tipo));
    this.historial.push(copiaCambio(cambio));
  }

  async actualizar(tipos: TipoCarga[], cambios: CambioTipoCarga[]): Promise<void> {
    const nuevos = new Map(tipos.map((t) => [t.codigo, t]));
    const resultado = this.tipos.map((t) => nuevos.get(t.codigo) ?? t);
    for (const t of tipos) {
      if (!this.tipos.some((x) => x.codigo === t.codigo)) throw new DomainError("NO_ENCONTRADO", `No existe el tipo de carga ${t.codigo}`);
      if (resultado.some((x) => x.codigo !== t.codigo && mismoNombreTipo(x.nombre, t.nombre))) {
        throw new DomainError("CONFLICTO", `Ya existe un tipo de carga llamado ${t.nombre}`);
      }
    }
    exigirAlgunoActivo(resultado);
    this.tipos = resultado.map(copiaTipo);
    this.historial.push(...cambios.map(copiaCambio));
  }

  async eliminar(codigo: TipoCargaCodigo, cambio: CambioTipoCarga): Promise<void> {
    if (await this.opciones.usaTipoCarga?.(codigo)) {
      throw new DomainError("CONFLICTO", "El tipo de carga se usa en envíos registrados; desactívelo");
    }
    const resto = this.tipos.filter((t) => t.codigo !== codigo);
    exigirAlgunoActivo(resto);
    this.tipos = resto;
    this.historial.push(copiaCambio(cambio));
  }

  async listarHistorial(
    filtro: { codigo?: TipoCargaCodigo },
    { pagina, porPagina }: Paginacion,
  ): Promise<{ cambios: CambioTipoCarga[]; total: number }> {
    // Más recientes primero; a igual fecha, el registrado después (orden de inserción).
    const filtrados = this.historial
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => !filtro.codigo || c.codigo === filtro.codigo)
      .sort((a, b) => b.c.fecha.getTime() - a.c.fecha.getTime() || b.i - a.i)
      .map(({ c }) => c);
    const desde = (pagina - 1) * porPagina;
    return { cambios: filtrados.slice(desde, desde + porPagina).map(copiaCambio), total: filtrados.length };
  }
}

const copiaArticulo = (a: ArticuloRestringido): ArticuloRestringido => ({ ...a, actualizadoEn: new Date(a.actualizadoEn) });

export class InMemoryArticuloRestringidoRepository implements ArticuloRestringidoRepository {
  private articulos: ArticuloRestringido[];

  constructor(semilla: readonly ArticuloRestringido[] = ARTICULOS_SEED) {
    this.articulos = semilla.map(copiaArticulo);
  }

  async listar(filtro: { activos?: boolean } = {}): Promise<ArticuloRestringido[]> {
    return this.articulos.filter((a) => !filtro.activos || a.activo).sort(compararArticulos).map(copiaArticulo);
  }

  async buscarPorId(id: string): Promise<ArticuloRestringido | null> {
    const a = this.articulos.find((x) => x.id === id);
    return a ? copiaArticulo(a) : null;
  }

  async crear(articulo: ArticuloRestringido): Promise<void> {
    this.articulos.push(copiaArticulo(articulo));
  }

  async actualizar(articulos: ArticuloRestringido[]): Promise<void> {
    const nuevos = new Map(articulos.map((a) => [a.id, a]));
    this.articulos = this.articulos.map((a) => copiaArticulo(nuevos.get(a.id) ?? a));
  }

  async eliminar(id: string): Promise<void> {
    this.articulos = this.articulos.filter((a) => a.id !== id);
  }
}

interface RutaFila extends NuevaRuta {
  id: number;
  activa: boolean;
}

export class InMemoryRutaRepository implements RutaRepository {
  private filas: RutaFila[];

  constructor(
    private readonly ciudades: Ciudad[] = ciudadesSemilla(),
    semilla: NuevaRuta[] = RUTAS_SEED,
  ) {
    this.filas = semilla.map((r, i) => ({ ...r, id: i + 1, activa: true }));
  }

  private aRuta(f: RutaFila): Ruta {
    const ciudad = (id: number): Ciudad => {
      const c = this.ciudades.find((x) => x.id === id);
      return c ? { ...c } : { id, nombre: "?", activa: false };
    };
    return {
      id: f.id,
      origen: ciudad(f.origenId),
      destino: ciudad(f.destinoId),
      tiempoEstimadoMin: f.tiempoEstimadoMin,
      activa: f.activa,
    };
  }

  async listar(filtro: { activa?: boolean } = {}): Promise<Ruta[]> {
    return this.filas
      .filter((f) => filtro.activa === undefined || f.activa === filtro.activa)
      .map((f) => this.aRuta(f));
  }

  async buscarPorId(id: number): Promise<Ruta | null> {
    const f = this.filas.find((x) => x.id === id);
    return f ? this.aRuta(f) : null;
  }

  async existe(origenId: number, destinoId: number): Promise<boolean> {
    return this.filas.some((f) => f.origenId === origenId && f.destinoId === destinoId);
  }

  async usaCiudad(ciudadId: number): Promise<boolean> {
    return this.filas.some((f) => f.origenId === ciudadId || f.destinoId === ciudadId);
  }

  async crear(datos: NuevaRuta): Promise<Ruta> {
    const fila = { ...datos, id: Math.max(0, ...this.filas.map((f) => f.id)) + 1, activa: true };
    this.filas.push(fila);
    return this.aRuta(fila);
  }

  async actualizar(id: number, cambios: CambiosRuta): Promise<Ruta> {
    const f = this.filas.find((x) => x.id === id)!;
    Object.assign(f, Object.fromEntries(Object.entries(cambios).filter(([, v]) => v !== undefined)));
    return this.aRuta(f);
  }
}

export interface OpcionesEnvioMemoria {
  /** Cola de webhooks (outbox) donde se encolan las entregas al guardar. */
  outbox?: { encolar(entregas: EntregaWebhook[]): void };
  /** Nombre actual de una integración (para `Envio.origen.integracion`). */
  nombreIntegracion?: (id: string) => string | null;
}

export class InMemoryEnvioRepository implements EnvioRepository {
  private readonly datos = new Map<string, EnvioProps>();

  constructor(private readonly opciones: OpcionesEnvioMemoria = {}) {}

  async guardar(envio: Envio, opciones: OpcionesGuardarEnvio = {}): Promise<void> {
    const s = envio.toSnapshot();
    if (!this.datos.has(s.id)) {
      const repetida =
        s.integracionId &&
        [...this.datos.values()].some((x) => x.integracionId === s.integracionId && x.referenciaExterna === s.referenciaExterna);
      if (repetida) throw new DomainError("CONFLICTO", `Ya existe un envío con la referencia ${s.referenciaExterna}`);
      if ([...this.datos.values()].some((x) => x.numeroGuia === s.numeroGuia)) {
        throw new DomainError("CONFLICTO", `La guía ${s.numeroGuia} ya está registrada`);
      }
    } else {
      // Como en Postgres: el origen y la referencia no cambian después de crear el envío.
      const previo = this.datos.get(s.id)!;
      s.integracionId = previo.integracionId ?? null;
      s.referenciaExterna = previo.referenciaExterna ?? null;
    }
    if (opciones.webhooks?.length) this.opciones.outbox?.encolar(opciones.webhooks);
    this.datos.set(envio.id, { ...s, integracionNombre: null });
  }

  /** Reconstruye con el nombre ACTUAL de la integración (como el JOIN de Postgres). */
  private leer(p: EnvioProps): Envio {
    const nombre = p.integracionId ? (this.opciones.nombreIntegracion?.(p.integracionId) ?? null) : null;
    return Envio.reconstruir({ ...p, integracionNombre: nombre });
  }

  async buscarPorId(id: string): Promise<Envio | null> {
    const p = this.datos.get(id);
    return p ? this.leer(p) : null;
  }

  async buscarPorNumeroGuia(numeroGuia: number): Promise<Envio | null> {
    const p = [...this.datos.values()].find((x) => x.numeroGuia === numeroGuia);
    return p ? this.leer(p) : null;
  }

  async buscarPorReferencia(integracionId: string, referenciaExterna: string): Promise<Envio | null> {
    const p = [...this.datos.values()].find(
      (x) => x.integracionId === integracionId && x.referenciaExterna === referenciaExterna,
    );
    return p ? this.leer(p) : null;
  }

  async estadisticasPorIntegracion(): Promise<Map<string, EstadisticaIntegracion>> {
    const mapa = new Map<string, EstadisticaIntegracion>();
    for (const p of this.datos.values()) {
      if (!p.integracionId) continue;
      const e = mapa.get(p.integracionId) ?? { envios: 0, ultimoEnvio: null };
      e.envios++;
      if (!e.ultimoEnvio || p.creadoEn > e.ultimoEnvio) e.ultimoEnvio = p.creadoEn;
      mapa.set(p.integracionId, e);
    }
    return mapa;
  }

  async existeNumeroGuia(numeroGuia: number): Promise<boolean> {
    return [...this.datos.values()].some((x) => x.numeroGuia === numeroGuia);
  }

  async usaTipoCarga(codigo: TipoCargaCodigo): Promise<boolean> {
    return [...this.datos.values()].some((x) => x.items.some((i) => i.tipoCarga === codigo));
  }

  async siguienteNumeroGuia(): Promise<number> {
    return Math.max(0, ...[...this.datos.values()].map((x) => x.numeroGuia)) + 1;
  }

  async listar(filtro: FiltroEnvios = {}): Promise<Envio[]> {
    return this.filtrar(filtro).map((p) => this.leer(p));
  }

  async listarPagina(filtro: FiltroEnvios, { pagina, porPagina }: Paginacion): Promise<{ envios: Envio[]; total: number }> {
    const todos = this.filtrar(filtro);
    const desde = (pagina - 1) * porPagina;
    return { envios: todos.slice(desde, desde + porPagina).map((p) => this.leer(p)), total: todos.length };
  }

  private filtrar(filtro: FiltroEnvios): EnvioProps[] {
    const q = filtro.q?.trim().toLowerCase();
    return [...this.datos.values()]
      .filter((p) => !filtro.estado || p.estado === filtro.estado)
      .filter((p) => !filtro.rutaId || p.rutaId === filtro.rutaId)
      .filter((p) => !filtro.formaPago || p.formaPago === filtro.formaPago)
      .filter((p) => !filtro.clienteId || p.clienteId === filtro.clienteId)
      .filter((p) => !filtro.canal || (filtro.canal === "API") === Boolean(p.integracionId))
      .filter((p) => !filtro.integracionId || p.integracionId === filtro.integracionId)
      .filter(
        (p) =>
          !q ||
          p.numeroGuia === filtro.numeroGuia ||
          [p.remitente.nombre, p.destinatario.nombre, p.referenciaExterna ?? ""].some((v) => v.toLowerCase().includes(q)),
      )
      .sort((a, b) => b.creadoEn.getTime() - a.creadoEn.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  }
}
