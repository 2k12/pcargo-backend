import { describe, expect, it } from "vitest";
import { validarCodigoAcceso } from "../../../src/domain/usuario/Usuario.js";
import { HuellaCodigoHmac } from "../../../src/infrastructure/security/adapters.js";

// Contrato v17: reglas del código único de acceso y su huella.

describe("validarCodigoAcceso", () => {
  it("acepta 6–32 caracteres de letras, números, símbolos o mezcla", () => {
    for (const codigo of ["482913", "abcdef", "#$%&*!", "Pc-24*ñ", "x".repeat(32)]) {
      expect(() => validarCodigoAcceso(codigo, "Clave123")).not.toThrow();
    }
  });

  it("cuenta caracteres, no unidades UTF-16 (emojis)", () => {
    expect(() => validarCodigoAcceso("📦📦📦📦📦📦", "Clave123")).not.toThrow();
    expect(() => validarCodigoAcceso("📦📦📦", "Clave123")).toThrow(/entre 6 y 32/);
  });

  it("rechaza largos fuera de rango, espacios e igual a la contraseña", () => {
    expect(() => validarCodigoAcceso("12345", "Clave123")).toThrow(/entre 6 y 32/);
    expect(() => validarCodigoAcceso("x".repeat(33), "Clave123")).toThrow(/entre 6 y 32/);
    expect(() => validarCodigoAcceso("123 456", "Clave123")).toThrow(/espacios/);
    expect(() => validarCodigoAcceso("123456\t", "Clave123")).toThrow(/espacios/);
    expect(() => validarCodigoAcceso("Clave123", "Clave123")).toThrow(/distinto de la contraseña/);
  });
});

describe("HuellaCodigoHmac", () => {
  const huellas = new HuellaCodigoHmac("secreto-de-prueba-123456");

  it("es determinista, hex de 64 y distingue mayúsculas", () => {
    expect(huellas.huella("Abc!2026")).toBe(huellas.huella("Abc!2026"));
    expect(huellas.huella("Abc!2026")).toMatch(/^[0-9a-f]{64}$/);
    expect(huellas.huella("abc!2026")).not.toBe(huellas.huella("Abc!2026"));
  });

  it("depende del secreto del servidor y normaliza a NFC", () => {
    expect(new HuellaCodigoHmac("otro-secreto-123456789").huella("Abc!2026")).not.toBe(huellas.huella("Abc!2026"));
    expect(huellas.huella("cañon1")).toBe(huellas.huella("cañon1"));
  });
});
