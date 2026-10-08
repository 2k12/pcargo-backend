import type { Contacto, Destinatario } from "../../../domain/envio/Envio.js";
import { Envio } from "../../../domain/envio/Envio.js";
import { DomainError } from "../../../domain/shared/DomainError.js";
import type { Actor } from "../../../domain/usuario/Usuario.js";
import { toEnvioDTO, type EnvioDTO } from "../../dto/EnvioDTO.js";
import type { EnvioRepository } from "../../ports/repositories.js";
import type { Clock, IdGenerator } from "../../ports/services.js";
import type { CotizarEnvio } from "./CotizarEnvio.js";

export interface SolicitudEnvio {
  remitente: Contacto;
  destinatario: Destinatario;
  rutaId: number;
  tipoCarga: string;
  pesoKg: number;
  descripcion?: string | null;
}

const MAX_INTENTOS_CODIGO = 5;

export class CrearEnvio {
  constructor(
    private readonly envios: EnvioRepository,
    private readonly cotizador: CotizarEnvio,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async ejecutar(actor: Actor, s: SolicitudEnvio): Promise<EnvioDTO> {
    const { ruta, tipo, cotizacion } = await this.cotizador.resolver(s);
    const envio = Envio.crear(
      {
        remitente: s.remitente,
        destinatario: s.destinatario,
        rutaId: ruta.id,
        tipoCarga: tipo.codigo,
        pesoKg: s.pesoKg,
        descripcion: s.descripcion,
        costo: cotizacion.costo,
      },
      { id: this.ids.uuid(), codigo: await this.codigoUnico(), ahora: this.clock.ahora(), actor },
    );
    await this.envios.guardar(envio);
    return toEnvioDTO(envio, ruta, true);
  }

  private async codigoUnico(): Promise<string> {
    for (let i = 0; i < MAX_INTENTOS_CODIGO; i++) {
      const codigo = this.ids.codigoSeguimiento();
      if (!(await this.envios.existeCodigo(codigo))) return codigo;
    }
    throw new DomainError("CONFLICTO", "No se pudo generar un código de seguimiento único");
  }
}
