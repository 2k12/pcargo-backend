import type {
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

export class InMemoryCiudadRepository implements CiudadRepository {
  constructor(private readonly ciudades: Ciudad[] = CIUDADES) {}
  async listar(): Promise<Ciudad[]> {
    return [...this.ciudades];
  }
  async buscarPorId(id: number): Promise<Ciudad | null> {
    return this.ciudades.find((c) => c.id === id) ?? null;
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
    private readonly ciudades: Ciudad[] = CIUDADES,
    semilla: NuevaRuta[] = RUTAS_SEED,
  ) {
    this.filas = semilla.map((r, i) => ({ ...r, id: i + 1, activa: true }));
  }

  private aRuta(f: RutaFila): Ruta {
    const ciudad = (id: number) => this.ciudades.find((c) => c.id === id) ?? { id, nombre: "?" };
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
      .filter(
        (p) =>
          !q ||
          [p.codigo, p.remitente.nombre, p.destinatario.nombre].some((v) => v.toLowerCase().includes(q)),
      )
      .sort((a, b) => b.creadoEn.getTime() - a.creadoEn.getTime())
      .map((p) => Envio.reconstruir(p));
  }
}
