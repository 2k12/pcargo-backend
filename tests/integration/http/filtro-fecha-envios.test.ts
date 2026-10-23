import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { adaptadoresEnMemoria, crearCasosDeUso, type Adaptadores } from "../../../src/infrastructure/container.js";
import { crearApp } from "../../../src/infrastructure/http/app.js";
import { Envio } from "../../../src/domain/envio/Envio.js";
import { JWT_SECRET_TEST, OPERADOR, solicitudEnvio } from "../../helpers/fakes.js";

// Contrato v16: GET /envios?desde=&hasta= filtra por día en hora de Ecuador (UTC−5), inclusive. Desde v18 sobre la
// fecha de la guía, que en estos envíos (sin fecha elegida) es el día de su registro.

let app: Express;
let adaptadores: Adaptadores;
let token: string;
const auth = () => ({ Authorization: `Bearer ${token}` });

let n = 0;
const guardarEnvio = async (ahora: Date): Promise<number> => {
  n++;
  const e = Envio.crear(
    {
      ...solicitudEnvio(),
      formaPago: "CONTRATO",
      items: [{ tipoCarga: "PAQUETE", cantidad: 1, pesoKg: 2, costoUnitario: 3, subtotal: 3 }],
    } as Parameters<typeof Envio.crear>[0],
    { id: `00000000-0000-4000-a160-${String(n).padStart(12, "0")}`, numeroGuia: 91000 + n, ahora, actor: OPERADOR },
  );
  await adaptadores.envios.guardar(e);
  return e.numeroGuia;
};

let g: { dia9: number; dia10Temprano: number; dia10Noche: number; dia11: number };

beforeAll(async () => {
  adaptadores = await adaptadoresEnMemoria({ jwtSecret: JWT_SECRET_TEST, rondasBcrypt: 4 });
  app = crearApp(crearCasosDeUso(adaptadores));
  token = (await request(app).post("/api/auth/login").send({ email: "operador@pcargo.ec", password: "Operador123!" })).body
    .token as string;
  g = {
    // 2025-03-09 23:59 Ecuador = 2025-03-10 04:59 UTC
    dia9: await guardarEnvio(new Date("2025-03-10T04:59:00Z")),
    // 2025-03-10 00:00 Ecuador = 2025-03-10 05:00 UTC
    dia10Temprano: await guardarEnvio(new Date("2025-03-10T05:00:00Z")),
    // 2025-03-10 23:30 Ecuador = 2025-03-11 04:30 UTC (en UTC ya es el día siguiente)
    dia10Noche: await guardarEnvio(new Date("2025-03-11T04:30:00Z")),
    // 2025-03-11 00:00 Ecuador
    dia11: await guardarEnvio(new Date("2025-03-11T05:00:00Z")),
  };
});

const guias = async (query: Record<string, string>): Promise<number[]> => {
  const r = await request(app).get("/api/envios").query({ porPagina: "100", ...query }).set(auth()).expect(200);
  return (r.body.datos as { numeroGuia: number }[]).map((e) => e.numeroGuia).filter((x) => x > 91000).sort();
};

describe("GET /envios por fecha de registro (v16)", () => {
  it("filtra por día en hora de Ecuador (23:30 EC cae en ese día aunque en UTC sea el siguiente)", async () => {
    expect(await guias({ desde: "2025-03-10", hasta: "2025-03-10" })).toEqual([g.dia10Temprano, g.dia10Noche]);
    const r = await request(app).get("/api/envios").query({ desde: "2025-03-10", hasta: "2025-03-10" }).set(auth()).expect(200);
    expect(r.body.total).toBe(2);
  });

  it("solo desde (inclusive)", async () => {
    expect(await guias({ desde: "2025-03-10" })).toEqual([g.dia10Temprano, g.dia10Noche, g.dia11]);
  });

  it("solo hasta (inclusive)", async () => {
    expect(await guias({ hasta: "2025-03-10" })).toEqual([g.dia9, g.dia10Temprano, g.dia10Noche]);
  });

  it("se combina con los demás filtros", async () => {
    expect(await guias({ desde: "2025-03-11", hasta: "2025-03-11", estado: "REGISTRADO" })).toEqual([g.dia11]);
    expect(await guias({ desde: "2025-03-11", estado: "ENTREGADO" })).toEqual([]);
  });

  it.each([[{ desde: "10/03/2025" }], [{ hasta: "2025-3-10" }], [{ desde: "2025-02-30x" }]])(
    "formato inválido %o → 400 VALIDACION",
    async (query) => {
      const r = await request(app).get("/api/envios").query(query).set(auth()).expect(400);
      expect(r.body.error.code).toBe("VALIDACION");
    },
  );

  it("desde > hasta → 400 VALIDACION", async () => {
    const r = await request(app).get("/api/envios").query({ desde: "2025-03-11", hasta: "2025-03-10" }).set(auth()).expect(400);
    expect(r.body.error.code).toBe("VALIDACION");
  });
});
