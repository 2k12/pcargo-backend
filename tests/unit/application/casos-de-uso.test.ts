import { beforeEach, describe, expect, it } from "vitest";
import { adaptadoresEnMemoria, crearCasosDeUso, type CasosDeUso } from "../../../src/infrastructure/container.js";
import { ADMIN, FakeClock, hasherFalso, JWT_SECRET_TEST, OPERADOR, SecuenciaIds, solicitudEnvio } from "../../helpers/fakes.js";

let c: CasosDeUso;
let clock: FakeClock;
let ids: SecuenciaIds;

beforeEach(async () => {
  clock = new FakeClock();
  ids = new SecuenciaIds();
  c = crearCasosDeUso(await adaptadoresEnMemoria({ jwtSecret: JWT_SECRET_TEST, hasher: hasherFalso, clock, ids }));
});

describe("Login", () => {
  it("devuelve token y usuario con credenciales válidas", async () => {
    const r = await c.login.ejecutar("ADMIN@pcargo.ec ", "Admin123!");
    expect(r.usuario).toEqual({ id: ADMIN.id, nombre: ADMIN.nombre, email: "admin@pcargo.ec", rol: "ADMIN" });
    expect(c.tokens.verificar(r.token)).toEqual(ADMIN);
  });

  it.each([
    ["admin@pcargo.ec", "mala"],
    ["nadie@pcargo.ec", "Admin123!"],
  ])("rechaza %s / %s con el mismo error", async (email, pass) => {
    await expect(c.login.ejecutar(email, pass)).rejects.toMatchObject({ code: "CREDENCIALES_INVALIDAS" });
  });
});

describe("Cotizar y crear envío", () => {
  it("cotiza con la tarifa de la ruta", async () => {
    // Ibarra → Quito 6.00 * 1.4 + (3 - 2) * 0.5
    expect(await c.cotizar.ejecutar({ rutaId: 11, tipoCarga: "PAQUETE", pesoKg: 3 })).toMatchObject({ costo: 8.9 });
  });

  it("crea el envío cobrando el costo cotizado", async () => {
    const e = await c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio());
    expect(e).toMatchObject({
      codigo: "PC-TEST0002",
      estado: "REGISTRADO",
      costo: 8.9,
      ruta: { id: 11, origen: "Ibarra", destino: "Quito" },
    });
    expect(e.historial).toEqual([
      { estado: "REGISTRADO", nota: null, fecha: clock.ahora().toISOString(), usuario: OPERADOR.nombre },
    ]);
  });

  it("reintenta si el código de seguimiento ya existe", async () => {
    ids = new SecuenciaIds(["PC-REPETIDO", "PC-REPETIDO", "PC-UNICO000"]);
    c = crearCasosDeUso(await adaptadoresEnMemoria({ jwtSecret: JWT_SECRET_TEST, hasher: hasherFalso, ids }));
    await c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio());
    expect((await c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio())).codigo).toBe("PC-UNICO000");
  });

  it("no permite enviar por una ruta inactiva", async () => {
    await c.actualizarRuta.ejecutar(ADMIN, 11, { activa: false });
    await expect(c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio())).rejects.toMatchObject({ code: "RUTA_INACTIVA" });
  });

  it("rechaza tipo de carga desconocido y ruta inexistente", async () => {
    await expect(c.cotizar.ejecutar({ rutaId: 11, tipoCarga: "PIANO", pesoKg: 1 })).rejects.toMatchObject({ code: "VALIDACION" });
    await expect(c.cotizar.ejecutar({ rutaId: 999, tipoCarga: "SOBRE", pesoKg: 0.1 })).rejects.toMatchObject({ code: "NO_ENCONTRADO" });
  });
});

describe("Estados, consultas y seguimiento", () => {
  it("cambia estado y lo refleja en el seguimiento público sin datos personales", async () => {
    const e = await c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio());
    clock.avanzar(30);
    await c.cambiarEstado.ejecutar(OPERADOR, e.id, "EN_TRANSITO", "Salió en bus de las 10:00");
    const s = await c.seguimiento.ejecutar(e.codigo.toLowerCase());
    expect(s).toMatchObject({ codigo: e.codigo, estado: "EN_TRANSITO", origen: "Ibarra", destino: "Quito" });
    expect(s.historial.map((h) => h.usuario)).toEqual([null, null]);
    expect(JSON.stringify(s)).not.toContain("María");
  });

  it("propaga TRANSICION_INVALIDA y NO_ENCONTRADO", async () => {
    const e = await c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio());
    await expect(c.cambiarEstado.ejecutar(OPERADOR, e.id, "ENTREGADO")).rejects.toMatchObject({ code: "TRANSICION_INVALIDA" });
    await expect(c.obtenerEnvio.ejecutar("no-existe")).rejects.toMatchObject({ code: "NO_ENCONTRADO" });
    await expect(c.seguimiento.ejecutar("PC-XXXXXXXX")).rejects.toMatchObject({ code: "NO_ENCONTRADO" });
  });

  it("filtra envíos por estado, ruta y texto, más recientes primero", async () => {
    const a = await c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio());
    clock.avanzar(5);
    const b = await c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio({ rutaId: 1, tipoCarga: "SOBRE", pesoKg: 0.2, destinatario: { nombre: "Rosa Cevallos", telefono: "0999999999", direccion: "Sucre 4-5" } }));
    await c.cambiarEstado.ejecutar(OPERADOR, a.id, "CANCELADO");

    expect((await c.listarEnvios.ejecutar()).map((e) => e.id)).toEqual([b.id, a.id]);
    expect((await c.listarEnvios.ejecutar({ estado: "CANCELADO" })).map((e) => e.id)).toEqual([a.id]);
    expect((await c.listarEnvios.ejecutar({ rutaId: 1 })).map((e) => e.id)).toEqual([b.id]);
    expect((await c.listarEnvios.ejecutar({ q: "rosa" })).map((e) => e.id)).toEqual([b.id]);
  });

  it("resume envíos e ingresos excluyendo cancelados", async () => {
    const a = await c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio());
    await c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio({ tipoCarga: "SOBRE", pesoKg: 0.1 }));
    await c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio({ tipoCarga: "SOBRE", pesoKg: 0.1 }));
    await c.cambiarEstado.ejecutar(OPERADOR, a.id, "CANCELADO");

    const r = await c.resumen.ejecutar();
    expect(r.totalEnvios).toBe(3);
    expect(r.ingresos).toBe(12);
    expect(r.porEstado).toMatchObject({ REGISTRADO: 2, CANCELADO: 1, ENTREGADO: 0 });
    expect(r.porTipo).toContainEqual({ tipoCarga: "SOBRE", total: 2 });
    expect(r.porRuta).toEqual([{ ruta: "Ibarra → Quito", total: 3 }]);
  });
});

describe("Gestión de rutas", () => {
  it("solo ADMIN crea o modifica rutas", async () => {
    await expect(c.actualizarRuta.ejecutar(OPERADOR, 1, { tarifaBase: 9 })).rejects.toMatchObject({ code: "PROHIBIDO" });
    expect((await c.actualizarRuta.ejecutar(ADMIN, 1, { tarifaBase: 2.25 })).tarifaBase).toBe(2.25);
  });

  it("no duplica rutas y valida ciudades", async () => {
    await expect(c.crearRuta.ejecutar(ADMIN, { origenId: 1, destinoId: 4, tarifaBase: 6, tiempoEstimadoMin: 180 })).rejects.toMatchObject({ code: "CONFLICTO" });
    await expect(c.crearRuta.ejecutar(ADMIN, { origenId: 1, destinoId: 99, tarifaBase: 6, tiempoEstimadoMin: 180 })).rejects.toMatchObject({ code: "NO_ENCONTRADO" });
  });

  it("siembra las rutas entre Ibarra, Atuntaqui, Otavalo y Quito", async () => {
    const rutas = await c.listarRutas.ejecutar();
    expect(rutas).toHaveLength(16);
    const ciudades = new Set(rutas.flatMap((r) => [r.origen.nombre, r.destino.nombre]));
    expect([...ciudades].sort()).toEqual(["Atuntaqui", "Ibarra", "Otavalo", "Quito"]);
  });
});
