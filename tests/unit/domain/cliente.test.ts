import { describe, expect, it } from "vitest";
import { exigirConsentimiento } from "../../../src/domain/cliente/Cliente.js";

describe("Consentimiento del cliente (LOPDP)", () => {
  it("solo true acredita el consentimiento", () => {
    expect(() => exigirConsentimiento(true)).not.toThrow();
  });

  it.each([undefined, null, false, "true", 1, {}])("rechaza %s como regla de negocio (VALIDACION, 422)", (valor) => {
    expect(() => exigirConsentimiento(valor)).toThrowError(
      expect.objectContaining({
        code: "VALIDACION",
        regla: true,
        message: "Se necesita el consentimiento del cliente para guardar sus datos",
      }),
    );
  });
});
