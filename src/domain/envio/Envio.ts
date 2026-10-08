import type { TipoCargaCodigo } from "../carga/TipoCarga.js";
import { DomainError } from "../shared/DomainError.js";
import type { Actor } from "../usuario/Usuario.js";
import { puedeTransicionar, type EstadoEnvio } from "./EstadoEnvio.js";

export interface Contacto {
  nombre: string;
  telefono: string;
}

export interface Destinatario extends Contacto {
  direccion: string;
}

export interface EventoHistorial {
  estado: EstadoEnvio;
  nota: string | null;
  fecha: Date;
  usuario: { id: string; nombre: string } | null;
}

export interface EnvioProps {
  id: string;
  codigo: string;
  remitente: Contacto;
  destinatario: Destinatario;
  rutaId: number;
  tipoCarga: TipoCargaCodigo;
  pesoKg: number;
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
  tipoCarga: TipoCargaCodigo;
  pesoKg: number;
  descripcion?: string | null;
  costo: number;
}

const TELEFONO = /^\+?[0-9 ]{7,15}$/;

function validarContacto(c: Contacto, rol: string): void {
  if (!c.nombre?.trim()) throw new DomainError("VALIDACION", `El nombre del ${rol} es obligatorio`);
  if (!TELEFONO.test(c.telefono?.trim() ?? "")) {
    throw new DomainError("VALIDACION", `El teléfono del ${rol} no es válido`);
  }
}

/** Agregado raíz: una encomienda y su ciclo de vida. */
export class Envio {
  private constructor(private props: EnvioProps) {}

  static crear(
    datos: NuevoEnvio,
    ctx: { id: string; codigo: string; ahora: Date; actor: Actor },
  ): Envio {
    validarContacto(datos.remitente, "remitente");
    validarContacto(datos.destinatario, "destinatario");
    if (!datos.destinatario.direccion?.trim()) {
      throw new DomainError("VALIDACION", "La dirección de entrega es obligatoria");
    }
    const usuario = { id: ctx.actor.id, nombre: ctx.actor.nombre };
    return new Envio({
      id: ctx.id,
      codigo: ctx.codigo,
      remitente: { nombre: datos.remitente.nombre.trim(), telefono: datos.remitente.telefono.trim() },
      destinatario: {
        nombre: datos.destinatario.nombre.trim(),
        telefono: datos.destinatario.telefono.trim(),
        direccion: datos.destinatario.direccion.trim(),
      },
      rutaId: datos.rutaId,
      tipoCarga: datos.tipoCarga,
      pesoKg: datos.pesoKg,
      descripcion: datos.descripcion?.trim() || null,
      costo: datos.costo,
      estado: "REGISTRADO",
      creadoPor: ctx.actor.id,
      creadoEn: ctx.ahora,
      actualizadoEn: ctx.ahora,
      historial: [{ estado: "REGISTRADO", nota: null, fecha: ctx.ahora, usuario }],
    });
  }

  static reconstruir(props: EnvioProps): Envio {
    return new Envio({ ...props, historial: [...props.historial] });
  }

  cambiarEstado(nuevo: EstadoEnvio, ctx: { ahora: Date; actor: Actor; nota?: string | null }): void {
    if (!puedeTransicionar(this.props.estado, nuevo)) {
      throw new DomainError(
        "TRANSICION_INVALIDA",
        `No se puede pasar de ${this.props.estado} a ${nuevo}`,
      );
    }
    this.props.estado = nuevo;
    this.props.actualizadoEn = ctx.ahora;
    this.props.historial.push({
      estado: nuevo,
      nota: ctx.nota?.trim() || null,
      fecha: ctx.ahora,
      usuario: { id: ctx.actor.id, nombre: ctx.actor.nombre },
    });
  }

  get id(): string {
    return this.props.id;
  }
  get codigo(): string {
    return this.props.codigo;
  }
  get estado(): EstadoEnvio {
    return this.props.estado;
  }
  get rutaId(): number {
    return this.props.rutaId;
  }
  get historial(): readonly EventoHistorial[] {
    return this.props.historial;
  }

  toSnapshot(): EnvioProps {
    return { ...this.props, historial: [...this.props.historial] };
  }
}
