import {
  normalizarAlcances,
  normalizarEventos,
  normalizarFormaPago,
  normalizarIps,
  normalizarNombreIntegracion,
  normalizarNombreKey,
  normalizarRemitenteIntegracion,
  validarUrlWebhook,
  type DatosIntegracion,
  type EventoWebhook,
  type Integracion,
  type ModoKey,
} from "../../../domain/integracion/Integracion.js";
import type { EstadoEntrega } from "../../../domain/integracion/Webhook.js";
import { DomainError } from "../../../domain/shared/DomainError.js";
import type { Actor } from "../../../domain/usuario/Usuario.js";
import {
  toApiKeyDTO,
  toEntregaWebhookDTO,
  toIntegracionDTO,
  toSolicitudApiDTO,
  type ApiKeyDTO,
  type EntregaWebhookDTO,
  type IntegracionDTO,
  type SolicitudApiDTO,
} from "../../dto/IntegracionDTO.js";
import type {
  CifradorSecretos,
  EntregaWebhookRepository,
  IntegracionRepository,
  ServicioApiKeys,
  ServicioSecretosWebhook,
  SolicitudApiRepository,
} from "../../ports/integraciones.js";
import type {
  CiudadRepository,
  ClienteRepository,
  EnvioRepository,
  Paginacion,
} from "../../ports/repositories.js";
import type { Clock, IdGenerator } from "../../ports/services.js";
import type { PaginaDTO } from "../envios/ConsultasEnvio.js";
import { nuevoMensajeId } from "./EmisorWebhooks.js";
import { intentarEntrega, type DependenciasEntrega } from "./Webhooks.js";

/** Máximo de keys activas por integración (permite rotar sin acumular credenciales olvidadas). */
export const MAX_KEYS_ACTIVAS = 10;

export function exigirAdmin(actor: Actor): void {
  if (actor.rol !== "ADMIN") {
    throw new DomainError("PROHIBIDO", "Solo un administrador puede gestionar las integraciones");
  }
}

async function cargar(repo: IntegracionRepository, id: string): Promise<Integracion> {
  const i = await repo.buscarPorId(id);
  if (!i) throw new DomainError("NO_ENCONTRADO", "Integración no encontrada");
  return i;
}

function pagina<T>(datos: T[], total: number, p: Paginacion): PaginaDTO<T> {
  return { datos, pagina: p.pagina, porPagina: p.porPagina, total, totalPaginas: Math.ceil(total / p.porPagina) };
}

/** Arma el DTO con el nombre de la ciudad de origen y las estadísticas de envíos. */
class Presentador {
  constructor(
    private readonly ciudades: CiudadRepository,
    private readonly envios: EnvioRepository,
  ) {}

  async uno(i: Integracion): Promise<IntegracionDTO> {
    return (await this.varios([i]))[0]!;
  }

  async varios(lista: Integracion[]): Promise<IntegracionDTO[]> {
    const [ciudades, est] = await Promise.all([this.ciudades.listar(), this.envios.estadisticasPorIntegracion()]);
    const nombres = new Map(ciudades.map((c) => [c.id, c.nombre]));
    return lista.map((i) => toIntegracionDTO(i, nombres.get(i.ciudadOrigenId) ?? "?", est.get(i.id)));
  }
}

export interface DepsAdmin {
  integraciones: IntegracionRepository;
  ciudades: CiudadRepository;
  clientes: ClienteRepository;
  envios: EnvioRepository;
  ids: IdGenerator;
  clock: Clock;
}

export class ListarIntegraciones {
  private readonly p: Presentador;
  constructor(private readonly d: DepsAdmin) {
    this.p = new Presentador(d.ciudades, d.envios);
  }
  async ejecutar(actor: Actor): Promise<IntegracionDTO[]> {
    exigirAdmin(actor);
    return this.p.varios(await this.d.integraciones.listar());
  }
}

export class ObtenerIntegracion {
  private readonly p: Presentador;
  constructor(private readonly d: DepsAdmin) {
    this.p = new Presentador(d.ciudades, d.envios);
  }
  async ejecutar(actor: Actor, id: string): Promise<IntegracionDTO> {
    exigirAdmin(actor);
    return this.p.uno(await cargar(this.d.integraciones, id));
  }
}

/** Valida ciudad de origen (activa) y cliente (existente): reglas de negocio → 422. */
async function validarReferencias(d: DepsAdmin, ciudadOrigenId: number | undefined, clienteId: string | null | undefined) {
  if (ciudadOrigenId !== undefined) {
    const ciudad = await d.ciudades.buscarPorId(ciudadOrigenId);
    if (!ciudad?.activa) {
      throw new DomainError("VALIDACION", "La ciudad de origen no existe o no está activa", { regla: true });
    }
  }
  if (clienteId && !(await d.clientes.buscarPorId(clienteId))) {
    throw new DomainError("VALIDACION", "El cliente indicado no existe", { regla: true });
  }
}

export class CrearIntegracion {
  private readonly p: Presentador;
  constructor(private readonly d: DepsAdmin) {
    this.p = new Presentador(d.ciudades, d.envios);
  }

  async ejecutar(actor: Actor, datos: DatosIntegracion): Promise<IntegracionDTO> {
    exigirAdmin(actor);
    const nombre = normalizarNombreIntegracion(datos.nombre);
    const integracion: Integracion = {
      id: this.d.ids.uuid(),
      nombre,
      activa: datos.activa ?? true,
      remitente: normalizarRemitenteIntegracion(datos.remitente),
      ciudadOrigenId: datos.ciudadOrigenId,
      formaPagoPorDefecto: normalizarFormaPago(datos.formaPagoPorDefecto),
      clienteId: datos.clienteId ?? null,
      ipsPermitidas: normalizarIps(datos.ipsPermitidas),
      webhook: null,
      creadaEn: this.d.clock.ahora(),
      keys: [],
    };
    if (await this.d.integraciones.existeNombre(nombre)) {
      throw new DomainError("CONFLICTO", `Ya existe una integración llamada ${nombre}`);
    }
    await validarReferencias(this.d, datos.ciudadOrigenId, datos.clienteId);
    await this.d.integraciones.guardar(integracion);
    return this.p.uno(integracion);
  }
}

export class ActualizarIntegracion {
  private readonly p: Presentador;
  constructor(private readonly d: DepsAdmin) {
    this.p = new Presentador(d.ciudades, d.envios);
  }

  async ejecutar(actor: Actor, id: string, cambios: Partial<DatosIntegracion>): Promise<IntegracionDTO> {
    exigirAdmin(actor);
    const actual = await cargar(this.d.integraciones, id);
    if (Object.values(cambios).every((v) => v === undefined)) {
      throw new DomainError("VALIDACION", "Debe enviar al menos un campo");
    }
    const nueva: Integracion = { ...actual };
    if (cambios.nombre !== undefined) {
      nueva.nombre = normalizarNombreIntegracion(cambios.nombre);
      if (await this.d.integraciones.existeNombre(nueva.nombre, id)) {
        throw new DomainError("CONFLICTO", `Ya existe una integración llamada ${nueva.nombre}`);
      }
    }
    if (cambios.activa !== undefined) nueva.activa = cambios.activa;
    if (cambios.remitente !== undefined) nueva.remitente = normalizarRemitenteIntegracion(cambios.remitente);
    if (cambios.formaPagoPorDefecto !== undefined) nueva.formaPagoPorDefecto = normalizarFormaPago(cambios.formaPagoPorDefecto);
    if (cambios.ipsPermitidas !== undefined) nueva.ipsPermitidas = normalizarIps(cambios.ipsPermitidas);
    if (cambios.clienteId !== undefined) nueva.clienteId = cambios.clienteId ?? null;
    if (cambios.ciudadOrigenId !== undefined) nueva.ciudadOrigenId = cambios.ciudadOrigenId;
    await validarReferencias(
      this.d,
      cambios.ciudadOrigenId !== undefined && cambios.ciudadOrigenId !== actual.ciudadOrigenId ? cambios.ciudadOrigenId : undefined,
      cambios.clienteId,
    );
    await this.d.integraciones.guardar(nueva);
    return this.p.uno(nueva);
  }
}

export class EliminarIntegracion {
  constructor(private readonly d: DepsAdmin) {}

  async ejecutar(actor: Actor, id: string): Promise<void> {
    exigirAdmin(actor);
    await cargar(this.d.integraciones, id);
    if ((await this.d.envios.estadisticasPorIntegracion()).get(id)?.envios) {
      throw new DomainError("CONFLICTO", "La integración tiene envíos registrados: desactívela en lugar de eliminarla");
    }
    await this.d.integraciones.eliminar(id);
  }
}

export class CrearApiKey {
  constructor(
    private readonly d: DepsAdmin,
    private readonly apiKeys: ServicioApiKeys,
  ) {}

  async ejecutar(
    actor: Actor,
    integracionId: string,
    datos: { nombre: string; modo: ModoKey; alcances: string[] },
  ): Promise<{ key: string; apiKey: ApiKeyDTO }> {
    exigirAdmin(actor);
    const integracion = await cargar(this.d.integraciones, integracionId);
    const nombre = normalizarNombreKey(datos.nombre);
    const alcances = normalizarAlcances(datos.alcances);
    if (integracion.keys.filter((k) => k.revocadaEn === null).length >= MAX_KEYS_ACTIVAS) {
      throw new DomainError("CONFLICTO", `La integración ya tiene ${MAX_KEYS_ACTIVAS} keys activas; revoque alguna`);
    }
    const generada = this.apiKeys.generar(datos.modo);
    const apiKey = {
      id: this.d.ids.uuid(),
      integracionId,
      nombre,
      modo: datos.modo,
      prefijo: generada.prefijo,
      hash: generada.hash,
      alcances,
      creadaEn: this.d.clock.ahora(),
      ultimoUsoEn: null,
      revocadaEn: null,
    };
    await this.d.integraciones.crearKey(apiKey);
    return { key: generada.key, apiKey: toApiKeyDTO(apiKey) };
  }
}

export class RevocarApiKey {
  constructor(private readonly d: DepsAdmin) {}

  async ejecutar(actor: Actor, integracionId: string, keyId: string): Promise<void> {
    exigirAdmin(actor);
    await cargar(this.d.integraciones, integracionId);
    if (!(await this.d.integraciones.revocarKey(integracionId, keyId, this.d.clock.ahora()))) {
      throw new DomainError("NO_ENCONTRADO", "API key no encontrada");
    }
  }
}

export interface DepsWebhookAdmin extends DepsAdmin {
  cifrador: CifradorSecretos;
  secretos: ServicioSecretosWebhook;
  /** WEBHOOKS_PERMITIR_HTTP: acepta http:// (solo desarrollo). */
  permitirHttp: boolean;
}

/** `whsec_ab12`: lo justo para reconocer el secreto en el panel. */
const prefijoSecreto = (secreto: string): string => secreto.slice(0, 10);

export class ConfigurarWebhook {
  private readonly p: Presentador;
  constructor(private readonly d: DepsWebhookAdmin) {
    this.p = new Presentador(d.ciudades, d.envios);
  }

  async ejecutar(
    actor: Actor,
    id: string,
    datos: { url: string; eventos: string[]; activo: boolean },
  ): Promise<{ secreto: string | null; integracion: IntegracionDTO }> {
    exigirAdmin(actor);
    const integracion = await cargar(this.d.integraciones, id);
    const url = validarUrlWebhook(datos.url, this.d.permitirHttp);
    const eventos: EventoWebhook[] = normalizarEventos(datos.eventos);
    let secreto: string | null = null;
    let cifrado = integracion.webhook?.secretoCifrado;
    let prefijo = integracion.webhook?.secretoPrefijo;
    if (!cifrado || !prefijo) {
      secreto = this.d.secretos.generar();
      cifrado = this.d.cifrador.cifrar(secreto);
      prefijo = prefijoSecreto(secreto);
    }
    const nueva: Integracion = {
      ...integracion,
      webhook: { url, eventos, activo: datos.activo, secretoCifrado: cifrado, secretoPrefijo: prefijo },
    };
    await this.d.integraciones.guardar(nueva);
    return { secreto, integracion: await this.p.uno(nueva) };
  }
}

function exigirWebhook(i: Integracion): NonNullable<Integracion["webhook"]> {
  if (!i.webhook) throw new DomainError("NO_ENCONTRADO", "La integración no tiene webhook configurado");
  return i.webhook;
}

export class RotarSecretoWebhook {
  constructor(private readonly d: DepsWebhookAdmin) {}

  async ejecutar(actor: Actor, id: string): Promise<{ secreto: string }> {
    exigirAdmin(actor);
    const integracion = await cargar(this.d.integraciones, id);
    const webhook = exigirWebhook(integracion);
    const secreto = this.d.secretos.generar();
    await this.d.integraciones.guardar({
      ...integracion,
      webhook: { ...webhook, secretoCifrado: this.d.cifrador.cifrar(secreto), secretoPrefijo: prefijoSecreto(secreto) },
    });
    return { secreto };
  }
}

export class EliminarWebhook {
  constructor(private readonly d: DepsAdmin) {}

  async ejecutar(actor: Actor, id: string): Promise<void> {
    exigirAdmin(actor);
    const integracion = await cargar(this.d.integraciones, id);
    exigirWebhook(integracion);
    await this.d.integraciones.guardar({ ...integracion, webhook: null });
  }
}

/** Ejemplo para el evento de prueba: datos ficticios con `prueba: true`. */
function cuerpoPrueba(ahora: Date, publicUrl: string): string {
  const fecha = ahora.toISOString();
  return JSON.stringify({
    type: "envio.estado_actualizado",
    timestamp: fecha,
    data: {
      prueba: true,
      id: "prueba_00000000-0000-4000-8000-000000000000",
      numeroGuia: 0,
      referenciaExterna: "PEDIDO-DE-PRUEBA",
      estado: "EN_TRANSITO",
      origen: "Ibarra",
      destino: "Quito",
      destinatario: { nombre: "Cliente de prueba", telefono: "0990000000", direccion: "Dirección de prueba" },
      items: [{ tipoCarga: "PAQUETE", cantidad: 1, pesoKg: 1, costoUnitario: 3, subtotal: 3 }],
      totalPiezas: 1,
      pesoTotalKg: 1,
      zona: "URBANA",
      costo: 3,
      formaPago: "CONTRATO",
      descripcion: null,
      seguimientoUrl: `${publicUrl.replace(/\/+$/, "")}/seguimiento/0`,
      entrega: null,
      evidencia: null,
      creadoEn: fecha,
      actualizadoEn: fecha,
      historial: [
        { estado: "REGISTRADO", nota: "Evento de prueba", fecha },
        { estado: "EN_TRANSITO", nota: null, fecha },
      ],
    },
  });
}

export class EnviarWebhookPrueba {
  constructor(
    private readonly d: DepsAdmin & DependenciasEntrega,
    private readonly publicUrl: string,
  ) {}

  /** Un solo intento, sin reintentos; queda registrado en las entregas. */
  async ejecutar(actor: Actor, id: string): Promise<EntregaWebhookDTO> {
    exigirAdmin(actor);
    exigirWebhook(await cargar(this.d.integraciones, id));
    const ahora = this.d.clock.ahora();
    const entrega = {
      id: this.d.ids.uuid(),
      integracionId: id,
      mensajeId: nuevoMensajeId(this.d.ids),
      evento: "envio.estado_actualizado" as const,
      envioId: null,
      numeroGuia: null,
      cuerpo: cuerpoPrueba(ahora, this.publicUrl),
      prueba: true,
      estado: "PENDIENTE" as const,
      intentos: 0,
      ultimoStatus: null,
      ultimoError: null,
      // Sin fecha de próximo intento: el despachador no la toma; se envía aquí mismo.
      proximoIntentoEn: null,
      creadoEn: ahora,
      entregadoEn: null,
    };
    await this.d.entregas.crear(entrega);
    return toEntregaWebhookDTO(await intentarEntrega(entrega, this.d));
  }
}

export class ListarEntregasWebhook {
  constructor(private readonly d: DepsAdmin & { entregas: EntregaWebhookRepository }) {}

  async ejecutar(
    actor: Actor,
    id: string,
    filtro: { estado?: EstadoEntrega },
    p: Paginacion,
  ): Promise<PaginaDTO<EntregaWebhookDTO>> {
    exigirAdmin(actor);
    await cargar(this.d.integraciones, id);
    const { entregas, total } = await this.d.entregas.listarPagina(id, filtro, p);
    return pagina(entregas.map(toEntregaWebhookDTO), total, p);
  }
}

export class ReintentarEntregaWebhook {
  constructor(private readonly d: DepsAdmin & DependenciasEntrega) {}

  /** Intenta ya mismo. Si vuelve a fallar sigue la política normal (reintentos o FALLIDO si ya no quedan). */
  async ejecutar(actor: Actor, id: string, entregaId: string): Promise<EntregaWebhookDTO> {
    exigirAdmin(actor);
    await cargar(this.d.integraciones, id);
    const entrega = await this.d.entregas.buscarPorId(id, entregaId);
    if (!entrega) throw new DomainError("NO_ENCONTRADO", "Entrega no encontrada");
    if (entrega.estado === "ENTREGADO") {
      throw new DomainError("ESTADO_INVALIDO", "La entrega ya fue recibida por la empresa");
    }
    return toEntregaWebhookDTO(await intentarEntrega(entrega, this.d));
  }
}

export class ListarSolicitudesApi {
  constructor(private readonly d: DepsAdmin & { solicitudes: SolicitudApiRepository }) {}

  async ejecutar(actor: Actor, id: string, p: Paginacion): Promise<PaginaDTO<SolicitudApiDTO>> {
    exigirAdmin(actor);
    await cargar(this.d.integraciones, id);
    const { solicitudes, total } = await this.d.solicitudes.listarPagina(id, p);
    return pagina(solicitudes.map(toSolicitudApiDTO), total, p);
  }
}
