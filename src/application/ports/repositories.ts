import type { TipoCarga, TipoCargaCodigo } from "../../domain/carga/TipoCarga.js";
import type { Cliente, DatosCliente } from "../../domain/cliente/Cliente.js";
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
  clienteId?: string;
  /** Número de guía exacto (se combina con `q` mediante OR). */
  numeroGuia?: number;
  /** Busca en remitente y destinatario (sin distinguir mayúsculas). */
  q?: string;
}

export interface Paginacion {
  /** Empieza en 1. */
  pagina: number;
  porPagina: number;
}

export interface EnvioRepository {
  guardar(envio: Envio): Promise<void>;
  buscarPorId(id: string): Promise<Envio | null>;
  buscarPorNumeroGuia(numeroGuia: number): Promise<Envio | null>;
  existeNumeroGuia(numeroGuia: number): Promise<boolean>;
  /** Máximo número de guía registrado + 1 (1 si no hay envíos). */
  siguienteNumeroGuia(): Promise<number>;
  /** Todos los que cumplen el filtro, más recientes primero (para agregados como el dashboard). */
  listar(filtro?: FiltroEnvios): Promise<Envio[]>;
  /** Una página de resultados (más recientes primero, orden estable) y el total que cumple el filtro. */
  listarPagina(filtro: FiltroEnvios, paginacion: Paginacion): Promise<{ envios: Envio[]; total: number }>;
}

export interface ClienteRepository {
  /** Ordenados por nombre; `q` busca en nombre y teléfono (sin distinguir mayúsculas). */
  listar(filtro?: { q?: string }): Promise<Cliente[]>;
  buscarPorId(id: string): Promise<Cliente | null>;
  /** Compara solo los dígitos; `excluirId` permite editar un cliente sin cambiar su teléfono. */
  buscarPorTelefono(telefono: string, excluirId?: string): Promise<Cliente | null>;
  crear(cliente: Cliente): Promise<void>;
  actualizar(id: string, datos: Required<DatosCliente>): Promise<Cliente>;
  /** Registra el consentimiento solo si aún no tenía (conserva la fecha original). Devuelve el cliente. */
  registrarConsentimiento(id: string, fecha: Date): Promise<Cliente>;
  /** Los envíos del cliente se conservan sin cliente asociado. */
  eliminar(id: string): Promise<void>;
}
