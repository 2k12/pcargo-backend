import {
  accionDeCambios,
  aTipoCargaPublico,
  diferenciasTipoCarga,
  exigirAlgunoActivo,
  normalizarDatosTipoCarga,
  validarCodigoTipoCarga,
  type AccionTipoCarga,
  type CambioCampo,
  type CambioTipoCarga,
  type DatosTipoCarga,
  type TipoCarga,
  type TipoCargaCodigo,
  type TipoCargaPublico,
} from "../../../domain/carga/TipoCarga.js";
import { exigirMismoConjunto } from "../../../domain/catalogo/ArticuloRestringido.js";
import { DomainError } from "../../../domain/shared/DomainError.js";
import type { Actor } from "../../../domain/usuario/Usuario.js";
import type { EnvioRepository, Paginacion, TipoCargaRepository } from "../../ports/repositories.js";
import type { Clock, IdGenerator } from "../../ports/services.js";
import { POR_PAGINA_DEFECTO, POR_PAGINA_MAX, type PaginaDTO } from "../envios/ConsultasEnvio.js";

// Catálogo configurable de tipos de carga (contrato v11). Lectura: cualquier usuario (solo activos);
// administración e inactivos: solo ADMIN. Cada escritura deja una entrada en el historial.

export interface TipoCargaDTO extends TipoCargaPublico {
  activo: boolean;
  orden: number;
  actualizadoEn: string | null;
  actualizadoPor: string | null;
}

export interface CambioTipoCargaDTO {
  id: string;
  codigo: string;
  fecha: string;
  usuario: string | null;
  accion: AccionTipoCarga;
  cambios: CambioCampo[];
}

export const toTipoCargaDTO = (t: TipoCarga): TipoCargaDTO => ({
  ...aTipoCargaPublico(t),
  activo: t.activo,
  orden: t.orden,
  actualizadoEn: t.actualizadoEn?.toISOString() ?? null,
  actualizadoPor: t.actualizadoPor,
});

const toCambioDTO = (c: CambioTipoCarga): CambioTipoCargaDTO => ({
  id: c.id,
  codigo: c.codigo,
  fecha: c.fecha.toISOString(),
  usuario: c.usuario,
  accion: c.accion,
  cambios: c.cambios,
});

function exigirAdmin(actor: Actor): void {
  if (actor.rol !== "ADMIN") {
    throw new DomainError("PROHIBIDO", "Solo un administrador puede gestionar los tipos de carga");
  }
}

const noEncontrado = (codigo: string) => new DomainError("NO_ENCONTRADO", `No existe el tipo de carga ${codigo}`);

interface Deps {
  tipos: TipoCargaRepository;
  ids: IdGenerator;
  clock: Clock;
}

const cambio = (d: Deps, actor: Actor, codigo: string, fecha: Date, accion: AccionTipoCarga, cambios: CambioCampo[]): CambioTipoCarga => ({
  id: d.ids.uuid(),
  codigo,
  fecha,
  usuarioId: actor.id,
  usuario: actor.nombre,
  accion,
  cambios,
});

/** Lectura del catálogo sin permisos (la composición la envuelve con caché). `todos` incluye los inactivos. */
export class LeerTiposCarga {
  constructor(private readonly tipos: TipoCargaRepository) {}

  async ejecutar(todos: boolean): Promise<TipoCargaDTO[]> {
    return (await this.tipos.listar(todos ? {} : { activos: true })).map(toTipoCargaDTO);
  }
}

export class ListarTiposCarga {
  constructor(private readonly lector: Pick<LeerTiposCarga, "ejecutar">) {}

  /** Por defecto solo los activos; `todos` (solo ADMIN) incluye los inactivos. */
  async ejecutar(actor: Actor, opciones: { todos?: boolean } = {}): Promise<TipoCargaDTO[]> {
    if (opciones.todos) exigirAdmin(actor);
    return this.lector.ejecutar(opciones.todos === true);
  }
}

export type NuevoTipoCarga = DatosTipoCarga & { codigo: string };

export class CrearTipoCarga {
  constructor(private readonly d: Deps) {}

  async ejecutar(actor: Actor, datos: NuevoTipoCarga): Promise<TipoCargaDTO> {
    exigirAdmin(actor);
    const codigo = validarCodigoTipoCarga(datos.codigo);
    const limpios = normalizarDatosTipoCarga(datos);
    if (await this.d.tipos.buscarPorCodigo(codigo)) {
      throw new DomainError("CONFLICTO", `Ya existe un tipo de carga con el código ${codigo}`);
    }
    if (await this.d.tipos.existeNombre(limpios.nombre)) {
      throw new DomainError("CONFLICTO", `Ya existe un tipo de carga llamado ${limpios.nombre}`);
    }
    const existentes = await this.d.tipos.listar();
    const ahora = this.d.clock.ahora();
    const tipo: TipoCarga = {
      codigo,
      ...limpios,
      orden: Math.max(0, ...existentes.map((t) => t.orden)) + 1,
      actualizadoEn: ahora,
      actualizadoPor: actor.nombre,
    };
    await this.d.tipos.crear(tipo, cambio(this.d, actor, codigo, ahora, "CREADO", diferenciasTipoCarga(null, tipo)));
    return toTipoCargaDTO(tipo);
  }
}

export class ActualizarTipoCarga {
  constructor(private readonly d: Deps) {}

  async ejecutar(actor: Actor, codigo: string, cambios: Partial<DatosTipoCarga>): Promise<TipoCargaDTO> {
    exigirAdmin(actor);
    if (Object.values(cambios).every((v) => v === undefined)) {
      throw new DomainError("VALIDACION", "Debe enviar al menos un campo");
    }
    if ("codigo" in cambios) throw new DomainError("VALIDACION", "El código de un tipo de carga no se puede cambiar");
    const actual = await this.d.tipos.buscarPorCodigo(codigo);
    if (!actual) throw noEncontrado(codigo);
    // Se valida el resultado completo: p. ej. bajar el precio por debajo del de mayoreo no se admite.
    const limpios = normalizarDatosTipoCarga({
      nombre: cambios.nombre ?? actual.nombre,
      precio: cambios.precio ?? actual.precio,
      precioRural: cambios.precioRural === undefined ? actual.precioRural : cambios.precioRural,
      mayoreo: cambios.mayoreo === undefined ? actual.mayoreo : cambios.mayoreo,
      pesoMaxKg: cambios.pesoMaxKg ?? actual.pesoMaxKg,
      activo: cambios.activo ?? actual.activo,
    });
    const propuesto: TipoCarga = { ...actual, ...limpios };
    const diferencias = diferenciasTipoCarga(actual, propuesto);
    if (diferencias.length === 0) return toTipoCargaDTO(actual);

    if (limpios.nombre !== actual.nombre && (await this.d.tipos.existeNombre(limpios.nombre, codigo))) {
      throw new DomainError("CONFLICTO", `Ya existe un tipo de carga llamado ${limpios.nombre}`);
    }
    if (!propuesto.activo) {
      const tipos = await this.d.tipos.listar();
      exigirAlgunoActivo(tipos.map((t) => (t.codigo === codigo ? propuesto : t)));
    }
    const ahora = this.d.clock.ahora();
    const nuevo: TipoCarga = { ...propuesto, actualizadoEn: ahora, actualizadoPor: actor.nombre };
    await this.d.tipos.actualizar([nuevo], [cambio(this.d, actor, codigo, ahora, accionDeCambios(diferencias), diferencias)]);
    return toTipoCargaDTO(nuevo);
  }
}

export class EliminarTipoCarga {
  constructor(
    private readonly d: Deps,
    private readonly envios: EnvioRepository,
  ) {}

  /** Solo tipos que ningún envío usa (los demás se desactivan) y nunca el último activo. */
  async ejecutar(actor: Actor, codigo: string): Promise<void> {
    exigirAdmin(actor);
    const actual = await this.d.tipos.buscarPorCodigo(codigo);
    if (!actual) throw noEncontrado(codigo);
    if (await this.envios.usaTipoCarga(codigo)) {
      throw new DomainError(
        "CONFLICTO",
        `${actual.nombre} se usa en envíos registrados; desactívelo en lugar de eliminarlo para conservar el historial`,
      );
    }
    const tipos = await this.d.tipos.listar();
    exigirAlgunoActivo(tipos.filter((t) => t.codigo !== codigo));
    const ahora = this.d.clock.ahora();
    await this.d.tipos.eliminar(codigo, cambio(this.d, actor, codigo, ahora, "ELIMINADO", diferenciasTipoCarga(actual, null)));
  }
}

export class ReordenarTiposCarga {
  constructor(private readonly d: Deps) {}

  /** Reasigna el orden en bloque (1, 2, 3, …). `codigos` debe traer todos los códigos, sin repetir. */
  async ejecutar(actor: Actor, codigos: TipoCargaCodigo[]): Promise<TipoCargaDTO[]> {
    exigirAdmin(actor);
    const tipos = await this.d.tipos.listar();
    exigirMismoConjunto(codigos, tipos.map((t) => t.codigo), "códigos de tipo de carga");
    const porCodigo = new Map(tipos.map((t) => [t.codigo, t]));
    const ahora = this.d.clock.ahora();
    const cambiados: TipoCarga[] = [];
    const historial: CambioTipoCarga[] = [];
    const resultado = codigos.map((c, i) => {
      const actual = porCodigo.get(c)!;
      if (actual.orden === i + 1) return actual;
      const nuevo: TipoCarga = { ...actual, orden: i + 1, actualizadoEn: ahora, actualizadoPor: actor.nombre };
      cambiados.push(nuevo);
      historial.push(cambio(this.d, actor, c, ahora, "MODIFICADO", diferenciasTipoCarga(actual, nuevo)));
      return nuevo;
    });
    if (cambiados.length > 0) await this.d.tipos.actualizar(cambiados, historial);
    return resultado.map(toTipoCargaDTO);
  }
}

export class ListarHistorialTiposCarga {
  constructor(private readonly tipos: TipoCargaRepository) {}

  async ejecutar(
    actor: Actor,
    filtro: { codigo?: string } = {},
    paginacion: Partial<Paginacion> = {},
  ): Promise<PaginaDTO<CambioTipoCargaDTO>> {
    exigirAdmin(actor);
    const porPagina = Math.min(Math.max(1, Math.trunc(paginacion.porPagina ?? POR_PAGINA_DEFECTO)), POR_PAGINA_MAX);
    const pagina = Math.max(1, Math.trunc(paginacion.pagina ?? 1));
    const codigo = filtro.codigo?.trim() || undefined;
    const { cambios, total } = await this.tipos.listarHistorial({ codigo }, { pagina, porPagina });
    return { datos: cambios.map(toCambioDTO), pagina, porPagina, total, totalPaginas: Math.ceil(total / porPagina) };
  }
}
