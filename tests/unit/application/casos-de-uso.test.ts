import { beforeEach, describe, expect, it } from "vitest";
import {
  adaptadoresEnMemoria,
  crearCasosDeUso,
  type Adaptadores,
  type CasosDeUso,
} from "../../../src/infrastructure/container.js";
import { CLIENTES_SEED } from "../../../src/infrastructure/persistence/seed-data.js";
import { ADMIN, FakeClock, hasherFalso, item, JWT_SECRET_TEST, OPERADOR, SecuenciaIds, solicitudEnvio } from "../../helpers/fakes.js";

let c: CasosDeUso;
let a: Adaptadores;
let clock: FakeClock;
let ids: SecuenciaIds;

beforeEach(async () => {
  clock = new FakeClock();
  ids = new SecuenciaIds();
  a = await adaptadoresEnMemoria({ jwtSecret: JWT_SECRET_TEST, hasher: hasherFalso, clock, ids });
  // Estos tests parten sin clientes frecuentes: se retira el cliente semilla del portal (v12).
  await a.clientes.eliminar(CLIENTES_SEED[0]!.id);
  c = crearCasosDeUso(a);
});

describe("Login", () => {
  it("devuelve token y usuario con credenciales válidas", async () => {
    const r = await c.login.ejecutar("ADMIN@pcargo.ec ", "Admin123!");
    expect(r.usuario).toEqual({ id: ADMIN.id, nombre: ADMIN.nombre, email: "admin@pcargo.ec", rol: "ADMIN", clienteId: null });
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
  it("cotiza por tipo de carga: la ruta no influye en el precio", async () => {
    // Ibarra → Quito y Ibarra urbano: un paquete cuesta 3.00 en cualquier ruta, sin recargo por peso
    expect(await c.cotizar.ejecutar({ rutaId: 11, ...item("PAQUETE", 3) })).toEqual({
      costo: 3,
      zona: "URBANA",
      totalPiezas: 1,
      pesoTotalKg: 3,
      items: [{ tipoCarga: "PAQUETE", cantidad: 1, pesoKg: 3, costoUnitario: 3, subtotal: 3, mayoreo: false }],
    });
    expect((await c.cotizar.ejecutar({ rutaId: 1, ...item("PAQUETE", 45) })).costo).toBe(3);
  });

  it("cotiza la tela según la zona y con mayoreo sobre 50 rollos de todo el envío", async () => {
    const tela = (cantidad: number) => ({ tipoCarga: "TELA", cantidad, pesoKg: 2 });
    expect((await c.cotizar.ejecutar({ rutaId: 11, items: [tela(10)] })).costo).toBe(12.5);
    expect(await c.cotizar.ejecutar({ rutaId: 11, items: [tela(10)], zona: "RURAL" })).toMatchObject({ zona: "RURAL", costo: 15 });
    // 25 + 25 = 50 rollos: sin mayoreo
    expect((await c.cotizar.ejecutar({ rutaId: 11, items: [tela(25), tela(25)], zona: "RURAL" })).costo).toBe(75);
    // 25 + 26 = 51 rollos: todos a 1.00, también en zona rural
    const mayoreo = await c.cotizar.ejecutar({ rutaId: 11, items: [tela(25), tela(26)], zona: "RURAL" });
    expect(mayoreo.costo).toBe(51);
    expect(mayoreo.items.every((i) => i.mayoreo && i.costoUnitario === 1)).toBe(true);
    await expect(c.cotizar.ejecutar({ rutaId: 11, items: [tela(1)], zona: "PLAYA" })).rejects.toMatchObject({ code: "VALIDACION" });
  });

  it("crea el envío con la zona y el costo cotizados (sin zona → URBANA)", async () => {
    const items = [{ tipoCarga: "TELA", cantidad: 4, pesoKg: 5 }, { tipoCarga: "PLUMON_GRANDE", cantidad: 1, pesoKg: 10 }];
    const rural = await c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio({ items, zona: "RURAL" }));
    expect(rural).toMatchObject({
      zona: "RURAL",
      costo: 10, // 4 × 1.50 + 4.00
      items: [
        { tipoCarga: "TELA", cantidad: 4, pesoKg: 5, costoUnitario: 1.5, subtotal: 6 },
        { tipoCarga: "PLUMON_GRANDE", cantidad: 1, pesoKg: 10, costoUnitario: 4, subtotal: 4 },
      ],
    });
    expect(rural.items[0]).not.toHaveProperty("mayoreo");
    expect((await c.obtenerEnvio.ejecutar(rural.id)).zona).toBe("RURAL");
    expect(await c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio({ items }))).toMatchObject({ zona: "URBANA", costo: 9 });
  });

  it("crea el envío cobrando el costo cotizado", async () => {
    const e = await c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio());
    expect(e).toMatchObject({
      numeroGuia: 1,
      estado: "REGISTRADO",
      zona: "URBANA",
      costo: 3,
      ruta: { id: 11, origen: "Ibarra", destino: "Quito" },
    });
    expect(e.historial).toEqual([
      { estado: "REGISTRADO", nota: null, fecha: clock.ahora().toISOString(), usuario: OPERADOR.nombre },
    ]);
  });

  it("usa el número de la guía física (con o sin ceros) y si no hay, asigna el consecutivo", async () => {
    const fisica = await c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio({ numeroGuia: "0040425" }));
    expect(fisica.numeroGuia).toBe(40425);
    await expect(c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio({ numeroGuia: "40425" }))).rejects.toMatchObject({ code: "CONFLICTO" });
    await expect(c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio({ numeroGuia: "PC-12" }))).rejects.toMatchObject({ code: "VALIDACION" });
    expect((await c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio({ numeroGuia: "  " }))).numeroGuia).toBe(40426);
    expect((await c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio())).numeroGuia).toBe(40427);
  });

  it("no permite enviar por una ruta inactiva", async () => {
    await c.actualizarRuta.ejecutar(ADMIN, 11, { activa: false });
    await expect(c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio())).rejects.toMatchObject({ code: "RUTA_INACTIVA" });
  });

  it("rechaza tipo de carga desconocido y ruta inexistente", async () => {
    await expect(c.cotizar.ejecutar({ rutaId: 11, ...item("PIANO", 1) })).rejects.toMatchObject({ code: "VALIDACION" });
    await expect(c.cotizar.ejecutar({ rutaId: 999, ...item("SOBRE", 0.1) })).rejects.toMatchObject({ code: "NO_ENCONTRADO" });
  });
});

describe("Estados, consultas y seguimiento", () => {
  it("cambia estado y lo refleja en el seguimiento público sin datos personales", async () => {
    const e = await c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio());
    clock.avanzar(30);
    await c.cambiarEstado.ejecutar(OPERADOR, e.id, "EN_TRANSITO", "Salió en bus de las 10:00");
    const s = await c.seguimiento.ejecutar(`000${e.numeroGuia}`);
    expect(s).toMatchObject({ numeroGuia: e.numeroGuia, estado: "EN_TRANSITO", origen: "Ibarra", destino: "Quito" });
    expect(s.historial.map((h) => h.usuario)).toEqual([null, null]);
    expect(JSON.stringify(s)).not.toContain("María");
  });

  it("propaga TRANSICION_INVALIDA y NO_ENCONTRADO", async () => {
    const e = await c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio());
    await expect(c.cambiarEstado.ejecutar(OPERADOR, e.id, "ENTREGADO")).rejects.toMatchObject({ code: "TRANSICION_INVALIDA" });
    await expect(c.obtenerEnvio.ejecutar("no-existe")).rejects.toMatchObject({ code: "NO_ENCONTRADO" });
    await expect(c.seguimiento.ejecutar("999999")).rejects.toMatchObject({ code: "NO_ENCONTRADO" });
    await expect(c.seguimiento.ejecutar("PC-XXXXXXXX")).rejects.toMatchObject({ code: "VALIDACION" });
  });

  it("filtra envíos por estado, ruta y texto, más recientes primero", async () => {
    const a = await c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio());
    clock.avanzar(5);
    const b = await c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio({ rutaId: 1, ...item("SOBRE", 0.2), formaPago: "CONTRATO", destinatario: { nombre: "Rosa Cevallos", telefono: "0999999999", direccion: "Sucre 4-5" } }));
    await c.cambiarEstado.ejecutar(OPERADOR, a.id, "CANCELADO");

    expect((await c.listarEnvios.ejecutar()).datos.map((e) => e.id)).toEqual([b.id, a.id]);
    expect((await c.listarEnvios.ejecutar({ estado: "CANCELADO" })).datos.map((e) => e.id)).toEqual([a.id]);
    expect((await c.listarEnvios.ejecutar({ rutaId: 1 })).datos.map((e) => e.id)).toEqual([b.id]);
    expect((await c.listarEnvios.ejecutar({ q: "rosa" })).datos.map((e) => e.id)).toEqual([b.id]);
    expect((await c.listarEnvios.ejecutar({ q: `00${a.numeroGuia}` })).datos.map((e) => e.id)).toEqual([a.id]);
  });

  it("pagina el listado en el servidor y acota el tamaño de página", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.unshift((await c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio())).id);
      clock.avanzar(1);
    }
    const p1 = await c.listarEnvios.ejecutar({}, { pagina: 1, porPagina: 2 });
    const p3 = await c.listarEnvios.ejecutar({}, { pagina: 3, porPagina: 2 });
    expect(p1).toMatchObject({ pagina: 1, porPagina: 2, total: 5, totalPaginas: 3 });
    expect(p1.datos.map((e) => e.id)).toEqual(ids.slice(0, 2));
    expect(p3.datos.map((e) => e.id)).toEqual(ids.slice(4));
    expect((await c.listarEnvios.ejecutar({}, { pagina: 9, porPagina: 2 })).datos).toEqual([]);
    expect((await c.listarEnvios.ejecutar({}, { porPagina: 5000 })).porPagina).toBe(100);
    expect(await c.listarEnvios.ejecutar({ estado: "ENTREGADO" })).toMatchObject({ datos: [], total: 0, totalPaginas: 0 });
  });

  it("resume envíos e ingresos excluyendo cancelados", async () => {
    const a = await c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio());
    await c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio({ ...item("SOBRE", 0.1), formaPago: "AL_COBRO" }));
    await c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio({ ...item("SOBRE", 0.1), formaPago: "AL_COBRO" }));
    await c.cambiarEstado.ejecutar(OPERADOR, a.id, "CANCELADO");

    const r = await c.resumen.ejecutar();
    expect(r.totalEnvios).toBe(3);
    expect(r.ingresos).toBe(6);
    expect(r.porEstado).toMatchObject({ REGISTRADO: 2, CANCELADO: 1, ENTREGADO: 0 });
    expect(r.porTipo).toContainEqual({ tipoCarga: "SOBRE", piezas: 2 });
    expect(r.totalPiezas).toBe(3);
    expect(r.porFormaPago).toEqual([
      { formaPago: "PAGADO", envios: 1, monto: 0 },
      { formaPago: "AL_COBRO", envios: 2, monto: 6 },
      { formaPago: "CONTRATO", envios: 0, monto: 0 },
      { formaPago: "SEGURO", envios: 0, monto: 0 },
    ]);
    expect(r.porRuta).toEqual([{ rutaId: 11, ruta: "Ibarra → Quito", total: 3, monto: 6 }]);
    expect(r.porCobrar).toBe(6);
    expect(r.porCliente).toEqual([{ clienteId: null, nombre: "Sin cliente registrado", envios: 3, monto: 6 }]);
  });

  it("filtra por cliente y periodo, con serie diaria continua en hora de Ecuador", async () => {
    const tienda = await c.crearCliente.ejecutar({ nombre: "Tienda La Esquina", telefono: "062 950 111", consentimiento: true });
    // 2026-10-01T12:00Z = 07:00 en Ecuador
    await c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio({ clienteId: tienda.id }));
    clock.avanzar(2 * 24 * 60); // 2026-10-03
    await c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio({ clienteId: tienda.id, ...item("SOBRE", 0.1) }));
    await c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio({ remitente: { nombre: "Otro", telefono: "0980000000" } }));

    const delCliente = await c.resumen.ejecutar({ clienteId: tienda.id });
    expect(delCliente).toMatchObject({ totalEnvios: 2, ingresos: 6 });
    expect(delCliente.porCliente).toEqual([{ clienteId: tienda.id, nombre: "Tienda La Esquina", envios: 2, monto: 6 }]);
    expect(delCliente.porDia).toEqual([
      { fecha: "2026-10-01", envios: 1, ingresos: 3 },
      { fecha: "2026-10-02", envios: 0, ingresos: 0 },
      { fecha: "2026-10-03", envios: 1, ingresos: 3 },
    ]);

    const dia3 = await c.resumen.ejecutar({ desde: "2026-10-03", hasta: "2026-10-03" });
    expect(dia3.totalEnvios).toBe(2);
    expect(dia3.porCliente.map((p) => p.clienteId).sort()).toEqual([tienda.id, null].sort());
    expect(dia3.porDia).toEqual([{ fecha: "2026-10-03", envios: 2, ingresos: 6 }]);

    await expect(c.resumen.ejecutar({ desde: "03/10/2026" })).rejects.toMatchObject({ code: "VALIDACION" });
    await expect(c.resumen.ejecutar({ desde: "2026-10-05", hasta: "2026-10-01" })).rejects.toMatchObject({
      code: "VALIDACION",
    });
  });
});

describe("Clientes frecuentes", () => {
  it("registra, busca por nombre o teléfono, edita y elimina", async () => {
    const a = await c.crearCliente.ejecutar({
      nombre: "  Ferretería   Imbabura ",
      telefono: "06-295-0222",
      direccion: " Av. Mariano Acosta ",
      consentimiento: true,
    });
    expect(a).toMatchObject({
      nombre: "Ferretería Imbabura",
      telefono: "06 295 0222",
      direccion: "Av. Mariano Acosta",
      notas: null,
      envios: 0,
      monto: 0,
    });
    await c.crearCliente.ejecutar({ nombre: "Ana López", telefono: "0991113344", consentimiento: true });

    expect((await c.listarClientes.ejecutar()).map((x) => x.nombre)).toEqual(["Ana López", "Ferretería Imbabura"]);
    expect((await c.listarClientes.ejecutar({ q: "ferre" })).map((x) => x.id)).toEqual([a.id]);
    expect((await c.listarClientes.ejecutar({ q: "0222" })).map((x) => x.id)).toEqual([a.id]);

    const editado = await c.actualizarCliente.ejecutar(a.id, { notas: "Paga a fin de mes" });
    expect(editado).toMatchObject({ nombre: "Ferretería Imbabura", notas: "Paga a fin de mes" });

    await c.eliminarCliente.ejecutar(a.id);
    expect(await c.listarClientes.ejecutar()).toHaveLength(1);
    await expect(c.eliminarCliente.ejecutar(a.id)).rejects.toMatchObject({ code: "NO_ENCONTRADO" });
  });

  it("no admite dos clientes con el mismo teléfono ni datos inválidos", async () => {
    const a = await c.crearCliente.ejecutar({ nombre: "Ana López", telefono: "0991113344", consentimiento: true });
    const b = await c.crearCliente.ejecutar({ nombre: "Luis Mora", telefono: "0994445566", consentimiento: true });
    const conflicto = { code: "CONFLICTO" };
    await expect(c.crearCliente.ejecutar({ nombre: "Otra Ana", telefono: "099 111 3344", consentimiento: true })).rejects.toMatchObject(conflicto);
    await expect(c.actualizarCliente.ejecutar(b.id, { telefono: "0991113344" })).rejects.toMatchObject(conflicto);
    await expect(c.actualizarCliente.ejecutar(a.id, { telefono: "099 111 3344" })).resolves.toMatchObject({
      telefono: "099 111 3344",
    });
    const invalido = { code: "VALIDACION" };
    await expect(c.crearCliente.ejecutar({ nombre: "X", telefono: "0991112299", consentimiento: true })).rejects.toMatchObject(invalido);
    await expect(c.crearCliente.ejecutar({ nombre: "Sin teléfono", telefono: "12", consentimiento: true })).rejects.toMatchObject(invalido);
  });

  it("asocia envíos al cliente: elegido, guardado al vuelo o reconocido por su teléfono", async () => {
    const tienda = await c.crearCliente.ejecutar({ nombre: "Tienda La Esquina", telefono: "062950111", consentimiento: true });
    const elegido = await c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio({ clienteId: tienda.id }));
    expect(elegido.clienteId).toBe(tienda.id);

    const nuevo = await c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio({ guardarCliente: true, consentimientoCliente: true }));
    const maria = (await c.listarClientes.ejecutar()).find((x) => x.nombre === "María Pérez")!;
    expect(nuevo.clienteId).toBe(maria.id);

    // Mismo teléfono: se reconoce sin duplicar, aunque no se pida guardarlo
    const otraVez = await c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio());
    const deNuevo = await c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio({ guardarCliente: true, consentimientoCliente: true }));
    expect([otraVez.clienteId, deNuevo.clienteId]).toEqual([maria.id, maria.id]);
    expect(await c.listarClientes.ejecutar()).toHaveLength(2);

    const ocasional = await c.crearEnvio.ejecutar(
      OPERADOR,
      solicitudEnvio({ remitente: { nombre: "Pedro", telefono: "0970000000" } }),
    );
    expect(ocasional.clienteId).toBeNull();

    expect((await c.listarClientes.ejecutar()).find((x) => x.id === maria.id)).toMatchObject({ envios: 3, monto: 9 });
    expect((await c.listarEnvios.ejecutar({ clienteId: tienda.id })).datos.map((e) => e.id)).toEqual([elegido.id]);

    await expect(
      c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio({ clienteId: "00000000-0000-4000-8000-000000000999" })),
    ).rejects.toMatchObject({ code: "VALIDACION" });
  });

  it("no da de alta al cliente si el envío es inválido", async () => {
    const invalido = solicitudEnvio({ guardarCliente: true, consentimientoCliente: true, destinatario: { nombre: "", telefono: "1", direccion: "" } });
    await expect(c.crearEnvio.ejecutar(OPERADOR, invalido)).rejects.toMatchObject({ code: "VALIDACION" });
    expect(await c.listarClientes.ejecutar()).toEqual([]);
  });
});

describe("Consentimiento de datos personales (LOPDP)", () => {
  const ANA = { nombre: "Ana López", telefono: "0991113344" };
  const MENSAJE = "Se necesita el consentimiento del cliente para guardar sus datos";

  it("no guarda un cliente sin consentimiento expreso", async () => {
    for (const consentimiento of [undefined, false, "true", 1, null]) {
      await expect(c.crearCliente.ejecutar({ ...ANA, consentimiento })).rejects.toMatchObject({
        code: "VALIDACION",
        regla: true,
        message: MENSAJE,
      });
    }
    expect(await c.listarClientes.ejecutar()).toEqual([]);
  });

  it("al crear fija consentimientoEn con el reloj del servidor", async () => {
    const cliente = await c.crearCliente.ejecutar({ ...ANA, consentimiento: true });
    expect(cliente.consentimientoEn).toBe("2026-10-01T12:00:00.000Z");
    expect(cliente.creadoEn).toBe(cliente.consentimientoEn);
  });

  it("PATCH registra el consentimiento de un cliente antiguo y luego conserva la fecha original", async () => {
    const id = "00000000-0000-4000-c000-000000000010";
    await a.clientes.crear({ id, ...ANA, direccion: null, notas: null, creadoEn: new Date("2026-09-01T00:00:00Z"), consentimientoEn: null });
    expect((await c.listarClientes.ejecutar())[0]?.consentimientoEn).toBeNull();

    clock.avanzar(60);
    // solo el consentimiento cuenta como cambio
    expect(await c.actualizarCliente.ejecutar(id, { consentimiento: true })).toMatchObject({
      nombre: "Ana López",
      consentimientoEn: "2026-10-01T13:00:00.000Z",
    });

    clock.avanzar(60);
    const otraVez = await c.actualizarCliente.ejecutar(id, { notas: "Prefiere WhatsApp", consentimiento: true });
    expect(otraVez).toMatchObject({ notas: "Prefiere WhatsApp", consentimientoEn: "2026-10-01T13:00:00.000Z" });
    // editar sin consentimiento tampoco lo toca
    expect((await c.actualizarCliente.ejecutar(id, { notas: null })).consentimientoEn).toBe("2026-10-01T13:00:00.000Z");
  });

  it("PATCH con consentimiento distinto de true → VALIDACION (no se revoca editando)", async () => {
    const cliente = await c.crearCliente.ejecutar({ ...ANA, consentimiento: true });
    for (const consentimiento of [false, null, "si"]) {
      await expect(c.actualizarCliente.ejecutar(cliente.id, { notas: "x", consentimiento })).rejects.toMatchObject({
        code: "VALIDACION",
        regla: true,
      });
    }
    expect((await c.listarClientes.ejecutar())[0]).toMatchObject({ notas: null, consentimientoEn: cliente.consentimientoEn });
  });

  it("guardarCliente sin consentimientoCliente → VALIDACION y no se crea ni el envío ni el cliente", async () => {
    for (const consentimientoCliente of [undefined, false]) {
      await expect(
        c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio({ guardarCliente: true, consentimientoCliente })),
      ).rejects.toMatchObject({ code: "VALIDACION", regla: true, message: MENSAJE });
    }
    expect(await c.listarClientes.ejecutar()).toEqual([]);
    expect((await c.listarEnvios.ejecutar({})).total).toBe(0);
  });

  it("guardarCliente con consentimiento crea al cliente con la fecha; sin guardarCliente se ignora", async () => {
    const ocasional = await c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio({ consentimientoCliente: false }));
    expect(ocasional.clienteId).toBeNull();
    expect(await c.listarClientes.ejecutar()).toEqual([]);

    clock.avanzar(5);
    const e = await c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio({ guardarCliente: true, consentimientoCliente: true }));
    expect((await c.listarClientes.ejecutar())[0]).toMatchObject({
      id: e.clienteId,
      nombre: "María Pérez",
      consentimientoEn: "2026-10-01T12:05:00.000Z",
    });
  });

  it("guardarCliente reutilizando un cliente sin consentimiento lo registra en ese momento", async () => {
    const id = "00000000-0000-4000-c000-000000000011";
    // mismo teléfono que el remitente de solicitudEnvio(), cliente anterior a v7
    await a.clientes.crear({
      id, nombre: "María Pérez", telefono: "099 123 4567", direccion: null, notas: null,
      creadoEn: new Date("2026-09-01T00:00:00Z"), consentimientoEn: null,
    });
    clock.avanzar(30);
    const e = await c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio({ guardarCliente: true, consentimientoCliente: true }));
    expect(e.clienteId).toBe(id);
    expect((await a.clientes.buscarPorId(id))?.consentimientoEn).toEqual(new Date("2026-10-01T12:30:00Z"));

    // ya registrado: un nuevo envío no cambia la fecha original
    clock.avanzar(30);
    await c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio({ guardarCliente: true, consentimientoCliente: true }));
    expect((await a.clientes.buscarPorId(id))?.consentimientoEn).toEqual(new Date("2026-10-01T12:30:00Z"));
    expect(await c.listarClientes.ejecutar()).toHaveLength(1);
  });
});

describe("Ciudades de cobertura", () => {
  it("ADMIN agrega una ciudad, crea su ruta y queda en el catálogo público", async () => {
    const cayambe = await c.crearCiudad.ejecutar(ADMIN, "  Cayambe ");
    expect(cayambe).toMatchObject({ nombre: "Cayambe", activa: true });
    const ruta = await c.crearRuta.ejecutar(ADMIN, { origenId: 1, destinoId: cayambe.id, tiempoEstimadoMin: 75 });
    expect(ruta.operativa).toBe(true);
    expect(ruta).not.toHaveProperty("tarifaBase");

    const catalogo = await c.catalogoPublico.ejecutar();
    expect(catalogo.ciudades.map((x) => x.nombre)).toContain("Cayambe");
    expect(catalogo.rutas.map((r) => r.id)).toContain(ruta.id);
  });

  it("no permite nombres repetidos (sin distinguir mayúsculas) ni a OPERADOR", async () => {
    await expect(c.crearCiudad.ejecutar(ADMIN, "IBARRA")).rejects.toMatchObject({ code: "CONFLICTO" });
    await expect(c.actualizarCiudad.ejecutar(ADMIN, 2, { nombre: "otavalo" })).rejects.toMatchObject({ code: "CONFLICTO" });
    await expect(c.crearCiudad.ejecutar(OPERADOR, "Cayambe")).rejects.toMatchObject({ code: "PROHIBIDO" });
    await expect(c.crearCiudad.ejecutar(ADMIN, "X")).rejects.toMatchObject({ code: "VALIDACION" });
    // renombrar a su mismo nombre (cambiando mayúsculas) sí se permite
    expect((await c.actualizarCiudad.ejecutar(ADMIN, 2, { nombre: "ATUNTAQUI" })).nombre).toBe("ATUNTAQUI");
  });

  it("desactivar una ciudad deja sus rutas no operativas y bloquea nuevos envíos por ellas", async () => {
    await c.actualizarCiudad.ejecutar(ADMIN, 4, { activa: false }); // Quito
    const rutas = await c.listarRutas.ejecutar();
    const ibarraQuito = rutas.find((r) => r.id === 11)!;
    expect(ibarraQuito).toMatchObject({ activa: true, operativa: false, destino: { nombre: "Quito", activa: false } });
    expect((await c.listarRutas.ejecutar({ activa: true })).some((r) => r.id === 11)).toBe(false);
    await expect(c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio())).rejects.toMatchObject({ code: "RUTA_INACTIVA" });

    const catalogo = await c.catalogoPublico.ejecutar();
    expect(catalogo.ciudades.map((x) => x.nombre)).not.toContain("Quito");
    expect(catalogo.rutas.every((r) => r.origen.nombre !== "Quito" && r.destino.nombre !== "Quito")).toBe(true);

    await c.actualizarCiudad.ejecutar(ADMIN, 4, { activa: true });
    expect((await c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio())).estado).toBe("REGISTRADO");
  });

  it("solo elimina ciudades sin rutas", async () => {
    await expect(c.eliminarCiudad.ejecutar(ADMIN, 1)).rejects.toMatchObject({ code: "CONFLICTO" });
    const nueva = await c.crearCiudad.ejecutar(ADMIN, "Pimampiro");
    await c.eliminarCiudad.ejecutar(ADMIN, nueva.id);
    expect((await c.listarCiudades.ejecutar()).map((x) => x.nombre)).not.toContain("Pimampiro");
    await expect(c.eliminarCiudad.ejecutar(ADMIN, nueva.id)).rejects.toMatchObject({ code: "NO_ENCONTRADO" });
  });

  it("lista ordenado por nombre y filtra activas", async () => {
    await c.actualizarCiudad.ejecutar(ADMIN, 3, { activa: false });
    expect((await c.listarCiudades.ejecutar()).map((x) => x.nombre)).toEqual(["Atuntaqui", "Ibarra", "Otavalo", "Quito"]);
    expect((await c.listarCiudades.ejecutar({ activa: true })).map((x) => x.nombre)).toEqual(["Atuntaqui", "Ibarra", "Quito"]);
  });
});

describe("Gestión de rutas", () => {
  it("solo ADMIN crea o modifica rutas", async () => {
    await expect(c.actualizarRuta.ejecutar(OPERADOR, 1, { tiempoEstimadoMin: 50 })).rejects.toMatchObject({ code: "PROHIBIDO" });
    const ruta = await c.actualizarRuta.ejecutar(ADMIN, 1, { tiempoEstimadoMin: 50 });
    expect(ruta).toMatchObject({ id: 1, tiempoEstimadoMin: 50 });
    expect(ruta).not.toHaveProperty("tarifaBase");
    await expect(c.actualizarRuta.ejecutar(ADMIN, 1, { tiempoEstimadoMin: 0 })).rejects.toMatchObject({ code: "VALIDACION" });
  });

  it("no duplica rutas y valida ciudades", async () => {
    await expect(c.crearRuta.ejecutar(ADMIN, { origenId: 1, destinoId: 4, tiempoEstimadoMin: 180 })).rejects.toMatchObject({ code: "CONFLICTO" });
    await expect(c.crearRuta.ejecutar(ADMIN, { origenId: 1, destinoId: 99, tiempoEstimadoMin: 180 })).rejects.toMatchObject({ code: "NO_ENCONTRADO" });
  });

  it("siembra las rutas entre Ibarra, Atuntaqui, Otavalo y Quito", async () => {
    const rutas = await c.listarRutas.ejecutar();
    expect(rutas).toHaveLength(16);
    const ciudades = new Set(rutas.flatMap((r) => [r.origen.nombre, r.destino.nombre]));
    expect([...ciudades].sort()).toEqual(["Atuntaqui", "Ibarra", "Otavalo", "Quito"]);
  });
});
