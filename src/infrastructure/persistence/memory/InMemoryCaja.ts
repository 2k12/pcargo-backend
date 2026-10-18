import type { CajaRepository, FiltroCierres, Paginacion } from "../../../application/ports/repositories.js";
import type { CierreCaja, Cobro, MovimientosCaja } from "../../../domain/caja/Caja.js";
import { DomainError } from "../../../domain/shared/DomainError.js";

const porFecha = (a: { fecha: Date; id: string }, b: { fecha: Date; id: string }) =>
  a.fecha.getTime() - b.fecha.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Caja en memoria. El repositorio de envíos llama a `validar`/`aplicar` al guardar (como la transacción de Postgres). */
export class InMemoryCajaRepository implements CajaRepository {
  private cobros: Cobro[] = [];
  private readonly cierres: CierreCaja[] = [];

  /** `nombreUsuario`: nombre actual de un usuario (como el JOIN de Postgres). */
  constructor(private readonly nombreUsuario?: (id: string) => string | null) {}

  private leer(c: Cobro): Cobro {
    const copia = structuredClone(c);
    copia.usuario.nombre = this.nombreUsuario?.(c.usuario.id) ?? copia.usuario.nombre;
    return copia;
  }

  private leerCierre(c: CierreCaja): CierreCaja {
    const copia = structuredClone(c);
    copia.usuario.nombre = this.nombreUsuario?.(c.usuario.id) ?? copia.usuario.nombre;
    copia.recibidoPor.nombre = this.nombreUsuario?.(c.recibidoPor.id) ?? copia.recibidoPor.nombre;
    return copia;
  }

  /** Como la restricción única (envio_id, tipo) de Postgres: un solo cobro de cada tipo por envío. */
  validar(m: MovimientosCaja): void {
    for (const c of m.cobros) {
      const repetido =
        this.cobros.some((x) => x.envioId === c.envioId && x.tipo === c.tipo) ||
        m.cobros.filter((x) => x.envioId === c.envioId && x.tipo === c.tipo).length > 1;
      if (repetido) throw new DomainError("CONFLICTO", `El envío ya tiene un cobro ${c.tipo}`);
    }
  }

  aplicar(m: MovimientosCaja): void {
    this.cobros.push(...m.cobros.map((c) => structuredClone(c)));
    for (const a of m.anulaciones) {
      const origen = this.cobros.find((c) => c.id === a.cobroId);
      if (!origen) continue;
      // Pendiente → se anula (desaparece); ya cerrado por otro proceso → devolución.
      if (origen.cierreId === null) this.cobros = this.cobros.filter((c) => c.id !== a.cobroId);
      else this.cobros.push(structuredClone(a.siYaCerrado));
    }
  }

  async cobrosDeEnvio(envioId: string): Promise<Cobro[]> {
    return this.cobros.filter((c) => c.envioId === envioId).sort(porFecha).map((c) => this.leer(c));
  }

  async pendientes(usuarioId?: string): Promise<Cobro[]> {
    return this.cobros
      .filter((c) => c.cierreId === null && (usuarioId === undefined || c.usuario.id === usuarioId))
      .sort(porFecha)
      .map((c) => this.leer(c));
  }

  async cerrar(
    usuarioId: string,
    fabricar: (pendientes: Cobro[]) => CierreCaja,
  ): Promise<{ cierre: CierreCaja; cobros: Cobro[] }> {
    // Sin await entre la lectura y la escritura: atómico en el bucle de eventos.
    const pendientes = this.cobros.filter((c) => c.cierreId === null && c.usuario.id === usuarioId).sort(porFecha);
    const cierre = fabricar(pendientes.map((c) => this.leer(c)));
    for (const c of pendientes) c.cierreId = cierre.id;
    this.cierres.push(structuredClone(cierre));
    return { cierre: this.leerCierre(cierre), cobros: pendientes.map((c) => this.leer(c)) };
  }

  async listarCierres(
    f: FiltroCierres,
    { pagina, porPagina }: Paginacion,
  ): Promise<{ cierres: CierreCaja[]; total: number }> {
    const filtrados = this.cierres
      .filter((c) => !f.usuarioId || c.usuario.id === f.usuarioId)
      .filter((c) => !f.desde || c.fecha >= f.desde)
      .filter((c) => !f.hasta || c.fecha < f.hasta)
      .sort((a, b) => porFecha(b, a));
    const desde = (pagina - 1) * porPagina;
    return {
      cierres: filtrados.slice(desde, desde + porPagina).map((c) => this.leerCierre(c)),
      total: filtrados.length,
    };
  }

  async buscarCierre(id: string): Promise<CierreCaja | null> {
    const c = this.cierres.find((x) => x.id === id);
    return c ? this.leerCierre(c) : null;
  }

  async cobrosDeCierre(cierreId: string): Promise<Cobro[]> {
    return this.cobros.filter((c) => c.cierreId === cierreId).sort(porFecha).map((c) => this.leer(c));
  }
}
