import type { TipoCargaCodigo } from "../carga/TipoCarga.js";
import { DomainError, redondear2 } from "../shared/DomainError.js";
import { ZONA_POR_DEFECTO, type Zona } from "../tarifa/Zona.js";
import type { Actor } from "../usuario/Usuario.js";
import {
  esResultadoEntrega,
  puedeTransicionar,
  REQUIEREN_NOTA,
  type EstadoEnvio,
  type ResultadoEntrega,
} from "./EstadoEnvio.js";
import type { FormaPago } from "./FormaPago.js";

export interface Contacto {
  nombre: string;
  telefono: string;
}

export interface Destinatario extends Contacto {
  direccion: string;
}

export interface ItemEnvio {
  tipoCarga: TipoCargaCodigo;
  cantidad: number;
  /** Peso por unidad. */
  pesoKg: number;
  costoUnitario: number;
  subtotal: number;
}

export interface EventoHistorial {
  estado: EstadoEnvio;
  nota: string | null;
  fecha: Date;
  usuario: { id: string; nombre: string } | null;
}

export interface Gestion {
  fecha: Date;
  operador: string | null;
}

export interface GestionEntrega extends Gestion {
  resultado: ResultadoEntrega;
  nota: string | null;
}

export interface EnvioProps {
  id: string;
  /** Número de la guía física (único). */
  numeroGuia: number;
  /** Cliente frecuente que envía (y normalmente paga); null si es ocasional. */
  clienteId?: string | null;
  remitente: Contacto;
  destinatario: Destinatario;
  rutaId: number;
  items: ItemEnvio[];
  /** Zona de entrega con la que se cotizó (los envíos anteriores a v8 son URBANA). */
  zona: Zona;
  formaPago: FormaPago;
  descripcion: string | null;
  costo: number;
  estado: EstadoEnvio;
  creadoPor: string | null;
  creadoEn: Date;
  actualizadoEn: Date;
  historial: EventoHistorial[];
}

export interface NuevoEnvio {
  remitente: Contacto;
  destinatario: Destinatario;
  rutaId: number;
  /** Ítems ya cotizados (costo unitario y subtotal calculados por la tarifa). */
  items: ItemEnvio[];
  formaPago: FormaPago;
  descripcion?: string | null;
  clienteId?: string | null;
  /** Por defecto URBANA. */
  zona?: Zona;
}

const TELEFONO = /^\+?[0-9 ]{7,15}$/;

function validarContacto(c: Contacto, rol: string): void {
  if (!c.nombre?.trim()) throw new DomainError("VALIDACION", `El nombre del ${rol} es obligatorio`);
  if (!TELEFONO.test(c.telefono?.trim() ?? "")) {
    throw new DomainError("VALIDACION", `El teléfono del ${rol} no es válido`);
  }
}

/** Agregado raíz: una encomienda (una o varias piezas) y su ciclo de vida. */
export class Envio {
  private constructor(private props: EnvioProps) {}

  static crear(datos: NuevoEnvio, ctx: { id: string; numeroGuia: number; ahora: Date; actor: Actor }): Envio {
    validarContacto(datos.remitente, "remitente");
    validarContacto(datos.destinatario, "destinatario");
    if (!datos.destinatario.direccion?.trim()) {
      throw new DomainError("VALIDACION", "La dirección de entrega es obligatoria");
    }
    if (datos.items.length === 0) throw new DomainError("VALIDACION", "El envío debe tener al menos un ítem");
    const usuario = { id: ctx.actor.id, nombre: ctx.actor.nombre };
    return new Envio({
      id: ctx.id,
      numeroGuia: ctx.numeroGuia,
      clienteId: datos.clienteId ?? null,
      remitente: { nombre: datos.remitente.nombre.trim(), telefono: datos.remitente.telefono.trim() },
      destinatario: {
        nombre: datos.destinatario.nombre.trim(),
        telefono: datos.destinatario.telefono.trim(),
        direccion: datos.destinatario.direccion.trim(),
      },
      rutaId: datos.rutaId,
      items: datos.items.map((i) => ({ ...i })),
      zona: datos.zona ?? ZONA_POR_DEFECTO,
      formaPago: datos.formaPago,
      descripcion: datos.descripcion?.trim() || null,
      costo: redondear2(datos.items.reduce((s, i) => s + i.subtotal, 0)),
      estado: "REGISTRADO",
      creadoPor: ctx.actor.id,
      creadoEn: ctx.ahora,
      actualizadoEn: ctx.ahora,
      historial: [{ estado: "REGISTRADO", nota: null, fecha: ctx.ahora, usuario }],
    });
  }

  static reconstruir(props: EnvioProps): Envio {
    return new Envio({ ...props, items: [...props.items], historial: [...props.historial] });
  }

  cambiarEstado(nuevo: EstadoEnvio, ctx: { ahora: Date; actor: Actor; nota?: string | null }): void {
    if (!puedeTransicionar(this.props.estado, nuevo)) {
      throw new DomainError("TRANSICION_INVALIDA", `No se puede pasar de ${this.props.estado} a ${nuevo}`);
    }
    const nota = ctx.nota?.trim() || null;
    if (REQUIEREN_NOTA.includes(nuevo) && !nota) {
      throw new DomainError("VALIDACION", `Debe indicar el motivo para marcar ${nuevo}`);
    }
    this.props.estado = nuevo;
    this.props.actualizadoEn = ctx.ahora;
    this.props.historial.push({
      estado: nuevo,
      nota,
      fecha: ctx.ahora,
      usuario: { id: ctx.actor.id, nombre: ctx.actor.nombre },
    });
  }

  get id(): string {
    return this.props.id;
  }
  get numeroGuia(): number {
    return this.props.numeroGuia;
  }
  get estado(): EstadoEnvio {
    return this.props.estado;
  }
  get clienteId(): string | null {
    return this.props.clienteId ?? null;
  }
  get zona(): Zona {
    return this.props.zona;
  }
  get rutaId(): number {
    return this.props.rutaId;
  }
  get historial(): readonly EventoHistorial[] {
    return this.props.historial;
  }
  get totalPiezas(): number {
    return this.props.items.reduce((s, i) => s + i.cantidad, 0);
  }
  get pesoTotalKg(): number {
    return redondear2(this.props.items.reduce((s, i) => s + i.pesoKg * i.cantidad, 0));
  }

  /** Fecha y operador del registro (creación) del envío. */
  get registro(): Gestion {
    const ev = this.props.historial[0];
    return { fecha: this.props.creadoEn, operador: ev?.usuario?.nombre ?? null };
  }

  /** Última gestión de entrega (ENTREGADO / NO_ENTREGADO / NOVEDAD), o null si aún no hubo intento. */
  get ultimaGestionEntrega(): GestionEntrega | null {
    for (let i = this.props.historial.length - 1; i >= 0; i--) {
      const ev = this.props.historial[i]!;
      if (esResultadoEntrega(ev.estado)) {
        return { resultado: ev.estado, fecha: ev.fecha, operador: ev.usuario?.nombre ?? null, nota: ev.nota };
      }
    }
    return null;
  }

  toSnapshot(): EnvioProps {
    return { ...this.props, items: [...this.props.items], historial: [...this.props.historial] };
  }
}
