import { describe, expect, it } from "vitest";
import { Envio, validarFechaGuia, type NuevoEnvio } from "../../../src/domain/envio/Envio.js";
import { fechaLocalEC } from "../../../src/domain/shared/FechaEcuador.js";
import { ESTADOS, puedeTransicionar } from "../../../src/domain/envio/EstadoEnvio.js";
import { pareceNumeroGuia, parsearGuiaFisica, parsearNumeroGuia } from "../../../src/domain/envio/NumeroGuia.js";
import { conEstado, esOperativa, nombreRuta, normalizarNombreCiudad, validarDatosRuta } from "../../../src/domain/ruta/Ruta.js";
import { ADMIN, OPERADOR } from "../../helpers/fakes.js";

const ahora = new Date("2026-10-01T10:00:00Z");
const despues = (min: number) => new Date(ahora.getTime() + min * 60_000);
const datos: NuevoEnvio = {
  remitente: { nombre: " María ", telefono: "0991234567" },
  destinatario: { nombre: "Juan", telefono: "+593 98 765 4321", direccion: "Calle Bolívar 1-23" },
  rutaId: 5,
  items: [
    { tipoCarga: "PAQUETE", cantidad: 5, pesoKg: 2, costoUnitario: 3.5, subtotal: 17.5 },
    { tipoCarga: "CARTON", cantidad: 20, pesoKg: 8, costoUnitario: 7, subtotal: 140 },
  ],
  formaPago: "AL_COBRO",
};
const crear = (d: Partial<NuevoEnvio> = {}) =>
  Envio.crear({ ...datos, ...d }, { id: "e1", numeroGuia: 40425, ahora, actor: OPERADOR });

describe("Envio", () => {
  it("se crea REGISTRADO con totales de piezas, peso y costo, y registro (fecha + operador)", () => {
    const e = crear();
    expect(e.estado).toBe("REGISTRADO");
    expect(e.totalPiezas).toBe(25);
    expect(e.pesoTotalKg).toBe(170);
    expect(e.toSnapshot()).toMatchObject({ costo: 157.5, formaPago: "AL_COBRO", remitente: { nombre: "María" } });
    expect(e.registro).toEqual({ fecha: ahora, operador: OPERADOR.nombre });
    expect(e.ultimaGestionEntrega).toBeNull();
  });

  it("guarda la zona de entrega (URBANA por defecto) y conserva el costo de los ítems cotizados", () => {
    expect(crear().zona).toBe("URBANA");
    const rural = crear({ zona: "RURAL" });
    expect(rural.zona).toBe("RURAL");
    expect(rural.toSnapshot()).toMatchObject({ zona: "RURAL", costo: 157.5 });
    expect(Envio.reconstruir(rural.toSnapshot()).zona).toBe("RURAL");
  });

  describe("costo adicional (v15)", () => {
    it.each([
      [2, 159.5],
      [1.5, 159],
      [1.1, 158.6],
      [0.29, 157.79],
      [9999.99, 10157.49],
    ])("%s se suma al costo de los ítems y se guarda aparte", (costoAdicional, costo) => {
      const e = crear({ costoAdicional });
      expect(e.costo).toBe(costo);
      expect(e.costoAdicional).toBe(costoAdicional);
      expect(e.toSnapshot()).toMatchObject({ costo, costoAdicional });
    });

    it("0 o ausente → 0 y el costo es solo la suma de los subtotales", () => {
      expect(crear({ costoAdicional: 0 }).toSnapshot()).toMatchObject({ costo: 157.5, costoAdicional: 0 });
      expect(crear().toSnapshot()).toMatchObject({ costo: 157.5, costoAdicional: 0 });
    });

    it.each([[-1], [-0.01], [1.234], [0.001], [10000], [9999.991], [Number.NaN], [Number.POSITIVE_INFINITY]])(
      "%s → VALIDACION",
      (costoAdicional) => {
        expect(() => crear({ costoAdicional })).toThrow(expect.objectContaining({ code: "VALIDACION" }));
      },
    );

    it("reconstruir usa 0 si falta (envíos anteriores a v15) y conserva el valor guardado", () => {
      const { costoAdicional: _omitido, ...viejo } = crear().toSnapshot();
      expect(Envio.reconstruir(viejo).costoAdicional).toBe(0);
      expect(Envio.reconstruir(crear({ costoAdicional: 2.25 }).toSnapshot()).toSnapshot()).toMatchObject({
        costo: 159.75,
        costoAdicional: 2.25,
      });
    });
  });

  describe("fecha de la guía (v18)", () => {
    // ahora = 2026-10-01 10:00 UTC = 2026-10-01 05:00 en Ecuador → hoy 2026-10-01, máximo 2026-12-30.
    it.each([[undefined], [null], [""], ["  "]])("vacía (%o) → hoy en Ecuador", (fechaGuia) => {
      expect(crear({ fechaGuia: fechaGuia as string | null | undefined }).fechaGuia).toBe("2026-10-01");
    });

    it("usa el día de Ecuador, no el de UTC (21:00 EC ya es el día siguiente en UTC)", () => {
      const noche = new Date("2026-10-02T02:00:00Z"); // 2026-10-01 21:00 en Ecuador
      const e = Envio.crear(datos, { id: "e2", numeroGuia: 1, ahora: noche, actor: OPERADOR });
      expect(e.fechaGuia).toBe("2026-10-01");
      expect(validarFechaGuia("2026-10-01", fechaLocalEC(noche))).toBe("2026-10-01");
    });

    it.each([["2026-10-01"], ["2026-10-02"], [" 2026-11-15 "], ["2026-12-30"]])(
      "%s (hoy..hoy+90) se acepta y se guarda",
      (fechaGuia) => {
        const e = crear({ fechaGuia });
        expect(e.fechaGuia).toBe(fechaGuia.trim());
        expect(e.toSnapshot().fechaGuia).toBe(fechaGuia.trim());
        expect(e.registro.fecha).toEqual(ahora); // el registro sigue siendo el momento real de creación
      },
    );

    it.each([
      ["2026-09-30", /anterior a hoy/],
      ["2025-10-01", /anterior a hoy/],
      ["2026-12-31", /como máximo 90 días.*2026-12-30/],
      ["2027-01-15", /como máximo 90 días/],
      ["01/10/2026", /formato AAAA-MM-DD/],
      ["2026-10-1", /formato AAAA-MM-DD/],
      ["2026-02-30", /formato AAAA-MM-DD/],
      ["2026-13-01", /formato AAAA-MM-DD/],
      ["hoy", /formato AAAA-MM-DD/],
    ])("%s → VALIDACION", (fechaGuia, mensaje) => {
      expect(() => crear({ fechaGuia })).toThrow(expect.objectContaining({ code: "VALIDACION", message: expect.stringMatching(mensaje) }));
    });

    it("reconstruir usa el día (Ecuador) del registro si falta (envíos anteriores a v18) y conserva la guardada", () => {
      const { fechaGuia: _omitida, ...viejo } = crear().toSnapshot();
      expect(Envio.reconstruir({ ...viejo, creadoEn: new Date("2026-03-11T04:30:00Z") }).fechaGuia).toBe("2026-03-10");
      expect(Envio.reconstruir(crear({ fechaGuia: "2026-10-20" }).toSnapshot()).fechaGuia).toBe("2026-10-20");
    });
  });

  it.each([
    [{ remitente: { nombre: "", telefono: "0991234567" } }, /nombre del remitente/],
    [{ remitente: { nombre: "Ana", telefono: "abc" } }, /teléfono del remitente/],
    [{ destinatario: { nombre: "Juan", telefono: "0991234567", direccion: " " } }, /dirección/],
    [{ items: [] }, /al menos un ítem/],
  ])("valida datos obligatorios (%#)", (d, msg) => {
    expect(() => crear(d as Partial<NuevoEnvio>)).toThrow(msg);
  });

  it("recorre el flujo hasta ENTREGADO y expone la gestión de entrega", () => {
    const e = crear();
    e.cambiarEstado("EN_TRANSITO", { ahora: despues(10), actor: OPERADOR });
    e.cambiarEstado("EN_REPARTO", { ahora: despues(60), actor: OPERADOR });
    e.cambiarEstado("ENTREGADO", { ahora: despues(90), actor: ADMIN, nota: "Recibió portero" });
    expect(e.historial.map((h) => h.estado)).toEqual(["REGISTRADO", "EN_TRANSITO", "EN_REPARTO", "ENTREGADO"]);
    expect(e.ultimaGestionEntrega).toEqual({
      resultado: "ENTREGADO",
      fecha: despues(90),
      operador: ADMIN.nombre,
      nota: "Recibió portero",
    });
  });

  it("NO_ENTREGADO y NOVEDAD exigen motivo; se puede reintentar y la gestión muestra la última", () => {
    const e = crear();
    e.cambiarEstado("EN_TRANSITO", { ahora, actor: OPERADOR });
    e.cambiarEstado("EN_REPARTO", { ahora, actor: OPERADOR });
    expect(() => e.cambiarEstado("NO_ENTREGADO", { ahora, actor: OPERADOR, nota: "  " })).toThrow(/motivo/);
    e.cambiarEstado("NO_ENTREGADO", { ahora: despues(5), actor: OPERADOR, nota: "Nadie en casa" });
    expect(e.ultimaGestionEntrega).toMatchObject({ resultado: "NO_ENTREGADO", nota: "Nadie en casa" });

    e.cambiarEstado("EN_REPARTO", { ahora: despues(60), actor: OPERADOR }); // reintento
    expect(() => e.cambiarEstado("NOVEDAD", { ahora, actor: OPERADOR })).toThrow(/motivo/);
    e.cambiarEstado("NOVEDAD", { ahora: despues(70), actor: OPERADOR, nota: "Dirección incompleta" });
    e.cambiarEstado("ENTREGADO", { ahora: despues(80), actor: OPERADOR });
    expect(e.ultimaGestionEntrega).toMatchObject({ resultado: "ENTREGADO", fecha: despues(80), nota: null });
  });

  it("rechaza transiciones inválidas", () => {
    const e = crear();
    expect(() => e.cambiarEstado("ENTREGADO", { ahora, actor: OPERADOR })).toThrow(/No se puede pasar/);
    e.cambiarEstado("EN_TRANSITO", { ahora, actor: OPERADOR });
    expect(() => e.cambiarEstado("CANCELADO", { ahora, actor: OPERADOR })).toThrow(/TRANSITO a CANCELADO/);
  });

  it("los snapshots no comparten el historial ni los ítems con el agregado", () => {
    const e = crear();
    const snap = e.toSnapshot();
    snap.historial.push({ estado: "CANCELADO", nota: null, fecha: ahora, usuario: null });
    snap.items.pop();
    expect(e.historial).toHaveLength(1);
    expect(e.totalPiezas).toBe(25);
  });
});

describe("máquina de estados", () => {
  it("ENTREGADO y CANCELADO son estados finales", () => {
    for (const hacia of ESTADOS) {
      expect(puedeTransicionar("ENTREGADO", hacia)).toBe(false);
      expect(puedeTransicionar("CANCELADO", hacia)).toBe(false);
    }
  });

  it("solo se cancela desde REGISTRADO", () => {
    expect(ESTADOS.filter((d) => puedeTransicionar(d, "CANCELADO"))).toEqual(["REGISTRADO"]);
  });

  it("NO_ENTREGADO solo permite reintentar (EN_REPARTO)", () => {
    expect(ESTADOS.filter((h) => puedeTransicionar("NO_ENTREGADO", h))).toEqual(["EN_REPARTO"]);
  });

  it("una NOVEDAD se puede registrar en tránsito o en reparto y luego resolver", () => {
    expect(puedeTransicionar("EN_TRANSITO", "NOVEDAD")).toBe(true);
    expect(puedeTransicionar("EN_REPARTO", "NOVEDAD")).toBe(true);
    expect(ESTADOS.filter((h) => puedeTransicionar("NOVEDAD", h))).toEqual(["EN_REPARTO", "ENTREGADO", "NO_ENTREGADO"]);
  });
});

describe("número de guía", () => {
  it.each([
    ["0040425", 40425],
    ["40425", 40425],
    ["  00 40 425 ", 40425],
    [40425, 40425],
    ["000000000001", 1],
  ])("%j se interpreta como %i (ignora ceros a la izquierda y espacios)", (entrada, esperado) => {
    expect(parsearNumeroGuia(entrada)).toBe(esperado);
  });

  it.each(["PC-7K2M9QXA", "40-425", "4.5", "", "0000", "-12", "1234567890123"])("rechaza %j", (entrada) => {
    expect(() => parsearNumeroGuia(entrada)).toThrow(/número de guía/);
  });

  it("acepta hasta 12 dígitos significativos aunque tenga ceros delante", () => {
    expect(parsearNumeroGuia("000999999999999")).toBe(999999999999);
  });

  it("detecta textos de búsqueda que son números", () => {
    expect(pareceNumeroGuia(" 0040425 ")).toBe(true);
    expect(pareceNumeroGuia("Rosa")).toBe(false);
    expect(pareceNumeroGuia("40425a")).toBe(false);
  });

  it("el envío conserva su número de guía", () => {
    expect(crear().numeroGuia).toBe(40425);
  });
});

describe("guía física (v21)", () => {
  it.each([
    ["0040425", 40425],
    [" 00 40 425 ", 40425],
    [40425, 40425],
    ["000999999999999", 999999999999],
  ])("%j se normaliza como el número de guía → %i", (entrada, esperado) => {
    expect(parsearGuiaFisica(entrada)).toBe(esperado);
  });

  it.each([undefined, null, "", "   "])("vacía (%j) → null", (entrada) => {
    expect(parsearGuiaFisica(entrada)).toBeNull();
  });

  it.each(["40-425", "abc", "0000", "1234567890123", 0, -3, 1.5])("rechaza %j con VALIDACION que nombra la guía física", (entrada) => {
    expect(() => parsearGuiaFisica(entrada)).toThrow(expect.objectContaining({ code: "VALIDACION", message: expect.stringMatching(/guía física/) }));
  });

  it("el envío la guarda normalizada (null si no tiene) y la conserva al reconstruir", () => {
    expect(crear().guiaFisica).toBeNull();
    const e = crear({ guiaFisica: "000123456" });
    expect(e.guiaFisica).toBe(123456);
    expect(e.numeroGuia).toBe(40425);
    expect(Envio.reconstruir(e.toSnapshot()).guiaFisica).toBe(123456);
    const { guiaFisica: _, ...sinGuia } = e.toSnapshot();
    expect(Envio.reconstruir(sinGuia).guiaFisica).toBeNull(); // envíos anteriores a v21
    expect(() => crear({ guiaFisica: "12-3" })).toThrow(/guía física/);
  });
});

describe("Ruta", () => {
  const ib = { id: 1, nombre: "Ibarra", activa: true };
  const qu = { id: 4, nombre: "Quito", activa: true };

  it("nombra rutas urbanas e interurbanas", () => {
    expect(nombreRuta({ origen: ib, destino: ib })).toBe("Ibarra (urbano)");
    expect(nombreRuta({ origen: ib, destino: qu })).toBe("Ibarra → Quito");
  });

  it("una ruta es operativa solo si ella y sus dos ciudades están activas", () => {
    const base = { id: 1, origen: ib, destino: qu, tiempoEstimadoMin: 180, activa: true };
    expect(esOperativa(base)).toBe(true);
    expect(esOperativa({ ...base, activa: false })).toBe(false);
    expect(esOperativa({ ...base, destino: { ...qu, activa: false } })).toBe(false);
    expect(conEstado({ ...base, origen: { ...ib, activa: false } }).operativa).toBe(false);
  });

  it("normaliza y valida el nombre de una ciudad", () => {
    expect(normalizarNombreCiudad("  San   Antonio de Ibarra ")).toBe("San Antonio de Ibarra");
    expect(() => normalizarNombreCiudad("X")).toThrow(/entre 2 y 60/);
    expect(() => normalizarNombreCiudad("a".repeat(61))).toThrow(/entre 2 y 60/);
  });

  it("valida el tiempo estimado (la ruta ya no tiene tarifa)", () => {
    expect(() => validarDatosRuta({ tiempoEstimadoMin: 1.5 })).toThrow(/tiempo/);
    expect(() => validarDatosRuta({ tiempoEstimadoMin: 0 })).toThrow(/tiempo/);
    expect(() => validarDatosRuta({ tiempoEstimadoMin: 30 })).not.toThrow();
  });
});
