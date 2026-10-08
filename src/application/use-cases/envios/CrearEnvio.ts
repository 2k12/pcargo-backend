import type { Contacto, Destinatario } from "../../../domain/envio/Envio.js";
import { Envio } from "../../../domain/envio/Envio.js";
import { esFormaPago } from "../../../domain/envio/FormaPago.js";
import { parsearNumeroGuia } from "../../../domain/envio/NumeroGuia.js";
import { DomainError } from "../../../domain/shared/DomainError.js";
import type { Actor } from "../../../domain/usuario/Usuario.js";
import { toEnvioDTO, type EnvioDTO } from "../../dto/EnvioDTO.js";
import type { EnvioRepository } from "../../ports/repositories.js";
import type { Clock, IdGenerator } from "../../ports/services.js";
import type { CotizarEnvio, ItemSolicitud } from "./CotizarEnvio.js";

export interface SolicitudEnvio {
  remitente: Contacto;
  destinatario: Destinatario;
  rutaId: number;
  items: ItemSolicitud[];
  formaPago: string;
  descripcion?: string | null;
  /** Número de la guía física. Vacío → consecutivo automático. */
  numeroGuia?: string | number | null;
}

const MAX_INTENTOS_GUIA = 5;

export class CrearEnvio {
  constructor(
    private readonly envios: EnvioRepository,
    private readonly cotizador: CotizarEnvio,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async ejecutar(actor: Actor, s: SolicitudEnvio): Promise<EnvioDTO> {
    if (!esFormaPago(s.formaPago)) throw new DomainError("VALIDACION", `Forma de pago desconocida: ${s.formaPago}`);
    const { ruta, cotizacion } = await this.cotizador.resolver(s);
    const envio = Envio.crear(
      {
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
        formaPago: s.formaPago,
        descripcion: s.descripcion,
      },
      { id: this.ids.uuid(), numeroGuia: await this.numeroGuia(s.numeroGuia), ahora: this.clock.ahora(), actor },
    );
    await this.envios.guardar(envio);
    return toEnvioDTO(envio, ruta, true);
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
