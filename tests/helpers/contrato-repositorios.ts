import { beforeEach, describe, expect, it } from "vitest";
import type { CiudadRepository, EnvioRepository, RutaRepository } from "../../src/application/ports/repositories.js";
import { Envio } from "../../src/domain/envio/Envio.js";
import { OPERADOR, solicitudEnvio } from "./fakes.js";

export interface FabricaRepos {
  envios: EnvioRepository;
  rutas: RutaRepository;
  ciudades: CiudadRepository;
}

/**
 * Suite de contrato: cualquier adaptador de persistencia debe pasarla.
 * Se ejecuta contra memoria siempre y contra Postgres cuando hay TEST_DATABASE_URL.
 */
export function contratoRepositorios(nombre: string, fabrica: () => Promise<FabricaRepos>): void {
  describe(`Contrato de repositorios — ${nombre}`, () => {
    let repos: FabricaRepos;
    let n = 0;

    beforeEach(async () => {
      repos = await fabrica();
    });

    const nuevoEnvio = (minutos = 0, sobre: Record<string, unknown> = {}) => {
      n++;
      const s = solicitudEnvio(sobre);
      return Envio.crear(
        {
          ...s,
          formaPago: "CONTRATO",
          items: [
            { tipoCarga: "PAQUETE", cantidad: 5, pesoKg: 2, costoUnitario: 8.4, subtotal: 42 },
            { tipoCarga: "CARTON", cantidad: 2, pesoKg: 8, costoUnitario: 12.6, subtotal: 25.2 },
          ],
        } as Parameters<typeof Envio.crear>[0],
        {
          id: `00000000-0000-4000-b000-${String(n).padStart(12, "0")}`,
          numeroGuia: 70000 + n,
          ahora: new Date(Date.UTC(2026, 9, 1, 12, minutos)),
          actor: OPERADOR,
        },
      );
    };

    it("guarda y recupera un envío con su historial", async () => {
      const e = nuevoEnvio();
      await repos.envios.guardar(e);
      const leido = await repos.envios.buscarPorId(e.id);
      expect(leido?.toSnapshot()).toMatchObject({
        numeroGuia: e.numeroGuia,
        costo: 67.2,
        formaPago: "CONTRATO",
        items: [
          { tipoCarga: "PAQUETE", cantidad: 5, pesoKg: 2, costoUnitario: 8.4, subtotal: 42 },
          { tipoCarga: "CARTON", cantidad: 2, pesoKg: 8, costoUnitario: 12.6, subtotal: 25.2 },
        ],
        remitente: { nombre: "María Pérez" },
        historial: [{ estado: "REGISTRADO", usuario: { id: OPERADOR.id } }],
      });
      expect(await repos.envios.existeNumeroGuia(e.numeroGuia)).toBe(true);
      expect((await repos.envios.buscarPorNumeroGuia(e.numeroGuia))?.id).toBe(e.id);
      expect(await repos.envios.siguienteNumeroGuia()).toBeGreaterThan(e.numeroGuia);
    });

    it("persiste solo los eventos nuevos al cambiar de estado", async () => {
      const e = nuevoEnvio();
      await repos.envios.guardar(e);
      e.cambiarEstado("EN_TRANSITO", { ahora: new Date(Date.UTC(2026, 9, 1, 13)), actor: OPERADOR, nota: "bus 10:00" });
      await repos.envios.guardar(e);
      await repos.envios.guardar(e); // idempotente
      const leido = (await repos.envios.buscarPorId(e.id))!;
      expect(leido.estado).toBe("EN_TRANSITO");
      expect(leido.historial.map((h) => [h.estado, h.nota])).toEqual([
        ["REGISTRADO", null],
        ["EN_TRANSITO", "bus 10:00"],
      ]);
    });

    it("lista con filtros y orden descendente por fecha", async () => {
      const a = nuevoEnvio(0);
      const b = nuevoEnvio(10, { destinatario: { nombre: "Rosa Cevallos", telefono: "0999999999", direccion: "Sucre" } });
      await repos.envios.guardar(a);
      await repos.envios.guardar(b);
      const ids = (await repos.envios.listar()).map((e) => e.id);
      expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id));
      expect((await repos.envios.listar({ q: "ROSA" })).map((e) => e.id)).toEqual([b.id]);
      expect((await repos.envios.listar({ q: String(a.numeroGuia), numeroGuia: a.numeroGuia })).map((e) => e.id)).toEqual([a.id]);
      expect((await repos.envios.listar({ estado: "ENTREGADO" })).map((e) => e.id)).not.toContain(a.id);
      expect((await repos.envios.listar({ rutaId: 11 })).map((e) => e.id)).toEqual(expect.arrayContaining([a.id, b.id]));
    });

    it("pagina con orden estable y total del filtro", async () => {
      // Tres envíos con la MISMA fecha: el desempate por id evita repetir o saltar filas entre páginas.
      const iguales = [nuevoEnvio(50), nuevoEnvio(50), nuevoEnvio(50)];
      for (const e of iguales) await repos.envios.guardar(e);
      const filtro = { q: iguales[0]!.toSnapshot().remitente.nombre };
      const todos = (await repos.envios.listar(filtro)).map((e) => e.id);
      const p1 = await repos.envios.listarPagina(filtro, { pagina: 1, porPagina: 2 });
      const p2 = await repos.envios.listarPagina(filtro, { pagina: 2, porPagina: 2 });
      expect(p1.total).toBe(todos.length);
      expect(p2.total).toBe(todos.length);
      expect([...p1.envios, ...p2.envios].map((e) => e.id)).toEqual(todos.slice(0, 4));
      expect(new Set([...p1.envios, ...p2.envios].map((e) => e.id)).size).toBe(Math.min(4, todos.length));
      expect(p1.envios[0]?.toSnapshot().items.length).toBeGreaterThan(0);
      const vacia = await repos.envios.listarPagina({ estado: "CANCELADO", rutaId: 999 }, { pagina: 1, porPagina: 10 });
      expect(vacia).toEqual({ envios: [], total: 0 });
    });

    it("persiste NO_ENTREGADO/NOVEDAD con motivo, sin duplicar ítems, y filtra por forma de pago", async () => {
      const e = nuevoEnvio(30);
      await repos.envios.guardar(e);
      for (const estado of ["EN_TRANSITO", "EN_REPARTO"] as const) {
        e.cambiarEstado(estado, { ahora: new Date(Date.UTC(2026, 9, 1, 13)), actor: OPERADOR });
      }
      e.cambiarEstado("NO_ENTREGADO", { ahora: new Date(Date.UTC(2026, 9, 1, 14)), actor: OPERADOR, nota: "Nadie en casa" });
      await repos.envios.guardar(e);
      e.cambiarEstado("EN_REPARTO", { ahora: new Date(Date.UTC(2026, 9, 2, 9)), actor: OPERADOR });
      e.cambiarEstado("NOVEDAD", { ahora: new Date(Date.UTC(2026, 9, 2, 10)), actor: OPERADOR, nota: "Paquete mojado" });
      await repos.envios.guardar(e);

      const leido = (await repos.envios.buscarPorId(e.id))!;
      expect(leido.estado).toBe("NOVEDAD");
      expect(leido.totalPiezas).toBe(7);
      expect(leido.toSnapshot().items).toHaveLength(2);
      expect(leido.ultimaGestionEntrega).toMatchObject({ resultado: "NOVEDAD", nota: "Paquete mojado", operador: OPERADOR.nombre });
      expect(leido.registro.operador).toBe(OPERADOR.nombre);

      expect((await repos.envios.listar({ formaPago: "CONTRATO" })).map((x) => x.id)).toContain(e.id);
      expect((await repos.envios.listar({ formaPago: "SEGURO" })).map((x) => x.id)).not.toContain(e.id);
      expect((await repos.envios.listar({ estado: "NOVEDAD" })).map((x) => x.id)).toEqual([e.id]);
    });

    it("devuelve null para envíos inexistentes", async () => {
      expect(await repos.envios.buscarPorId("00000000-0000-4000-8000-0000000fffff")).toBeNull();
      expect(await repos.envios.existeNumeroGuia(999_999_999_999)).toBe(false);
    });

    it("gestiona ciudades y las rutas reflejan su nombre y estado", async () => {
      const nueva = await repos.ciudades.crear("Cayambe");
      expect(nueva).toMatchObject({ nombre: "Cayambe", activa: true });
      expect(await repos.ciudades.existeNombre("CAYAMBE")).toBe(true);
      expect(await repos.ciudades.existeNombre("cayambe", nueva.id)).toBe(false);
      expect(await repos.rutas.usaCiudad(nueva.id)).toBe(false);
      expect(await repos.rutas.usaCiudad(4)).toBe(true);

      await repos.ciudades.actualizar(4, { activa: false });
      const r = (await repos.rutas.buscarPorId(11))!;
      expect(r.destino).toEqual({ id: 4, nombre: "Quito", activa: false });
      expect((await repos.ciudades.listar({ activa: true })).map((c) => c.nombre)).not.toContain("Quito");
      await repos.ciudades.actualizar(4, { activa: true });

      await repos.ciudades.eliminar(nueva.id);
      expect(await repos.ciudades.buscarPorId(nueva.id)).toBeNull();
    });

    it("lee y actualiza rutas con sus ciudades", async () => {
      const r = (await repos.rutas.buscarPorId(11))!;
      expect([r.origen.nombre, r.destino.nombre]).toEqual(["Ibarra", "Quito"]);
      const act = await repos.rutas.actualizar(11, { tarifaBase: 6.5 });
      expect(act).toMatchObject({ tarifaBase: 6.5, tiempoEstimadoMin: r.tiempoEstimadoMin, activa: true });
      expect(await repos.rutas.existe(1, 4)).toBe(true);
    });
  });
}
