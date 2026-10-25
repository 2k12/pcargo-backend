import {
  claveEvidencia,
  validarFotoEvidencia,
  type FotoEvidencia,
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

/** v19: por partes; al menos uno de los dos (si no, 400 VALIDACION). Lo que no se envía se conserva. */
export interface SolicitudEvidencia {
  /** Contenido del archivo subido (`null` si no se adjuntó). */
  foto: Uint8Array | null;
  /** Nombre de quien recibió (`null`/ausente si no se envió). */
  recibidoPor?: string | null;
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
 * Registra o edita la evidencia de entrega de un envío ENTREGADO (v19: por partes). Si viene foto, la guarda en el
 * almacén privado y borra la anterior; si viene nombre, lo reemplaza. Lo que no se envía se conserva.
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
    let foto: FotoEvidencia | null = null;
    if (s.foto !== null) {
      const tipo = validarFotoEvidencia(s.foto);
      foto = { tipo, bytes: s.foto.length, clave: claveEvidencia(envio.id, this.ids.uuid(), tipo) };
    }

    // Valida datos y estado antes de tocar el almacén: registrarEvidencia lanza VALIDACION/ESTADO_INVALIDO.
    const anterior = envio.registrarEvidencia(
      { recibidoPor: s.recibidoPor ?? null, foto },
      { ahora: this.clock.ahora(), actor },
    );
    const ruta = (await this.rutas.buscarPorId(envio.rutaId)) ?? undefined;
    const webhooks = (await this.webhooks?.entregasPara(envio, ruta, "envio.evidencia_registrada")) ?? [];
    if (foto) await this.almacen.guardar(foto.clave, s.foto!, foto.tipo);
    try {
      await this.envios.guardar(envio, { webhooks });
    } catch (e) {
      if (foto) await eliminarSinFallar(this.almacen, foto.clave); // sin metadatos la foto nueva quedaría huérfana
      throw e;
    }
    // Solo se borra la foto anterior si se reemplazó.
    if (foto && anterior?.clave && anterior.clave !== foto.clave) await eliminarSinFallar(this.almacen, anterior.clave);
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
    // v19: puede haber solo nombre; sin foto → 404.
    if (!evidencia?.clave || !evidencia.tipo) {
      throw new DomainError("NO_ENCONTRADO", "El envío no tiene foto de evidencia de entrega");
    }
    const bytes = await this.almacen.obtener(evidencia.clave);
    if (!bytes) {
      console.error(`Falta en el almacén la evidencia ${evidencia.clave} del envío ${envio.id}`);
      throw new DomainError("NO_ENCONTRADO", "No se encontró la foto de la evidencia");
    }
    return { bytes, tipo: evidencia.tipo };
  }
}
