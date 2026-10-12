import { beforeEach, describe, expect, it } from "vitest";
import type { ClienteWebhook, MensajeWebhook } from "../../../src/application/ports/integraciones.js";
import type { ContextoApi, NuevoEnvioApi } from "../../../src/application/use-cases/integraciones/ApiEmpresas.js";
import type { ResultadoEnvioWebhook } from "../../../src/domain/integracion/Webhook.js";
import { adaptadoresEnMemoria, crearCasosDeUso, type Adaptadores, type CasosDeUso } from "../../../src/infrastructure/container.js";
import { CifradorNoConfigurado } from "../../../src/infrastructure/security/cifrado.js";
import { ADMIN, FakeClock, hasherFalso, JWT_SECRET_TEST, OPERADOR, SecuenciaIds } from "../../helpers/fakes.js";

/** Cliente de webhooks falso: responde lo que se le indique y guarda lo que "envió". */
class ClienteWebhookFalso implements ClienteWebhook {
  enviados: MensajeWebhook[] = [];
  respuesta: ResultadoEnvioWebhook = { ok: true, status: 200, error: null };
  async enviar(m: MensajeWebhook): Promise<ResultadoEnvioWebhook> {
    this.enviados.push(m);
    return this.respuesta;
  }
}

let c: CasosDeUso;
let a: Adaptadores;
let clock: FakeClock;
let webhooks: ClienteWebhookFalso;

const datosIntegracion = {
  nombre: "Tienda Andina",
  remitente: { nombre: "Tienda Andina S.A.", telefono: "062600100", direccion: "Bolívar 1-23, Ibarra" },
  ciudadOrigenId: 1, // Ibarra
};

const nuevoEnvio = (sobre: Partial<NuevoEnvioApi> = {}): NuevoEnvioApi => ({
  referenciaExterna: "PED-1",
  destinatario: { nombre: "Rosa Cevallos", telefono: "0991234567", direccion: "Av. Amazonas N24-56", ciudad: "quito" },
  items: [{ tipoCarga: "PAQUETE", cantidad: 2, pesoKg: 3 }],
  ...sobre,
});

async function crearConKey(modo: "live" | "test" = "live", alcances = ["envios:crear", "envios:leer", "cotizar"]) {
  const integracion = await c.crearIntegracion.ejecutar(ADMIN, datosIntegracion);
  const { key } = await c.crearApiKey.ejecutar(ADMIN, integracion.id, { nombre: "Principal", modo, alcances });
  return { integracion, key, ctx: await c.autenticarApiKey.ejecutar(key) };
}

beforeEach(async () => {
  clock = new FakeClock();
  webhooks = new ClienteWebhookFalso();
  a = await adaptadoresEnMemoria({ jwtSecret: JWT_SECRET_TEST, hasher: hasherFalso, clock, ids: new SecuenciaIds(), clienteWebhook: webhooks });
  c = crearCasosDeUso(a, undefined, { publicUrl: "https://pcargo.example/" });
});

describe("Administración de integraciones", () => {
  it("solo ADMIN; nombre único; ciudad de origen activa", async () => {
    await expect(c.crearIntegracion.ejecutar(OPERADOR, datosIntegracion)).rejects.toMatchObject({ code: "PROHIBIDO" });
    const i = await c.crearIntegracion.ejecutar(ADMIN, datosIntegracion);
    expect(i).toMatchObject({ nombre: "Tienda Andina", activa: true, ciudadOrigen: "Ibarra", formaPagoPorDefecto: "CONTRATO", keys: [], webhook: null, envios: 0 });
    await expect(c.crearIntegracion.ejecutar(ADMIN, { ...datosIntegracion, nombre: "TIENDA ANDINA" })).rejects.toMatchObject({ code: "CONFLICTO" });
    await expect(c.crearIntegracion.ejecutar(ADMIN, { ...datosIntegracion, nombre: "Otra", ciudadOrigenId: 99 })).rejects.toMatchObject({
      code: "VALIDACION",
      regla: true,
    });
    await expect(c.actualizarIntegracion.ejecutar(ADMIN, i.id, {})).rejects.toMatchObject({ code: "VALIDACION" });
    expect(await c.actualizarIntegracion.ejecutar(ADMIN, i.id, { activa: false })).toMatchObject({ activa: false });
  });

  it("la key se muestra una sola vez; se guarda solo prefijo y hash", async () => {
    const i = await c.crearIntegracion.ejecutar(ADMIN, datosIntegracion);
    const r = await c.crearApiKey.ejecutar(ADMIN, i.id, { nombre: "Prod", modo: "live", alcances: ["cotizar"] });
    expect(r.key).toMatch(/^pc_live_[0-9A-Za-z]{8}_[0-9A-Za-z]{32}$/);
    expect(r.apiKey).toMatchObject({ nombre: "Prod", modo: "live", prefijo: r.key.slice(0, 16), alcances: ["cotizar"], revocadaEn: null });
    const guardada = (await a.integraciones.buscarPorId(i.id))!.keys[0]!;
    expect(JSON.stringify(guardada)).not.toContain(r.key.slice(17));
    expect(JSON.stringify(await c.obtenerIntegracion.ejecutar(ADMIN, i.id))).not.toContain(guardada.hash);
  });

  it("webhook: el secreto se genera al configurarlo por primera vez y al rotarlo; se guarda cifrado", async () => {
    const i = await c.crearIntegracion.ejecutar(ADMIN, datosIntegracion);
    const datos = { url: "https://tienda.example/hooks", eventos: ["envio.creado"], activo: true };
    const primera = await c.configurarWebhook.ejecutar(ADMIN, i.id, datos);
    expect(primera.secreto).toMatch(/^whsec_/);
    expect(primera.integracion.webhook).toEqual({ ...datos, secretoPrefijo: primera.secreto!.slice(0, 10) });
    const guardado = (await a.integraciones.buscarPorId(i.id))!.webhook!;
    expect(guardado.secretoCifrado).not.toContain(primera.secreto!.slice(6));
    expect(a.cifrador.descifrar(guardado.secretoCifrado)).toBe(primera.secreto);

    expect((await c.configurarWebhook.ejecutar(ADMIN, i.id, { ...datos, activo: false })).secreto).toBeNull();
    const { secreto } = await c.rotarSecretoWebhook.ejecutar(ADMIN, i.id);
    expect(secreto).not.toBe(primera.secreto);
    await expect(c.configurarWebhook.ejecutar(ADMIN, i.id, { ...datos, url: "http://tienda.example" })).rejects.toMatchObject({ code: "VALIDACION" });
    await c.eliminarWebhook.ejecutar(ADMIN, i.id);
    await expect(c.rotarSecretoWebhook.ejecutar(ADMIN, i.id)).rejects.toMatchObject({ code: "NO_ENCONTRADO" });
  });

  it("sin clave de cifrado configurar el webhook falla con SERVICIO_NO_CONFIGURADO", async () => {
    const sin = crearCasosDeUso({ ...a, cifrador: new CifradorNoConfigurado() });
    const i = await sin.crearIntegracion.ejecutar(ADMIN, datosIntegracion);
    await expect(
      sin.configurarWebhook.ejecutar(ADMIN, i.id, { url: "https://tienda.example/h", eventos: ["envio.creado"], activo: true }),
    ).rejects.toMatchObject({ code: "SERVICIO_NO_CONFIGURADO" });
  });
});

describe("Autenticación con API key", () => {
  it("formato inválido, inexistente, revocada o JWT → el mismo API_KEY_INVALIDA", async () => {
    const { integracion, key } = await crearConKey();
    const token = c.tokens.firmar(ADMIN);
    const otra = `${key.slice(0, 17)}${"Z".repeat(32)}`; // prefijo real, secreto falso
    for (const k of [undefined, "", "basura", token, otra, key.replace("pc_live_", "pc_test_")]) {
      await expect(c.autenticarApiKey.ejecutar(k)).rejects.toMatchObject({ code: "API_KEY_INVALIDA", message: "API key inválida o revocada" });
    }
    const keyId = (await c.obtenerIntegracion.ejecutar(ADMIN, integracion.id)).keys[0]!.id;
    await c.revocarApiKey.ejecutar(ADMIN, integracion.id, keyId);
    await expect(c.autenticarApiKey.ejecutar(key)).rejects.toMatchObject({ code: "API_KEY_INVALIDA", message: "API key inválida o revocada" });
  });

  it("integración inactiva → INTEGRACION_INACTIVA; registra el último uso (como mucho una vez por minuto)", async () => {
    const { integracion, key } = await crearConKey();
    expect((await c.obtenerIntegracion.ejecutar(ADMIN, integracion.id)).keys[0]!.ultimoUsoEn).toBe(clock.ahora().toISOString());
    clock.avanzar(0.5);
    await c.autenticarApiKey.ejecutar(key);
    expect((await c.obtenerIntegracion.ejecutar(ADMIN, integracion.id)).keys[0]!.ultimoUsoEn).not.toBe(clock.ahora().toISOString());
    clock.avanzar(1);
    await c.autenticarApiKey.ejecutar(key);
    expect((await c.obtenerIntegracion.ejecutar(ADMIN, integracion.id)).keys[0]!.ultimoUsoEn).toBe(clock.ahora().toISOString());
    await c.actualizarIntegracion.ejecutar(ADMIN, integracion.id, { activa: false });
    await expect(c.autenticarApiKey.ejecutar(key)).rejects.toMatchObject({ code: "INTEGRACION_INACTIVA" });
  });
});

describe("API para empresas", () => {
  it("crea el envío con la MISMA tarifa del panel, remitente y origen de la integración", async () => {
    const { ctx, integracion } = await crearConKey();
    const items = [{ tipoCarga: "TELA", cantidad: 60, pesoKg: 2 }, { tipoCarga: "PAQUETE", cantidad: 1, pesoKg: 3 }];
    const envio = await c.crearEnvioApi.ejecutar(ctx, nuevoEnvio({ items, zona: "RURAL" }));
    const panel = await c.cotizar.ejecutar({ rutaId: 11, items, zona: "RURAL" });
    expect(envio).toMatchObject({
      referenciaExterna: "PED-1",
      prueba: false,
      estado: "REGISTRADO",
      origen: "Ibarra",
      destino: "Quito",
      costo: panel.costo,
      formaPago: "CONTRATO",
      zona: "RURAL",
      seguimientoUrl: `https://pcargo.example/seguimiento/${envio.numeroGuia}`,
    });
    expect(envio.costo).toBe(63); // 60 rollos a 1.00 (mayoreo) + 1 paquete a 3.00
    const guardado = (await a.envios.buscarPorReferencia(integracion.id, "PED-1"))!;
    expect(guardado.origen).toEqual({ canal: "API", integracionId: integracion.id, integracion: "Tienda Andina" });
    expect(guardado.toSnapshot().remitente).toEqual(datosIntegracion.remitente);
    expect(guardado.historial[0]).toMatchObject({ nota: "Ingresado por API: Tienda Andina", usuario: null });
  });

  it("ciudad sin ruta operativa → RUTA_NO_DISPONIBLE; referencia repetida → CONFLICTO con el envío existente", async () => {
    const { ctx } = await crearConKey();
    await expect(c.crearEnvioApi.ejecutar(ctx, nuevoEnvio({ destinatario: { ...nuevoEnvio().destinatario, ciudad: "Cuenca" } }))).rejects.toMatchObject({
      code: "RUTA_NO_DISPONIBLE",
    });
    await c.actualizarRuta.ejecutar(ADMIN, 11, { activa: false });
    await expect(c.crearEnvioApi.ejecutar(ctx, nuevoEnvio())).rejects.toMatchObject({ code: "RUTA_NO_DISPONIBLE" });
    await c.actualizarRuta.ejecutar(ADMIN, 11, { activa: true });

    const primero = await c.crearEnvioApi.ejecutar(ctx, nuevoEnvio());
    await expect(c.crearEnvioApi.ejecutar(ctx, nuevoEnvio())).rejects.toMatchObject({
      code: "CONFLICTO",
      detalles: { envio: { numeroGuia: primero.numeroGuia, referenciaExterna: "PED-1" } },
    });
  });

  it("modo prueba: valida y cotiza igual, pero no guarda ni dispara webhooks; consultar responde 404", async () => {
    const { ctx, integracion } = await crearConKey("test");
    await c.configurarWebhook.ejecutar(ADMIN, integracion.id, { url: "https://tienda.example/h", eventos: ["envio.creado"], activo: true });
    const envio = await c.crearEnvioApi.ejecutar(ctx, nuevoEnvio());
    expect(envio).toMatchObject({ prueba: true, numeroGuia: 0, costo: 6, id: expect.stringMatching(/^prueba_/) });
    expect(await a.envios.listar()).toEqual([]);
    expect((await a.entregasWebhook.listarPagina(integracion.id, {}, { pagina: 1, porPagina: 10 })).total).toBe(0);
    await expect(c.crearEnvioApi.ejecutar(ctx, nuevoEnvio({ items: [{ tipoCarga: "SOBRE", cantidad: 1, pesoKg: 2 }] }))).rejects.toMatchObject({
      code: "PESO_INVALIDO",
    });
    await expect(c.consultarEnvioApi.ejecutar(ctx, "PED-1")).rejects.toMatchObject({ code: "NO_ENCONTRADO" });
  });

  it("alcance insuficiente → ALCANCE_INSUFICIENTE; cobertura con cualquier alcance", async () => {
    const { ctx } = await crearConKey("live", ["cotizar"]);
    await expect(c.crearEnvioApi.ejecutar(ctx, nuevoEnvio())).rejects.toMatchObject({ code: "ALCANCE_INSUFICIENTE" });
    await expect(c.consultarEnvioApi.ejecutar(ctx, "PED-1")).rejects.toMatchObject({ code: "ALCANCE_INSUFICIENTE" });
    const cobertura = await c.coberturaApi.ejecutar(ctx);
    expect(cobertura.origen).toBe("Ibarra");
    expect(cobertura.destinos.map((d) => d.ciudad)).toEqual(["Atuntaqui", "Ibarra", "Otavalo", "Quito"]);
    expect((await c.cotizarApi.ejecutar(ctx, { destino: { ciudad: "OTÁVALO" }, items: [{ tipoCarga: "VALIJA", cantidad: 2, pesoKg: 5 }] })).costo).toBe(6);
  });

  it("lote no atómico: crea los válidos y reporta cada error por índice", async () => {
    const { ctx } = await crearConKey();
    const r = await c.crearLoteApi.ejecutar(ctx, [
      { ok: true, datos: nuevoEnvio({ referenciaExterna: "L-1" }) },
      { ok: false, error: { code: "VALIDACION", message: "items: requerido" } },
      { ok: true, datos: nuevoEnvio({ referenciaExterna: "L-1" }) },
      { ok: true, datos: nuevoEnvio({ referenciaExterna: "L-3", destinatario: { ...nuevoEnvio().destinatario, ciudad: "Lima" } }) },
      { ok: true, datos: nuevoEnvio({ referenciaExterna: "L-4" }) },
    ]);
    expect(r.creados).toBe(2);
    expect(r.fallidos).toBe(3);
    expect(r.resultados.map((x) => (x.ok ? "ok" : x.error.code))).toEqual(["ok", "VALIDACION", "CONFLICTO", "RUTA_NO_DISPONIBLE", "ok"]);
    expect(r.resultados[2]).toMatchObject({ error: { envio: { referenciaExterna: "L-1" } } });
  });
});

describe("Idempotencia (caso de uso)", () => {
  it("replay de la misma respuesta, conflicto con otra huella y libera la clave ante un error inesperado", async () => {
    const { ctx } = await crearConKey();
    const clave = { integracionId: ctx.integracion.id, modo: ctx.key.modo, clave: "k-1" };
    let llamadas = 0;
    const procesar = async () => ({ status: 201, cuerpo: `{"n":${++llamadas}}` });
    expect(await c.ejecutarIdempotente.ejecutar(clave, "h", procesar)).toEqual({ respuesta: { status: 201, cuerpo: '{"n":1}' }, repetida: false });
    expect(await c.ejecutarIdempotente.ejecutar(clave, "h", procesar)).toEqual({ respuesta: { status: 201, cuerpo: '{"n":1}' }, repetida: true });
    expect(llamadas).toBe(1);
    await expect(c.ejecutarIdempotente.ejecutar(clave, "otra", procesar)).rejects.toMatchObject({ code: "IDEMPOTENCIA_CONFLICTO" });

    const otra = { ...clave, clave: "k-2" };
    await expect(c.ejecutarIdempotente.ejecutar(otra, "h", async () => { throw new Error("BD caída"); })).rejects.toThrow("BD caída");
    expect((await c.ejecutarIdempotente.ejecutar(otra, "h2", procesar)).repetida).toBe(false);
  });
});

describe("Webhooks (outbox y despachador)", () => {
  async function conWebhook(eventos = ["envio.creado", "envio.estado_actualizado"]) {
    const r = await crearConKey();
    const { secreto } = await c.configurarWebhook.ejecutar(ADMIN, r.integracion.id, { url: "https://tienda.example/h", eventos, activo: true });
    return { ...r, secreto: secreto! };
  }
  const pendientes = (ctx: ContextoApi) => a.entregasWebhook.listarPagina(ctx.integracion.id, {}, { pagina: 1, porPagina: 50 });

  it("encola solo los eventos suscritos de envíos de la integración (no los del panel) y los entrega firmados con el secreto", async () => {
    const { ctx, secreto } = await conWebhook(["envio.estado_actualizado"]);
    const envio = await c.crearEnvioApi.ejecutar(ctx, nuevoEnvio());
    expect((await pendientes(ctx)).total).toBe(0); // no suscrito a envio.creado
    await c.cambiarEstado.ejecutar(OPERADOR, envio.id, "EN_TRANSITO");
    const panel = await c.crearEnvio.ejecutar(OPERADOR, {
      remitente: { nombre: "Ana", telefono: "0991112233" },
      destinatario: { nombre: "Luis", telefono: "0987654321", direccion: "Quito" },
      rutaId: 11,
      items: [{ tipoCarga: "SOBRE", cantidad: 1, pesoKg: 0.2 }],
      formaPago: "PAGADO",
    });
    await c.cambiarEstado.ejecutar(OPERADOR, panel.id, "EN_TRANSITO");
    const lista = await pendientes(ctx);
    expect(lista.entregas.map((e) => [e.evento, e.envioId, e.estado])).toEqual([["envio.estado_actualizado", envio.id, "PENDIENTE"]]);

    expect(await c.despacharWebhooks.ejecutar()).toBe(1);
    const enviado = webhooks.enviados[0]!;
    expect(enviado).toMatchObject({ url: "https://tienda.example/h", secreto, id: lista.entregas[0]!.mensajeId });
    const cuerpo = JSON.parse(enviado.cuerpo);
    expect(cuerpo).toMatchObject({ type: "envio.estado_actualizado", data: { referenciaExterna: "PED-1", estado: "EN_TRANSITO" } });
    expect(JSON.stringify(cuerpo)).not.toContain(OPERADOR.nombre); // sin nombres de operadores
    expect((await pendientes(ctx)).entregas[0]).toMatchObject({ estado: "ENTREGADO", intentos: 1, ultimoStatus: 200 });
    expect(await c.despacharWebhooks.ejecutar()).toBe(0);
  });

  it("reintenta con espera creciente y tras 8 intentos queda FALLIDO; el reintento manual lo entrega", async () => {
    const { ctx } = await conWebhook();
    await c.crearEnvioApi.ejecutar(ctx, nuevoEnvio());
    webhooks.respuesta = { ok: false, status: 503, error: "HTTP 503" };
    const esperas = [1, 5, 30, 120, 360, 720, 1440];
    expect(await c.despacharWebhooks.ejecutar()).toBe(1);
    for (const min of esperas) {
      clock.avanzar(min - 0.5);
      expect(await c.despacharWebhooks.ejecutar()).toBe(0); // todavía no toca
      clock.avanzar(0.5);
      expect(await c.despacharWebhooks.ejecutar()).toBe(1);
    }
    const [entrega] = (await pendientes(ctx)).entregas;
    expect(entrega).toMatchObject({ estado: "FALLIDO", intentos: 8, ultimoStatus: 503, ultimoError: "HTTP 503", proximoIntentoEn: null });
    expect(new Set(webhooks.enviados.map((m) => m.id)).size).toBe(1); // mismo webhook-id en todos los reintentos

    webhooks.respuesta = { ok: true, status: 204, error: null };
    expect(await c.reintentarEntregaWebhook.ejecutar(ADMIN, ctx.integracion.id, entrega!.id)).toMatchObject({ estado: "ENTREGADO", intentos: 9 });
    await expect(c.reintentarEntregaWebhook.ejecutar(ADMIN, ctx.integracion.id, entrega!.id)).rejects.toMatchObject({ code: "ESTADO_INVALIDO" });
  });

  it("si el webhook se elimina, las entregas pendientes quedan FALLIDO sin más reintentos", async () => {
    const { ctx } = await conWebhook();
    await c.crearEnvioApi.ejecutar(ctx, nuevoEnvio());
    await c.eliminarWebhook.ejecutar(ADMIN, ctx.integracion.id);
    await c.despacharWebhooks.ejecutar();
    expect((await pendientes(ctx)).entregas[0]).toMatchObject({ estado: "FALLIDO", intentos: 1, ultimoError: expect.stringMatching(/eliminado/) });
    expect(webhooks.enviados).toEqual([]);
  });

  it("evento de prueba: un intento inmediato con data.prueba = true", async () => {
    const { ctx } = await conWebhook();
    webhooks.respuesta = { ok: false, status: null, error: "Sin respuesta en 10 s" };
    const e = await c.enviarWebhookPrueba.ejecutar(ADMIN, ctx.integracion.id);
    expect(e).toMatchObject({ evento: "envio.estado_actualizado", estado: "FALLIDO", intentos: 1, envioId: null, proximoIntentoEn: null });
    expect(JSON.parse(webhooks.enviados[0]!.cuerpo)).toMatchObject({ type: "envio.estado_actualizado", data: { prueba: true } });
  });

  it("no se elimina una integración con envíos (se desactiva)", async () => {
    const { ctx } = await crearConKey();
    await c.crearEnvioApi.ejecutar(ctx, nuevoEnvio());
    await expect(c.eliminarIntegracion.ejecutar(ADMIN, ctx.integracion.id)).rejects.toMatchObject({ code: "CONFLICTO" });
    const vacia = await c.crearIntegracion.ejecutar(ADMIN, { ...datosIntegracion, nombre: "Sin envíos" });
    await c.eliminarIntegracion.ejecutar(ADMIN, vacia.id);
    await expect(c.obtenerIntegracion.ejecutar(ADMIN, vacia.id)).rejects.toMatchObject({ code: "NO_ENCONTRADO" });
  });

  it("el resumen agrupa por canal y filtra por integración", async () => {
    const { ctx } = await crearConKey();
    await c.crearEnvioApi.ejecutar(ctx, nuevoEnvio());
    const r = await c.resumen.ejecutar({});
    expect(r.porCanal).toEqual([{ canal: "API", integracionId: ctx.integracion.id, nombre: "Tienda Andina", envios: 1, monto: 6 }]);
    expect((await c.resumen.ejecutar({ canal: "PANEL" })).totalEnvios).toBe(0);
    expect((await c.resumen.ejecutar({ integracionId: ctx.integracion.id })).totalEnvios).toBe(1);
  });
});
