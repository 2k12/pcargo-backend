import { MAX_DIGITOS_GUIA } from "../envio/NumeroGuia.js";
import { DomainError } from "../shared/DomainError.js";
import { fechaLocalEC } from "../shared/FechaEcuador.js";

// Talonarios de guías en blanco (contrato v20): se reserva un bloque de números consecutivos, se imprimen las guías
// vacías para llenarlas a mano en carretera y luego se registran como envíos con ese número.

export const ESTADOS_GUIA_TALONARIO = ["DISPONIBLE", "USADA", "ANULADA"] as const;
export type EstadoGuiaTalonario = (typeof ESTADOS_GUIA_TALONARIO)[number];

export const MIN_CANTIDAD_TALONARIO = 1;
export const MAX_CANTIDAD_TALONARIO = 50;
export const MAX_NOTA_TALONARIO = 120;
export const MIN_MOTIVO_ANULACION = 3;
export const MAX_MOTIVO_ANULACION = 200;
const MAXIMO_NUMERO = 10 ** MAX_DIGITOS_GUIA - 1;

export interface GuiaTalonario {
  numeroGuia: number;
  estado: EstadoGuiaTalonario;
  /** Envío registrado con este número (si USADA). */
  envioId: string | null;
  /** Por qué se anuló (si ANULADA). */
  motivo: string | null;
  /** Cuándo se usó o anuló. */
  actualizadoEn: Date | null;
}

export interface TalonarioProps {
  id: string;
  desde: number;
  hasta: number;
  nota: string | null;
  creadoEn: Date;
  /** Nombre de quien lo creó. */
  creadoPor: string | null;
  /** En orden de número, de `desde` a `hasta`. */
  guias: GuiaTalonario[];
}

/** Cantidad de guías a reservar: entero de 1 a 50. */
export function validarCantidadTalonario(valor: unknown): number {
  if (
    typeof valor !== "number" ||
    !Number.isInteger(valor) ||
    valor < MIN_CANTIDAD_TALONARIO ||
    valor > MAX_CANTIDAD_TALONARIO
  ) {
    throw new DomainError(
      "VALIDACION",
      `La cantidad de guías debe ser un entero entre ${MIN_CANTIDAD_TALONARIO} y ${MAX_CANTIDAD_TALONARIO}`,
    );
  }
  return valor;
}

/** Nota opcional (0–120 caracteres); vacía → null. */
export function validarNotaTalonario(valor: string | null | undefined): string | null {
  const nota = valor?.trim() || null;
  if (nota && nota.length > MAX_NOTA_TALONARIO) {
    throw new DomainError("VALIDACION", `La nota del talonario admite hasta ${MAX_NOTA_TALONARIO} caracteres`);
  }
  return nota;
}

/** Motivo de anulación obligatorio (3–200 caracteres). */
export function validarMotivoAnulacion(valor: string | null | undefined): string {
  const motivo = valor?.trim() ?? "";
  if (motivo.length < MIN_MOTIVO_ANULACION || motivo.length > MAX_MOTIVO_ANULACION) {
    throw new DomainError(
      "VALIDACION",
      `El motivo de la anulación debe tener entre ${MIN_MOTIVO_ANULACION} y ${MAX_MOTIVO_ANULACION} caracteres`,
    );
  }
  return motivo;
}

/**
 * ¿Se puede registrar un envío con esta guía del talonario? DISPONIBLE → sí; ANULADA → GUIA_ANULADA (422);
 * USADA → CONFLICTO (409, como cualquier número repetido).
 */
export function exigirGuiaDisponible(guia: Pick<GuiaTalonario, "numeroGuia" | "estado">): void {
  if (guia.estado === "ANULADA") {
    throw new DomainError("GUIA_ANULADA", `La guía ${guia.numeroGuia} del talonario está anulada`);
  }
  if (guia.estado === "USADA") {
    throw new DomainError("CONFLICTO", `La guía ${guia.numeroGuia} ya está registrada`);
  }
}

/** Agregado: un bloque de números de guía reservados y el estado de cada uno. */
export class Talonario {
  private constructor(private props: TalonarioProps) {}

  /** `desde` es el siguiente consecutivo calculado por el repositorio dentro de la reserva atómica. */
  static crear(
    datos: { cantidad: unknown; nota?: string | null },
    ctx: { id: string; desde: number; ahora: Date; creadoPor: string | null },
  ): Talonario {
    const cantidad = validarCantidadTalonario(datos.cantidad);
    const nota = validarNotaTalonario(datos.nota);
    if (!Number.isInteger(ctx.desde) || ctx.desde < 1) {
      throw new DomainError("VALIDACION", "El primer número del talonario debe ser un entero mayor a 0");
    }
    const hasta = ctx.desde + cantidad - 1;
    if (hasta > MAXIMO_NUMERO) {
      throw new DomainError("CONFLICTO", "No quedan números de guía disponibles para el talonario");
    }
    const guias: GuiaTalonario[] = Array.from({ length: cantidad }, (_, i) => ({
      numeroGuia: ctx.desde + i,
      estado: "DISPONIBLE",
      envioId: null,
      motivo: null,
      actualizadoEn: null,
    }));
    return new Talonario({ id: ctx.id, desde: ctx.desde, hasta, nota, creadoEn: ctx.ahora, creadoPor: ctx.creadoPor, guias });
  }

  static reconstruir(props: TalonarioProps): Talonario {
    return new Talonario({ ...props, guias: [...props.guias].sort((a, b) => a.numeroGuia - b.numeroGuia) });
  }

  get id(): string {
    return this.props.id;
  }
  get desde(): number {
    return this.props.desde;
  }
  get hasta(): number {
    return this.props.hasta;
  }
  get cantidad(): number {
    return this.props.hasta - this.props.desde + 1;
  }
  get nota(): string | null {
    return this.props.nota;
  }
  get creadoEn(): Date {
    return this.props.creadoEn;
  }
  get creadoPor(): string | null {
    return this.props.creadoPor;
  }
  get guias(): GuiaTalonario[] {
    return this.props.guias.map((g) => ({ ...g }));
  }

  private contar(estado: EstadoGuiaTalonario): number {
    return this.props.guias.filter((g) => g.estado === estado).length;
  }
  get disponibles(): number {
    return this.contar("DISPONIBLE");
  }
  get usadas(): number {
    return this.contar("USADA");
  }
  get anuladas(): number {
    return this.contar("ANULADA");
  }
  /** Con al menos una guía DISPONIBLE. */
  get abierto(): boolean {
    return this.disponibles > 0;
  }

  /** Día (Ecuador) de creación: la fecha de la guía de sus envíos puede ir desde aquí (no desde hoy). */
  get fechaMinimaGuia(): string {
    return fechaLocalEC(this.props.creadoEn);
  }

  contiene(numeroGuia: number): boolean {
    return numeroGuia >= this.props.desde && numeroGuia <= this.props.hasta;
  }

  /** Guía del talonario; NO_ENCONTRADO si el número no es de este talonario. */
  guia(numeroGuia: number): GuiaTalonario {
    const g = this.props.guias.find((x) => x.numeroGuia === numeroGuia);
    if (!g) throw new DomainError("NO_ENCONTRADO", `La guía ${numeroGuia} no es de este talonario`);
    return { ...g };
  }

  /** Solo guías DISPONIBLE (USADA o ya ANULADA → ESTADO_INVALIDO). */
  anular(numeroGuia: number, motivo: string, ahora: Date): void {
    const g = this.mutable(numeroGuia);
    const m = validarMotivoAnulacion(motivo);
    if (g.estado !== "DISPONIBLE") {
      throw new DomainError("ESTADO_INVALIDO", `La guía ${numeroGuia} está ${g.estado}: solo se anulan guías disponibles`);
    }
    Object.assign(g, { estado: "ANULADA", motivo: m, actualizadoEn: new Date(ahora) });
  }

  /** Registro de un envío con este número: DISPONIBLE → USADA. */
  usar(numeroGuia: number, envioId: string, ahora: Date): void {
    const g = this.mutable(numeroGuia);
    exigirGuiaDisponible(g);
    Object.assign(g, { estado: "USADA", envioId, actualizadoEn: new Date(ahora) });
  }

  private mutable(numeroGuia: number): GuiaTalonario {
    const g = this.props.guias.find((x) => x.numeroGuia === numeroGuia);
    if (!g) throw new DomainError("NO_ENCONTRADO", `La guía ${numeroGuia} no es de este talonario`);
    return g;
  }

  toSnapshot(): TalonarioProps {
    return { ...this.props, guias: this.guias };
  }
}
