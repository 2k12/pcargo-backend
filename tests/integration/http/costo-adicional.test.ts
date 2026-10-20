import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { adaptadoresEnMemoria, crearCasosDeUso, type Adaptadores } from "../../../src/infrastructure/container.js";
import { crearApp } from "../../../src/infrastructure/http/app.js";
import { JWT_SECRET_TEST, solicitudEnvio } from "../../helpers/fakes.js";

// Contrato v15: costo adicional opcional al crear un envío desde el panel (POST /envios).

let app: Express;
let adaptadores: Adaptadores;
let tokenAdmin: string;
let tokenOperador: string;
let tokenPortal: string;

const login = async (email: string, password: string) =>
  (await request(app).post("/api/auth/login").send({ email, password })).body.token as string;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  adaptadores = await adaptadoresEnMemoria({ jwtSecret: JWT_SECRET_TEST, rondasBcrypt: 4 });
  app = crearApp(crearCasosDeUso(adaptadores));
  tokenAdmin = await login("admin@pcargo.ec", "Admin123!");
  tokenOperador = await login("operador@pcargo.ec", "Operador123!");
  tokenPortal = await login("portal@pcargo.ec", "Portal123!");
});

describe("Costo adicional (v15)", () => {
  const items = [{ tipoCarga: "PAQUETE", cantidad: 2, pesoKg: 3 }]; // 2 × 3.00 = 6.00

  it("POST /envios suma el costo adicional al costo y lo expone aparte (también al leer)", async () => {
    const r = await request(app)
      .post("/api/envios")
      .set(auth(tokenOperador))
      .send(solicitudEnvio({ items, formaPago: "CONTRATO", costoAdicional: 2.25 }))
      .expect(201);
    expect(r.body).toMatchObject({ costo: 8.25, costoAdicional: 2.25 });
    const leido = await request(app).get(`/api/envios/${r.body.id}`).set(auth(tokenOperador)).expect(200);
    expect(leido.body).toMatchObject({ costo: 8.25, costoAdicional: 2.25 });

    const sin = await request(app)
      .post("/api/envios")
      .set(auth(tokenOperador))
      .send(solicitudEnvio({ items, formaPago: "CONTRATO" }))
      .expect(201);
    expect(sin.body).toMatchObject({ costo: 6, costoAdicional: 0 });
    const entero = await request(app)
      .post("/api/envios")
      .set(auth(tokenOperador))
      .send(solicitudEnvio({ items, formaPago: "CONTRATO", costoAdicional: 2 }))
      .expect(201);
    expect(entero.body).toMatchObject({ costo: 8, costoAdicional: 2 });
  });

  it.each([[-1], [1.234], [10000], ["2.25"]])("costoAdicional inválido (%s) → 400 VALIDACION", async (costoAdicional) => {
    const r = await request(app)
      .post("/api/envios")
      .set(auth(tokenOperador))
      .send(solicitudEnvio({ costoAdicional }))
      .expect(400);
    expect(r.body.error.code).toBe("VALIDACION");
  });

  it("un envío PAGADO genera el cobro ORIGEN por la tarifa + costo adicional y cuenta en ingresos", async () => {
    const antes = await request(app).get("/api/dashboard/resumen").set(auth(tokenAdmin)).expect(200);
    const r = await request(app)
      .post("/api/envios")
      .set(auth(tokenOperador))
      .send(solicitudEnvio({ costoAdicional: 1.5 }))
      .expect(201);
    expect(r.body).toMatchObject({ costo: 4.5, costoAdicional: 1.5, formaPago: "PAGADO" });
    const cobros = (await adaptadores.caja.pendientes()).filter((c) => c.envioId === r.body.id);
    expect(cobros).toEqual([expect.objectContaining({ tipo: "ORIGEN", monto: 4.5 })]);
    const despues = await request(app).get("/api/dashboard/resumen").set(auth(tokenAdmin)).expect(200);
    expect(despues.body.ingresos).toBeCloseTo(antes.body.ingresos + 4.5, 2);
  });

  it("AL_COBRO: el por cobrar y el cobro CONTRA_ENTREGA incluyen el costo adicional", async () => {
    const antes = await request(app).get("/api/dashboard/resumen").set(auth(tokenAdmin)).expect(200);
    const r = await request(app)
      .post("/api/envios")
      .set(auth(tokenOperador))
      .send(solicitudEnvio({ formaPago: "AL_COBRO", costoAdicional: 0.29 }))
      .expect(201);
    expect(r.body).toMatchObject({ costo: 3.29, costoAdicional: 0.29 });
    const medio = await request(app).get("/api/dashboard/resumen").set(auth(tokenAdmin)).expect(200);
    expect(medio.body.porCobrar).toBeCloseTo(antes.body.porCobrar + 3.29, 2);
    for (const estado of ["EN_TRANSITO", "EN_REPARTO", "ENTREGADO"]) {
      await request(app).patch(`/api/envios/${r.body.id}/estado`).set(auth(tokenOperador)).send({ estado }).expect(200);
    }
    const cobros = (await adaptadores.caja.pendientes()).filter((c) => c.envioId === r.body.id);
    expect(cobros).toEqual([expect.objectContaining({ tipo: "CONTRA_ENTREGA", monto: 3.29 })]);
  });

  it("la API de empresas y el portal no aceptan costoAdicional (400)", async () => {
    const integracion = await request(app)
      .post("/api/integraciones")
      .set(auth(tokenAdmin))
      .send({
        nombre: "Tienda Costo",
        remitente: { nombre: "Tienda Costo S.A.", telefono: "062600100", direccion: "Bolívar 1-23, Ibarra" },
        ciudadOrigenId: 1,
        ipsPermitidas: [],
      })
      .expect(201);
    const { key } = (
      await request(app)
        .post(`/api/integraciones/${integracion.body.id}/keys`)
        .set(auth(tokenAdmin))
        .send({ nombre: "Key", modo: "live", alcances: ["envios:crear"] })
        .expect(201)
    ).body as { key: string };
    const nuevo = {
      referenciaExterna: "PED-CA-1",
      destinatario: { nombre: "Rosa Cevallos", telefono: "0991234567", direccion: "Av. Amazonas N24-56", ciudad: "Quito" },
      items: [{ tipoCarga: "PAQUETE", cantidad: 1, pesoKg: 3 }],
    };
    const api = await request(app)
      .post("/api/v1/integraciones/envios")
      .set(auth(key))
      .set("Idempotency-Key", "ca-1")
      .send({ ...nuevo, costoAdicional: 1 })
      .expect(400);
    expect(api.body.error.code).toBe("VALIDACION");
    const ok = await request(app)
      .post("/api/v1/integraciones/envios")
      .set(auth(key))
      .set("Idempotency-Key", "ca-2")
      .send(nuevo)
      .expect(201);
    expect(ok.body.costo).toBe(3);

    const portal = await request(app)
      .post("/api/portal/envios")
      .set(auth(tokenPortal))
      .send({
        destinatario: { nombre: "Ana", telefono: "0987654321", direccion: "Quito" },
        rutaId: 11,
        items: [{ tipoCarga: "SOBRE", cantidad: 1, pesoKg: 0.2 }],
        costoAdicional: 1,
      })
      .expect(400);
    expect(portal.body.error.code).toBe("VALIDACION");
  });
});
