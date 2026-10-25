import type { CambioTipoCarga, TipoCarga, TipoCargaCodigo } from "../../domain/carga/TipoCarga.js";
import type { ArticuloRestringido } from "../../domain/catalogo/ArticuloRestringido.js";
import type { Cliente, DatosCliente } from "../../domain/cliente/Cliente.js";
import type { Envio } from "../../domain/envio/Envio.js";
import type { EstadoEnvio } from "../../domain/envio/EstadoEnvio.js";
import type { FormaPago } from "../../domain/envio/FormaPago.js";
import type { Canal } from "../../domain/integracion/Integracion.js";
import type { EntregaWebhook } from "../../domain/integracion/Webhook.js";
import type { Ciudad, Ruta } from "../../domain/ruta/Ruta.js";
import type { Cobro, CierreCaja, MovimientosCaja } from "../../domain/caja/Caja.js";
import type { SolicitudDatos } from "../../domain/datos/DatosPersonales.js";
import type { Talonario } from "../../domain/talonario/Talonario.js";
import type {
  CambiosPerfil,
  Rol,
  Usuario,
  UsuarioAdmin,
  UsuarioConCredenciales,
} from "../../domain/usuario/Usuario.js";

// Puertos de salida (driven ports). Los adaptadores viven en infrastructure/persistence.

export interface UsuarioRepository {
  buscarPorEmail(email: string): Promise<UsuarioConCredenciales | null>;
  /** Solo usuarios activos. */
  buscarPorId(id: string): Promise<Usuario | null>;
  /** Con el hash de la contraseña (para cambiarla); solo usuarios activos. */
  buscarCredencialesPorId(id: string): Promise<UsuarioConCredenciales | null>;
  /** ¿El correo (ya en minúsculas) es de otro usuario? `excluirId` permite conservar el propio. */
  existeEmail(email: string, excluirId?: string): Promise<boolean>;
  /** Aplica los cambios presentes y devuelve el usuario. Correo repetido → DomainError("CONFLICTO"). */
  actualizarPerfil(id: string, cambios: CambiosPerfil): Promise<Usuario>;
  actualizarPasswordHash(id: string, passwordHash: string): Promise<void>;

  // ── Gestión de usuarios (v12, ADMIN) ──
  /** Activos e inactivos, ordenados por nombre (orden estable por id). */
  listar(filtro?: FiltroUsuarios): Promise<UsuarioAdmin[]>;
  /** Cualquier estado (activo o no). */
  obtener(id: string): Promise<UsuarioAdmin | null>;
  /** Correo repetido → DomainError("CONFLICTO"). */
  crear(usuario: UsuarioAdmin & { passwordHash: string }): Promise<void>;
  /** Aplica los cambios presentes. Correo repetido → DomainError("CONFLICTO"). */
  actualizar(id: string, cambios: CambiosUsuarioRepo): Promise<UsuarioAdmin>;
  /** Usuarios CLIENTE activos por cliente (solo los clientes que tienen alguno). */
  accesosPortalPorCliente(): Promise<Map<string, number>>;

  // ── Código único de acceso (v17): se guarda solo su huella ──
  /** Cualquier estado (activo o no). */
  buscarPorCodigoAcceso(huella: string): Promise<UsuarioConCredenciales | null>;
  /** Desde cuándo tiene el código activo; null si no tiene. */
  codigoAccesoActivoDesde(id: string): Promise<Date | null>;
  /** Activa o reemplaza el código. Huella de otro usuario (carrera) → DomainError("CONFLICTO"). */
  guardarCodigoAcceso(id: string, huella: string, en: Date): Promise<void>;
  quitarCodigoAcceso(id: string): Promise<void>;
}

export interface FiltroUsuarios {
  rol?: Rol;
  activo?: boolean;
  clienteId?: string;
}

export interface CambiosUsuarioRepo {
  nombre?: string;
  email?: string;
  rol?: Rol;
  activo?: boolean;
  passwordHash?: string;
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
  /** Por `orden` y, a igualdad, por código. `activos: true` → solo los activos. */
  listar(filtro?: { activos?: boolean }): Promise<TipoCarga[]>;
  buscarPorCodigo(codigo: TipoCargaCodigo): Promise<TipoCarga | null>;
  /** Sin distinguir mayúsculas; `excluirCodigo` permite conservar el nombre propio al editar. */
  existeNombre(nombre: string, excluirCodigo?: TipoCargaCodigo): Promise<boolean>;
  /**
   * Alta con su entrada de historial (atómico). Código o nombre repetidos → DomainError("CONFLICTO").
   */
  crear(tipo: TipoCarga, cambio: CambioTipoCarga): Promise<void>;
  /**
   * Guarda los tipos ya existentes indicados y sus entradas de historial (atómico). Nombre repetido o que no quede
   * ningún tipo activo → DomainError("CONFLICTO") sin guardar nada.
   */
  actualizar(tipos: TipoCarga[], cambios: CambioTipoCarga[]): Promise<void>;
  /**
   * Elimina el tipo y registra el cambio (atómico). Si algún envío lo usa o es el último activo →
   * DomainError("CONFLICTO") sin borrar nada.
   */
  eliminar(codigo: TipoCargaCodigo, cambio: CambioTipoCarga): Promise<void>;
  /** Historial (más recientes primero, orden estable); `codigo` filtra por tipo. */
  listarHistorial(
    filtro: { codigo?: TipoCargaCodigo },
    paginacion: Paginacion,
  ): Promise<{ cambios: CambioTipoCarga[]; total: number }>;
}

export interface ArticuloRestringidoRepository {
  /** Por categoría (PROHIBIDO, CONDICIONADO, NOTA), orden e id. `activos: true` → solo los publicados. */
  listar(filtro?: { activos?: boolean }): Promise<ArticuloRestringido[]>;
  buscarPorId(id: string): Promise<ArticuloRestringido | null>;
  crear(articulo: ArticuloRestringido): Promise<void>;
  /** Guarda los artículos existentes indicados (atómico; p. ej. un reordenamiento). */
  actualizar(articulos: ArticuloRestringido[]): Promise<void>;
  eliminar(id: string): Promise<void>;
}

export interface NuevaRuta {
  origenId: number;
  destinoId: number;
  tiempoEstimadoMin: number;
}

export interface CambiosRuta {
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
  /** Busca en remitente, destinatario y referencia externa (sin distinguir mayúsculas). */
  q?: string;
  /** PANEL (sin integración) o API. */
  canal?: Canal;
  integracionId?: string;
  // ── v12 ──
  /** Id del repartidor asignado; `null` = sin asignar. */
  repartidorId?: string | null;
  /** Cualquiera de estos estados (se combina con `estado` mediante AND). */
  estados?: EstadoEnvio[];
  /** `actualizadoEn` ≥ este instante. */
  actualizadoDesde?: Date;
  /** Dígitos del teléfono del remitente o del destinatario (comparando solo dígitos). */
  telefono?: string;
  // ── v16 ──
  /** `creadoEn` ≥ este instante. */
  registradoDesde?: Date;
  /** `creadoEn` < este instante (exclusivo). */
  registradoHasta?: Date;
  // ── v18 ──
  /** `fechaGuia` ≥ esta fecha `AAAA-MM-DD` (inclusive). */
  fechaGuiaDesde?: string;
  /** `fechaGuia` ≤ esta fecha `AAAA-MM-DD` (inclusive). */
  fechaGuiaHasta?: string;
}

export interface Paginacion {
  /** Empieza en 1. */
  pagina: number;
  porPagina: number;
}

export interface OpcionesGuardarEnvio {
  /**
   * Webhooks a encolar (outbox) en la MISMA transacción que el cambio del envío: si el cambio no se guarda,
   * tampoco se encolan; si se guarda, un reinicio no los pierde.
   */
  webhooks?: EntregaWebhook[];
  /** Cobros a registrar y cobros ORIGEN a anular (caja, v12), en la MISMA transacción que el cambio del envío. */
  caja?: MovimientosCaja;
  /**
   * v20 (solo al crear): el número de guía lo indicó el operador. Si es de un talonario y está DISPONIBLE, la guía
   * pasa a USADA (con el id del envío) en la MISMA transacción; ANULADA → DomainError("GUIA_ANULADA"); USADA →
   * DomainError("CONFLICTO"). Sin indicarlo (consecutivo automático), un número reservado en un talonario →
   * DomainError("CONFLICTO"). La comprobación se hace bajo el mismo bloqueo que la reserva de talonarios.
   */
  numeroGuiaIndicado?: boolean;
}

export interface EstadisticaIntegracion {
  envios: number;
  ultimoEnvio: Date | null;
}

export interface EnvioRepository {
  /**
   * Referencia externa repetida en la misma integración → DomainError("CONFLICTO").
   */
  guardar(envio: Envio, opciones?: OpcionesGuardarEnvio): Promise<void>;
  /** Envío de una integración por su número de pedido. */
  buscarPorReferencia(integracionId: string, referenciaExterna: string): Promise<Envio | null>;
  /** Cantidad de envíos y fecha del último por integración (solo las que tienen envíos). */
  estadisticasPorIntegracion(): Promise<Map<string, EstadisticaIntegracion>>;
  buscarPorId(id: string): Promise<Envio | null>;
  buscarPorNumeroGuia(numeroGuia: number): Promise<Envio | null>;
  existeNumeroGuia(numeroGuia: number): Promise<boolean>;
  /** ¿Algún envío (de cualquier estado) lleva ítems de este tipo de carga? */
  usaTipoCarga(codigo: TipoCargaCodigo): Promise<boolean>;
  /** v20: máximo entre los números de envíos y los reservados en talonarios, + 1 (1 si no hay ninguno). */
  siguienteNumeroGuia(): Promise<number>;
  /** Todos los que cumplen el filtro, más recientes primero (para agregados como el dashboard). */
  listar(filtro?: FiltroEnvios): Promise<Envio[]>;
  /** Una página de resultados (más recientes primero, orden estable) y el total que cumple el filtro. */
  listarPagina(filtro: FiltroEnvios, paginacion: Paginacion): Promise<{ envios: Envio[]; total: number }>;
  /**
   * Asigna (o quita, con null) el repartidor de todos los envíos indicados, de forma atómica: si alguno no existe
   * (NO_ENCONTRADO) o está en un estado final (ESTADO_INVALIDO) no se asigna ninguno. Devuelve cuántos se asignaron.
   */
  asignarRepartidor(envioIds: string[], repartidorId: string | null, fecha: Date): Promise<number>;
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
  /**
   * Los envíos del cliente se conservan sin cliente asociado y sus usuarios del portal se desactivan y quedan con
   * `clienteId: null` (atómico). Devuelve cuántos usuarios activos se desactivaron.
   */
  eliminar(id: string): Promise<number>;
}

/** Caja (v12): cobros y cierres. Los cobros se registran al guardar el envío (OpcionesGuardarEnvio.caja). */
export interface CajaRepository {
  cobrosDeEnvio(envioId: string): Promise<Cobro[]>;
  /** Cobros sin cierre (de una persona o de todas), por fecha ascendente y id. */
  pendientes(usuarioId?: string): Promise<Cobro[]>;
  /**
   * Cierre atómico: toma TODOS los cobros pendientes de la persona (bloqueados: un cobro nunca queda en dos cierres),
   * llama a `fabricar` con ellos (puede lanzar, p. ej. SIN_COBROS) y guarda el cierre marcándolos.
   */
  cerrar(usuarioId: string, fabricar: (pendientes: Cobro[]) => CierreCaja): Promise<{ cierre: CierreCaja; cobros: Cobro[] }>;
  /** Más recientes primero (orden estable por id). `hasta` es exclusivo. */
  listarCierres(filtro: FiltroCierres, paginacion: Paginacion): Promise<{ cierres: CierreCaja[]; total: number }>;
  buscarCierre(id: string): Promise<CierreCaja | null>;
  cobrosDeCierre(cierreId: string): Promise<Cobro[]>;
}

export interface FiltroCierres {
  usuarioId?: string;
  desde?: Date;
  /** Exclusivo. */
  hasta?: Date;
}

/** Datos personales (LOPDP): plazo de conservación declarado y solicitudes del titular atendidas. */
export interface DatosPersonalesRepository {
  crearSolicitud(solicitud: SolicitudDatos): Promise<void>;
  /** Más recientes primero (orden estable por id). */
  listarSolicitudes(paginacion: Paginacion): Promise<{ solicitudes: SolicitudDatos[]; total: number }>;
}

/** Talonarios de guías en blanco (v20). */
export interface TalonarioRepository {
  /**
   * Reserva atómica: bajo el mismo bloqueo que el alta de envíos calcula el siguiente consecutivo (máximo entre envíos
   * y talonarios + 1), llama a `fabricar` con él (puede lanzar) y guarda el talonario con sus guías. Dos reservas
   * simultáneas (o una reserva y un envío con consecutivo automático) nunca comparten números.
   */
  reservar(fabricar: (desde: number) => Talonario): Promise<Talonario>;
  /** Más recientes primero (orden estable por id). `abiertos`: con al menos una guía DISPONIBLE. */
  listar(filtro: { abiertos?: boolean }, paginacion: Paginacion): Promise<{ talonarios: Talonario[]; total: number }>;
  buscarPorId(id: string): Promise<Talonario | null>;
  /** Talonario que contiene el número; null si no es de ninguno. */
  buscarPorNumeroGuia(numeroGuia: number): Promise<Talonario | null>;
  /**
   * Lee el talonario bloqueando sus guías, aplica `cambio` (p. ej. anular; puede lanzar) y guarda las guías.
   * NO_ENCONTRADO si no existe.
   */
  modificar(id: string, cambio: (t: Talonario) => void): Promise<Talonario>;
}
