import type { TipoCarga, TipoCargaCodigo } from "../../domain/carga/TipoCarga.js";
import type { Envio } from "../../domain/envio/Envio.js";
import type { EstadoEnvio } from "../../domain/envio/EstadoEnvio.js";
import type { FormaPago } from "../../domain/envio/FormaPago.js";
import type { Ciudad, Ruta } from "../../domain/ruta/Ruta.js";
import type { Usuario, UsuarioConCredenciales } from "../../domain/usuario/Usuario.js";

// Puertos de salida (driven ports). Los adaptadores viven en infrastructure/persistence.

export interface UsuarioRepository {
  buscarPorEmail(email: string): Promise<UsuarioConCredenciales | null>;
  buscarPorId(id: string): Promise<Usuario | null>;
}

export interface CambiosCiudad {
  nombre?: string;
  activa?: boolean;
}

export interface CiudadRepository {
  /** Ordenadas por nombre. */
  listar(filtro?: { activa?: boolean }): Promise<Ciudad[]>;
  buscarPorId(id: number): Promise<Ciudad | null>;
  /** Sin distinguir mayúsculas; `excluirId` permite renombrar una ciudad a su mismo nombre. */
  existeNombre(nombre: string, excluirId?: number): Promise<boolean>;
  crear(nombre: string): Promise<Ciudad>;
  actualizar(id: number, cambios: CambiosCiudad): Promise<Ciudad>;
  eliminar(id: number): Promise<void>;
}

export interface TipoCargaRepository {
  listar(): Promise<TipoCarga[]>;
  buscarPorCodigo(codigo: TipoCargaCodigo): Promise<TipoCarga | null>;
}

export interface NuevaRuta {
  origenId: number;
  destinoId: number;
  tarifaBase: number;
  tiempoEstimadoMin: number;
}

export interface CambiosRuta {
  tarifaBase?: number;
  tiempoEstimadoMin?: number;
  activa?: boolean;
}

export interface RutaRepository {
  listar(filtro?: { activa?: boolean }): Promise<Ruta[]>;
  buscarPorId(id: number): Promise<Ruta | null>;
  existe(origenId: number, destinoId: number): Promise<boolean>;
  /** ¿Alguna ruta (activa o no) usa la ciudad como origen o destino? */
  usaCiudad(ciudadId: number): Promise<boolean>;
  crear(datos: NuevaRuta): Promise<Ruta>;
  actualizar(id: number, cambios: CambiosRuta): Promise<Ruta>;
}

export interface FiltroEnvios {
  estado?: EstadoEnvio;
  rutaId?: number;
  formaPago?: FormaPago;
  /** Busca en código, remitente y destinatario (sin distinguir mayúsculas). */
  q?: string;
}

export interface EnvioRepository {
  guardar(envio: Envio): Promise<void>;
  buscarPorId(id: string): Promise<Envio | null>;
  buscarPorCodigo(codigo: string): Promise<Envio | null>;
  existeCodigo(codigo: string): Promise<boolean>;
  listar(filtro?: FiltroEnvios): Promise<Envio[]>;
}
