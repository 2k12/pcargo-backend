import { cobroAlRegistrar } from "../../../domain/caja/Caja.js";
import type { Contacto, Destinatario } from "../../../domain/envio/Envio.js";
import { Envio } from "../../../domain/envio/Envio.js";
import { esFormaPago } from "../../../domain/envio/FormaPago.js";
import { parsearNumeroGuia } from "../../../domain/envio/NumeroGuia.js";
import type { Ruta } from "../../../domain/ruta/Ruta.js";
import { DomainError } from "../../../domain/shared/DomainError.js";
import type { Actor } from "../../../domain/usuario/Usuario.js";
import { toEnvioDTO, type EnvioDTO } from "../../dto/EnvioDTO.js";
import type { ClienteRepository, EnvioRepository } from "../../ports/repositories.js";
import type { Clock, IdGenerator } from "../../ports/services.js";
import { obtenerOCrearCliente } from "../clientes/Clientes.js";
import type { EmisorWebhooks } from "../integraciones/EmisorWebhooks.js";
import type { CotizarEnvio, ItemSolicitud } from "./CotizarEnvio.js";

export interface SolicitudEnvio {
  remitente: Contacto & { direccion?: string | null };
  destinatario: Destinatario;
  rutaId: number;
  items: ItemSolicitud[];
  /** Zona de entrega: URBANA (por defecto) o RURAL. Queda guardada en el envío. */
  zona?: string | null;
  formaPago: string;
  descripcion?: string | null;
  /** Número de la guía física. Vacío → consecutivo automático. */
  numeroGuia?: string | number | null;
  /** v15: recargo en USD sumado al costo (solo panel; la API de empresas y el portal no lo envían). */
  costoAdicional?: number;
  /** v18: fecha de la guía AAAA-MM-DD (solo panel; la API de empresas y el portal no la envían: siempre hoy). */
  fechaGuia?: string | null;
  /** Cliente frecuente que envía. */
  clienteId?: string | null;
  /** Sin `clienteId`: guarda al remitente como cliente frecuente (o reutiliza el que tenga su teléfono). */
  guardarCliente?: boolean;
  /** Obligatorio (`true`) junto con `guardarCliente`: el remitente acepta que se guarden sus datos (LOPDP). */
  consentimientoCliente?: unknown;
}

/** Cómo se registra el envío: desde el panel (con operador) o por la API de una empresa. */
export interface OpcionesRegistro {
  /** null = sin operador (API de empresas). */
  actor: Actor | null;
  integracion?: { id: string; nombre: string };
  referenciaExterna?: string;
  /** Nota del evento REGISTRADO. */
  notaRegistro?: string;
  /** Modo prueba: valida y cotiza igual, pero no asigna guía, no guarda nada ni dispara webhooks. */
  simular?: boolean;
  /**
   * Envío del panel: si es PAGADO genera el cobro ORIGEN a nombre del operador (caja, v12). Los de la API de
   * empresas y del portal se pagan por fuera y no generan cobro.
   */
  cobroOrigen?: boolean;
}

const MAX_INTENTOS_GUIA = 5;

export class CrearEnvio {
  constructor(
    private readonly envios: EnvioRepository,
    private readonly cotizador: CotizarEnvio,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly clientes?: ClienteRepository,
    private readonly webhooks?: EmisorWebhooks,
  ) {}

  /** Envío desde el panel. */
  async ejecutar(actor: Actor, s: SolicitudEnvio): Promise<EnvioDTO> {
    const { envio, ruta } = await this.registrar(s, { actor, cobroOrigen: true });
    return toEnvioDTO(envio, ruta, true);
  }

  /**
   * Lógica común del panel y de la API de empresas: cotiza con la tarifa vigente (el costo cobrado es el cotizado),
   * valida, resuelve el cliente, asigna la guía y guarda el envío junto con sus webhooks (outbox).
   */
  async registrar(s: SolicitudEnvio, o: OpcionesRegistro): Promise<{ envio: Envio; ruta: Ruta }> {
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
      costoAdicional: s.costoAdicional,
      fechaGuia: s.fechaGuia,
      integracion: o.integracion ?? null,
      referenciaExterna: o.referenciaExterna ?? null,
    };
    const automatica = s.numeroGuia === undefined || s.numeroGuia === null || String(s.numeroGuia).trim() === "";
    const base = { ahora: this.clock.ahora(), actor: o.actor, notaRegistro: o.notaRegistro ?? null };

    if (o.simular) {
      const ctx = { ...base, id: `prueba_${this.ids.uuid()}`, numeroGuia: 0 };
      Envio.crear(datos, ctx);
      // Solo lectura: en modo prueba nunca se da de alta un cliente.
      const clienteId = s.guardarCliente ? null : await this.cliente(s);
      return { envio: Envio.crear({ ...datos, clienteId }, ctx), ruta };
    }

    const id = this.ids.uuid();
    Envio.crear(datos, { ...base, id, numeroGuia: 0 }); // valida remitente/destinatario antes de dar de alta un cliente
    const clienteId = await this.cliente(s);
    let cobroId: string | undefined;
    for (let intento = 1; ; intento++) {
      const envio = Envio.crear({ ...datos, clienteId }, { ...base, id, numeroGuia: await this.numeroGuia(s.numeroGuia) });
      const webhooks = (await this.webhooks?.entregasPara(envio, ruta, "envio.creado")) ?? [];
      // El cobro se guarda en la misma transacción que el envío (si el envío no se guarda, no hay cobro).
      const cobro =
        o.cobroOrigen && o.actor && envio.formaPago === "PAGADO"
          ? cobroAlRegistrar(envio, { nuevoId: () => (cobroId ??= this.ids.uuid()), ahora: base.ahora, actor: o.actor })
          : null;
      try {
        await this.envios.guardar(envio, { webhooks, caja: { cobros: cobro ? [cobro] : [], anulaciones: [] } });
        return { envio, ruta };
      } catch (e) {
        // Dos registros simultáneos con guía automática pueden tomar el mismo consecutivo: se reintenta con otro.
        const choqueDeGuia =
          automatica &&
          e instanceof DomainError &&
          e.code === "CONFLICTO" &&
          intento < MAX_INTENTOS_GUIA &&
          (await this.envios.existeNumeroGuia(envio.numeroGuia)) &&
          !(await this.envios.buscarPorId(id));
        if (!choqueDeGuia) throw e;
      }
    }
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
