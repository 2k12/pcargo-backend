import { DomainError } from "../../../domain/shared/DomainError.js";
import { validarDatosRuta, type Ruta } from "../../../domain/ruta/Ruta.js";
import type { Actor } from "../../../domain/usuario/Usuario.js";
import type {
  CambiosRuta,
  CiudadRepository,
  NuevaRuta,
  RutaRepository,
} from "../../ports/repositories.js";

function exigirAdmin(actor: Actor): void {
  if (actor.rol !== "ADMIN") {
    throw new DomainError("PROHIBIDO", "Solo un administrador puede gestionar rutas");
  }
}

export class ListarRutas {
  constructor(private readonly rutas: RutaRepository) {}
  ejecutar(filtro?: { activa?: boolean }): Promise<Ruta[]> {
    return this.rutas.listar(filtro);
  }
}

export class CrearRuta {
  constructor(
    private readonly rutas: RutaRepository,
    private readonly ciudades: CiudadRepository,
  ) {}

  async ejecutar(actor: Actor, datos: NuevaRuta): Promise<Ruta> {
    exigirAdmin(actor);
    validarDatosRuta(datos);
    const [origen, destino] = await Promise.all([
      this.ciudades.buscarPorId(datos.origenId),
      this.ciudades.buscarPorId(datos.destinoId),
    ]);
    if (!origen || !destino) throw new DomainError("NO_ENCONTRADO", "Ciudad de origen o destino no existe");
    if (await this.rutas.existe(datos.origenId, datos.destinoId)) {
      throw new DomainError("CONFLICTO", `La ruta ${origen.nombre} → ${destino.nombre} ya existe`);
    }
    return this.rutas.crear(datos);
  }
}

export class ActualizarRuta {
  constructor(private readonly rutas: RutaRepository) {}

  async ejecutar(actor: Actor, id: number, cambios: CambiosRuta): Promise<Ruta> {
    exigirAdmin(actor);
    validarDatosRuta(cambios);
    if (!(await this.rutas.buscarPorId(id))) throw new DomainError("NO_ENCONTRADO", "Ruta no encontrada");
    return this.rutas.actualizar(id, cambios);
  }
}
