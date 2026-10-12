import {
  compararArticulos,
  exigirMismoConjunto,
  normalizarDatosArticulo,
  type ArticuloRestringido,
  type CategoriaArticulo,
  type DatosArticulo,
  type IconoArticulo,
} from "../../../domain/catalogo/ArticuloRestringido.js";
import { DomainError } from "../../../domain/shared/DomainError.js";
import type { Actor } from "../../../domain/usuario/Usuario.js";
import type { ArticuloRestringidoRepository } from "../../ports/repositories.js";
import type { Clock, IdGenerator } from "../../ports/services.js";

// Artículos restringidos de la landing («Qué no transportamos»), contrato v11.

export interface ArticuloRestringidoDTO {
  id: string;
  categoria: CategoriaArticulo;
  titulo: string;
  detalle: string;
  icono: IconoArticulo | null;
  activo: boolean;
  orden: number;
  actualizadoEn: string;
  actualizadoPor: string | null;
}

export const toArticuloDTO = (a: ArticuloRestringido): ArticuloRestringidoDTO => ({
  id: a.id,
  categoria: a.categoria,
  titulo: a.titulo,
  detalle: a.detalle,
  icono: a.icono,
  activo: a.activo,
  orden: a.orden,
  actualizadoEn: a.actualizadoEn.toISOString(),
  actualizadoPor: a.actualizadoPor,
});

function exigirAdmin(actor: Actor): void {
  if (actor.rol !== "ADMIN") {
    throw new DomainError("PROHIBIDO", "Solo un administrador puede gestionar los artículos restringidos");
  }
}

const noEncontrado = () => new DomainError("NO_ENCONTRADO", "Artículo restringido no encontrado");

/** Siguiente orden libre al final de la categoría. */
const siguienteOrden = (todos: ArticuloRestringido[], categoria: CategoriaArticulo): number =>
  Math.max(0, ...todos.filter((a) => a.categoria === categoria).map((a) => a.orden)) + 1;

interface Deps {
  articulos: ArticuloRestringidoRepository;
  ids: IdGenerator;
  clock: Clock;
}

/** Landing (pública): solo los activos, por categoría y orden. */
export class ListarArticulosPublicos {
  constructor(private readonly articulos: ArticuloRestringidoRepository) {}

  async ejecutar(): Promise<ArticuloRestringidoDTO[]> {
    return (await this.articulos.listar({ activos: true })).sort(compararArticulos).map(toArticuloDTO);
  }
}

/** Panel (ADMIN): todos, incluidos los inactivos. */
export class ListarArticulos {
  constructor(private readonly articulos: ArticuloRestringidoRepository) {}

  async ejecutar(actor: Actor): Promise<ArticuloRestringidoDTO[]> {
    exigirAdmin(actor);
    return (await this.articulos.listar()).sort(compararArticulos).map(toArticuloDTO);
  }
}

export class CrearArticulo {
  constructor(private readonly d: Deps) {}

  async ejecutar(actor: Actor, datos: DatosArticulo): Promise<ArticuloRestringidoDTO> {
    exigirAdmin(actor);
    const limpios = normalizarDatosArticulo(datos);
    const articulo: ArticuloRestringido = {
      id: this.d.ids.uuid(),
      ...limpios,
      orden: siguienteOrden(await this.d.articulos.listar(), limpios.categoria),
      actualizadoEn: this.d.clock.ahora(),
      actualizadoPor: actor.nombre,
    };
    await this.d.articulos.crear(articulo);
    return toArticuloDTO(articulo);
  }
}

export class ActualizarArticulo {
  constructor(private readonly d: Deps) {}

  async ejecutar(actor: Actor, id: string, cambios: Partial<DatosArticulo>): Promise<ArticuloRestringidoDTO> {
    exigirAdmin(actor);
    if (Object.values(cambios).every((v) => v === undefined)) {
      throw new DomainError("VALIDACION", "Debe enviar al menos un campo");
    }
    const actual = await this.d.articulos.buscarPorId(id);
    if (!actual) throw noEncontrado();
    const categoria = cambios.categoria ?? actual.categoria;
    const limpios = normalizarDatosArticulo({
      categoria,
      titulo: cambios.titulo ?? actual.titulo,
      detalle: cambios.detalle === undefined ? actual.detalle : cambios.detalle,
      icono: cambios.icono === undefined ? actual.icono : cambios.icono,
      activo: cambios.activo ?? actual.activo,
    });
    // Al cambiar de categoría pasa al final de la nueva.
    const orden =
      categoria === actual.categoria ? actual.orden : siguienteOrden(await this.d.articulos.listar(), categoria);
    const nuevo: ArticuloRestringido = {
      ...actual,
      ...limpios,
      orden,
      actualizadoEn: this.d.clock.ahora(),
      actualizadoPor: actor.nombre,
    };
    await this.d.articulos.actualizar([nuevo]);
    return toArticuloDTO(nuevo);
  }
}

export class EliminarArticulo {
  constructor(private readonly articulos: ArticuloRestringidoRepository) {}

  async ejecutar(actor: Actor, id: string): Promise<void> {
    exigirAdmin(actor);
    if (!(await this.articulos.buscarPorId(id))) throw noEncontrado();
    await this.articulos.eliminar(id);
  }
}

export class ReordenarArticulos {
  constructor(private readonly d: Deps) {}

  /** Reasigna el orden (1, 2, 3, …) dentro de una categoría; `ids` debe traer todos los de esa categoría. */
  async ejecutar(actor: Actor, categoria: CategoriaArticulo, ids: string[]): Promise<ArticuloRestringidoDTO[]> {
    exigirAdmin(actor);
    const deCategoria = (await this.d.articulos.listar()).filter((a) => a.categoria === categoria);
    exigirMismoConjunto(ids, deCategoria.map((a) => a.id), `artículos de la categoría ${categoria}`);
    const porId = new Map(deCategoria.map((a) => [a.id, a]));
    const ahora = this.d.clock.ahora();
    const cambiados: ArticuloRestringido[] = [];
    const resultado = ids.map((id, i) => {
      const actual = porId.get(id)!;
      if (actual.orden === i + 1) return actual;
      const nuevo = { ...actual, orden: i + 1, actualizadoEn: ahora, actualizadoPor: actor.nombre };
      cambiados.push(nuevo);
      return nuevo;
    });
    if (cambiados.length > 0) await this.d.articulos.actualizar(cambiados);
    return resultado.map(toArticuloDTO);
  }
}
