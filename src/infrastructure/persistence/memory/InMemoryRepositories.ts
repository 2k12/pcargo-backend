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
import { Envio, type EnvioProps } from "../../../domain/envio/Envio.js";
import type { Ciudad, Ruta } from "../../../domain/ruta/Ruta.js";
import type { Usuario, UsuarioConCredenciales } from "../../../domain/usuario/Usuario.js";
import { CIUDADES, RUTAS_SEED, TIPOS_CARGA_SEED } from "../seed-data.js";

// Adaptadores en memoria: usados en tests y en `DB_DRIVER=memory` (demo sin Postgres).

export class InMemoryUsuarioRepository implements UsuarioRepository {
  constructor(private readonly usuarios: UsuarioConCredenciales[] = []) {}

  async buscarPorEmail(email: string): Promise<UsuarioConCredenciales | null> {
    return this.usuarios.find((u) => u.email === email) ?? null;
  }

  async buscarPorId(id: string): Promise<Usuario | null> {
    const u = this.usuarios.find((x) => x.id === id);
    return u ? { id: u.id, nombre: u.nombre, email: u.email, rol: u.rol } : null;
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

export class InMemoryTipoCargaRepository implements TipoCargaRepository {
  constructor(private readonly tipos: TipoCarga[] = TIPOS_CARGA_SEED) {}
  async listar(): Promise<TipoCarga[]> {
    return [...this.tipos];
  }
  async buscarPorCodigo(codigo: TipoCargaCodigo): Promise<TipoCarga | null> {
    return this.tipos.find((t) => t.codigo === codigo) ?? null;
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
      tarifaBase: f.tarifaBase,
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

export class InMemoryEnvioRepository implements EnvioRepository {
  private readonly datos = new Map<string, EnvioProps>();

  async guardar(envio: Envio): Promise<void> {
    this.datos.set(envio.id, envio.toSnapshot());
  }

  async buscarPorId(id: string): Promise<Envio | null> {
    const p = this.datos.get(id);
    return p ? Envio.reconstruir(p) : null;
  }

  async buscarPorCodigo(codigo: string): Promise<Envio | null> {
    const p = [...this.datos.values()].find((x) => x.codigo === codigo);
    return p ? Envio.reconstruir(p) : null;
  }

  async existeCodigo(codigo: string): Promise<boolean> {
    return [...this.datos.values()].some((x) => x.codigo === codigo);
  }

  async listar(filtro: FiltroEnvios = {}): Promise<Envio[]> {
    const q = filtro.q?.trim().toLowerCase();
    return [...this.datos.values()]
      .filter((p) => !filtro.estado || p.estado === filtro.estado)
      .filter((p) => !filtro.rutaId || p.rutaId === filtro.rutaId)
      .filter((p) => !filtro.formaPago || p.formaPago === filtro.formaPago)
      .filter(
        (p) =>
          !q ||
          [p.codigo, p.remitente.nombre, p.destinatario.nombre].some((v) => v.toLowerCase().includes(q)),
      )
      .sort((a, b) => b.creadoEn.getTime() - a.creadoEn.getTime())
      .map((p) => Envio.reconstruir(p));
  }
}
