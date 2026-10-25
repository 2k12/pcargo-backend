import type { Paginacion, TalonarioRepository } from "../../../application/ports/repositories.js";
import { DomainError } from "../../../domain/shared/DomainError.js";
import { exigirGuiaDisponible, Talonario, type TalonarioProps } from "../../../domain/talonario/Talonario.js";

/**
 * Talonarios en memoria (v20). El repositorio de envíos llama a `validarUso`/`marcarUsada` al guardar un envío nuevo
 * (como la transacción de Postgres) y a `maximoNumero` para el consecutivo. Sin `await` entre lecturas y escrituras:
 * cada operación es atómica en el bucle de eventos.
 */
export class InMemoryTalonarioRepository implements TalonarioRepository {
  private readonly datos: TalonarioProps[] = [];

  /** `maximoEnvios`: mayor número de guía de los envíos guardados (0 si no hay). */
  constructor(private readonly maximoEnvios: () => number = () => 0) {}

  /** Mayor número reservado en talonarios (0 si no hay). */
  maximoNumero(): number {
    return Math.max(0, ...this.datos.map((t) => t.hasta));
  }

  private buscar(numeroGuia: number): TalonarioProps | undefined {
    return this.datos.find((t) => numeroGuia >= t.desde && numeroGuia <= t.hasta);
  }

  /** Como la comprobación de Postgres al insertar un envío (ver OpcionesGuardarEnvio.numeroGuiaIndicado). */
  validarUso(numeroGuia: number, indicado: boolean): void {
    const t = this.buscar(numeroGuia);
    if (!t) return;
    if (!indicado) throw new DomainError("CONFLICTO", `La guía ${numeroGuia} está reservada en un talonario`);
    exigirGuiaDisponible(t.guias.find((g) => g.numeroGuia === numeroGuia)!);
  }

  marcarUsada(numeroGuia: number, envioId: string, fecha: Date): void {
    const t = this.buscar(numeroGuia);
    const g = t?.guias.find((x) => x.numeroGuia === numeroGuia);
    if (g) Object.assign(g, { estado: "USADA", envioId, actualizadoEn: new Date(fecha) });
  }

  private leer(t: TalonarioProps): Talonario {
    return Talonario.reconstruir(structuredClone(t));
  }

  async reservar(fabricar: (desde: number) => Talonario): Promise<Talonario> {
    const desde = Math.max(this.maximoEnvios(), this.maximoNumero()) + 1;
    const t = fabricar(desde);
    this.datos.push(structuredClone(t.toSnapshot()));
    return this.leer(t.toSnapshot());
  }

  async listar(
    filtro: { abiertos?: boolean },
    { pagina, porPagina }: Paginacion,
  ): Promise<{ talonarios: Talonario[]; total: number }> {
    const filtrados = this.datos
      .filter((t) => !filtro.abiertos || t.guias.some((g) => g.estado === "DISPONIBLE"))
      .sort((a, b) => b.creadoEn.getTime() - a.creadoEn.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const desde = (pagina - 1) * porPagina;
    return { talonarios: filtrados.slice(desde, desde + porPagina).map((t) => this.leer(t)), total: filtrados.length };
  }

  async buscarPorId(id: string): Promise<Talonario | null> {
    const t = this.datos.find((x) => x.id === id);
    return t ? this.leer(t) : null;
  }

  async buscarPorNumeroGuia(numeroGuia: number): Promise<Talonario | null> {
    const t = this.buscar(numeroGuia);
    return t ? this.leer(t) : null;
  }

  async modificar(id: string, cambio: (t: Talonario) => void): Promise<Talonario> {
    const i = this.datos.findIndex((x) => x.id === id);
    if (i < 0) throw new DomainError("NO_ENCONTRADO", "Talonario no encontrado");
    const t = this.leer(this.datos[i]!);
    cambio(t);
    this.datos[i] = structuredClone(t.toSnapshot());
    return this.leer(this.datos[i]!);
  }
}
