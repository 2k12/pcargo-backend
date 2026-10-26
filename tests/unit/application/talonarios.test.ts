import { beforeEach, describe, expect, it } from "vitest";
import { adaptadoresEnMemoria, crearCasosDeUso, type Adaptadores, type CasosDeUso } from "../../../src/infrastructure/container.js";
import { FakeClock, hasherFalso, JWT_SECRET_TEST, OPERADOR, PORTAL, SecuenciaIds, solicitudEnvio } from "../../helpers/fakes.js";

// Contrato v20: talonarios de guías en blanco (casos de uso con adaptadores en memoria).

let c: CasosDeUso;
let a: Adaptadores;
let clock: FakeClock;

beforeEach(async () => {
  clock = new FakeClock(new Date("2026-10-20T15:00:00Z")); // 2026-10-20 en Ecuador
  a = await adaptadoresEnMemoria({ jwtSecret: JWT_SECRET_TEST, hasher: hasherFalso, clock, ids: new SecuenciaIds() });
  c = crearCasosDeUso(a);
});

const DIA_MIN = 24 * 60;
const crearEnvio = (sobre: Record<string, unknown> = {}) => c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio(sobre));
const talonario = (cantidad: number, nota?: string) => c.crearTalonario.ejecutar(OPERADOR, { cantidad, nota });

describe("Talonarios de guías en blanco (v20)", () => {
  it("reserva el primer bloque contiguo libre después del contador (v21) con quien lo creó", async () => {
    await crearEnvio({ numeroGuia: 3 }); // 1–2 no alcanzan para 5
    const t1 = await talonario(5, "Camión Quito – sábado");
    expect(t1).toMatchObject({
      desde: 4,
      hasta: 8,
      cantidad: 5,
      nota: "Camión Quito – sábado",
      creadoEn: clock.ahora().toISOString(),
      creadoPor: OPERADOR.nombre,
      disponibles: 5,
      usadas: 0,
      anuladas: 0,
    });
    expect(t1.guias.map((g) => [g.numeroGuia, g.estado])).toEqual([4, 5, 6, 7, 8].map((n) => [n, "DISPONIBLE"]));
    const t2 = await talonario(2);
    expect([t2.desde, t2.hasta, t2.nota]).toEqual([9, 10, null]);
    // el contador quedó al final del bloque: el consecutivo sigue después (1 y 2 ya quedaron atrás)
    expect((await crearEnvio()).numeroGuia).toBe(11);
  });

  it("reservas simultáneas nunca comparten números", async () => {
    const todos = await Promise.all(Array.from({ length: 8 }, (_, i) => talonario(i + 1)));
    const numeros = todos.flatMap((t) => t.guias.map((g) => g.numeroGuia)).sort((x, y) => x - y);
    expect(numeros).toEqual(Array.from({ length: 36 }, (_, i) => i + 1));
  });

  it("el consecutivo automático (panel, portal y API) salta los números reservados y los ocupados (v21)", async () => {
    await crearEnvio({ numeroGuia: 10 });
    await talonario(3); // 1–3
    expect((await crearEnvio()).numeroGuia).toBe(4);
    await talonario(2); // 5–6
    expect((await c.crearEnvioPortal.ejecutar(PORTAL, {
      destinatario: { nombre: "Ana", telefono: "0987654321", direccion: "Quito" },
      rutaId: 11,
      items: [{ tipoCarga: "SOBRE", cantidad: 1, pesoKg: 0.2 }],
    })).numeroGuia).toBe(7);
    // 8–9 no alcanzan para 3 (el 10 está ocupado): el talonario salta a 11–13
    const t = await talonario(3);
    expect([t.desde, t.hasta]).toEqual([11, 13]);
    expect((await crearEnvio()).numeroGuia).toBe(14);
  });

  it("registrar una guía DISPONIBLE crea el envío y la marca USADA; repetida → CONFLICTO", async () => {
    const t = await talonario(3);
    const e = await crearEnvio({ numeroGuia: "0002" });
    expect(e.numeroGuia).toBe(2);
    const leido = await c.obtenerTalonario.ejecutar(t.id);
    expect(leido.guias[1]).toEqual({
      numeroGuia: 2,
      estado: "USADA",
      envioId: e.id,
      motivo: null,
      actualizadoEn: clock.ahora().toISOString(),
    });
    expect([leido.disponibles, leido.usadas]).toEqual([2, 1]);
    await expect(crearEnvio({ numeroGuia: 2 })).rejects.toMatchObject({ code: "CONFLICTO" });
    // cancelar el envío no devuelve la guía al talonario
    await c.cambiarEstado.ejecutar(OPERADOR, e.id, "CANCELADO");
    expect((await c.obtenerGuiaTalonario.ejecutar("2")).estado).toBe("USADA");
  });

  it("guía ANULADA → GUIA_ANULADA sin crear el envío", async () => {
    const t = await talonario(2);
    await c.anularGuiaTalonario.ejecutar(t.id, { numeroGuia: "1", motivo: "Se mojó en el camión" });
    await expect(crearEnvio({ numeroGuia: 1 })).rejects.toMatchObject({ code: "GUIA_ANULADA" });
    expect((await c.listarEnvios.ejecutar()).total).toBe(0);
  });

  it("si la creación del envío falla, la guía sigue DISPONIBLE", async () => {
    const t = await talonario(1);
    await expect(crearEnvio({ numeroGuia: 1, destinatario: { nombre: "", telefono: "1", direccion: "" } })).rejects.toMatchObject({
      code: "VALIDACION",
    });
    await expect(crearEnvio({ numeroGuia: 1, rutaId: 9999 })).rejects.toBeDefined();
    expect((await c.obtenerTalonario.ejecutar(t.id)).guias[0]!.estado).toBe("DISPONIBLE");
  });

  it("fechaGuia desde el día de creación del talonario hasta hoy + 90; anterior → VALIDACION", async () => {
    await talonario(4); // creado el 2026-10-20
    clock.avanzar(3 * DIA_MIN); // hoy: 2026-10-23
    expect((await crearEnvio({ numeroGuia: 1, fechaGuia: "2026-10-20" })).fechaGuia).toBe("2026-10-20");
    expect((await crearEnvio({ numeroGuia: 2, fechaGuia: "2026-10-22" })).fechaGuia).toBe("2026-10-22");
    expect((await crearEnvio({ numeroGuia: 3 })).fechaGuia).toBe("2026-10-23");
    await expect(crearEnvio({ numeroGuia: 4, fechaGuia: "2026-10-19" })).rejects.toMatchObject({ code: "VALIDACION" });
    await expect(crearEnvio({ numeroGuia: 4, fechaGuia: "2027-01-22" })).rejects.toMatchObject({ code: "VALIDACION" });
    // un número que no es de talonario sigue exigiendo hoy o posterior
    await expect(crearEnvio({ numeroGuia: 900, fechaGuia: "2026-10-22" })).rejects.toMatchObject({ code: "VALIDACION" });
  });

  it("anular: solo DISPONIBLE (USADA → ESTADO_INVALIDO); número ajeno → NO_ENCONTRADO; motivo corto → VALIDACION", async () => {
    const t = await talonario(3);
    const otro = await talonario(1);
    await crearEnvio({ numeroGuia: 1 });
    await expect(c.anularGuiaTalonario.ejecutar(t.id, { numeroGuia: 1, motivo: "Dañada" })).rejects.toMatchObject({
      code: "ESTADO_INVALIDO",
    });
    await expect(c.anularGuiaTalonario.ejecutar(t.id, { numeroGuia: otro.desde, motivo: "Dañada" })).rejects.toMatchObject({
      code: "NO_ENCONTRADO",
    });
    await expect(c.anularGuiaTalonario.ejecutar(t.id, { numeroGuia: 2, motivo: "no" })).rejects.toMatchObject({
      code: "VALIDACION",
    });
    await expect(
      c.anularGuiaTalonario.ejecutar("00000000-0000-4000-a000-0000000000ff", { numeroGuia: 2, motivo: "Dañada" }),
    ).rejects.toMatchObject({ code: "NO_ENCONTRADO" });
    clock.avanzar(5);
    const r = await c.anularGuiaTalonario.ejecutar(t.id, { numeroGuia: "002", motivo: "Mal llenada" });
    expect(r.guias[1]).toEqual({
      numeroGuia: 2,
      estado: "ANULADA",
      envioId: null,
      motivo: "Mal llenada",
      actualizadoEn: clock.ahora().toISOString(),
    });
    expect([r.disponibles, r.usadas, r.anuladas]).toEqual([1, 1, 1]);
  });

  it("obtener por número (con ceros a la izquierda) y 404 si no es de ningún talonario", async () => {
    const t = await talonario(2, "Ruta Otavalo");
    expect(await c.obtenerGuiaTalonario.ejecutar("0002")).toEqual({
      numeroGuia: 2,
      estado: "DISPONIBLE",
      envioId: null,
      motivo: null,
      actualizadoEn: null,
      talonarioId: t.id,
      nota: "Ruta Otavalo",
      creadoEn: t.creadoEn,
    });
    await expect(c.obtenerGuiaTalonario.ejecutar("3")).rejects.toMatchObject({ code: "NO_ENCONTRADO" });
    await expect(c.obtenerGuiaTalonario.ejecutar("12a")).rejects.toMatchObject({ code: "VALIDACION" });
    await expect(c.obtenerTalonario.ejecutar("00000000-0000-4000-a000-0000000000ff")).rejects.toMatchObject({
      code: "NO_ENCONTRADO",
    });
  });

  it("lista abiertos (por defecto) o todos, más recientes primero y paginado", async () => {
    const t1 = await talonario(1);
    clock.avanzar(1);
    const t2 = await talonario(2);
    clock.avanzar(1);
    const t3 = await talonario(1);
    await crearEnvio({ numeroGuia: t1.desde }); // t1 queda sin disponibles
    const abiertos = await c.listarTalonarios.ejecutar();
    expect([abiertos.total, abiertos.datos.map((t) => t.id)]).toEqual([2, [t3.id, t2.id]]);
    expect(abiertos.datos[0]).not.toHaveProperty("guias");
    const todos = await c.listarTalonarios.ejecutar({ estado: "todos" }, { pagina: 2, porPagina: 2 });
    expect([todos.total, todos.totalPaginas, todos.datos.map((t) => t.id)]).toEqual([3, 2, [t1.id]]);
    expect(todos.datos[0]).toMatchObject({ disponibles: 0, usadas: 1 });
  });
});
