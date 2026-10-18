import {
  claveEvidencia,
  normalizarRecibidoPor,
  validarFotoEvidencia,
  type TipoImagen,
} from "../../../domain/envio/Evidencia.js";
import type { Envio } from "../../../domain/envio/Envio.js";
import type { Ruta } from "../../../domain/ruta/Ruta.js";
import { DomainError } from "../../../domain/shared/DomainError.js";
import type { Actor } from "../../../domain/usuario/Usuario.js";
import { toEnvioDTO, type EnvioDTO } from "../../dto/EnvioDTO.js";
import type { EnvioRepository, RutaRepository } from "../../ports/repositories.js";
import type { AlmacenArchivos, Clock, IdGenerator } from "../../ports/services.js";
import type { EmisorWebhooks } from "../integraciones/EmisorWebhooks.js";

export interface SolicitudEvidencia {
  /** Contenido del archivo subido (`null` si no se adjuntó). */
  foto: Uint8Array | null;
  recibidoPor: string;
}

/** Borra sin propagar errores: un archivo huérfano no debe tumbar una operación que ya se completó. */
export async function eliminarSinFallar(almacen: AlmacenArchivos, clave: string): Promise<void> {
  try {
    await almacen.eliminar(clave);
  } catch (e) {
    console.error(`No se pudo borrar ${clave} del almacén de archivos`, e);
  }
}

/**
 * Sube (o reemplaza) la evidencia de entrega de un envío ENTREGADO: guarda la foto en el almacén privado,
 * sus metadatos en el envío y borra la foto anterior si la había.
 */
export class SubirEvidencia {
  constructor(
    private readonly envios: EnvioRepository,
    private readonly rutas: RutaRepository,
    private readonly almacen: AlmacenArchivos,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly webhooks?: EmisorWebhooks,
  ) {}

  async ejecutar(actor: Actor, envioId: string, s: SolicitudEvidencia): Promise<EnvioDTO> {
    const { envio, ruta } = await this.subir(actor, envioId, s);
    return toEnvioDTO(envio, ruta, true);
  }

  /** Lógica común del panel y de la app del repartidor (`repartidorId`: solo sus envíos asignados, si no 404). */
  async subir(
    actor: Actor,
    envioId: string,
    s: SolicitudEvidencia,
    opciones: { repartidorId?: string } = {},
  ): Promise<{ envio: Envio; ruta: Ruta | undefined }> {
    const envio = await this.envios.buscarPorId(envioId);
    if (!envio || (opciones.repartidorId !== undefined && envio.repartidor?.id !== opciones.repartidorId)) {
      throw new DomainError("NO_ENCONTRADO", "Envío no encontrado");
    }
    const tipo = validarFotoEvidencia(s.foto);
    const recibidoPor = normalizarRecibidoPor(s.recibidoPor);
    const foto = s.foto!;
    const clave = claveEvidencia(envio.id, this.ids.uuid(), tipo);

    // Valida el estado antes de tocar el almacén: registrarEvidencia lanza ESTADO_INVALIDO si no está ENTREGADO.
    const anterior = envio.registrarEvidencia(
      { recibidoPor, tipo, bytes: foto.length, clave },
      { ahora: this.clock.ahora(), actor },
    );
    const ruta = (await this.rutas.buscarPorId(envio.rutaId)) ?? undefined;
    const webhooks = (await this.webhooks?.entregasPara(envio, ruta, "envio.evidencia_registrada")) ?? [];
    await this.almacen.guardar(clave, foto, tipo);
    try {
      await this.envios.guardar(envio, { webhooks });
    } catch (e) {
      await eliminarSinFallar(this.almacen, clave); // sin metadatos la foto nueva quedaría huérfana
      throw e;
    }
    if (anterior && anterior.clave !== clave) await eliminarSinFallar(this.almacen, anterior.clave);
    return { envio, ruta };
  }
}

export interface ArchivoEvidencia {
  bytes: Uint8Array;
  tipo: TipoImagen;
}

/** Devuelve la foto de la evidencia (solo para usuarios del panel; el seguimiento público no la expone). */
export class ObtenerEvidencia {
  constructor(
    private readonly envios: EnvioRepository,
    private readonly almacen: AlmacenArchivos,
  ) {}

  async ejecutar(envioId: string): Promise<ArchivoEvidencia> {
    const envio = await this.envios.buscarPorId(envioId);
    if (!envio) throw new DomainError("NO_ENCONTRADO", "Envío no encontrado");
    const evidencia = envio.evidencia;
    if (!evidencia) throw new DomainError("NO_ENCONTRADO", "El envío no tiene evidencia de entrega");
    const bytes = await this.almacen.obtener(evidencia.clave);
    if (!bytes) {
      console.error(`Falta en el almacén la evidencia ${evidencia.clave} del envío ${envio.id}`);
      throw new DomainError("NO_ENCONTRADO", "No se encontró la foto de la evidencia");
    }
    return { bytes, tipo: evidencia.tipo };
  }
}
