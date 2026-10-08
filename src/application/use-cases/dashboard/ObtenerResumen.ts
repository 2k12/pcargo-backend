import { TIPOS_CARGA, type TipoCargaCodigo } from "../../../domain/carga/TipoCarga.js";
import { ESTADOS, type EstadoEnvio } from "../../../domain/envio/EstadoEnvio.js";
import { FORMAS_PAGO, type FormaPago } from "../../../domain/envio/FormaPago.js";
import { nombreRuta } from "../../../domain/ruta/Ruta.js";
import { redondear2 } from "../../../domain/shared/DomainError.js";
import type { EnvioRepository, RutaRepository } from "../../ports/repositories.js";

export interface Resumen {
  totalEnvios: number;
  totalPiezas: number;
  /** Excluye envíos cancelados. */
  ingresos: number;
  porEstado: Record<EstadoEnvio, number>;
  porTipo: { tipoCarga: TipoCargaCodigo; piezas: number }[];
  porRuta: { ruta: string; total: number }[];
  porFormaPago: { formaPago: FormaPago; envios: number; monto: number }[];
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
    const porPago = new Map<FormaPago, { envios: number; monto: number }>(
      FORMAS_PAGO.map((f) => [f, { envios: 0, monto: 0 }]),
    );
    let ingresos = 0;
    let totalPiezas = 0;

    for (const e of envios) {
      const s = e.toSnapshot();
      porEstado[s.estado]++;
      porRuta.set(s.rutaId, (porRuta.get(s.rutaId) ?? 0) + 1);
      for (const i of s.items) porTipo.set(i.tipoCarga, (porTipo.get(i.tipoCarga) ?? 0) + i.cantidad);
      totalPiezas += e.totalPiezas;
      const pago = porPago.get(s.formaPago)!;
      pago.envios++;
      if (s.estado !== "CANCELADO") {
        ingresos += s.costo;
        pago.monto += s.costo;
      }
    }

    const nombres = new Map(rutas.map((r) => [r.id, nombreRuta(r)]));
    return {
      totalEnvios: envios.length,
      totalPiezas,
      ingresos: redondear2(ingresos),
      porEstado,
      porTipo: [...porTipo].map(([tipoCarga, piezas]) => ({ tipoCarga, piezas })),
      porRuta: [...porRuta]
        .map(([id, total]) => ({ ruta: nombres.get(id) ?? `Ruta ${id}`, total }))
        .sort((a, b) => b.total - a.total),
      porFormaPago: [...porPago].map(([formaPago, v]) => ({ formaPago, envios: v.envios, monto: redondear2(v.monto) })),
    };
  }
}
