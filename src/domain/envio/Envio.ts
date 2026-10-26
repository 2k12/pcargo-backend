import type { TipoCargaCodigo } from "../carga/TipoCarga.js";
import { validarReferenciaExterna } from "../integracion/EnvioExterno.js";
import type { OrigenEnvio } from "../integracion/Integracion.js";
import { DomainError, redondear2 } from "../shared/DomainError.js";
import { esFechaEC, fechaLocalEC, sumarDiasEC } from "../shared/FechaEcuador.js";
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
import { normalizarRecibidoPor, type EvidenciaEntrega, type FotoEvidencia } from "./Evidencia.js";
import type { FormaPago } from "./FormaPago.js";
import { parsearGuiaFisica } from "./NumeroGuia.js";

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
  /** Número de guía del sistema (único): consecutivo automático o de un talonario. */
  numeroGuia: number;
  /** v21: número de la guía física antigua (preimpresa), si la tuvo; único entre envíos. */
  guiaFisica?: number | null;
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
  /** Suma de los subtotales más `costoAdicional` (USD). */
  costo: number;
  /** Recargo acordado al crear el envío desde el panel (v15); 0 si no hubo. Ya está incluido en `costo`. */
  costoAdicional: number;
  /**
   * Fecha `AAAA-MM-DD` (Ecuador) que lleva la guía impresa y con la que se agrupan los envíos por día (v18). Al crear
   * desde el panel puede ser hoy o posterior (hasta 90 días); por defecto, hoy. Los envíos anteriores a v18 usan el
   * día de su registro.
   */
  fechaGuia: string;
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
  /** Recargo en USD (≥ 0, hasta 2 decimales, ≤ 9999.99) que se suma al costo. Por defecto 0. */
  costoAdicional?: number;
  /** v18: fecha de la guía `AAAA-MM-DD` (Ecuador), hoy..hoy+90. Vacía → hoy. */
  fechaGuia?: string | null;
  /** v21: número de la guía física antigua (solo panel). Vacío → null. */
  guiaFisica?: string | number | null;
}

/** Días hacia adelante que se admiten como fecha de la guía (v18), contados desde hoy en Ecuador. */
export const MAX_DIAS_FECHA_GUIA = 90;

/**
 * Valida la fecha de la guía respecto de `hoy` (fecha local de Ecuador): formato `AAAA-MM-DD`, no anterior a hoy y
 * como máximo hoy + 90 días. Vacía (undefined, null o "") → hoy.
 *
 * `minima` (v20): guía de un talonario, que se llenó en el camino y se registra después: se admite desde el día
 * (Ecuador) de creación del talonario en lugar de desde hoy.
 */
export function validarFechaGuia(valor: string | null | undefined, hoy: string, minima?: string): string {
  if (valor === undefined || valor === null) return hoy;
  if (typeof valor !== "string") {
    throw new DomainError("VALIDACION", "La fecha de la guía debe tener el formato AAAA-MM-DD");
  }
  const fecha = valor.trim();
  if (fecha === "") return hoy;
  if (!esFechaEC(fecha)) {
    throw new DomainError("VALIDACION", "La fecha de la guía debe ser una fecha válida con el formato AAAA-MM-DD");
  }
  if (minima !== undefined && minima < hoy) {
    if (fecha < minima) {
      throw new DomainError("VALIDACION", `La fecha de la guía no puede ser anterior al día del talonario (${minima})`);
    }
  } else if (fecha < hoy) {
    throw new DomainError("VALIDACION", `La fecha de la guía no puede ser anterior a hoy (${hoy})`);
  }
  const maxima = sumarDiasEC(hoy, MAX_DIAS_FECHA_GUIA);
  if (fecha > maxima) {
    throw new DomainError(
      "VALIDACION",
      `La fecha de la guía puede ser como máximo ${MAX_DIAS_FECHA_GUIA} días después de hoy (hasta ${maxima})`,
    );
  }
  return fecha;
}

export const MAX_COSTO_ADICIONAL = 9999.99;

/**
 * Valida el costo adicional: número finito, ≥ 0, ≤ 9999.99 y con hasta 2 decimales (tolerando la imprecisión de coma
 * flotante: 1.1 o 0.29 son válidos). Ausente → 0.
 */
export function validarCostoAdicional(valor: number | null | undefined): number {
  if (valor === undefined || valor === null) return 0;
  if (typeof valor !== "number" || !Number.isFinite(valor) || valor < 0) {
    throw new DomainError("VALIDACION", "El costo adicional debe ser un monto mayor o igual a 0");
  }
  if (valor > MAX_COSTO_ADICIONAL) {
    throw new DomainError("VALIDACION", `El costo adicional no puede superar ${MAX_COSTO_ADICIONAL}`);
  }
  const centavos = valor * 100;
  if (Math.abs(centavos - Math.round(centavos)) > 1e-6) {
    throw new DomainError("VALIDACION", "El costo adicional admite hasta 2 decimales");
  }
  return Math.round(centavos) / 100;
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
    ctx: {
      id: string;
      numeroGuia: number;
      ahora: Date;
      actor: Actor | null;
      notaRegistro?: string | null;
      /** v20: guía de talonario → la fecha de la guía puede ir desde este día (el de creación del talonario). */
      fechaGuiaMinima?: string;
    },
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
    const costoAdicional = validarCostoAdicional(datos.costoAdicional);
    const guiaFisica = parsearGuiaFisica(datos.guiaFisica);
    const fechaGuia = validarFechaGuia(datos.fechaGuia, fechaLocalEC(ctx.ahora), ctx.fechaGuiaMinima);
    const usuario = ctx.actor ? { id: ctx.actor.id, nombre: ctx.actor.nombre } : null;
    return new Envio({
      id: ctx.id,
      numeroGuia: ctx.numeroGuia,
      guiaFisica,
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
      costo: redondear2(datos.items.reduce((s, i) => s + i.subtotal, 0) + costoAdicional),
      costoAdicional,
      fechaGuia,
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

  /**
   * `costoAdicional` ausente (envíos anteriores a v15) → 0; `fechaGuia` ausente (anteriores a v18) → día (Ecuador)
   * del registro.
   */
  static reconstruir(
    props: Omit<EnvioProps, "costoAdicional" | "fechaGuia"> & { costoAdicional?: number | null; fechaGuia?: string | null },
  ): Envio {
    return new Envio({
      ...props,
      guiaFisica: props.guiaFisica ?? null,
      costoAdicional: props.costoAdicional ?? 0,
      fechaGuia: props.fechaGuia || fechaLocalEC(props.creadoEn),
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
   * Registra o edita la evidencia de entrega por partes (v19): `recibidoPor`, `foto` o ambos (al menos uno).
   * Lo que no se envía se conserva. Solo se admite en ENTREGADO.
   * Devuelve la evidencia anterior (si se reemplazó la foto, la anterior debe borrarse del almacén).
   */
  registrarEvidencia(
    datos: { recibidoPor?: string | null; foto?: FotoEvidencia | null },
    ctx: { ahora: Date; actor: Actor },
  ): EvidenciaEntrega | null {
    const tieneNombre = datos.recibidoPor !== undefined && datos.recibidoPor !== null;
    const foto = datos.foto ?? null;
    if (!tieneNombre && !foto) {
      throw new DomainError("VALIDACION", "Debe enviar la foto de la guía firmada, el nombre de quien recibió o ambos");
    }
    const recibidoPor = tieneNombre ? normalizarRecibidoPor(datos.recibidoPor) : null;
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
      recibidoPor: recibidoPor ?? anterior?.recibidoPor ?? null,
      tipo: foto ? foto.tipo : (anterior?.tipo ?? null),
      bytes: foto ? foto.bytes : (anterior?.bytes ?? null),
      clave: foto ? foto.clave : (anterior?.clave ?? null),
      subidaEn: ctx.ahora,
      subidaPor: { id: ctx.actor.id, nombre: ctx.actor.nombre },
    };
    this.props.actualizadoEn = ctx.ahora;
    return anterior ? { ...anterior } : null;
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

  get costoAdicional(): number {
    return this.props.costoAdicional;
  }

  /** Fecha de la guía `AAAA-MM-DD` (Ecuador, v18). */
  get fechaGuia(): string {
    return this.props.fechaGuia;
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
  /** v21: número de la guía física antigua, o null. */
  get guiaFisica(): number | null {
    return this.props.guiaFisica ?? null;
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
