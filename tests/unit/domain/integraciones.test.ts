import { describe, expect, it } from "vitest";
import { Envio } from "../../../src/domain/envio/Envio.js";
import { desarmarApiKey } from "../../../src/domain/integracion/ApiKeyFormato.js";
import { notaRegistroApi, validarReferenciaExterna } from "../../../src/domain/integracion/EnvioExterno.js";
import { jsonCanonico, validarClaveIdempotencia } from "../../../src/domain/integracion/Idempotencia.js";
import {
  exigirAlcance,
  normalizarAlcances,
  normalizarEventos,
  normalizarFormaPago,
  normalizarIps,
  normalizarNombreCiudad,
  normalizarNombreIntegracion,
  normalizarRemitenteIntegracion,
  validarUrlWebhook,
} from "../../../src/domain/integracion/Integracion.js";
import {
  ESPERAS_REINTENTO_MS,
  MAX_INTENTOS_WEBHOOK,
  proximoReintento,
  registrarIntento,
  type EntregaWebhook,
} from "../../../src/domain/integracion/Webhook.js";
import { OPERADOR } from "../../helpers/fakes.js";

const MIN = 60_000;

describe("Integración (datos)", () => {
  it("normaliza nombre, remitente, forma de pago, IPs, alcances y eventos", () => {
    expect(normalizarNombreIntegracion("  Tienda   Andina ")).toBe("Tienda Andina");
    expect(() => normalizarNombreIntegracion("x")).toThrow(expect.objectContaining({ code: "VALIDACION" }));
    expect(() => normalizarNombreIntegracion("x".repeat(81))).toThrow(/entre 2 y 80/);
    expect(normalizarRemitenteIntegracion({ nombre: " Tienda ", telefono: "062 600 100", direccion: " Bolívar  1-23 " })).toEqual({
      nombre: "Tienda",
      telefono: "062 600 100",
      direccion: "Bolívar 1-23",
    });
    expect(() => normalizarRemitenteIntegracion({ nombre: "Tienda", telefono: "abc", direccion: "Bolívar" })).toThrow(/teléfono/);
    expect(normalizarFormaPago(undefined)).toBe("CONTRATO");
    expect(() => normalizarFormaPago("GRATIS")).toThrow(/Forma de pago/);
    expect(normalizarIps([" 10.0.0.1 ", "10.0.0.1", ""])).toEqual(["10.0.0.1"]);
    expect(() => normalizarIps(Array.from({ length: 51 }, (_, i) => `10.0.0.${i}`))).toThrow(/Máximo 50/);
    expect(normalizarAlcances(["cotizar", "cotizar"])).toEqual(["cotizar"]);
    expect(() => normalizarAlcances([])).toThrow(/al menos un alcance/);
    expect(() => normalizarAlcances(["borrar"])).toThrow(/desconocido/);
    expect(() => normalizarEventos(["envio.borrado"])).toThrow(/desconocido/);
  });

  it("exige el alcance de la key (403 ALCANCE_INSUFICIENTE)", () => {
    expect(() => exigirAlcance({ alcances: ["cotizar"] }, "envios:crear")).toThrow(
      expect.objectContaining({ code: "ALCANCE_INSUFICIENTE" }),
    );
    expect(() => exigirAlcance({ alcances: ["cotizar"] }, null)).not.toThrow();
  });

  it("la URL del webhook debe ser https (http solo si se permite), sin credenciales ni fragmento", () => {
    expect(validarUrlWebhook("https://tienda.example/hooks", false)).toBe("https://tienda.example/hooks");
    expect(() => validarUrlWebhook("http://tienda.example/hooks", false)).toThrow(/https/);
    expect(validarUrlWebhook("http://localhost:4000/h", true)).toBe("http://localhost:4000/h");
    expect(() => validarUrlWebhook("ftp://tienda.example", true)).toThrow(/https/);
    expect(() => validarUrlWebhook("https://user:pass@tienda.example", false)).toThrow(/credenciales/);
    expect(() => validarUrlWebhook("https://tienda.example/#x", false)).toThrow(/fragmento/);
    expect(() => validarUrlWebhook("no es url", false)).toThrow(/no es válida/);
  });

  it("compara ciudades sin mayúsculas ni tildes", () => {
    expect(normalizarNombreCiudad("  QUITO ")).toBe("quito");
    expect(normalizarNombreCiudad("Cayambé")).toBe(normalizarNombreCiudad("cayambe"));
  });
});

describe("API keys (formato)", () => {
  it("acepta pc_live_/pc_test_ con prefijo 8 y secreto 32 base62; el resto es inválido", () => {
    const secreto = "A".repeat(16) + "b".repeat(8) + "0123456Z";
    expect(desarmarApiKey(`pc_live_Ab3dE6gH_${secreto}`)).toEqual({ modo: "live", prefijo: "pc_live_Ab3dE6gH" });
    expect(desarmarApiKey(`pc_test_Ab3dE6gH_${secreto}`)).toEqual({ modo: "test", prefijo: "pc_test_Ab3dE6gH" });
    for (const malo of [
      "",
      "eyJhbGciOiJIUzI1NiJ9.e30.x", // un JWT del panel
      `pc_prod_Ab3dE6gH_${secreto}`,
      `pc_live_Ab3dE6g_${secreto}`,
      `pc_live_Ab3dE6gH_${secreto}x`,
      `pc_live_Ab3d-6gH_${secreto}`,
      `pc_live_Ab3dE6gH_${secreto.slice(1)}!`,
    ]) {
      expect(desarmarApiKey(malo)).toBeNull();
    }
  });
});

describe("Envío por API (agregado)", () => {
  const datos = {
    remitente: { nombre: "Tienda Andina", telefono: "062600100", direccion: "Bolívar 1-23" },
    destinatario: { nombre: "Rosa", telefono: "0991234567", direccion: "Quito" },
    rutaId: 11,
    items: [{ tipoCarga: "PAQUETE" as const, cantidad: 1, pesoKg: 1, costoUnitario: 3, subtotal: 3 }],
    formaPago: "CONTRATO" as const,
  };
  const ctx = { id: "e1", numeroGuia: 1, ahora: new Date("2026-10-01T12:00:00Z") };

  it("sin operador: registro sin usuario y nota 'Ingresado por API'", () => {
    const e = Envio.crear(
      { ...datos, integracion: { id: "i1", nombre: "Tienda Andina" }, referenciaExterna: "PED-1" },
      { ...ctx, actor: null, notaRegistro: notaRegistroApi("Tienda Andina") },
    );
    expect(e.origen).toEqual({ canal: "API", integracionId: "i1", integracion: "Tienda Andina" });
    expect(e.referenciaExterna).toBe("PED-1");
    expect(e.registro.operador).toBeNull();
    expect(e.historial[0]).toMatchObject({ estado: "REGISTRADO", nota: "Ingresado por API: Tienda Andina", usuario: null });
    expect(e.toSnapshot().creadoPor).toBeNull();
  });

  it("los envíos del panel son canal PANEL y no admiten referencia externa", () => {
    const e = Envio.crear(datos, { ...ctx, actor: OPERADOR });
    expect(e.origen).toEqual({ canal: "PANEL", integracionId: null, integracion: null });
    expect(e.referenciaExterna).toBeNull();
    expect(() => Envio.crear({ ...datos, referenciaExterna: "X" }, { ...ctx, actor: OPERADOR })).toThrow(/solo aplica/);
    expect(() => Envio.crear({ ...datos, integracion: { id: "i1", nombre: "T" } }, { ...ctx, actor: null })).toThrow(/referenciaExterna/);
  });

  it("referencia externa: 1–64 de [A-Za-z0-9._-/#]", () => {
    expect(validarReferenciaExterna("PED-2026/0001#a.b_c")).toBe("PED-2026/0001#a.b_c");
    for (const malo of ["", "x".repeat(65), "con espacio", "ñandú", 42]) {
      expect(() => validarReferenciaExterna(malo)).toThrow(expect.objectContaining({ code: "VALIDACION" }));
    }
  });
});

describe("Idempotencia", () => {
  it("JSON canónico: mismo contenido con otro orden de claves → mismo texto", () => {
    const a = { b: 1, a: { d: [3, { y: 1, x: 2 }], c: null }, z: undefined };
    const b = { a: { c: null, d: [3, { x: 2, y: 1 }] }, b: 1 };
    expect(jsonCanonico(a)).toBe(jsonCanonico(b));
    expect(jsonCanonico(a)).toBe('{"a":{"c":null,"d":[3,{"x":2,"y":1}]},"b":1}');
    expect(jsonCanonico({ a: [1, 2] })).not.toBe(jsonCanonico({ a: [2, 1] }));
    expect(jsonCanonico("é")).toBe('"é"');
  });

  it("Idempotency-Key: obligatoria, 1–255 ASCII visibles", () => {
    expect(validarClaveIdempotencia("pedido-1:abc")).toBe("pedido-1:abc");
    expect(() => validarClaveIdempotencia(undefined)).toThrow(/Falta/);
    expect(() => validarClaveIdempotencia("con espacio")).toThrow(/ASCII/);
    expect(() => validarClaveIdempotencia("ñ")).toThrow(/ASCII/);
    expect(() => validarClaveIdempotencia("x".repeat(256))).toThrow(/255/);
    expect(validarClaveIdempotencia("x".repeat(255))).toHaveLength(255);
  });
});

describe("Webhooks: reintentos con espera creciente", () => {
  const ahora = new Date("2026-10-01T12:00:00Z");
  const entrega: EntregaWebhook = {
    id: "w1",
    integracionId: "i1",
    mensajeId: "msg_1",
    evento: "envio.creado",
    envioId: "e1",
    numeroGuia: 1,
    cuerpo: "{}",
    prueba: false,
    estado: "PENDIENTE",
    intentos: 0,
    ultimoStatus: null,
    ultimoError: null,
    proximoIntentoEn: ahora,
    creadoEn: ahora,
    entregadoEn: null,
  };

  it("1 min, 5 min, 30 min, 2 h, 6 h, 12 h, 24 h; 8 intentos en total", () => {
    expect(ESPERAS_REINTENTO_MS).toEqual([1 * MIN, 5 * MIN, 30 * MIN, 120 * MIN, 360 * MIN, 720 * MIN, 1440 * MIN]);
    expect(MAX_INTENTOS_WEBHOOK).toBe(8);
    expect(proximoReintento(1, ahora)).toEqual(new Date(ahora.getTime() + MIN));
    expect(proximoReintento(7, ahora)).toEqual(new Date(ahora.getTime() + 1440 * MIN));
    expect(proximoReintento(8, ahora)).toBeNull();
  });

  it("registrarIntento: éxito → ENTREGADO; fallo → PENDIENTE con espera; el 8.º fallo → FALLIDO", () => {
    const ok = registrarIntento(entrega, { ok: true, status: 204, error: null }, ahora);
    expect(ok).toMatchObject({ estado: "ENTREGADO", intentos: 1, ultimoStatus: 204, entregadoEn: ahora, proximoIntentoEn: null });

    let e = entrega;
    const esperas: number[] = [];
    for (let i = 0; i < 8; i++) {
      e = registrarIntento(e, { ok: false, status: 500, error: "HTTP 500" }, ahora);
      if (e.proximoIntentoEn) esperas.push((e.proximoIntentoEn.getTime() - ahora.getTime()) / MIN);
    }
    expect(esperas).toEqual([1, 5, 30, 120, 360, 720, 1440]);
    expect(e).toMatchObject({ estado: "FALLIDO", intentos: 8, ultimoError: "HTTP 500", proximoIntentoEn: null });
  });

  it("el evento de prueba no se reintenta", () => {
    const e = registrarIntento({ ...entrega, prueba: true }, { ok: false, status: null, error: "timeout" }, ahora);
    expect(e).toMatchObject({ estado: "FALLIDO", intentos: 1, ultimoError: "timeout" });
  });
});
