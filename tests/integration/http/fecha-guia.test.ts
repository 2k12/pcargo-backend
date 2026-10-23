import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { adaptadoresEnMemoria, crearCasosDeUso } from "../../../src/infrastructure/container.js";
import { crearApp } from "../../../src/infrastructure/http/app.js";
import { fechaLocalEC, sumarDiasEC } from "../../../src/domain/shared/FechaEcuador.js";
import { JWT_SECRET_TEST, solicitudEnvio } from "../../helpers/fakes.js";

// Contrato v18: fecha de la guía (fechaGuia, AAAA-MM-DD de Ecuador). Opcional al crear desde el panel (hoy..hoy+90,
// por defecto hoy); el portal y la API de empresas no la aceptan; GET /envios?desde=&hasta= filtra por ella.

let app: Express;
let tokenAdmin: string;
let tokenOperador: string;
let tokenPortal: string;
/** Reloj real: "hoy" se calcula igual que el servidor (hora de Ecuador). */
let hoy: string;

const login = async (email: string, password: string) =>
  (await request(app).post("/api/auth/login").send({ email, password })).body.token as string;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const items = [{ tipoCarga: "PAQUETE", cantidad: 1, pesoKg: 3 }];
const crear = (extra: Record<string, unknown>) =>
  request(app)
    .post("/api/envios")
    .set(auth(tokenOperador))
    .send(solicitudEnvio({ items, formaPago: "CONTRATO", ...extra }));

beforeAll(async () => {
  const adaptadores = await adaptadoresEnMemoria({ jwtSecret: JWT_SECRET_TEST, rondasBcrypt: 4 });
  app = crearApp(crearCasosDeUso(adaptadores));
  tokenAdmin = await login("admin@pcargo.ec", "Admin123!");
  tokenOperador = await login("operador@pcargo.ec", "Operador123!");
  tokenPortal = await login("portal@pcargo.ec", "Portal123!");
  hoy = fechaLocalEC(new Date());
});

describe("Fecha de la guía (v18)", () => {
  it("sin fechaGuia (ausente, null o vacía) → hoy en Ecuador; se devuelve también al leer y listar", async () => {
    for (const extra of [{}, { fechaGuia: null }, { fechaGuia: "" }]) {
      const r = await crear(extra).expect(201);
      expect(r.body.fechaGuia).toBe(hoy);
    }
    const r = await crear({}).expect(201);
    const leido = await request(app).get(`/api/envios/${r.body.id}`).set(auth(tokenOperador)).expect(200);
    expect(leido.body.fechaGuia).toBe(hoy);
    const lista = await request(app).get("/api/envios").set(auth(tokenOperador)).expect(200);
    expect(lista.body.datos.every((e: { fechaGuia: unknown }) => typeof e.fechaGuia === "string")).toBe(true);
  });

  it("acepta hoy, una fecha posterior y el límite de hoy + 90 días; el registro sigue siendo el momento real", async () => {
    for (const fechaGuia of [hoy, sumarDiasEC(hoy, 1), sumarDiasEC(hoy, 90)]) {
      const r = await crear({ fechaGuia }).expect(201);
      expect(r.body.fechaGuia).toBe(fechaGuia);
      expect(fechaLocalEC(new Date(r.body.registro.fecha))).toBe(hoy);
    }
  });

  it.each([
    ["ayer", () => sumarDiasEC(hoy, -1), /anterior a hoy/],
    ["hoy + 91", () => sumarDiasEC(hoy, 91), /como máximo 90 días/],
    ["formato dd/mm/aaaa", () => "23/10/2026", /AAAA-MM-DD/],
    ["fecha inexistente", () => "2027-02-30", /AAAA-MM-DD/],
    ["número", () => 20261023, /AAAA-MM-DD/],
  ])("%s → 400 VALIDACION con mensaje claro", async (_caso, valor, mensaje) => {
    const r = await crear({ fechaGuia: valor() }).expect(400);
    expect(r.body.error.code).toBe("VALIDACION");
    expect(r.body.error.message).toMatch(mensaje);
  });

  it("GET /envios?desde=&hasta= filtra por la fecha de la guía (no por la de registro)", async () => {
    const d30 = sumarDiasEC(hoy, 30);
    const d31 = sumarDiasEC(hoy, 31);
    const a = (await crear({ fechaGuia: d30 }).expect(201)).body.id as string;
    const b = (await crear({ fechaGuia: d31 }).expect(201)).body.id as string;
    const ids = async (query: Record<string, string>) =>
      (
        await request(app).get("/api/envios").query({ porPagina: "100", ...query }).set(auth(tokenOperador)).expect(200)
      ).body.datos.map((e: { id: string }) => e.id) as string[];

    expect(await ids({ desde: d30, hasta: d30 })).toEqual([a]);
    expect(await ids({ desde: d30, hasta: d31 })).toEqual([b, a]);
    expect(await ids({ desde: d31, hasta: d31 })).toEqual([b]);
    // registrados hoy, pero con guía de otro día: no salen en el día de hoy
    const deHoy = await ids({ desde: hoy, hasta: hoy });
    expect(deHoy).not.toContain(a);
    expect(deHoy).not.toContain(b);
  });

  it("el portal y la API de empresas no aceptan fechaGuia (400); sin ella usan hoy", async () => {
    const portal = await request(app)
      .post("/api/portal/envios")
      .set(auth(tokenPortal))
      .send({
        destinatario: { nombre: "Ana", telefono: "0987654321", direccion: "Quito" },
        rutaId: 11,
        items: [{ tipoCarga: "SOBRE", cantidad: 1, pesoKg: 0.2 }],
        fechaGuia: sumarDiasEC(hoy, 1),
      })
      .expect(400);
    expect(portal.body.error.code).toBe("VALIDACION");

    const integracion = await request(app)
      .post("/api/integraciones")
      .set(auth(tokenAdmin))
      .send({
        nombre: "Tienda Fecha",
        remitente: { nombre: "Tienda Fecha S.A.", telefono: "062600100", direccion: "Bolívar 1-23, Ibarra" },
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
      referenciaExterna: "PED-FG-1",
      destinatario: { nombre: "Rosa Cevallos", telefono: "0991234567", direccion: "Av. Amazonas N24-56", ciudad: "Quito" },
      items: [{ tipoCarga: "PAQUETE", cantidad: 1, pesoKg: 3 }],
    };
    const api = await request(app)
      .post("/api/v1/integraciones/envios")
      .set(auth(key))
      .set("Idempotency-Key", "fg-1")
      .send({ ...nuevo, fechaGuia: sumarDiasEC(hoy, 1) })
      .expect(400);
    expect(api.body.error.code).toBe("VALIDACION");
    const ok = await request(app)
      .post("/api/v1/integraciones/envios")
      .set(auth(key))
      .set("Idempotency-Key", "fg-2")
      .send(nuevo)
      .expect(201);
    const enPanel = await request(app)
      .get("/api/envios")
      .query({ q: ok.body.referenciaExterna ?? "PED-FG-1" })
      .set(auth(tokenOperador))
      .expect(200);
    expect(enPanel.body.datos[0].fechaGuia).toBe(hoy);
  });
});
