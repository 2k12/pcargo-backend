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
  ArticuloRestringidoRepository,
} from "../../../application/ports/repositories.js";
import { exigirAlgunoActivo, type CambioTipoCarga, type TipoCarga, type TipoCargaCodigo } from "../../../domain/carga/TipoCarga.js";
import { compararArticulos, type ArticuloRestringido } from "../../../domain/catalogo/ArticuloRestringido.js";
import { Envio, type EnvioProps } from "../../../domain/envio/Envio.js";
import type { EntregaWebhook } from "../../../domain/integracion/Webhook.js";
import type { Ciudad, Ruta } from "../../../domain/ruta/Ruta.js";
import { DomainError } from "../../../domain/shared/DomainError.js";
import type { CambiosPerfil, Usuario, UsuarioAdmin, UsuarioConCredenciales } from "../../../domain/usuario/Usuario.js";
import type { MovimientosCaja } from "../../../domain/caja/Caja.js";
import { digitosTelefono } from "../../../domain/cliente/Cliente.js";
import { esFinal } from "../../../domain/envio/EstadoEnvio.js";
import { ARTICULOS_SEED, CIUDADES, RUTAS_SEED, TIPOS_CARGA_SEED } from "../seed-data.js";

// Adaptadores en memoria: usados en tests y en `DB_DRIVER=memory` (demo sin Postgres).

/** Usuario guardado en memoria (con hash, fecha de alta y huella del código único de acceso). */
export type UsuarioMemoria = Omit<UsuarioConCredenciales, "clienteId"> & {
  clienteId?: string | null;
  creadoEn?: Date;
  codigoAcceso?: { huella: string; en: Date } | null;
};

/** Fecha de alta de los usuarios semilla en memoria. */
const FECHA_USUARIOS_SEED = new Date("2026-10-01T00:00:00.000Z");

const aUsuario = (u: UsuarioMemoria): Usuario => ({
  id: u.id,
  nombre: u.nombre,
  email: u.email,
  rol: u.rol,
  clienteId: u.clienteId ?? null,
});

const aUsuarioAdmin = (u: UsuarioMemoria): UsuarioAdmin => ({
  ...aUsuario(u),
  activo: u.activo,
  creadoEn: new Date(u.creadoEn ?? FECHA_USUARIOS_SEED),
});

const conCredenciales = (u: UsuarioMemoria): UsuarioConCredenciales => ({
  ...aUsuario(u),
  passwordHash: u.passwordHash,
  activo: u.activo,
});

export class InMemoryUsuarioRepository implements UsuarioRepository {
  private readonly usuarios: UsuarioMemoria[];

  constructor(usuarios: UsuarioMemoria[] = []) {
    this.usuarios = usuarios.map((u) => ({ ...u, clienteId: u.clienteId ?? null }));
  }

  async buscarPorEmail(email: string): Promise<UsuarioConCredenciales | null> {
    const u = this.usuarios.find((x) => x.email === email);
    return u ? conCredenciales(u) : null;
  }

  async buscarPorId(id: string): Promise<Usuario | null> {
    const u = this.usuarios.find((x) => x.id === id && x.activo);
    return u ? aUsuario(u) : null;
  }

  async buscarCredencialesPorId(id: string): Promise<UsuarioConCredenciales | null> {
    const u = this.usuarios.find((x) => x.id === id && x.activo);
    return u ? conCredenciales(u) : null;
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
    return aUsuario(u);
  }

  async actualizarPasswordHash(id: string, passwordHash: string): Promise<void> {
    const u = this.usuarios.find((x) => x.id === id);
    if (u) u.passwordHash = passwordHash;
  }

  async listar(filtro: FiltroUsuarios = {}): Promise<UsuarioAdmin[]> {
    return this.usuarios
      .filter((u) => filtro.rol === undefined || u.rol === filtro.rol)
      .filter((u) => filtro.activo === undefined || u.activo === filtro.activo)
      .filter((u) => filtro.clienteId === undefined || u.clienteId === filtro.clienteId)
      .sort((a, b) => a.nombre.localeCompare(b.nombre, "es", { sensitivity: "base" }) || (a.id < b.id ? -1 : 1))
      .map(aUsuarioAdmin);
  }

  async obtener(id: string): Promise<UsuarioAdmin | null> {
    const u = this.usuarios.find((x) => x.id === id);
    return u ? aUsuarioAdmin(u) : null;
  }

  async crear(usuario: UsuarioAdmin & { passwordHash: string }): Promise<void> {
    if (await this.existeEmail(usuario.email)) {
      throw new DomainError("CONFLICTO", "Ese correo ya está registrado por otro usuario");
    }
    this.usuarios.push({ ...usuario, creadoEn: new Date(usuario.creadoEn) });
  }

  async actualizar(id: string, c: CambiosUsuarioRepo): Promise<UsuarioAdmin> {
    const u = this.usuarios.find((x) => x.id === id);
    if (!u) throw new DomainError("NO_ENCONTRADO", "Usuario no encontrado");
    if (c.email !== undefined && (await this.existeEmail(c.email, id))) {
      throw new DomainError("CONFLICTO", "Ese correo ya está registrado por otro usuario");
    }
    if (c.nombre !== undefined) u.nombre = c.nombre;
    if (c.email !== undefined) u.email = c.email;
    if (c.rol !== undefined) u.rol = c.rol;
    if (c.activo !== undefined) u.activo = c.activo;
    if (c.passwordHash !== undefined) u.passwordHash = c.passwordHash;
    return aUsuarioAdmin(u);
  }

  async accesosPortalPorCliente(): Promise<Map<string, number>> {
    const mapa = new Map<string, number>();
    for (const u of this.usuarios) {
      if (u.rol === "CLIENTE" && u.activo && u.clienteId) mapa.set(u.clienteId, (mapa.get(u.clienteId) ?? 0) + 1);
    }
    return mapa;
  }

  async buscarPorCodigoAcceso(huella: string): Promise<UsuarioConCredenciales | null> {
    const u = this.usuarios.find((x) => x.codigoAcceso?.huella === huella);
    return u ? conCredenciales(u) : null;
  }

  async codigoAccesoActivoDesde(id: string): Promise<Date | null> {
    const en = this.usuarios.find((x) => x.id === id)?.codigoAcceso?.en;
    return en ? new Date(en) : null;
  }

  async guardarCodigoAcceso(id: string, huella: string, en: Date): Promise<void> {
    if (this.usuarios.some((x) => x.id !== id && x.codigoAcceso?.huella === huella)) {
      throw new DomainError("CONFLICTO", "Ese código no está disponible, elige otro");
    }
    const u = this.usuarios.find((x) => x.id === id);
    if (u) u.codigoAcceso = { huella, en: new Date(en) };
  }

  async quitarCodigoAcceso(id: string): Promise<void> {
    const u = this.usuarios.find((x) => x.id === id);
    if (u) u.codigoAcceso = null;
  }

  /** Al eliminar un cliente: desactiva sus usuarios del portal y los desvincula. Devuelve cuántos estaban activos. */
  desvincularCliente(clienteId: string): number {
    let activos = 0;
    for (const u of this.usuarios.filter((x) => x.clienteId === clienteId)) {
      if (u.activo) activos++;
      u.activo = false;
      u.clienteId = null;
    }
    return activos;
  }

  /** Nombre actual de un usuario (cualquier estado), para resolver nombres al leer como lo hace un JOIN. */
  nombre = (id: string): string | null => this.usuarios.find((u) => u.id === id)?.nombre ?? null;
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
  /** Caja donde se registran los cobros al guardar (misma «transacción» que el envío). */
  caja?: { validar(m: MovimientosCaja): void; aplicar(m: MovimientosCaja): void };
  /** Nombre actual de un usuario (repartidor asignado). */
  nombreUsuario?: (id: string) => string | null;
  /** v20: talonarios de guías en blanco (consecutivo y uso de la guía en la misma «transacción» que el envío). */
  talonarios?: {
    maximoNumero(): number;
    validarUso(numeroGuia: number, indicado: boolean): void;
    marcarUsada(numeroGuia: number, envioId: string, fecha: Date): void;
  };
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
      this.opciones.talonarios?.validarUso(s.numeroGuia, opciones.numeroGuiaIndicado ?? false);
    } else {
      // Como en Postgres: el origen y la referencia no cambian después de crear el envío; la asignación del
      // repartidor solo cambia con asignarRepartidor, y los datos personales solo al anonimizar.
      const previo = this.datos.get(s.id)!;
      s.integracionId = previo.integracionId ?? null;
      s.referenciaExterna = previo.referenciaExterna ?? null;
      s.repartidor = previo.repartidor ?? null;
      s.asignadoEn = previo.asignadoEn ?? null;
      if (previo.anonimizadoEn || !s.anonimizadoEn) {
        s.anonimizadoEn = previo.anonimizadoEn ?? null;
        s.remitente = previo.remitente;
        s.destinatario = previo.destinatario;
        s.descripcion = previo.descripcion;
        if (previo.anonimizadoEn) s.historial = s.historial.map((ev) => ({ ...ev, nota: null }));
      }
    }
    if (opciones.caja) this.opciones.caja?.validar(opciones.caja);
    if (opciones.webhooks?.length) this.opciones.outbox?.encolar(opciones.webhooks);
    if (opciones.caja) this.opciones.caja?.aplicar(opciones.caja);
    if (!this.datos.has(s.id) && opciones.numeroGuiaIndicado) {
      this.opciones.talonarios?.marcarUsada(s.numeroGuia, s.id, s.creadoEn);
    }
    this.datos.set(envio.id, structuredClone({ ...s, integracionNombre: null }));
  }

  async asignarRepartidor(envioIds: string[], repartidorId: string | null, fecha: Date): Promise<number> {
    for (const id of envioIds) {
      const p = this.datos.get(id);
      if (!p) throw new DomainError("NO_ENCONTRADO", `Envío no encontrado: ${id}`);
      if (esFinal(p.estado)) {
        throw new DomainError("ESTADO_INVALIDO", `La guía ${p.numeroGuia} está ${p.estado}: no se puede asignar`);
      }
    }
    const repartidor = repartidorId
      ? { id: repartidorId, nombre: this.opciones.nombreUsuario?.(repartidorId) ?? "" }
      : null;
    for (const id of envioIds) {
      const p = this.datos.get(id)!;
      this.datos.set(id, { ...p, repartidor, asignadoEn: repartidor ? new Date(fecha) : null });
    }
    return envioIds.length;
  }

  /** Reconstruye con el nombre ACTUAL de la integración y del repartidor (como el JOIN de Postgres). */
  private leer(p: EnvioProps): Envio {
    const copia = structuredClone(p);
    const nombre = copia.integracionId ? (this.opciones.nombreIntegracion?.(copia.integracionId) ?? null) : null;
    const repartidor = copia.repartidor
      ? { id: copia.repartidor.id, nombre: this.opciones.nombreUsuario?.(copia.repartidor.id) ?? copia.repartidor.nombre }
      : null;
    return Envio.reconstruir({ ...copia, integracionNombre: nombre, repartidor });
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

  /** Mayor número de guía de los envíos guardados (0 si no hay). */
  maximoNumeroGuia(): number {
    return Math.max(0, ...[...this.datos.values()].map((x) => x.numeroGuia));
  }

  async siguienteNumeroGuia(): Promise<number> {
    return Math.max(this.maximoNumeroGuia(), this.opciones.talonarios?.maximoNumero() ?? 0) + 1;
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
          filtro.repartidorId === undefined ||
          (filtro.repartidorId === null ? !p.repartidor : p.repartidor?.id === filtro.repartidorId),
      )
      .filter((p) => !filtro.estados || filtro.estados.includes(p.estado))
      .filter((p) => !filtro.actualizadoDesde || p.actualizadoEn >= filtro.actualizadoDesde)
      .filter((p) => !filtro.registradoDesde || p.creadoEn >= filtro.registradoDesde)
      .filter((p) => !filtro.registradoHasta || p.creadoEn < filtro.registradoHasta)
      .filter((p) => !filtro.fechaGuiaDesde || p.fechaGuia >= filtro.fechaGuiaDesde)
      .filter((p) => !filtro.fechaGuiaHasta || p.fechaGuia <= filtro.fechaGuiaHasta)
      .filter(
        (p) =>
          !filtro.telefono ||
          digitosTelefono(p.remitente.telefono) === filtro.telefono ||
          digitosTelefono(p.destinatario.telefono) === filtro.telefono,
      )
      .filter(
        (p) =>
          !q ||
          p.numeroGuia === filtro.numeroGuia ||
          [p.remitente.nombre, p.destinatario.nombre, p.referenciaExterna ?? ""].some((v) => v.toLowerCase().includes(q)),
      )
      .sort((a, b) => b.creadoEn.getTime() - a.creadoEn.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  }
}
