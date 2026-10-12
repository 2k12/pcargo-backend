import { desarmarApiKey } from "../../../domain/integracion/ApiKeyFormato.js";
import { notaRegistroApi, validarReferenciaExterna } from "../../../domain/integracion/EnvioExterno.js";
import {
  exigirAlcance,
  normalizarNombreCiudad,
  type ApiKey,
  type Integracion,
} from "../../../domain/integracion/Integracion.js";
import { esOperativa, type Ruta } from "../../../domain/ruta/Ruta.js";
import { DomainError } from "../../../domain/shared/DomainError.js";
import type { Cotizacion } from "../../../domain/tarifa/calcularTarifa.js";
import { toEnvioApiDTO, type EnvioApiDTO } from "../../dto/IntegracionDTO.js";
import type {
  IntegracionRepository,
  ServicioApiKeys,
  SolicitudApi,
  SolicitudApiRepository,
} from "../../ports/integraciones.js";
import type { CiudadRepository, EnvioRepository, RutaRepository } from "../../ports/repositories.js";
import type { Clock, IdGenerator } from "../../ports/services.js";
import type { CotizarEnvio, ItemSolicitud } from "../envios/CotizarEnvio.js";
import type { CrearEnvio } from "../envios/CrearEnvio.js";

/** Quién llama a la API para empresas: lo determina la key, nunca el body. */
export interface ContextoApi {
  integracion: Integracion;
  key: ApiKey;
  /** Key `pc_test_`: valida y responde igual, pero no guarda nada. */
  prueba: boolean;
}

const MENSAJE_KEY_INVALIDA = "API key inválida o revocada";
/** `ultimoUsoEn` se actualiza como mucho una vez por minuto (evita una escritura por solicitud). */
const INTERVALO_USO_MS = 60_000;
/** Hash de relleno: si el prefijo no existe se compara igual, para no revelar por tiempo qué prefijos existen. */
const HASH_RELLENO = "0".repeat(64);

export class AutenticarApiKey {
  constructor(
    private readonly integraciones: IntegracionRepository,
    private readonly apiKeys: ServicioApiKeys,
    private readonly clock: Clock,
  ) {}

  /** Sin key, con formato inválido, inexistente o revocada → 401 API_KEY_INVALIDA (mismo mensaje). */
  async ejecutar(key: string | undefined): Promise<ContextoApi> {
    const invalida = () => new DomainError("API_KEY_INVALIDA", MENSAJE_KEY_INVALIDA);
    const partes = key ? desarmarApiKey(key) : null;
    if (!key || !partes) throw invalida();
    const encontrada = await this.integraciones.buscarPorPrefijoKey(partes.prefijo);
    const hash = this.apiKeys.hashear(key);
    const coincide = this.apiKeys.coinciden(hash, encontrada?.key.hash ?? HASH_RELLENO);
    if (!encontrada || !coincide || encontrada.key.revocadaEn !== null || encontrada.key.modo !== partes.modo) {
      throw invalida();
    }
    const { integracion, key: apiKey } = encontrada;
    if (!integracion.activa) {
      throw new DomainError("INTEGRACION_INACTIVA", "La integración está desactivada; contacte a PCargo");
    }
    const ahora = this.clock.ahora();
    if (!apiKey.ultimoUsoEn || ahora.getTime() - apiKey.ultimoUsoEn.getTime() >= INTERVALO_USO_MS) {
      await this.integraciones.registrarUsoKey(apiKey.id, ahora);
    }
    return { integracion, key: apiKey, prueba: apiKey.modo === "test" };
  }
}

/** Ruta operativa ciudadOrigen → ciudad de destino (por nombre, sin mayúsculas ni tildes). */
async function resolverRuta(rutas: RutaRepository, origenId: number, ciudad: string): Promise<Ruta> {
  const buscada = normalizarNombreCiudad(ciudad);
  const ruta = (await rutas.listar()).find(
    (r) => r.origen.id === origenId && normalizarNombreCiudad(r.destino.nombre) === buscada,
  );
  if (!ruta || !esOperativa(ruta)) {
    throw new DomainError("RUTA_NO_DISPONIBLE", `No hay servicio disponible hacia "${ciudad}" desde la ciudad de origen`);
  }
  return ruta;
}

export interface CoberturaDTO {
  origen: string;
  destinos: { ciudad: string; tiempoEstimadoMin: number }[];
}

export class CoberturaApi {
  constructor(
    private readonly rutas: RutaRepository,
    private readonly ciudades: CiudadRepository,
  ) {}

  async ejecutar(ctx: ContextoApi): Promise<CoberturaDTO> {
    const origenId = ctx.integracion.ciudadOrigenId;
    const [origen, rutas] = await Promise.all([this.ciudades.buscarPorId(origenId), this.rutas.listar()]);
    return {
      origen: origen?.nombre ?? "?",
      destinos: rutas
        .filter((r) => r.origen.id === origenId && esOperativa(r))
        .map((r) => ({ ciudad: r.destino.nombre, tiempoEstimadoMin: r.tiempoEstimadoMin }))
        .sort((a, b) => a.ciudad.localeCompare(b.ciudad, "es")),
    };
  }
}

export interface SolicitudCotizacionApi {
  destino: { ciudad: string };
  items: ItemSolicitud[];
  zona?: string;
}

export class CotizarApi {
  constructor(
    private readonly rutas: RutaRepository,
    private readonly cotizador: CotizarEnvio,
  ) {}

  async ejecutar(ctx: ContextoApi, s: SolicitudCotizacionApi): Promise<Cotizacion> {
    exigirAlcance(ctx.key, "cotizar");
    const ruta = await resolverRuta(this.rutas, ctx.integracion.ciudadOrigenId, s.destino.ciudad);
    return this.cotizador.ejecutar({ rutaId: ruta.id, items: s.items, zona: s.zona });
  }
}

export interface NuevoEnvioApi {
  referenciaExterna: string;
  destinatario: { nombre: string; telefono: string; direccion: string; ciudad: string };
  items: ItemSolicitud[];
  zona?: string;
  formaPago?: string;
  descripcion?: string | null;
}

export class CrearEnvioApi {
  constructor(
    private readonly crearEnvio: CrearEnvio,
    private readonly envios: EnvioRepository,
    private readonly rutas: RutaRepository,
    private readonly publicUrl: string,
  ) {}

  async ejecutar(ctx: ContextoApi, d: NuevoEnvioApi): Promise<EnvioApiDTO> {
    exigirAlcance(ctx.key, "envios:crear");
    const { integracion } = ctx;
    const referenciaExterna = validarReferenciaExterna(d.referenciaExterna);
    await this.exigirReferenciaLibre(integracion.id, referenciaExterna);
    const ruta = await resolverRuta(this.rutas, integracion.ciudadOrigenId, d.destinatario.ciudad);
    const solicitud = {
      remitente: { ...integracion.remitente },
      destinatario: { nombre: d.destinatario.nombre, telefono: d.destinatario.telefono, direccion: d.destinatario.direccion },
      rutaId: ruta.id,
      items: d.items,
      zona: d.zona,
      formaPago: d.formaPago ?? integracion.formaPagoPorDefecto,
      descripcion: d.descripcion,
      clienteId: integracion.clienteId,
    };
    try {
      const { envio } = await this.crearEnvio.registrar(solicitud, {
        actor: null,
        integracion: { id: integracion.id, nombre: integracion.nombre },
        referenciaExterna,
        notaRegistro: notaRegistroApi(integracion.nombre),
        simular: ctx.prueba,
      });
      return toEnvioApiDTO(envio, ruta, { publicUrl: this.publicUrl, prueba: ctx.prueba });
    } catch (e) {
      // Dos solicitudes simultáneas con la misma referencia: decide la restricción UNIQUE de la BD.
      if (e instanceof DomainError && e.code === "CONFLICTO" && !ctx.prueba) {
        await this.exigirReferenciaLibre(integracion.id, referenciaExterna);
      }
      throw e;
    }
  }

  private async exigirReferenciaLibre(integracionId: string, referenciaExterna: string): Promise<void> {
    const existente = await this.envios.buscarPorReferencia(integracionId, referenciaExterna);
    if (existente) {
      throw new DomainError("CONFLICTO", `Ya existe un envío con la referencia ${referenciaExterna}`, {
        detalles: { envio: { numeroGuia: existente.numeroGuia, referenciaExterna } },
      });
    }
  }
}

export const MAX_LOTE = 100;

export type ElementoLote =
  | { ok: true; datos: NuevoEnvioApi }
  /** Elemento que no pasó la validación de forma (la hace el adaptador HTTP). */
  | { ok: false; error: { code: string; message: string } };

export type ResultadoElementoLote =
  | { indice: number; ok: true; envio: EnvioApiDTO }
  | { indice: number; ok: false; error: { code: string; message: string } & Record<string, unknown> };

export interface ResultadoLoteDTO {
  resultados: ResultadoElementoLote[];
  creados: number;
  fallidos: number;
}

/** Lote NO atómico: cada envío se registra (o falla) por separado, en orden. */
export class CrearLoteApi {
  constructor(private readonly crear: CrearEnvioApi) {}

  async ejecutar(ctx: ContextoApi, elementos: ElementoLote[]): Promise<ResultadoLoteDTO> {
    exigirAlcance(ctx.key, "envios:crear");
    if (elementos.length < 1 || elementos.length > MAX_LOTE) {
      throw new DomainError("VALIDACION", `El lote debe tener entre 1 y ${MAX_LOTE} envíos`);
    }
    const vistas = new Set<string>();
    const resultados: ResultadoElementoLote[] = [];
    for (const [indice, el] of elementos.entries()) {
      if (!el.ok) {
        resultados.push({ indice, ok: false, error: el.error });
        continue;
      }
      try {
        // En modo prueba nada se guarda: los duplicados dentro del mismo lote se detectan aquí.
        if (ctx.prueba && vistas.has(el.datos.referenciaExterna)) {
          throw new DomainError("CONFLICTO", `La referencia ${el.datos.referenciaExterna} se repite en el lote`);
        }
        vistas.add(el.datos.referenciaExterna);
        resultados.push({ indice, ok: true, envio: await this.crear.ejecutar(ctx, el.datos) });
      } catch (e) {
        if (!(e instanceof DomainError)) throw e;
        resultados.push({ indice, ok: false, error: { code: e.code, message: e.message, ...(e.detalles ?? {}) } });
      }
    }
    const creados = resultados.filter((r) => r.ok).length;
    return { resultados, creados, fallidos: resultados.length - creados };
  }
}

export class ConsultarEnvioApi {
  constructor(
    private readonly envios: EnvioRepository,
    private readonly rutas: RutaRepository,
    private readonly publicUrl: string,
  ) {}

  /** Solo envíos de la propia integración; con key de prueba siempre 404 (no hay envíos de prueba guardados). */
  async ejecutar(ctx: ContextoApi, referenciaExterna: string): Promise<EnvioApiDTO> {
    exigirAlcance(ctx.key, "envios:leer");
    const noEncontrado = new DomainError("NO_ENCONTRADO", "No existe un envío con esa referencia");
    if (ctx.prueba) throw noEncontrado;
    const envio = await this.envios.buscarPorReferencia(ctx.integracion.id, referenciaExterna);
    if (!envio) throw noEncontrado;
    const ruta = (await this.rutas.buscarPorId(envio.rutaId)) ?? undefined;
    return toEnvioApiDTO(envio, ruta, { publicUrl: this.publicUrl, conHistorial: true });
  }
}

/** Auditoría de la API para empresas: nunca recibe la key ni el body. */
export class RegistrarSolicitudApi {
  constructor(
    private readonly solicitudes: SolicitudApiRepository,
    private readonly ids: IdGenerator,
  ) {}

  async ejecutar(s: Omit<SolicitudApi, "id">): Promise<void> {
    await this.solicitudes.registrar({ ...s, id: this.ids.uuid() });
  }
}
