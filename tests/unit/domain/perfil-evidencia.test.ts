import { describe, expect, it } from "vitest";
import { Envio, type NuevoEnvio } from "../../../src/domain/envio/Envio.js";
import {
  claveEvidencia,
  detectarTipoImagen,
  MAX_BYTES_EVIDENCIA,
  normalizarRecibidoPor,
  validarFotoEvidencia,
} from "../../../src/domain/envio/Evidencia.js";
import { normalizarCambiosPerfil, validarContrasenaNueva } from "../../../src/domain/usuario/Usuario.js";
import { ADMIN, IMAGENES, OPERADOR } from "../../helpers/fakes.js";

const ahora = new Date("2026-10-11T10:00:00Z");
const despues = (min: number) => new Date(ahora.getTime() + min * 60_000);
const datos: NuevoEnvio = {
  remitente: { nombre: "María", telefono: "0991234567" },
  destinatario: { nombre: "Juan", telefono: "0987654321", direccion: "Calle Bolívar 1-23" },
  rutaId: 11,
  items: [{ tipoCarga: "PAQUETE", cantidad: 1, pesoKg: 2, costoUnitario: 3, subtotal: 3 }],
  formaPago: "PAGADO",
};
const crear = (d: Partial<NuevoEnvio> = {}) =>
  Envio.crear({ ...datos, ...d }, { id: "e1", numeroGuia: 1, ahora, actor: OPERADOR });

const entregado = () => {
  const e = crear();
  for (const [i, estado] of (["EN_TRANSITO", "EN_REPARTO", "ENTREGADO"] as const).entries()) {
    e.cambiarEstado(estado, { ahora: despues(i + 1), actor: OPERADOR });
  }
  return e;
};

describe("Perfil del usuario", () => {
  it("normaliza nombre (2–80, espacios colapsados) y correo en minúsculas", () => {
    expect(normalizarCambiosPerfil({ nombre: "  Ana   María  " })).toEqual({ nombre: "Ana María" });
    expect(normalizarCambiosPerfil({ email: " Ana@PCargo.EC " })).toEqual({ email: "ana@pcargo.ec" });
    expect(normalizarCambiosPerfil({ nombre: "Ana", email: "a@b.ec" })).toEqual({ nombre: "Ana", email: "a@b.ec" });
  });

  it.each([
    [{}],
    [{ nombre: "A" }],
    [{ nombre: "x".repeat(81) }],
    [{ email: "no-es-correo" }],
  ])("rechaza %j → VALIDACION", (cambios) => {
    expect(() => normalizarCambiosPerfil(cambios)).toThrowError(expect.objectContaining({ code: "VALIDACION" }));
  });

  it("contraseña nueva: 8–72, letra y número, distinta de la actual", () => {
    expect(() => validarContrasenaNueva("Vieja123", "Nueva2026")).not.toThrow();
    expect(() => validarContrasenaNueva("Vieja123", "Ñandú2026")).not.toThrow();
    for (const nueva of ["Corta1", "x".repeat(72) + "1", "solamenteletras", "1234567890", "Vieja123"]) {
      expect(() => validarContrasenaNueva("Vieja123", nueva), nueva).toThrowError(
        expect.objectContaining({ code: "VALIDACION" }),
      );
    }
    expect(() => validarContrasenaNueva("x", "a".repeat(71) + "1")).not.toThrow(); // 72 exactos
  });
});

describe("Dirección del remitente (opcional)", () => {
  it("se guarda recortada; vacía o ausente → null", () => {
    expect(crear().toSnapshot().remitente.direccion).toBeNull();
    expect(crear({ remitente: { ...datos.remitente, direccion: "   " } }).toSnapshot().remitente.direccion).toBeNull();
    const con = crear({ remitente: { ...datos.remitente, direccion: "  Sucre 4-56, Ibarra " } });
    expect(con.toSnapshot().remitente).toEqual({ nombre: "María", telefono: "0991234567", direccion: "Sucre 4-56, Ibarra" });
    // envíos anteriores a v9 (sin la propiedad) se reconstruyen con null
    const snap = crear().toSnapshot();
    const viejo = Envio.reconstruir({ ...snap, remitente: { nombre: "Ana", telefono: "0991234567" } as typeof snap.remitente });
    expect(viejo.toSnapshot().remitente.direccion).toBeNull();
  });

  it("admite hasta 200 caracteres", () => {
    expect(() => crear({ remitente: { ...datos.remitente, direccion: "x".repeat(200) } })).not.toThrow();
    expect(() => crear({ remitente: { ...datos.remitente, direccion: "x".repeat(201) } })).toThrowError(
      expect.objectContaining({ code: "VALIDACION" }),
    );
  });
});

describe("Evidencia de entrega", () => {
  it("detecta JPEG, PNG y WebP por bytes mágicos", () => {
    expect(detectarTipoImagen(IMAGENES.jpeg)).toBe("image/jpeg");
    expect(detectarTipoImagen(IMAGENES.png)).toBe("image/png");
    expect(detectarTipoImagen(IMAGENES.webp)).toBe("image/webp");
    expect(detectarTipoImagen(IMAGENES.falsa)).toBeNull();
    expect(detectarTipoImagen(new Uint8Array([0xff, 0xd8]))).toBeNull(); // truncado
    expect(detectarTipoImagen(Buffer.from("RIFF0000WAVE"))).toBeNull(); // RIFF que no es WebP
  });

  it("valida presencia, tamaño (≤ 5 MB) y tipo de la foto", () => {
    expect(validarFotoEvidencia(IMAGENES.png)).toBe("image/png");
    const grande = Buffer.alloc(MAX_BYTES_EVIDENCIA + 1);
    IMAGENES.jpeg.copy(grande);
    const limite = grande.subarray(0, MAX_BYTES_EVIDENCIA);
    expect(validarFotoEvidencia(limite)).toBe("image/jpeg");
    for (const foto of [null, new Uint8Array(), grande, IMAGENES.falsa]) {
      expect(() => validarFotoEvidencia(foto)).toThrowError(expect.objectContaining({ code: "VALIDACION" }));
    }
  });

  it("nombre de quien recibe: 2–120 caracteres", () => {
    expect(normalizarRecibidoPor("  Rosa   Cevallos ")).toBe("Rosa Cevallos");
    for (const n of ["", " R ", "x".repeat(121), undefined]) {
      expect(() => normalizarRecibidoPor(n)).toThrowError(expect.objectContaining({ code: "VALIDACION" }));
    }
  });

  it("clave en el almacén: evidencias/<envioId>/<uuid>.<ext>", () => {
    expect(claveEvidencia("e1", "u1", "image/jpeg")).toBe("evidencias/e1/u1.jpg");
    expect(claveEvidencia("e1", "u1", "image/webp")).toBe("evidencias/e1/u1.webp");
  });

  it("solo se registra en ENTREGADO → si no, ESTADO_INVALIDO", () => {
    const e = crear();
    const ev = { recibidoPor: "Rosa", tipo: "image/png" as const, bytes: 10, clave: "evidencias/e1/a.png" };
    expect(() => e.registrarEvidencia(ev, { ahora, actor: OPERADOR })).toThrowError(
      expect.objectContaining({ code: "ESTADO_INVALIDO" }),
    );
    e.cambiarEstado("CANCELADO", { ahora: despues(1), actor: OPERADOR });
    expect(() => e.registrarEvidencia(ev, { ahora, actor: OPERADOR })).toThrowError(
      expect.objectContaining({ code: "ESTADO_INVALIDO" }),
    );
    expect(e.evidencia).toBeNull();
  });

  it("registra y reemplaza la evidencia, devolviendo la anterior para borrar su foto", () => {
    const e = entregado();
    expect(e.evidencia).toBeNull();
    const primera = e.registrarEvidencia(
      { recibidoPor: " Rosa  Cevallos ", tipo: "image/png", bytes: 10, clave: "evidencias/e1/a.png" },
      { ahora: despues(10), actor: OPERADOR },
    );
    expect(primera).toBeNull();
    expect(e.evidencia).toEqual({
      recibidoPor: "Rosa Cevallos",
      tipo: "image/png",
      bytes: 10,
      clave: "evidencias/e1/a.png",
      subidaEn: despues(10),
      subidaPor: { id: OPERADOR.id, nombre: OPERADOR.nombre },
    });
    expect(e.toSnapshot().actualizadoEn).toEqual(despues(10));

    const anterior = e.registrarEvidencia(
      { recibidoPor: "Luis", tipo: "image/jpeg", bytes: 20, clave: "evidencias/e1/b.jpg" },
      { ahora: despues(20), actor: ADMIN },
    );
    expect(anterior?.clave).toBe("evidencias/e1/a.png");
    expect(e.evidencia).toMatchObject({ recibidoPor: "Luis", clave: "evidencias/e1/b.jpg", subidaPor: { id: ADMIN.id } });
    // el historial no cambia: la evidencia no es un cambio de estado
    expect(e.historial.map((h) => h.estado)).toEqual(["REGISTRADO", "EN_TRANSITO", "EN_REPARTO", "ENTREGADO"]);
    // el snapshot es una copia: mutarlo no altera el agregado
    e.toSnapshot().evidencia!.recibidoPor = "otro";
    expect(Envio.reconstruir(e.toSnapshot()).evidencia?.recibidoPor).toBe("Luis");
  });

  it("valida el nombre de quien recibe antes que el estado", () => {
    const e = crear();
    expect(() =>
      e.registrarEvidencia({ recibidoPor: "R", tipo: "image/png", bytes: 1, clave: "k" }, { ahora, actor: OPERADOR }),
    ).toThrowError(expect.objectContaining({ code: "VALIDACION" }));
  });
});
