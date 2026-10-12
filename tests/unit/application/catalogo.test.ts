import { beforeEach, describe, expect, it } from "vitest";
import type { NuevoTipoCarga } from "../../../src/application/use-cases/catalogo/TiposCarga.js";
import type { ContextoApi, NuevoEnvioApi } from "../../../src/application/use-cases/integraciones/ApiEmpresas.js";
import { MemoryCache } from "../../../src/infrastructure/cache/memoria.js";
import { adaptadoresEnMemoria, crearCasosDeUso, type Adaptadores, type CasosDeUso } from "../../../src/infrastructure/container.js";
import { ARTICULOS_SEED } from "../../../src/infrastructure/persistence/seed-data.js";
import { ADMIN, FakeClock, hasherFalso, JWT_SECRET_TEST, OPERADOR, SecuenciaIds, solicitudEnvio } from "../../helpers/fakes.js";

// Catálogo configurable (contrato v11) con adaptadores en memoria.

let c: CasosDeUso;
let a: Adaptadores;
let clock: FakeClock;

const caja: NuevoTipoCarga = {
  codigo: "CAJA_GRANDE",
  nombre: "Caja grande",
  precio: 5.5,
  precioRural: 6.25,
  mayoreo: { minimoExclusivo: 10, precio: 4.75 },
  pesoMaxKg: 40,
};

beforeEach(async () => {
  clock = new FakeClock();
  a = await adaptadoresEnMemoria({ jwtSecret: JWT_SECRET_TEST, hasher: hasherFalso, clock, ids: new SecuenciaIds() });
  c = crearCasosDeUso(a, new MemoryCache(clock));
});

describe("Tipos de carga: administración", () => {
  it("crear: ADMIN, al final del orden, con auditoría y entrada CREADO en el historial", async () => {
    const t = await c.crearTipoCarga.ejecutar(ADMIN, caja);
    expect(t).toEqual({
      ...caja,
      activo: true,
      orden: 8,
      actualizadoEn: clock.ahora().toISOString(),
      actualizadoPor: ADMIN.nombre,
    });
    const h = await c.historialTiposCarga.ejecutar(ADMIN, { codigo: "CAJA_GRANDE" });
    expect(h).toMatchObject({ total: 1, pagina: 1, porPagina: 20, totalPaginas: 1 });
    expect(h.datos[0]).toMatchObject({ codigo: "CAJA_GRANDE", accion: "CREADO", usuario: ADMIN.nombre, fecha: clock.ahora().toISOString() });
    expect(h.datos[0]!.cambios).toContainEqual({ campo: "precio", antes: null, despues: 5.5 });
  });

  it("crear: código o nombre (sin mayúsculas) repetidos → CONFLICTO; datos inválidos → VALIDACION", async () => {
    await expect(c.crearTipoCarga.ejecutar(ADMIN, { ...caja, codigo: "SOBRE" })).rejects.toMatchObject({ code: "CONFLICTO" });
    await expect(c.crearTipoCarga.ejecutar(ADMIN, { ...caja, nombre: "ROLLO DE TELA" })).rejects.toMatchObject({ code: "CONFLICTO" });
    await expect(c.crearTipoCarga.ejecutar(ADMIN, { ...caja, codigo: "caja" })).rejects.toMatchObject({ code: "VALIDACION" });
    await expect(c.crearTipoCarga.ejecutar(ADMIN, { ...caja, mayoreo: { minimoExclusivo: 10, precio: 5.5 } })).rejects.toMatchObject({
      code: "VALIDACION",
    });
    await expect(c.crearTipoCarga.ejecutar(ADMIN, { ...caja, precio: 2.555 })).rejects.toMatchObject({ code: "VALIDACION" });
  });

  it("solo ADMIN administra; cualquiera lista los activos; `todos` solo ADMIN", async () => {
    await expect(c.crearTipoCarga.ejecutar(OPERADOR, caja)).rejects.toMatchObject({ code: "PROHIBIDO" });
    await expect(c.actualizarTipoCarga.ejecutar(OPERADOR, "SOBRE", { precio: 4 })).rejects.toMatchObject({ code: "PROHIBIDO" });
    await expect(c.eliminarTipoCarga.ejecutar(OPERADOR, "SOBRE")).rejects.toMatchObject({ code: "PROHIBIDO" });
    await expect(c.reordenarTiposCarga.ejecutar(OPERADOR, [])).rejects.toMatchObject({ code: "PROHIBIDO" });
    await expect(c.historialTiposCarga.ejecutar(OPERADOR)).rejects.toMatchObject({ code: "PROHIBIDO" });
    await c.listarTiposCarga.ejecutar(ADMIN, { todos: true }); // queda en caché…
    await expect(c.listarTiposCarga.ejecutar(OPERADOR, { todos: true })).rejects.toMatchObject({ code: "PROHIBIDO" }); // …y no la ve
    expect(await c.listarTiposCarga.ejecutar(OPERADOR)).toHaveLength(7);
  });

  it("editar: valida el resultado completo, registra el diff y la acción; sin cambios no registra nada", async () => {
    // bajar el precio de la tela por debajo del de mayoreo (1.00) no se admite
    await expect(c.actualizarTipoCarga.ejecutar(ADMIN, "TELA", { precio: 1 })).rejects.toMatchObject({ code: "VALIDACION" });
    await expect(c.actualizarTipoCarga.ejecutar(ADMIN, "TELA", { nombre: "sobre" })).rejects.toMatchObject({ code: "CONFLICTO" });
    await expect(c.actualizarTipoCarga.ejecutar(ADMIN, "PIANO", { precio: 2 })).rejects.toMatchObject({ code: "NO_ENCONTRADO" });
    await expect(c.actualizarTipoCarga.ejecutar(ADMIN, "TELA", {})).rejects.toMatchObject({ code: "VALIDACION" });

    clock.avanzar(5);
    const t = await c.actualizarTipoCarga.ejecutar(ADMIN, "TELA", { precio: 1.3, mayoreo: null, nombre: "rollo de tela" });
    expect(t).toMatchObject({ precio: 1.3, mayoreo: null, nombre: "rollo de tela", actualizadoPor: ADMIN.nombre });
    clock.avanzar(5);
    await c.actualizarTipoCarga.ejecutar(ADMIN, "TELA", { activo: false });
    clock.avanzar(5);
    await c.actualizarTipoCarga.ejecutar(ADMIN, "TELA", { activo: true, precio: 1.3 }); // precio igual: solo activo
    await c.actualizarTipoCarga.ejecutar(ADMIN, "TELA", { precio: 1.3 }); // nada cambia

    const h = await c.historialTiposCarga.ejecutar(ADMIN, { codigo: "TELA" });
    expect(h.datos.map((x) => x.accion)).toEqual(["ACTIVADO", "DESACTIVADO", "MODIFICADO"]);
    expect(h.datos[2]!.cambios).toEqual([
      { campo: "nombre", antes: "Rollo de tela", despues: "rollo de tela" },
      { campo: "precio", antes: 1.25, despues: 1.3 },
      { campo: "mayoreo", antes: { minimoExclusivo: 50, precio: 1 }, despues: null },
    ]);
    expect(h.datos[1]!.cambios).toEqual([{ campo: "activo", antes: true, despues: false }]);
  });

  it("no se puede desactivar ni eliminar el último tipo activo (409)", async () => {
    const codigos = ["SOBRE", "PAQUETE", "CARTON", "VALIJA", "TELA", "PLUMON_PEQUENO"];
    for (const codigo of codigos) await c.actualizarTipoCarga.ejecutar(ADMIN, codigo, { activo: false });
    await expect(c.actualizarTipoCarga.ejecutar(ADMIN, "PLUMON_GRANDE", { activo: false })).rejects.toMatchObject({ code: "CONFLICTO" });
    await expect(c.eliminarTipoCarga.ejecutar(ADMIN, "PLUMON_GRANDE")).rejects.toMatchObject({ code: "CONFLICTO" });
    // eliminar uno inactivo sin envíos sí se puede
    await c.eliminarTipoCarga.ejecutar(ADMIN, "SOBRE");
    expect(await c.listarTiposCarga.ejecutar(ADMIN, { todos: true })).toHaveLength(6);
  });

  it("eliminar: 409 si algún envío lo usa (se desactiva); sin envíos se elimina y queda en el historial", async () => {
    await c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio()); // un PAQUETE
    await expect(c.eliminarTipoCarga.ejecutar(ADMIN, "PAQUETE")).rejects.toMatchObject({ code: "CONFLICTO" });
    await c.crearTipoCarga.ejecutar(ADMIN, caja);
    await c.eliminarTipoCarga.ejecutar(ADMIN, "CAJA_GRANDE");
    await expect(c.eliminarTipoCarga.ejecutar(ADMIN, "CAJA_GRANDE")).rejects.toMatchObject({ code: "NO_ENCONTRADO" });
    const h = await c.historialTiposCarga.ejecutar(ADMIN, { codigo: "CAJA_GRANDE" });
    expect(h.datos.map((x) => x.accion)).toEqual(["ELIMINADO", "CREADO"]);
    expect(h.datos[0]!.cambios).toContainEqual({ campo: "precio", antes: 5.5, despues: null });
  });

  it("reordenar: exige todos los códigos sin repetir; registra solo los que cambian", async () => {
    const actuales = (await c.listarTiposCarga.ejecutar(ADMIN, { todos: true })).map((t) => t.codigo);
    await expect(c.reordenarTiposCarga.ejecutar(ADMIN, actuales.slice(1))).rejects.toMatchObject({ code: "VALIDACION", regla: true });
    await expect(c.reordenarTiposCarga.ejecutar(ADMIN, [...actuales.slice(1), "PIANO"])).rejects.toMatchObject({ code: "VALIDACION" });
    await expect(c.reordenarTiposCarga.ejecutar(ADMIN, [...actuales, "SOBRE"])).rejects.toMatchObject({ code: "VALIDACION" });

    const nuevo = ["PAQUETE", "SOBRE", ...actuales.slice(2)];
    const r = await c.reordenarTiposCarga.ejecutar(ADMIN, nuevo);
    expect(r.map((t) => [t.codigo, t.orden])).toEqual(nuevo.map((cod, i) => [cod, i + 1]));
    expect((await c.listarTiposCarga.ejecutar(OPERADOR)).map((t) => t.codigo)).toEqual(nuevo);
    const h = await c.historialTiposCarga.ejecutar(ADMIN, {}, { porPagina: 1 });
    expect(h).toMatchObject({ total: 2, totalPaginas: 2, porPagina: 1 });
    expect(h.datos[0]).toMatchObject({ accion: "MODIFICADO", codigo: "SOBRE", cambios: [{ campo: "orden", antes: 1, despues: 2 }] });
  });
});

describe("Tipos de carga: uso en cotizaciones y envíos", () => {
  it("un tipo nuevo se cotiza y se usa en un envío con su precio, precio rural y mayoreo", async () => {
    await c.crearTipoCarga.ejecutar(ADMIN, caja);
    const item = (cantidad: number) => ({ tipoCarga: "CAJA_GRANDE", cantidad, pesoKg: 20 });
    expect((await c.cotizar.ejecutar({ rutaId: 11, items: [item(2)] })).costo).toBe(11);
    expect((await c.cotizar.ejecutar({ rutaId: 11, items: [item(2)], zona: "RURAL" })).costo).toBe(12.5);
    const e = await c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio({ items: [item(6), item(5)] }));
    expect(e).toMatchObject({ costo: 52.25, items: [{ costoUnitario: 4.75, subtotal: 28.5 }, { costoUnitario: 4.75, subtotal: 23.75 }] });
    await expect(c.cotizar.ejecutar({ rutaId: 11, items: [{ ...item(1), pesoKg: 41 }] })).rejects.toMatchObject({ code: "PESO_INVALIDO" });
    // aparece en el dashboard
    expect((await c.resumen.ejecutar()).porTipo).toContainEqual({ tipoCarga: "CAJA_GRANDE", piezas: 11 });
  });

  it("un envío ya registrado conserva su costo al cambiar la tarifa; los nuevos usan la vigente", async () => {
    const viejo = await c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio({ items: [{ tipoCarga: "PAQUETE", cantidad: 2, pesoKg: 3 }] }));
    expect(viejo.costo).toBe(6);
    await c.actualizarTipoCarga.ejecutar(ADMIN, "PAQUETE", { precio: 4.5, pesoMaxKg: 2 });
    expect(await c.obtenerEnvio.ejecutar(viejo.id)).toMatchObject({ costo: 6, items: [{ costoUnitario: 3, subtotal: 6, pesoKg: 3 }] });
    const nuevo = await c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio({ items: [{ tipoCarga: "PAQUETE", cantidad: 2, pesoKg: 2 }] }));
    expect(nuevo.costo).toBe(9);
  });

  it("tipo inactivo → TIPO_CARGA_INACTIVO al cotizar y crear; inexistente → VALIDACION (422)", async () => {
    await c.actualizarTipoCarga.ejecutar(ADMIN, "VALIJA", { activo: false });
    const items = [{ tipoCarga: "VALIJA", cantidad: 1, pesoKg: 2 }];
    await expect(c.cotizar.ejecutar({ rutaId: 11, items })).rejects.toMatchObject({ code: "TIPO_CARGA_INACTIVO" });
    await expect(c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio({ items }))).rejects.toMatchObject({ code: "TIPO_CARGA_INACTIVO" });
    await expect(c.cotizar.ejecutar({ rutaId: 11, items: [{ tipoCarga: "PIANO", cantidad: 1, pesoKg: 1 }] })).rejects.toMatchObject({
      code: "VALIDACION",
      regla: true,
    });
    // inactivo no se ofrece: ni en el panel, ni en el catálogo público, ni en el dashboard (si no tiene piezas)
    expect((await c.listarTiposCarga.ejecutar(OPERADOR)).map((t) => t.codigo)).not.toContain("VALIJA");
    expect((await c.catalogoPublico.ejecutar()).tiposCarga.map((t) => t.codigo)).not.toContain("VALIJA");
    expect((await c.resumen.ejecutar()).porTipo.map((t) => t.tipoCarga)).not.toContain("VALIJA");
    // reactivado se vuelve a poder usar
    await c.actualizarTipoCarga.ejecutar(ADMIN, "VALIJA", { activo: true });
    expect((await c.cotizar.ejecutar({ rutaId: 11, items })).costo).toBe(3);
  });

  it("API de empresas: cobertura lista solo los activos; inactivo → 422 en cotizar, crear, lote y modo prueba", async () => {
    const integracion = await c.crearIntegracion.ejecutar(ADMIN, {
      nombre: "Tienda Andina",
      remitente: { nombre: "Tienda Andina S.A.", telefono: "062600100", direccion: "Bolívar 1-23, Ibarra" },
      ciudadOrigenId: 1,
    });
    const ctx = async (modo: "live" | "test"): Promise<ContextoApi> => {
      const { key } = await c.crearApiKey.ejecutar(ADMIN, integracion.id, { nombre: modo, modo, alcances: ["envios:crear", "cotizar"] });
      return c.autenticarApiKey.ejecutar(key);
    };
    const [live, prueba] = [await ctx("live"), await ctx("test")];
    const envio = (ref: string, tipoCarga: string): NuevoEnvioApi => ({
      referenciaExterna: ref,
      destinatario: { nombre: "Rosa", telefono: "0991234567", direccion: "Av. Amazonas", ciudad: "Quito" },
      items: [{ tipoCarga, cantidad: 1, pesoKg: 1 }],
    });

    await c.actualizarTipoCarga.ejecutar(ADMIN, "SOBRE", { activo: false });
    const cobertura = await c.coberturaApi.ejecutar(live);
    expect(cobertura.tiposCarga.map((t) => t.codigo)).toEqual(["PAQUETE", "CARTON", "VALIJA", "TELA", "PLUMON_PEQUENO", "PLUMON_GRANDE"]);
    expect(cobertura.tiposCarga[0]).toEqual({ codigo: "PAQUETE", nombre: "Paquete", precio: 3, precioRural: null, mayoreo: null, pesoMaxKg: 50 });

    const sobre = [{ tipoCarga: "SOBRE", cantidad: 1, pesoKg: 0.2 }];
    await expect(c.cotizarApi.ejecutar(live, { destino: { ciudad: "Quito" }, items: sobre })).rejects.toMatchObject({ code: "TIPO_CARGA_INACTIVO" });
    await expect(c.crearEnvioApi.ejecutar(live, envio("P-1", "SOBRE"))).rejects.toMatchObject({ code: "TIPO_CARGA_INACTIVO" });
    await expect(c.crearEnvioApi.ejecutar(prueba, envio("P-1", "SOBRE"))).rejects.toMatchObject({ code: "TIPO_CARGA_INACTIVO" });
    await expect(c.crearEnvioApi.ejecutar(live, envio("P-1", "PIANO"))).rejects.toMatchObject({ code: "VALIDACION" });
    const lote = await c.crearLoteApi.ejecutar(live, [
      { ok: true, datos: envio("L-1", "PAQUETE") },
      { ok: true, datos: envio("L-2", "SOBRE") },
      { ok: true, datos: envio("L-3", "PIANO") },
    ]);
    expect(lote).toMatchObject({ creados: 1, fallidos: 2 });
    expect(lote.resultados.map((r) => (r.ok ? "ok" : r.error.code))).toEqual(["ok", "TIPO_CARGA_INACTIVO", "VALIDACION"]);

    // un tipo nuevo se puede usar enseguida desde la API
    await c.crearTipoCarga.ejecutar(ADMIN, caja);
    expect((await c.coberturaApi.ejecutar(live)).tiposCarga.map((t) => t.codigo)).toContain("CAJA_GRANDE");
    expect((await c.crearEnvioApi.ejecutar(live, envio("P-2", "CAJA_GRANDE"))).costo).toBe(5.5);
  });
});

describe("Artículos restringidos", () => {
  it("CRUD de ADMIN: crear al final de su categoría, editar, cambiar de categoría y eliminar", async () => {
    clock.avanzar(1);
    const nuevo = await c.crearArticulo.ejecutar(ADMIN, { categoria: "PROHIBIDO", titulo: "Baterías de litio", detalle: "Sueltas.", icono: "bateria" });
    expect(nuevo).toEqual({
      id: expect.any(String),
      categoria: "PROHIBIDO",
      titulo: "Baterías de litio",
      detalle: "Sueltas.",
      icono: "bateria",
      activo: true,
      orden: 10,
      actualizadoEn: clock.ahora().toISOString(),
      actualizadoPor: ADMIN.nombre,
    });
    const editado = await c.actualizarArticulo.ejecutar(ADMIN, nuevo.id, { categoria: "NOTA", titulo: "Las baterías van aparte" });
    expect(editado).toMatchObject({ categoria: "NOTA", icono: null, orden: 3, titulo: "Las baterías van aparte", detalle: "Sueltas." });
    await expect(c.actualizarArticulo.ejecutar(ADMIN, nuevo.id, { titulo: "X" })).rejects.toMatchObject({ code: "VALIDACION" });
    await expect(c.actualizarArticulo.ejecutar(ADMIN, nuevo.id, {})).rejects.toMatchObject({ code: "VALIDACION" });
    await c.eliminarArticulo.ejecutar(ADMIN, nuevo.id);
    await expect(c.eliminarArticulo.ejecutar(ADMIN, nuevo.id)).rejects.toMatchObject({ code: "NO_ENCONTRADO" });
    await expect(c.actualizarArticulo.ejecutar(ADMIN, nuevo.id, { activo: false })).rejects.toMatchObject({ code: "NO_ENCONTRADO" });
  });

  it("público: solo activos, por categoría y orden; el ADMIN ve todos", async () => {
    const publicos = await c.articulosPublicos.ejecutar();
    expect(publicos).toHaveLength(14);
    expect(publicos.map((x) => x.id)).toEqual(ARTICULOS_SEED.map((x) => x.id));
    await c.actualizarArticulo.ejecutar(ADMIN, ARTICULOS_SEED[0]!.id, { activo: false });
    expect((await c.articulosPublicos.ejecutar()).map((x) => x.id)).not.toContain(ARTICULOS_SEED[0]!.id); // caché invalidada
    expect(await c.listarArticulos.ejecutar(ADMIN)).toHaveLength(14);
  });

  it("reordenar por categoría: exige todos los ids de esa categoría", async () => {
    const condicionados = ARTICULOS_SEED.filter((x) => x.categoria === "CONDICIONADO").map((x) => x.id);
    await expect(c.reordenarArticulos.ejecutar(ADMIN, "CONDICIONADO", condicionados.slice(1))).rejects.toMatchObject({ code: "VALIDACION" });
    await expect(c.reordenarArticulos.ejecutar(ADMIN, "NOTA", condicionados)).rejects.toMatchObject({ code: "VALIDACION" });
    const invertido = [...condicionados].reverse();
    const r = await c.reordenarArticulos.ejecutar(ADMIN, "CONDICIONADO", invertido);
    expect(r.map((x) => [x.id, x.orden])).toEqual(invertido.map((id, i) => [id, i + 1]));
    expect((await c.articulosPublicos.ejecutar()).filter((x) => x.categoria === "CONDICIONADO").map((x) => x.id)).toEqual(invertido);
  });

  it("solo ADMIN gestiona los artículos", async () => {
    const id = ARTICULOS_SEED[0]!.id;
    await expect(c.listarArticulos.ejecutar(OPERADOR)).rejects.toMatchObject({ code: "PROHIBIDO" });
    await expect(c.crearArticulo.ejecutar(OPERADOR, { categoria: "NOTA", titulo: "Hola" })).rejects.toMatchObject({ code: "PROHIBIDO" });
    await expect(c.actualizarArticulo.ejecutar(OPERADOR, id, { activo: false })).rejects.toMatchObject({ code: "PROHIBIDO" });
    await expect(c.eliminarArticulo.ejecutar(OPERADOR, id)).rejects.toMatchObject({ code: "PROHIBIDO" });
    await expect(c.reordenarArticulos.ejecutar(OPERADOR, "NOTA", [])).rejects.toMatchObject({ code: "PROHIBIDO" });
  });
});
