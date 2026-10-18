import type { TipoCargaCodigo } from "../carga/TipoCarga.js";
import { validarReferenciaExterna } from "../integracion/EnvioExterno.js";
import type { OrigenEnvio } from "../integracion/Integracion.js";
import { DomainError, redondear2 } from "../shared/DomainError.js";
import { ZONA_POR_DEFECTO, type Zona } from "../tarifa/Zona.js";
import type { Actor } from "../usuario/Usuario.js";
import {
  esFinal,
  esResultadoEntrega,
  puedeTransicionar,
  REQUIEREN_NOTA,
  type EstadoEnvio,
  type ResultadoEntrega,
} from "./EstadoEnvio.js";
import { normalizarRecibidoPor, type EvidenciaEntrega, type TipoImagen } from "./Evidencia.js";
import type { FormaPago } from "./FormaPago.js";

export interface Contacto {
  nombre: string;
  telefono: string;
}

/** Remitente: la dirección es opcional (sale en la guía imprimible). */
export interface Remitente extends Contacto {
  direccion?: string | null;
}

export const MAX_DIRECCION_REMITENTE = 200;

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
  remitente: { nombre: string; telefono: string; direccion: string | null };
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
  /** Foto de la guía firmada y nombre de quien recibió (solo en ENTREGADO). */
  evidencia?: EvidenciaEntrega | null;
  /** Integración (empresa) que ingresó el envío por la API; null/undefined = panel. */
  integracionId?: string | null;
  /** Nombre actual de la integración (lo resuelve el repositorio al leer). */
  integracionNombre?: string | null;
  /** Número de pedido de la empresa (solo canal API; único por integración). */
  referenciaExterna?: string | null;
  /** Repartidor asignado (v12); el nombre lo resuelve el repositorio al leer. */
  repartidor?: { id: string; nombre: string } | null;
  asignadoEn?: Date | null;
  /** Cuándo se eliminaron sus datos personales (retención o solicitud del titular, v12). */
  anonimizadoEn?: Date | null;
}

/** Texto que reemplaza los nombres (y la dirección de entrega, obligatoria) al anonimizar. */
export const ANONIMIZADO = "Anonimizado";

export interface NuevoEnvio {
  remitente: Remitente;
  destinatario: Destinatario;
  rutaId: number;
  /** Ítems ya cotizados (costo unitario y subtotal calculados por la tarifa). */
  items: ItemEnvio[];
  formaPago: FormaPago;
  descripcion?: string | null;
  clienteId?: string | null;
  /** Por defecto URBANA. */
  zona?: Zona;
  /** Envío ingresado por la API de una empresa: exige `referenciaExterna`. */
  integracion?: { id: string; nombre: string } | null;
  referenciaExterna?: string | null;
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

  /**
   * `actor` null = sin operador (envío ingresado por la API de una empresa). `notaRegistro` es la nota del evento
   * REGISTRADO (p. ej. "Ingresado por API: Tienda X").
   */
  static crear(
    datos: NuevoEnvio,
    ctx: { id: string; numeroGuia: number; ahora: Date; actor: Actor | null; notaRegistro?: string | null },
  ): Envio {
    validarContacto(datos.remitente, "remitente");
    validarContacto(datos.destinatario, "destinatario");
    if (!datos.destinatario.direccion?.trim()) {
      throw new DomainError("VALIDACION", "La dirección de entrega es obligatoria");
    }
    const direccionRemitente = datos.remitente.direccion?.trim() || null;
    if (direccionRemitente && direccionRemitente.length > MAX_DIRECCION_REMITENTE) {
      throw new DomainError("VALIDACION", `La dirección del remitente admite hasta ${MAX_DIRECCION_REMITENTE} caracteres`);
    }
    if (datos.items.length === 0) throw new DomainError("VALIDACION", "El envío debe tener al menos un ítem");
    const integracion = datos.integracion ?? null;
    const referenciaExterna = integracion ? validarReferenciaExterna(datos.referenciaExterna) : null;
    if (!integracion && datos.referenciaExterna) {
      throw new DomainError("VALIDACION", "La referencia externa solo aplica a envíos ingresados por API");
    }
    const usuario = ctx.actor ? { id: ctx.actor.id, nombre: ctx.actor.nombre } : null;
    return new Envio({
      id: ctx.id,
      numeroGuia: ctx.numeroGuia,
      clienteId: datos.clienteId ?? null,
      remitente: {
        nombre: datos.remitente.nombre.trim(),
        telefono: datos.remitente.telefono.trim(),
        direccion: direccionRemitente,
      },
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
      creadoPor: ctx.actor?.id ?? null,
      creadoEn: ctx.ahora,
      actualizadoEn: ctx.ahora,
      historial: [{ estado: "REGISTRADO", nota: ctx.notaRegistro?.trim() || null, fecha: ctx.ahora, usuario }],
      evidencia: null,
      integracionId: integracion?.id ?? null,
      integracionNombre: integracion?.nombre ?? null,
      referenciaExterna,
      repartidor: null,
      asignadoEn: null,
      anonimizadoEn: null,
    });
  }

  static reconstruir(props: EnvioProps): Envio {
    return new Envio({
      ...props,
      remitente: { ...props.remitente, direccion: props.remitente.direccion ?? null },
      items: [...props.items],
      historial: [...props.historial],
      evidencia: props.evidencia ? { ...props.evidencia } : null,
      repartidor: props.repartidor ? { ...props.repartidor } : null,
      asignadoEn: props.asignadoEn ?? null,
      anonimizadoEn: props.anonimizadoEn ?? null,
    });
  }

  /**
   * Asigna (o quita, con null) el repartidor. No agrega eventos al historial ni cambia `actualizadoEn`.
   * Un envío en estado final no se asigna → ESTADO_INVALIDO.
   */
  asignarRepartidor(repartidor: { id: string; nombre: string } | null, ahora: Date): void {
    if (esFinal(this.props.estado)) {
      throw new DomainError(
        "ESTADO_INVALIDO",
        `La guía ${this.props.numeroGuia} está ${this.props.estado}: no se puede asignar a un repartidor`,
      );
    }
    this.props.repartidor = repartidor ? { ...repartidor } : null;
    this.props.asignadoEn = repartidor ? ahora : null;
  }

  /**
   * Elimina los datos personales (LOPDP): nombres, teléfonos y direcciones, descripción, notas del historial y
   * evidencia. Conserva guía, ruta, ítems, costos, forma de pago, estados y fechas. Solo en estado final.
   * Devuelve la evidencia que tenía (su foto debe borrarse del almacén); idempotente.
   */
  anonimizar(ahora: Date): EvidenciaEntrega | null {
    if (!esFinal(this.props.estado)) {
      throw new DomainError("ESTADO_INVALIDO", "Solo se anonimizan envíos terminados (ENTREGADO o CANCELADO)");
    }
    const evidencia = this.props.evidencia ?? null;
    this.props.remitente = { nombre: ANONIMIZADO, telefono: "", direccion: null };
    this.props.destinatario = { nombre: ANONIMIZADO, telefono: "", direccion: ANONIMIZADO };
    this.props.descripcion = null;
    this.props.historial = this.props.historial.map((ev) => ({ ...ev, nota: null }));
    this.props.evidencia = null;
    this.props.anonimizadoEn ??= ahora;
    return evidencia;
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

  /**
   * Registra (o reemplaza) la evidencia de entrega. Solo se admite en ENTREGADO.
   * Devuelve la evidencia anterior, cuya foto debe borrarse del almacén.
   */
  registrarEvidencia(
    datos: { recibidoPor: string; tipo: TipoImagen; bytes: number; clave: string },
    ctx: { ahora: Date; actor: Actor },
  ): EvidenciaEntrega | null {
    const recibidoPor = normalizarRecibidoPor(datos.recibidoPor);
    if (this.props.anonimizadoEn) {
      throw new DomainError("ESTADO_INVALIDO", "Los datos personales de este envío ya se eliminaron");
    }
    if (this.props.estado !== "ENTREGADO") {
      throw new DomainError(
        "ESTADO_INVALIDO",
        `Solo se puede registrar la evidencia de un envío ENTREGADO (está ${this.props.estado})`,
      );
    }
    const anterior = this.props.evidencia ?? null;
    this.props.evidencia = {
      recibidoPor,
      tipo: datos.tipo,
      bytes: datos.bytes,
      clave: datos.clave,
      subidaEn: ctx.ahora,
      subidaPor: { id: ctx.actor.id, nombre: ctx.actor.nombre },
    };
    this.props.actualizadoEn = ctx.ahora;
    return anterior;
  }

  /** Canal por el que ingresó: PANEL o API (+ integración). */
  get origen(): OrigenEnvio {
    const id = this.props.integracionId ?? null;
    return id
      ? { canal: "API", integracionId: id, integracion: this.props.integracionNombre ?? null }
      : { canal: "PANEL", integracionId: null, integracion: null };
  }

  get integracionId(): string | null {
    return this.props.integracionId ?? null;
  }

  get referenciaExterna(): string | null {
    return this.props.referenciaExterna ?? null;
  }

  get repartidor(): { id: string; nombre: string } | null {
    return this.props.repartidor ? { ...this.props.repartidor } : null;
  }

  get asignadoEn(): Date | null {
    return this.props.asignadoEn ?? null;
  }

  get anonimizadoEn(): Date | null {
    return this.props.anonimizadoEn ?? null;
  }

  get formaPago(): FormaPago {
    return this.props.formaPago;
  }

  get costo(): number {
    return this.props.costo;
  }

  get actualizadoEn(): Date {
    return this.props.actualizadoEn;
  }

  get evidencia(): EvidenciaEntrega | null {
    return this.props.evidencia ? { ...this.props.evidencia } : null;
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
    return {
      ...this.props,
      remitente: { ...this.props.remitente },
      items: [...this.props.items],
      historial: [...this.props.historial],
      evidencia: this.props.evidencia ? { ...this.props.evidencia } : null,
      repartidor: this.props.repartidor ? { ...this.props.repartidor } : null,
    };
  }
}
