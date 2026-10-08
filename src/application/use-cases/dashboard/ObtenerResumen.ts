import { TIPOS_CARGA, type TipoCargaCodigo } from "../../../domain/carga/TipoCarga.js";
import { ESTADOS, type EstadoEnvio } from "../../../domain/envio/EstadoEnvio.js";
import { nombreRuta } from "../../../domain/ruta/Ruta.js";
import { redondear2 } from "../../../domain/shared/DomainError.js";
import type { EnvioRepository, RutaRepository } from "../../ports/repositories.js";

export interface Resumen {
  totalEnvios: number;
  ingresos: number;
  porEstado: Record<EstadoEnvio, number>;
  porTipo: { tipoCarga: TipoCargaCodigo; total: number }[];
  porRuta: { ruta: string; total: number }[];
}

export class ObtenerResumen {
  constructor(
    private readonly envios: EnvioRepository,
    private readonly rutas: RutaRepository,
  ) {}

  async ejecutar(): Promise<Resumen> {
    const [envios, rutas] = await Promise.all([this.envios.listar(), this.rutas.listar()]);
    const porEstado = Object.fromEntries(ESTADOS.map((e) => [e, 0])) as Record<EstadoEnvio, number>;
    const porTipo = new Map<TipoCargaCodigo, number>(TIPOS_CARGA.map((t) => [t, 0]));
    const porRuta = new Map<number, number>();
    let ingresos = 0;

    for (const e of envios) {
      const s = e.toSnapshot();
      porEstado[s.estado]++;
      porTipo.set(s.tipoCarga, (porTipo.get(s.tipoCarga) ?? 0) + 1);
      porRuta.set(s.rutaId, (porRuta.get(s.rutaId) ?? 0) + 1);
      if (s.estado !== "CANCELADO") ingresos += s.costo;
    }

    const nombres = new Map(rutas.map((r) => [r.id, nombreRuta(r)]));
    return {
      totalEnvios: envios.length,
      ingresos: redondear2(ingresos),
      porEstado,
      porTipo: [...porTipo].map(([tipoCarga, total]) => ({ tipoCarga, total })),
      porRuta: [...porRuta]
        .map(([id, total]) => ({ ruta: nombres.get(id) ?? `Ruta ${id}`, total }))
        .sort((a, b) => b.total - a.total),
    };
  }
}
