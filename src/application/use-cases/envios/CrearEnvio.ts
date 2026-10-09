import type { Contacto, Destinatario } from "../../../domain/envio/Envio.js";
import { Envio } from "../../../domain/envio/Envio.js";
import { esFormaPago } from "../../../domain/envio/FormaPago.js";
import { parsearNumeroGuia } from "../../../domain/envio/NumeroGuia.js";
import { DomainError } from "../../../domain/shared/DomainError.js";
import type { Actor } from "../../../domain/usuario/Usuario.js";
import { toEnvioDTO, type EnvioDTO } from "../../dto/EnvioDTO.js";
import type { ClienteRepository, EnvioRepository } from "../../ports/repositories.js";
import type { Clock, IdGenerator } from "../../ports/services.js";
import { obtenerOCrearCliente } from "../clientes/Clientes.js";
import type { CotizarEnvio, ItemSolicitud } from "./CotizarEnvio.js";

export interface SolicitudEnvio {
  remitente: Contacto;
  destinatario: Destinatario;
  rutaId: number;
  items: ItemSolicitud[];
  /** Zona de entrega: URBANA (por defecto) o RURAL. Queda guardada en el envío. */
  zona?: string | null;
  formaPago: string;
  descripcion?: string | null;
  /** Número de la guía física. Vacío → consecutivo automático. */
  numeroGuia?: string | number | null;
  /** Cliente frecuente que envía. */
  clienteId?: string | null;
  /** Sin `clienteId`: guarda al remitente como cliente frecuente (o reutiliza el que tenga su teléfono). */
  guardarCliente?: boolean;
  /** Obligatorio (`true`) junto con `guardarCliente`: el remitente acepta que se guarden sus datos (LOPDP). */
  consentimientoCliente?: unknown;
}

const MAX_INTENTOS_GUIA = 5;

export class CrearEnvio {
  constructor(
    private readonly envios: EnvioRepository,
    private readonly cotizador: CotizarEnvio,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly clientes?: ClienteRepository,
  ) {}

  async ejecutar(actor: Actor, s: SolicitudEnvio): Promise<EnvioDTO> {
    if (!esFormaPago(s.formaPago)) throw new DomainError("VALIDACION", `Forma de pago desconocida: ${s.formaPago}`);
    const { ruta, cotizacion } = await this.cotizador.resolver(s);
    const datos = {
      remitente: s.remitente,
      destinatario: s.destinatario,
      rutaId: ruta.id,
      items: cotizacion.items.map(({ tipoCarga, cantidad, pesoKg, costoUnitario, subtotal }) => ({
        tipoCarga,
        cantidad,
        pesoKg,
        costoUnitario,
        subtotal,
      })),
      zona: cotizacion.zona,
      formaPago: s.formaPago,
      descripcion: s.descripcion,
    };
    const ctx = { id: this.ids.uuid(), numeroGuia: await this.numeroGuia(s.numeroGuia), ahora: this.clock.ahora(), actor };
    Envio.crear(datos, ctx); // valida remitente/destinatario antes de dar de alta un cliente
    const envio = Envio.crear({ ...datos, clienteId: await this.cliente(s) }, ctx);
    await this.envios.guardar(envio);
    return toEnvioDTO(envio, ruta, true);
  }

  /**
   * Cliente del envío: el indicado; o el remitente guardado como cliente nuevo; o, si el teléfono
   * del remitente ya es de un cliente registrado, ese cliente (así sus envíos suman en su historial).
   */
  private async cliente(s: SolicitudEnvio): Promise<string | null> {
    if (!this.clientes) return null;
    if (s.clienteId) {
      if (!(await this.clientes.buscarPorId(s.clienteId))) {
        throw new DomainError("VALIDACION", "El cliente seleccionado no existe");
      }
      return s.clienteId;
    }
    if (s.guardarCliente) {
      const ctx = { ids: this.ids, clock: this.clock };
      return (await obtenerOCrearCliente(this.clientes, ctx, s.remitente, s.consentimientoCliente)).id;
    }
    return (await this.clientes.buscarPorTelefono(s.remitente.telefono))?.id ?? null;
  }

  /** Usa el número de la guía física si se indicó; si no, asigna el consecutivo siguiente. */
  private async numeroGuia(indicado: string | number | null | undefined): Promise<number> {
    const vacio = indicado === undefined || indicado === null || String(indicado).trim() === "";
    if (!vacio) {
      const n = parsearNumeroGuia(indicado);
      if (await this.envios.existeNumeroGuia(n)) {
        throw new DomainError("CONFLICTO", `La guía ${n} ya está registrada`);
      }
      return n;
    }
    for (let i = 0; i < MAX_INTENTOS_GUIA; i++) {
      const n = await this.envios.siguienteNumeroGuia();
      if (!(await this.envios.existeNumeroGuia(n))) return n;
    }
    throw new DomainError("CONFLICTO", "No se pudo asignar un número de guía; intente de nuevo");
  }
}
