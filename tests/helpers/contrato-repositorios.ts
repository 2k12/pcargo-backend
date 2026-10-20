import { beforeEach, describe, expect, it } from "vitest";
import type {
  CajaRepository,
  DatosPersonalesRepository,
  CiudadRepository,
  ClienteRepository,
  EnvioRepository,
  RutaRepository,
  TipoCargaRepository,
  UsuarioRepository,
  ArticuloRestringidoRepository,
} from "../../src/application/ports/repositories.js";
import type { CambioTipoCarga, TipoCarga } from "../../src/domain/carga/TipoCarga.js";
import type { ArticuloRestringido } from "../../src/domain/catalogo/ArticuloRestringido.js";
import type {
  EntregaWebhookRepository,
  IdempotenciaRepository,
  IntegracionRepository,
  SolicitudApiRepository,
} from "../../src/application/ports/integraciones.js";
import type { Integracion } from "../../src/domain/integracion/Integracion.js";
import type { EntregaWebhook } from "../../src/domain/integracion/Webhook.js";
import { Envio } from "../../src/domain/envio/Envio.js";
import { crearCierre, resumirCobros, type Cobro } from "../../src/domain/caja/Caja.js";
import { ARTICULOS_SEED, TIPOS_CARGA_SEED, USUARIOS_SEED } from "../../src/infrastructure/persistence/seed-data.js";
import { ADMIN, OPERADOR, solicitudEnvio } from "./fakes.js";

export interface FabricaRepos {
  envios: EnvioRepository;
  rutas: RutaRepository;
  ciudades: CiudadRepository;
  clientes: ClienteRepository;
  /** Con los 7 tipos semilla en su estado original y sin historial. */
  tiposCarga: TipoCargaRepository;
  /** Con la semilla de artículos restringidos. */
  articulos: ArticuloRestringidoRepository;
  /** Con los usuarios semilla en su estado original (nombre, correo y contraseña). */
  usuarios: UsuarioRepository;
  integraciones: IntegracionRepository;
  entregasWebhook: EntregaWebhookRepository;
  solicitudesApi: SolicitudApiRepository;
  idempotencia: IdempotenciaRepository;
  // ── v12 ──
  caja: CajaRepository;
  datosPersonales: DatosPersonalesRepository;
}

export const ID_INTEGRACION = "00000000-0000-4000-e000-000000000001";
export const ID_INTEGRACION_2 = "00000000-0000-4000-e000-000000000002";

export const integracionDePrueba = (sobre: Partial<Integracion> = {}): Integracion => ({
  id: ID_INTEGRACION,
  nombre: "Tienda Andina",
  activa: true,
  remitente: { nombre: "Tienda Andina S.A.", telefono: "062600100", direccion: "Bolívar 1-23, Ibarra" },
  ciudadOrigenId: 1,
  formaPagoPorDefecto: "CONTRATO",
  clienteId: null,
  ipsPermitidas: [],
  webhook: null,
  creadaEn: new Date(Date.UTC(2026, 9, 1)),
  keys: [],
  ...sobre,
});

const entregaDePrueba = (n: number, sobre: Partial<EntregaWebhook> = {}): EntregaWebhook => ({
  id: `00000000-0000-4000-f000-${String(n).padStart(12, "0")}`,
  integracionId: ID_INTEGRACION,
  mensajeId: `msg_${n}`,
  evento: "envio.estado_actualizado",
  envioId: null,
  numeroGuia: null,
  cuerpo: `{"n":${n}}`,
  prueba: false,
  estado: "PENDIENTE",
  intentos: 0,
  ultimoStatus: null,
  ultimoError: null,
  proximoIntentoEn: new Date(Date.UTC(2026, 9, 1, 12, n)),
  creadoEn: new Date(Date.UTC(2026, 9, 1, 12, n)),
  entregadoEn: null,
  ...sobre,
});

/**
 * Suite de contrato: cualquier adaptador de persistencia debe pasarla.
 * Se ejecuta contra memoria siempre y contra Postgres cuando hay TEST_DATABASE_URL.
 */
export function contratoRepositorios(nombre: string, fabrica: () => Promise<FabricaRepos>): void {
  describe(`Contrato de repositorios — ${nombre}`, () => {
    let repos: FabricaRepos;
    let n = 0;

    beforeEach(async () => {
      repos = await fabrica();
    });

    const nuevoEnvio = (minutos = 0, sobre: Record<string, unknown> = {}) => {
      n++;
      const s = solicitudEnvio(sobre);
      return Envio.crear(
        {
          ...s,
          formaPago: "CONTRATO",
          items: [
            { tipoCarga: "PAQUETE", cantidad: 5, pesoKg: 2, costoUnitario: 8.4, subtotal: 42 },
            { tipoCarga: "CARTON", cantidad: 2, pesoKg: 8, costoUnitario: 12.6, subtotal: 25.2 },
          ],
        } as Parameters<typeof Envio.crear>[0],
        {
          id: `00000000-0000-4000-b000-${String(n).padStart(12, "0")}`,
          numeroGuia: 70000 + n,
          ahora: new Date(Date.UTC(2026, 9, 1, 12, minutos)),
          actor: OPERADOR,
        },
      );
    };

    it("guarda y recupera un envío con su historial", async () => {
      const e = nuevoEnvio();
      await repos.envios.guardar(e);
      const leido = await repos.envios.buscarPorId(e.id);
      expect(leido?.toSnapshot()).toMatchObject({
        numeroGuia: e.numeroGuia,
        costo: 67.2,
        formaPago: "CONTRATO",
        items: [
          { tipoCarga: "PAQUETE", cantidad: 5, pesoKg: 2, costoUnitario: 8.4, subtotal: 42 },
          { tipoCarga: "CARTON", cantidad: 2, pesoKg: 8, costoUnitario: 12.6, subtotal: 25.2 },
        ],
        remitente: { nombre: "María Pérez" },
        historial: [{ estado: "REGISTRADO", usuario: { id: OPERADOR.id } }],
      });
      expect(await repos.envios.existeNumeroGuia(e.numeroGuia)).toBe(true);
      expect((await repos.envios.buscarPorNumeroGuia(e.numeroGuia))?.id).toBe(e.id);
      expect(await repos.envios.siguienteNumeroGuia()).toBeGreaterThan(e.numeroGuia);
    });

    it("persiste solo los eventos nuevos al cambiar de estado", async () => {
      const e = nuevoEnvio();
      await repos.envios.guardar(e);
      e.cambiarEstado("EN_TRANSITO", { ahora: new Date(Date.UTC(2026, 9, 1, 13)), actor: OPERADOR, nota: "bus 10:00" });
      await repos.envios.guardar(e);
      await repos.envios.guardar(e); // idempotente
      const leido = (await repos.envios.buscarPorId(e.id))!;
      expect(leido.estado).toBe("EN_TRANSITO");
      expect(leido.historial.map((h) => [h.estado, h.nota])).toEqual([
        ["REGISTRADO", null],
        ["EN_TRANSITO", "bus 10:00"],
      ]);
    });

    it("lista con filtros y orden descendente por fecha", async () => {
      const a = nuevoEnvio(0);
      const b = nuevoEnvio(10, { destinatario: { nombre: "Rosa Cevallos", telefono: "0999999999", direccion: "Sucre" } });
      await repos.envios.guardar(a);
      await repos.envios.guardar(b);
      const ids = (await repos.envios.listar()).map((e) => e.id);
      expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id));
      expect((await repos.envios.listar({ q: "ROSA" })).map((e) => e.id)).toEqual([b.id]);
      expect((await repos.envios.listar({ q: String(a.numeroGuia), numeroGuia: a.numeroGuia })).map((e) => e.id)).toEqual([a.id]);
      expect((await repos.envios.listar({ estado: "ENTREGADO" })).map((e) => e.id)).not.toContain(a.id);
      expect((await repos.envios.listar({ rutaId: 11 })).map((e) => e.id)).toEqual(expect.arrayContaining([a.id, b.id]));
    });

    it("pagina con orden estable y total del filtro", async () => {
      // Tres envíos con la MISMA fecha: el desempate por id evita repetir o saltar filas entre páginas.
      const iguales = [nuevoEnvio(50), nuevoEnvio(50), nuevoEnvio(50)];
      for (const e of iguales) await repos.envios.guardar(e);
      const filtro = { q: iguales[0]!.toSnapshot().remitente.nombre };
      const todos = (await repos.envios.listar(filtro)).map((e) => e.id);
      const p1 = await repos.envios.listarPagina(filtro, { pagina: 1, porPagina: 2 });
      const p2 = await repos.envios.listarPagina(filtro, { pagina: 2, porPagina: 2 });
      expect(p1.total).toBe(todos.length);
      expect(p2.total).toBe(todos.length);
      expect([...p1.envios, ...p2.envios].map((e) => e.id)).toEqual(todos.slice(0, 4));
      expect(new Set([...p1.envios, ...p2.envios].map((e) => e.id)).size).toBe(Math.min(4, todos.length));
      expect(p1.envios[0]?.toSnapshot().items.length).toBeGreaterThan(0);
      const vacia = await repos.envios.listarPagina({ estado: "CANCELADO", rutaId: 999 }, { pagina: 1, porPagina: 10 });
      expect(vacia).toEqual({ envios: [], total: 0 });
    });

    it("persiste NO_ENTREGADO/NOVEDAD con motivo, sin duplicar ítems, y filtra por forma de pago", async () => {
      const e = nuevoEnvio(30);
      await repos.envios.guardar(e);
      for (const estado of ["EN_TRANSITO", "EN_REPARTO"] as const) {
        e.cambiarEstado(estado, { ahora: new Date(Date.UTC(2026, 9, 1, 13)), actor: OPERADOR });
      }
      e.cambiarEstado("NO_ENTREGADO", { ahora: new Date(Date.UTC(2026, 9, 1, 14)), actor: OPERADOR, nota: "Nadie en casa" });
      await repos.envios.guardar(e);
      e.cambiarEstado("EN_REPARTO", { ahora: new Date(Date.UTC(2026, 9, 2, 9)), actor: OPERADOR });
      e.cambiarEstado("NOVEDAD", { ahora: new Date(Date.UTC(2026, 9, 2, 10)), actor: OPERADOR, nota: "Paquete mojado" });
      await repos.envios.guardar(e);

      const leido = (await repos.envios.buscarPorId(e.id))!;
      expect(leido.estado).toBe("NOVEDAD");
      expect(leido.totalPiezas).toBe(7);
      expect(leido.toSnapshot().items).toHaveLength(2);
      expect(leido.ultimaGestionEntrega).toMatchObject({ resultado: "NOVEDAD", nota: "Paquete mojado", operador: OPERADOR.nombre });
      expect(leido.registro.operador).toBe(OPERADOR.nombre);

      expect((await repos.envios.listar({ formaPago: "CONTRATO" })).map((x) => x.id)).toContain(e.id);
      expect((await repos.envios.listar({ formaPago: "SEGURO" })).map((x) => x.id)).not.toContain(e.id);
      expect((await repos.envios.listar({ estado: "NOVEDAD" })).map((x) => x.id)).toEqual([e.id]);
    });

    it("guarda clientes, los encuentra por teléfono y filtra envíos por cliente", async () => {
      const id = "00000000-0000-4000-c000-000000000001";
      const creadoEn = new Date(Date.UTC(2026, 9, 1));
      await repos.clientes.crear({ id, nombre: "Tienda La Esquina", telefono: "062 950 111", direccion: null, notas: null, creadoEn, consentimientoEn: creadoEn });
      expect(await repos.clientes.buscarPorTelefono("062950111")).toMatchObject({ id, nombre: "Tienda La Esquina", consentimientoEn: creadoEn });
      expect(await repos.clientes.buscarPorTelefono("062950111", id)).toBeNull();
      expect((await repos.clientes.listar({ q: "esquina" })).map((c) => c.id)).toEqual([id]);
      expect((await repos.clientes.listar({ q: "950" })).map((c) => c.id)).toEqual([id]);
      expect(await repos.clientes.listar({ q: "nadie" })).toEqual([]);

      const actualizado = await repos.clientes.actualizar(id, {
        nombre: "Tienda Esquina",
        telefono: "062 950 111",
        direccion: "Bolívar 3-20",
        notas: null,
      });
      expect(actualizado).toMatchObject({ nombre: "Tienda Esquina", direccion: "Bolívar 3-20" });

      const delCliente = nuevoEnvio(0, { clienteId: id });
      await repos.envios.guardar(delCliente);
      await repos.envios.guardar(nuevoEnvio(1));
      expect((await repos.envios.listar({ clienteId: id })).map((e) => e.id)).toEqual([delCliente.id]);
      expect((await repos.envios.buscarPorId(delCliente.id))?.clienteId).toBe(id);

      // Al eliminar el cliente, su envío se conserva
      await repos.clientes.eliminar(id);
      expect(await repos.clientes.buscarPorId(id)).toBeNull();
      expect(await repos.envios.buscarPorId(delCliente.id)).not.toBeNull();
    });

    it("registra el consentimiento de un cliente sin él y conserva la fecha original (LOPDP)", async () => {
      const id = "00000000-0000-4000-c000-000000000002";
      const creadoEn = new Date(Date.UTC(2026, 8, 1));
      // cliente anterior a v7: sin consentimiento
      await repos.clientes.crear({ id, nombre: "Ana López", telefono: "0991112233", direccion: null, notas: null, creadoEn, consentimientoEn: null });
      expect((await repos.clientes.buscarPorId(id))?.consentimientoEn).toBeNull();

      const primera = new Date(Date.UTC(2026, 9, 5, 15));
      expect((await repos.clientes.registrarConsentimiento(id, primera)).consentimientoEn).toEqual(primera);
      // un segundo registro no cambia la fecha
      const despues = await repos.clientes.registrarConsentimiento(id, new Date(Date.UTC(2026, 9, 6)));
      expect(despues).toMatchObject({ id, nombre: "Ana López", consentimientoEn: primera });
      expect((await repos.clientes.listar({ q: "ana" }))[0]?.consentimientoEn).toEqual(primera);

      // editar los datos no toca el consentimiento
      const editado = await repos.clientes.actualizar(id, { nombre: "Ana María López", telefono: "0991112233", direccion: null, notas: null });
      expect(editado.consentimientoEn).toEqual(primera);
    });

    it("guarda la zona de entrega del envío (URBANA por defecto) y tipos de carga nuevos en los ítems", async () => {
      const urbano = nuevoEnvio(5);
      await repos.envios.guardar(urbano);
      expect((await repos.envios.buscarPorId(urbano.id))?.zona).toBe("URBANA");

      n++;
      const rural = Envio.crear(
        {
          ...solicitudEnvio(),
          formaPago: "PAGADO",
          zona: "RURAL",
          items: [
            { tipoCarga: "TELA", cantidad: 51, pesoKg: 3, costoUnitario: 1, subtotal: 51 },
            { tipoCarga: "PLUMON_PEQUENO", cantidad: 1, pesoKg: 5, costoUnitario: 3, subtotal: 3 },
            { tipoCarga: "PLUMON_GRANDE", cantidad: 2, pesoKg: 8, costoUnitario: 4, subtotal: 8 },
          ],
        } as Parameters<typeof Envio.crear>[0],
        { id: `00000000-0000-4000-b000-${String(n).padStart(12, "0")}`, numeroGuia: 70000 + n, ahora: new Date(Date.UTC(2026, 9, 1, 15)), actor: OPERADOR },
      );
      await repos.envios.guardar(rural);
      rural.cambiarEstado("EN_TRANSITO", { ahora: new Date(Date.UTC(2026, 9, 1, 16)), actor: OPERADOR });
      await repos.envios.guardar(rural); // el upsert no pierde la zona
      const leido = (await repos.envios.buscarPorId(rural.id))!;
      expect(leido.toSnapshot()).toMatchObject({
        zona: "RURAL",
        costo: 62,
        items: [
          { tipoCarga: "TELA", cantidad: 51, costoUnitario: 1, subtotal: 51 },
          { tipoCarga: "PLUMON_PEQUENO", cantidad: 1, costoUnitario: 3, subtotal: 3 },
          { tipoCarga: "PLUMON_GRANDE", cantidad: 2, costoUnitario: 4, subtotal: 8 },
        ],
      });
      expect((await repos.envios.listar({ estado: "EN_TRANSITO" })).find((e) => e.id === rural.id)?.zona).toBe("RURAL");
    });

    it("lista los 7 tipos de carga con precio, precio rural, mayoreo y peso máximo (igual que la semilla)", async () => {
      expect(await repos.tiposCarga.listar()).toEqual(TIPOS_CARGA_SEED);
      expect(await repos.tiposCarga.buscarPorCodigo("TELA")).toEqual({
        codigo: "TELA",
        nombre: "Rollo de tela",
        precio: 1.25,
        precioRural: 1.5,
        mayoreo: { minimoExclusivo: 50, precio: 1 },
        pesoMaxKg: 50,
        activo: true,
        orden: 5,
        actualizadoEn: null,
        actualizadoPor: null,
      });
      expect(await repos.tiposCarga.buscarPorCodigo("CARTON")).toMatchObject({ precio: 3, precioRural: null, mayoreo: null, pesoMaxKg: 35 });
    });

    it("guarda el costo adicional (v15) sumado al costo; 0 si no se indicó", async () => {
      const con = nuevoEnvio(1, { costoAdicional: 2.25 });
      const sin = nuevoEnvio(2);
      await repos.envios.guardar(con);
      await repos.envios.guardar(sin);
      expect((await repos.envios.buscarPorId(con.id))?.toSnapshot()).toMatchObject({ costo: 69.45, costoAdicional: 2.25 });
      expect((await repos.envios.buscarPorId(sin.id))?.toSnapshot()).toMatchObject({ costo: 67.2, costoAdicional: 0 });
      // se conserva tras un cambio de estado (upsert)
      const leido = (await repos.envios.buscarPorId(con.id))!;
      leido.cambiarEstado("EN_TRANSITO", { ahora: new Date(Date.UTC(2026, 9, 1, 13)), actor: OPERADOR });
      await repos.envios.guardar(leido);
      expect((await repos.envios.buscarPorNumeroGuia(con.numeroGuia))?.costoAdicional).toBe(2.25);
    });

    it("guarda la dirección opcional del remitente (null si no se indicó)", async () => {
      const con = nuevoEnvio(1, { remitente: { nombre: "María Pérez", telefono: "0991234567", direccion: "Sucre 4-56, Ibarra" } });
      const sin = nuevoEnvio(2);
      await repos.envios.guardar(con);
      await repos.envios.guardar(sin);
      expect((await repos.envios.buscarPorId(con.id))?.toSnapshot().remitente).toEqual({
        nombre: "María Pérez",
        telefono: "0991234567",
        direccion: "Sucre 4-56, Ibarra",
      });
      expect((await repos.envios.buscarPorId(sin.id))?.toSnapshot().remitente.direccion).toBeNull();
    });

    it("guarda, reemplaza y lista la evidencia de entrega con sus metadatos", async () => {
      const e = nuevoEnvio(3);
      await repos.envios.guardar(e);
      expect((await repos.envios.buscarPorId(e.id))?.evidencia).toBeNull();
      for (const [i, estado] of (["EN_TRANSITO", "EN_REPARTO", "ENTREGADO"] as const).entries()) {
        e.cambiarEstado(estado, { ahora: new Date(Date.UTC(2026, 9, 1, 13 + i)), actor: OPERADOR });
      }
      const subidaEn = new Date(Date.UTC(2026, 9, 1, 17));
      const clave1 = `evidencias/${e.id}/a.jpg`;
      e.registrarEvidencia({ recibidoPor: "Rosa Cevallos", tipo: "image/jpeg", bytes: 1234, clave: clave1 }, { ahora: subidaEn, actor: OPERADOR });
      await repos.envios.guardar(e);
      const leido = (await repos.envios.buscarPorId(e.id))!;
      expect(leido.evidencia).toEqual({
        recibidoPor: "Rosa Cevallos",
        tipo: "image/jpeg",
        bytes: 1234,
        subidaEn,
        subidaPor: { id: OPERADOR.id, nombre: OPERADOR.nombre },
        clave: clave1,
      });
      expect(leido.estado).toBe("ENTREGADO");
      expect(leido.historial).toHaveLength(4);

      const clave2 = `evidencias/${e.id}/b.webp`;
      leido.registrarEvidencia({ recibidoPor: "Luis", tipo: "image/webp", bytes: 99, clave: clave2 }, { ahora: new Date(Date.UTC(2026, 9, 1, 18)), actor: ADMIN });
      await repos.envios.guardar(leido);
      const pagina = await repos.envios.listarPagina({ estado: "ENTREGADO" }, { pagina: 1, porPagina: 10 });
      expect(pagina.envios.find((x) => x.id === e.id)?.evidencia).toMatchObject({
        recibidoPor: "Luis",
        tipo: "image/webp",
        bytes: 99,
        subidaPor: { id: ADMIN.id },
        clave: clave2,
      });
      expect((await repos.envios.buscarPorId(e.id))?.historial).toHaveLength(4);
    });

    it("usuarios: busca credenciales por id, detecta correos repetidos y actualiza perfil y contraseña", async () => {
      const op = USUARIOS_SEED[1]!;
      const cred = (await repos.usuarios.buscarCredencialesPorId(op.id))!;
      expect(cred).toMatchObject({ id: op.id, email: op.email, rol: "OPERADOR", activo: true });
      expect(cred.passwordHash).toEqual(expect.any(String));
      expect(await repos.usuarios.buscarCredencialesPorId("00000000-0000-4000-8000-0000000000ff")).toBeNull();

      expect(await repos.usuarios.existeEmail("admin@pcargo.ec")).toBe(true);
      expect(await repos.usuarios.existeEmail("admin@pcargo.ec", ADMIN.id)).toBe(false);
      expect(await repos.usuarios.existeEmail("admin@pcargo.ec", op.id)).toBe(true);
      expect(await repos.usuarios.existeEmail("nadie@pcargo.ec")).toBe(false);

      expect(await repos.usuarios.actualizarPerfil(op.id, { nombre: "Paola Ruiz" })).toEqual({
        id: op.id,
        nombre: "Paola Ruiz",
        email: op.email,
        rol: "OPERADOR",
        clienteId: null,
      });
      expect(await repos.usuarios.actualizarPerfil(op.id, { email: "paola@pcargo.ec" })).toMatchObject({ nombre: "Paola Ruiz", email: "paola@pcargo.ec" });
      expect(await repos.usuarios.buscarPorEmail("paola@pcargo.ec")).toMatchObject({ id: op.id });
      expect(await repos.usuarios.buscarPorEmail(op.email)).toBeNull();
      await expect(repos.usuarios.actualizarPerfil(op.id, { email: "admin@pcargo.ec" })).rejects.toMatchObject({ code: "CONFLICTO" });

      await repos.usuarios.actualizarPasswordHash(op.id, "hash-nuevo");
      expect((await repos.usuarios.buscarCredencialesPorId(op.id))?.passwordHash).toBe("hash-nuevo");
    });

    it("devuelve null para envíos inexistentes", async () => {
      expect(await repos.envios.buscarPorId("00000000-0000-4000-8000-0000000fffff")).toBeNull();
      expect(await repos.envios.existeNumeroGuia(999_999_999_999)).toBe(false);
    });

    it("gestiona ciudades y las rutas reflejan su nombre y estado", async () => {
      const nueva = await repos.ciudades.crear("Cayambe");
      expect(nueva).toMatchObject({ nombre: "Cayambe", activa: true });
      expect(await repos.ciudades.existeNombre("CAYAMBE")).toBe(true);
      expect(await repos.ciudades.existeNombre("cayambe", nueva.id)).toBe(false);
      expect(await repos.rutas.usaCiudad(nueva.id)).toBe(false);
      expect(await repos.rutas.usaCiudad(4)).toBe(true);

      await repos.ciudades.actualizar(4, { activa: false });
      const r = (await repos.rutas.buscarPorId(11))!;
      expect(r.destino).toEqual({ id: 4, nombre: "Quito", activa: false });
      expect((await repos.ciudades.listar({ activa: true })).map((c) => c.nombre)).not.toContain("Quito");
      await repos.ciudades.actualizar(4, { activa: true });

      await repos.ciudades.eliminar(nueva.id);
      expect(await repos.ciudades.buscarPorId(nueva.id)).toBeNull();
    });

    it("lee, crea y actualiza rutas con sus ciudades (sin tarifa)", async () => {
      const r = (await repos.rutas.buscarPorId(11))!;
      expect([r.origen.nombre, r.destino.nombre]).toEqual(["Ibarra", "Quito"]);
      expect(r).not.toHaveProperty("tarifaBase");
      const act = await repos.rutas.actualizar(11, { tiempoEstimadoMin: 175 });
      expect(act).toMatchObject({ tiempoEstimadoMin: 175, activa: true });
      await repos.rutas.actualizar(11, { tiempoEstimadoMin: r.tiempoEstimadoMin });
      expect(await repos.rutas.existe(1, 4)).toBe(true);

      const ciudad = await repos.ciudades.crear("San Pablo");
      const nueva = await repos.rutas.crear({ origenId: 3, destinoId: ciudad.id, tiempoEstimadoMin: 25 });
      expect(nueva).toMatchObject({ origen: { id: 3 }, destino: { id: ciudad.id, nombre: "San Pablo" }, tiempoEstimadoMin: 25, activa: true });
      expect(nueva).not.toHaveProperty("tarifaBase");
      expect(await repos.rutas.existe(3, ciudad.id)).toBe(true);
    });

    // ── Integraciones con empresas (v10) ──

    it("integraciones: alta, nombre único sin distinguir mayúsculas, webhook y keys (prefijo, revocación, uso)", async () => {
      const i = integracionDePrueba({ ipsPermitidas: ["203.0.113.0/24", "2001:db8::1"] });
      await repos.integraciones.guardar(i);
      expect(await repos.integraciones.existeNombre("TIENDA ANDINA")).toBe(true);
      expect(await repos.integraciones.existeNombre("tienda andina", ID_INTEGRACION)).toBe(false);
      await expect(
        repos.integraciones.guardar(integracionDePrueba({ id: ID_INTEGRACION_2, nombre: "tienda ANDINA" })),
      ).rejects.toMatchObject({ code: "CONFLICTO" });

      const webhook = {
        url: "https://tienda.example/hooks",
        eventos: ["envio.creado" as const],
        activo: true,
        secretoCifrado: "v1:abc",
        secretoPrefijo: "whsec_abcd",
      };
      await repos.integraciones.guardar({ ...i, nombre: "Tienda Andina Cía.", webhook });
      const leida = (await repos.integraciones.buscarPorId(ID_INTEGRACION))!;
      expect(leida).toMatchObject({
        nombre: "Tienda Andina Cía.",
        remitente: i.remitente,
        ciudadOrigenId: 1,
        formaPagoPorDefecto: "CONTRATO",
        ipsPermitidas: ["203.0.113.0/24", "2001:db8::1"],
        webhook,
        keys: [],
      });

      const key = {
        id: "00000000-0000-4000-e100-000000000001",
        integracionId: ID_INTEGRACION,
        nombre: "Producción",
        modo: "live" as const,
        prefijo: "pc_live_Ab3dE6gH",
        hash: "a".repeat(64),
        alcances: ["envios:crear" as const, "cotizar" as const],
        creadaEn: new Date(Date.UTC(2026, 9, 2)),
        ultimoUsoEn: null,
        revocadaEn: null,
      };
      await repos.integraciones.crearKey(key);
      // guardar los datos de la integración no toca sus keys
      await repos.integraciones.guardar({ ...leida, activa: false, keys: [] });
      const porPrefijo = (await repos.integraciones.buscarPorPrefijoKey("pc_live_Ab3dE6gH"))!;
      expect(porPrefijo.key).toEqual(key);
      expect(porPrefijo.integracion).toMatchObject({ id: ID_INTEGRACION, activa: false, keys: [key] });
      expect(await repos.integraciones.buscarPorPrefijoKey("pc_live_XXXXXXXX")).toBeNull();

      const uso = new Date(Date.UTC(2026, 9, 3));
      await repos.integraciones.registrarUsoKey(key.id, uso);
      const revocada = new Date(Date.UTC(2026, 9, 4));
      expect(await repos.integraciones.revocarKey(ID_INTEGRACION, key.id, revocada)).toBe(true);
      expect(await repos.integraciones.revocarKey(ID_INTEGRACION, key.id, new Date())).toBe(true); // conserva la fecha
      expect(await repos.integraciones.revocarKey(ID_INTEGRACION_2, key.id, new Date())).toBe(false);
      expect((await repos.integraciones.buscarPorId(ID_INTEGRACION))?.keys[0]).toMatchObject({ ultimoUsoEn: uso, revocadaEn: revocada });

      await repos.integraciones.guardar({ ...leida, webhook: null });
      expect((await repos.integraciones.buscarPorId(ID_INTEGRACION))?.webhook).toBeNull();
      expect((await repos.integraciones.listar()).map((x) => x.id)).toEqual([ID_INTEGRACION]);
      await repos.integraciones.eliminar(ID_INTEGRACION);
      expect(await repos.integraciones.buscarPorId(ID_INTEGRACION)).toBeNull();
      expect(await repos.integraciones.buscarPorPrefijoKey("pc_live_Ab3dE6gH")).toBeNull();
    });

    it("envíos por API: origen con el nombre actual, referencia única por integración, filtros y outbox", async () => {
      await repos.integraciones.guardar(integracionDePrueba());
      await repos.integraciones.guardar(integracionDePrueba({ id: ID_INTEGRACION_2, nombre: "Distribuidora Norte" }));
      const integracion = { id: ID_INTEGRACION, nombre: "Tienda Andina" };
      const api = nuevoEnvio(20, { integracion, referenciaExterna: "PED-1001" });
      const panel = nuevoEnvio(21);
      const webhook = entregaDePrueba(1, { envioId: api.id, numeroGuia: api.numeroGuia, evento: "envio.creado" });
      await repos.envios.guardar(api, { webhooks: [webhook] });
      await repos.envios.guardar(panel);

      const leido = (await repos.envios.buscarPorId(api.id))!;
      expect(leido.origen).toEqual({ canal: "API", integracionId: ID_INTEGRACION, integracion: "Tienda Andina" });
      expect(leido.referenciaExterna).toBe("PED-1001");
      expect((await repos.envios.buscarPorId(panel.id))!.origen).toEqual({ canal: "PANEL", integracionId: null, integracion: null });
      expect((await repos.envios.buscarPorReferencia(ID_INTEGRACION, "PED-1001"))?.id).toBe(api.id);
      expect(await repos.envios.buscarPorReferencia(ID_INTEGRACION_2, "PED-1001")).toBeNull();

      // la misma referencia en otra integración sí se puede; en la misma, no
      const otra = nuevoEnvio(22, { integracion: { id: ID_INTEGRACION_2, nombre: "Distribuidora Norte" }, referenciaExterna: "PED-1001" });
      await repos.envios.guardar(otra);
      await expect(repos.envios.guardar(nuevoEnvio(23, { integracion, referenciaExterna: "PED-1001" }))).rejects.toMatchObject({
        code: "CONFLICTO",
      });

      expect((await repos.envios.listar({ canal: "API" })).map((e) => e.id).sort()).toEqual([api.id, otra.id].sort());
      expect((await repos.envios.listar({ canal: "PANEL" })).map((e) => e.id)).toEqual([panel.id]);
      expect((await repos.envios.listar({ integracionId: ID_INTEGRACION })).map((e) => e.id)).toEqual([api.id]);
      expect((await repos.envios.listarPagina({ q: "ped-10" }, { pagina: 1, porPagina: 10 })).total).toBe(2);
      expect((await repos.envios.listar({ q: "100%" })).map((e) => e.id)).toEqual([]); // comodines literales

      const est = await repos.envios.estadisticasPorIntegracion();
      expect(est.get(ID_INTEGRACION)).toEqual({ envios: 1, ultimoEnvio: api.toSnapshot().creadoEn });
      expect(est.get(ID_INTEGRACION_2)?.envios).toBe(1);

      // el nombre que se muestra es el actual de la integración
      await repos.integraciones.guardar(integracionDePrueba({ nombre: "Tienda Andina Express" }));
      expect((await repos.envios.buscarPorId(api.id))!.origen.integracion).toBe("Tienda Andina Express");

      // cambiar el estado conserva origen y referencia, y encola otra entrega
      leido.cambiarEstado("EN_TRANSITO", { ahora: new Date(Date.UTC(2026, 9, 1, 14)), actor: OPERADOR });
      await repos.envios.guardar(leido, { webhooks: [entregaDePrueba(2, { envioId: api.id })] });
      expect((await repos.envios.buscarPorReferencia(ID_INTEGRACION, "PED-1001"))?.estado).toBe("EN_TRANSITO");

      const pendientes = await repos.entregasWebhook.tomarPendientes(
        new Date(Date.UTC(2026, 9, 2)),
        10,
        new Date(Date.UTC(2026, 9, 2, 0, 2)),
      );
      expect(pendientes.map((e) => e.mensajeId)).toEqual(["msg_1", "msg_2"]);
      expect(pendientes[0]).toEqual(webhook);
    });

    it("webhooks: reserva con bloqueo, actualiza intentos, lista recientes primero y filtra por estado", async () => {
      await repos.integraciones.guardar(integracionDePrueba());
      for (const n of [1, 2, 3]) await repos.entregasWebhook.crear(entregaDePrueba(n));
      await repos.entregasWebhook.crear(entregaDePrueba(4, { proximoIntentoEn: new Date(Date.UTC(2026, 9, 5)) }));
      await repos.entregasWebhook.crear(entregaDePrueba(5, { prueba: true, proximoIntentoEn: null }));

      const ahora = new Date(Date.UTC(2026, 9, 2));
      const bloqueo = new Date(ahora.getTime() + 120_000);
      const primeras = await repos.entregasWebhook.tomarPendientes(ahora, 2, bloqueo);
      expect(primeras.map((e) => e.mensajeId)).toEqual(["msg_1", "msg_2"]);
      // las bloqueadas no se vuelven a tomar; las futuras ni las de prueba (sin fecha) tampoco
      expect((await repos.entregasWebhook.tomarPendientes(ahora, 10, bloqueo)).map((e) => e.mensajeId)).toEqual(["msg_3"]);
      expect(await repos.entregasWebhook.tomarPendientes(ahora, 10, bloqueo)).toEqual([]);
      // vencido el bloqueo vuelven a estar disponibles
      expect((await repos.entregasWebhook.tomarPendientes(bloqueo, 10, new Date(bloqueo.getTime() + 1))).length).toBe(3);

      const entregada = {
        ...primeras[0]!,
        estado: "ENTREGADO" as const,
        intentos: 1,
        ultimoStatus: 200,
        proximoIntentoEn: null,
        entregadoEn: ahora,
      };
      await repos.entregasWebhook.actualizar(entregada);
      const fallida = {
        ...primeras[1]!,
        estado: "FALLIDO" as const,
        intentos: 8,
        ultimoStatus: 500,
        ultimoError: "HTTP 500",
        proximoIntentoEn: null,
      };
      await repos.entregasWebhook.actualizar(fallida);
      expect(await repos.entregasWebhook.buscarPorId(ID_INTEGRACION, entregada.id)).toEqual(entregada);
      expect(await repos.entregasWebhook.buscarPorId(ID_INTEGRACION_2, entregada.id)).toBeNull();

      const todas = await repos.entregasWebhook.listarPagina(ID_INTEGRACION, {}, { pagina: 1, porPagina: 2 });
      expect(todas.total).toBe(5);
      expect(todas.entregas.map((e) => e.mensajeId)).toEqual(["msg_5", "msg_4"]);
      const fallidas = await repos.entregasWebhook.listarPagina(ID_INTEGRACION, { estado: "FALLIDO" }, { pagina: 1, porPagina: 10 });
      expect(fallidas.entregas).toEqual([fallida]);
    });

    it("auditoría de la API: registra, pagina recientes primero y purga por fecha", async () => {
      await repos.integraciones.guardar(integracionDePrueba());
      const base = {
        integracionId: ID_INTEGRACION,
        metodo: "POST",
        ruta: "/api/v1/integraciones/envios",
        status: 201,
        ip: "203.0.113.7",
        keyPrefijo: "pc_live_Ab3dE6gH",
        idempotencyKey: "pedido-1",
        referenciaExterna: "PED-1",
        duracionMs: 12,
      };
      for (const [n, dia] of [[1, 1], [2, 5], [3, 9]] as const) {
        await repos.solicitudesApi.registrar({
          ...base,
          id: `00000000-0000-4000-e200-00000000000${n}`,
          fecha: new Date(Date.UTC(2026, 9, dia)),
          requestId: `00000000-0000-4000-e300-00000000000${n}`,
        });
      }
      await repos.solicitudesApi.registrar({
        ...base,
        integracionId: null,
        keyPrefijo: null,
        status: 401,
        id: "00000000-0000-4000-e200-000000000009",
        fecha: new Date(Date.UTC(2026, 9, 9)),
        requestId: "00000000-0000-4000-e300-000000000009",
      });
      const p = await repos.solicitudesApi.listarPagina(ID_INTEGRACION, { pagina: 1, porPagina: 2 });
      expect(p.total).toBe(3);
      expect(p.solicitudes.map((s) => s.requestId)).toEqual([
        "00000000-0000-4000-e300-000000000003",
        "00000000-0000-4000-e300-000000000002",
      ]);
      expect(p.solicitudes[0]).toMatchObject({ ...base, fecha: new Date(Date.UTC(2026, 9, 9)) });
      expect(await repos.solicitudesApi.purgarAnteriores(new Date(Date.UTC(2026, 9, 6)))).toBe(2);
      expect((await repos.solicitudesApi.listarPagina(ID_INTEGRACION, { pagina: 1, porPagina: 10 })).total).toBe(1);
    });

    it("idempotencia: reserva atómica, replay, conflicto, en proceso, vencida, abandonada, liberar y purgar", async () => {
      await repos.integraciones.guardar(integracionDePrueba());
      const clave = { integracionId: ID_INTEGRACION, modo: "live" as const, clave: "pedido-1" };
      const t0 = new Date(Date.UTC(2026, 9, 1, 12));
      const lim = (ahora: Date) => ({
        vigenteDesde: new Date(ahora.getTime() - 24 * 3600_000),
        abandonadaAntesDe: new Date(ahora.getTime() - 5 * 60_000),
      });
      expect(await repos.idempotencia.reservar(clave, "h1", t0, lim(t0))).toEqual({ tipo: "nueva" });
      expect(await repos.idempotencia.reservar(clave, "h1", t0, lim(t0))).toEqual({ tipo: "en_proceso" });
      expect(await repos.idempotencia.reservar(clave, "h2", t0, lim(t0))).toEqual({ tipo: "conflicto" });
      // la misma clave en modo prueba es independiente
      expect(await repos.idempotencia.reservar({ ...clave, modo: "test" }, "h2", t0, lim(t0))).toEqual({ tipo: "nueva" });

      const cuerpo = JSON.stringify({ b: 1, a: [2, "x"] });
      await repos.idempotencia.completar(clave, { status: 201, cuerpo }, t0);
      expect(await repos.idempotencia.reservar(clave, "h1", t0, lim(t0))).toEqual({ tipo: "repetida", respuesta: { status: 201, cuerpo } });
      expect(await repos.idempotencia.reservar(clave, "h9", t0, lim(t0))).toEqual({ tipo: "conflicto" });

      // a las 24 h vence y se puede reutilizar con otro cuerpo
      const t1 = new Date(t0.getTime() + 24 * 3600_000 + 1000);
      expect(await repos.idempotencia.reservar(clave, "h3", t1, lim(t1))).toEqual({ tipo: "nueva" });
      // una reserva "en proceso" abandonada (> 5 min) se puede tomar
      const t2 = new Date(t1.getTime() + 6 * 60_000);
      expect(await repos.idempotencia.reservar(clave, "h3", t2, lim(t2))).toEqual({ tipo: "nueva" });
      await repos.idempotencia.liberar(clave);
      expect(await repos.idempotencia.reservar(clave, "h4", t2, lim(t2))).toEqual({ tipo: "nueva" });

      expect(await repos.idempotencia.purgarAnteriores(new Date(t2.getTime() + 1))).toBe(2);
      expect(await repos.idempotencia.reservar(clave, "h5", t2, lim(t2))).toEqual({ tipo: "nueva" });
    });

    // ── Catálogo configurable (v11) ──────────────────────────────────────────

    const tipoNuevo = (sobre: Partial<TipoCarga> = {}): TipoCarga => ({
      codigo: "CAJA_GRANDE",
      nombre: "Caja grande",
      precio: 5.5,
      precioRural: 6.25,
      mayoreo: { minimoExclusivo: 10, precio: 4.75 },
      pesoMaxKg: 40,
      activo: true,
      orden: 8,
      actualizadoEn: new Date(Date.UTC(2026, 9, 12, 15)),
      actualizadoPor: ADMIN.nombre,
      ...sobre,
    });
    let nCambio = 0;
    const cambioDe = (codigo: string, accion: CambioTipoCarga["accion"], minutos: number, cambios: CambioTipoCarga["cambios"] = []): CambioTipoCarga => ({
      id: `00000000-0000-4000-9000-${String(++nCambio).padStart(12, "0")}`,
      codigo,
      fecha: new Date(Date.UTC(2026, 9, 12, 15, minutos)),
      usuarioId: ADMIN.id,
      usuario: ADMIN.nombre,
      accion,
      cambios,
    });

    it("tipos de carga: alta, búsqueda, nombre único sin mayúsculas y filtro de activos", async () => {
      await repos.tiposCarga.crear(tipoNuevo(), cambioDe("CAJA_GRANDE", "CREADO", 0, [{ campo: "precio", antes: null, despues: 5.5 }]));
      expect(await repos.tiposCarga.buscarPorCodigo("CAJA_GRANDE")).toEqual(tipoNuevo());
      expect((await repos.tiposCarga.listar()).map((t) => t.codigo).at(-1)).toBe("CAJA_GRANDE");
      expect(await repos.tiposCarga.existeNombre("CAJA GRANDE")).toBe(true);
      expect(await repos.tiposCarga.existeNombre("caja grande", "CAJA_GRANDE")).toBe(false);
      await expect(repos.tiposCarga.crear(tipoNuevo({ nombre: "Otra" }), cambioDe("CAJA_GRANDE", "CREADO", 1))).rejects.toMatchObject({ code: "CONFLICTO" });
      await expect(repos.tiposCarga.crear(tipoNuevo({ codigo: "OTRA", nombre: "caja GRANDE" }), cambioDe("OTRA", "CREADO", 1))).rejects.toMatchObject({ code: "CONFLICTO" });

      await repos.tiposCarga.actualizar([{ ...TIPOS_CARGA_SEED[3]!, activo: false }], [cambioDe("VALIJA", "DESACTIVADO", 2)]);
      const activos = (await repos.tiposCarga.listar({ activos: true })).map((t) => t.codigo);
      expect(activos).not.toContain("VALIJA");
      expect(activos).toContain("CAJA_GRANDE");
      expect((await repos.tiposCarga.listar()).map((t) => t.codigo)).toContain("VALIJA");
    });

    it("tipos de carga: actualizar en bloque guarda el historial (recientes primero, filtro por código y páginas)", async () => {
      const [sobre, paquete] = [TIPOS_CARGA_SEED[0]!, TIPOS_CARGA_SEED[1]!];
      const t = new Date(Date.UTC(2026, 9, 12, 16));
      await repos.tiposCarga.actualizar(
        [{ ...sobre, precio: 3.5, actualizadoEn: t, actualizadoPor: ADMIN.nombre }],
        [cambioDe("SOBRE", "MODIFICADO", 5, [{ campo: "precio", antes: 3, despues: 3.5 }])],
      );
      // reordenamiento: varios tipos y cambios con la misma fecha
      await repos.tiposCarga.actualizar(
        [{ ...paquete, orden: 1 }, { ...sobre, precio: 3.5, orden: 2, actualizadoEn: t, actualizadoPor: ADMIN.nombre }],
        [
          cambioDe("PAQUETE", "MODIFICADO", 6, [{ campo: "orden", antes: 2, despues: 1 }]),
          cambioDe("SOBRE", "MODIFICADO", 6, [{ campo: "orden", antes: 1, despues: 2 }]),
        ],
      );
      expect(await repos.tiposCarga.buscarPorCodigo("SOBRE")).toMatchObject({ precio: 3.5, orden: 2, actualizadoEn: t, actualizadoPor: ADMIN.nombre });
      expect((await repos.tiposCarga.listar()).slice(0, 2).map((x) => x.codigo)).toEqual(["PAQUETE", "SOBRE"]);

      const todo = await repos.tiposCarga.listarHistorial({}, { pagina: 1, porPagina: 10 });
      expect(todo.total).toBe(3);
      // a igual fecha, el último registrado primero
      expect(todo.cambios.map((c) => [c.codigo, c.cambios[0]!.campo])).toEqual([
        ["SOBRE", "orden"],
        ["PAQUETE", "orden"],
        ["SOBRE", "precio"],
      ]);
      expect(todo.cambios[2]).toEqual({
        id: expect.any(String),
        codigo: "SOBRE",
        fecha: new Date(Date.UTC(2026, 9, 12, 15, 5)),
        usuarioId: ADMIN.id,
        usuario: ADMIN.nombre,
        accion: "MODIFICADO",
        cambios: [{ campo: "precio", antes: 3, despues: 3.5 }],
      });
      const sobreSolo = await repos.tiposCarga.listarHistorial({ codigo: "SOBRE" }, { pagina: 2, porPagina: 1 });
      expect(sobreSolo.total).toBe(2);
      expect(sobreSolo.cambios.map((c) => c.cambios[0]!.campo)).toEqual(["precio"]);
    });

    it("tipos de carga: nunca queda el catálogo sin tipos activos (no guarda nada)", async () => {
      const todos = await repos.tiposCarga.listar();
      await expect(
        repos.tiposCarga.actualizar(todos.map((t) => ({ ...t, activo: false })), todos.map((t, i) => cambioDe(t.codigo, "DESACTIVADO", i))),
      ).rejects.toMatchObject({ code: "CONFLICTO" });
      expect(await repos.tiposCarga.listar({ activos: true })).toHaveLength(7);
      expect((await repos.tiposCarga.listarHistorial({}, { pagina: 1, porPagina: 50 })).total).toBe(0);
      // con un solo activo, eliminarlo tampoco se admite
      const resto = todos.filter((t) => t.codigo !== "SOBRE").map((t) => ({ ...t, activo: false }));
      await repos.tiposCarga.actualizar(resto, resto.map((t, i) => cambioDe(t.codigo, "DESACTIVADO", i)));
      await expect(repos.tiposCarga.eliminar("SOBRE", cambioDe("SOBRE", "ELIMINADO", 30))).rejects.toMatchObject({ code: "CONFLICTO" });
      expect(await repos.tiposCarga.buscarPorCodigo("SOBRE")).not.toBeNull();
    });

    it("tipos de carga: no se elimina uno usado en envíos; uno sin envíos sí (el historial se conserva)", async () => {
      await repos.tiposCarga.crear(tipoNuevo(), cambioDe("CAJA_GRANDE", "CREADO", 0));
      await repos.envios.guardar(nuevoEnvio()); // PAQUETE y CARTON
      expect(await repos.envios.usaTipoCarga("PAQUETE")).toBe(true);
      expect(await repos.envios.usaTipoCarga("CAJA_GRANDE")).toBe(false);
      await expect(repos.tiposCarga.eliminar("PAQUETE", cambioDe("PAQUETE", "ELIMINADO", 1))).rejects.toMatchObject({ code: "CONFLICTO" });
      expect(await repos.tiposCarga.buscarPorCodigo("PAQUETE")).not.toBeNull();

      await repos.tiposCarga.eliminar("CAJA_GRANDE", cambioDe("CAJA_GRANDE", "ELIMINADO", 2));
      expect(await repos.tiposCarga.buscarPorCodigo("CAJA_GRANDE")).toBeNull();
      const h = await repos.tiposCarga.listarHistorial({ codigo: "CAJA_GRANDE" }, { pagina: 1, porPagina: 10 });
      expect(h.cambios.map((c) => c.accion)).toEqual(["ELIMINADO", "CREADO"]);
    });

    it("artículos restringidos: semilla (9 prohibidos, 3 condicionados, 2 notas) ordenada por categoría y orden", async () => {
      const todos = await repos.articulos.listar();
      expect(todos).toEqual(ARTICULOS_SEED);
      expect(todos.map((a) => a.categoria)).toEqual([...Array(9).fill("PROHIBIDO"), ...Array(3).fill("CONDICIONADO"), "NOTA", "NOTA"]);
    });

    it("artículos restringidos: crear, actualizar en bloque, filtrar activos y eliminar", async () => {
      const ahora = new Date(Date.UTC(2026, 9, 12, 17));
      const nuevo: ArticuloRestringido = {
        id: "00000000-0000-4000-8011-000000000099",
        categoria: "PROHIBIDO",
        titulo: "Baterías de litio sueltas",
        detalle: "",
        icono: "bateria",
        activo: true,
        orden: 0, // primero de su categoría
        actualizadoEn: ahora,
        actualizadoPor: ADMIN.nombre,
      };
      await repos.articulos.crear(nuevo);
      expect(await repos.articulos.buscarPorId(nuevo.id)).toEqual(nuevo);
      expect((await repos.articulos.listar())[0]!.id).toBe(nuevo.id);

      const dinero = ARTICULOS_SEED[0]!;
      await repos.articulos.actualizar([
        { ...nuevo, categoria: "CONDICIONADO", orden: 9 },
        { ...dinero, activo: false, actualizadoEn: ahora, actualizadoPor: ADMIN.nombre },
      ]);
      const activos = await repos.articulos.listar({ activos: true });
      expect(activos.map((a) => a.id)).not.toContain(dinero.id);
      expect(activos.filter((a) => a.categoria === "CONDICIONADO").at(-1)?.id).toBe(nuevo.id);
      expect(await repos.articulos.buscarPorId(dinero.id)).toMatchObject({ activo: false, actualizadoPor: ADMIN.nombre });

      await repos.articulos.eliminar(nuevo.id);
      expect(await repos.articulos.buscarPorId(nuevo.id)).toBeNull();
      expect(await repos.articulos.listar()).toHaveLength(14);
    });
    // ── v12: usuarios, reparto, caja y datos personales ──────────────────────

    const REP = { id: USUARIOS_SEED[2]!.id, nombre: USUARIOS_SEED[2]!.nombre, rol: "REPARTIDOR" as const };
    let m = 0;
    /** Envío de un ítem (3.00) con la forma de pago indicada. */
    const envioV12 = (formaPago: "PAGADO" | "AL_COBRO" | "CONTRATO" = "PAGADO", minutos = 0, sobre: Partial<Parameters<typeof Envio.crear>[0]> = {}) => {
      m++;
      return Envio.crear(
        {
          remitente: { nombre: "María Pérez", telefono: "0991234567", direccion: "Bolívar 1-23" },
          destinatario: { nombre: "Juan Andrade", telefono: "098 765 4321", direccion: "Av. Amazonas, Quito" },
          rutaId: 11,
          items: [{ tipoCarga: "PAQUETE", cantidad: 1, pesoKg: 2, costoUnitario: 3, subtotal: 3 }],
          formaPago,
          descripcion: "Ropa",
          ...sobre,
        },
        {
          id: `00000000-0000-4000-c000-${String(m).padStart(12, "0")}`,
          numeroGuia: 90000 + m,
          ahora: new Date(Date.UTC(2026, 9, 1, 12, minutos)),
          actor: OPERADOR,
          notaRegistro: "Paquete frágil",
        },
      );
    };
    const fecha = (min: number) => new Date(Date.UTC(2026, 9, 1, 12, min));
    const cobroDe = (envio: Envio, tipo: Cobro["tipo"], monto: number, usuario = OPERADOR, min = 0): Cobro => ({
      id: `00000000-0000-4000-c100-${String(++m).padStart(12, "0")}`,
      tipo,
      monto,
      envioId: envio.id,
      numeroGuia: envio.numeroGuia,
      formaPago: envio.toSnapshot().formaPago,
      usuario: { id: usuario.id, nombre: usuario.nombre },
      fecha: fecha(min),
      cierreId: null,
    });
    const cierreDe = (id: string, pendientes: Cobro[], usuario = OPERADOR, min = 30) =>
      crearCierre(pendientes, {
        id,
        fecha: fecha(min),
        usuario: { id: usuario.id, nombre: usuario.nombre, rol: usuario.rol },
        recibidoPor: { id: ADMIN.id, nombre: ADMIN.nombre },
        montoEntregado: resumirCobros(pendientes).total,
      });

    it("usuarios (v12): alta, listado por nombre con filtros, obtener, actualizar, correo único y accesos del portal", async () => {
      const cliente = "00000000-0000-4000-c200-000000000001";
      await repos.clientes.crear({ id: cliente, nombre: "Textiles Andinos", telefono: "062900100", direccion: null, notas: null, creadoEn: fecha(0), consentimientoEn: fecha(0) });
      const base = { passwordHash: "hash:Clave1234", activo: true, creadoEn: fecha(5) };
      const zeta = { ...base, id: "00000000-0000-4000-c300-000000000001", nombre: "Zeta Repartidor", email: "zeta@pcargo.ec", rol: "REPARTIDOR" as const, clienteId: null };
      const compras = { ...base, id: "00000000-0000-4000-c300-000000000002", nombre: "Compras Textiles", email: "compras@textiles.ec", rol: "CLIENTE" as const, clienteId: cliente };
      const bodega = { ...compras, id: "00000000-0000-4000-c300-000000000003", nombre: "Bodega Textiles", email: "bodega@textiles.ec", activo: false };
      for (const u of [zeta, compras, bodega]) await repos.usuarios.crear(u);
      await expect(repos.usuarios.crear({ ...zeta, id: "00000000-0000-4000-c300-000000000009" })).rejects.toMatchObject({ code: "CONFLICTO" });

      expect((await repos.usuarios.listar()).map((u) => u.nombre)).toEqual([
        "Administrador PCargo",
        "Bodega Textiles",
        "Compras Textiles",
        "Operador Ibarra",
        "Portal Textiles Atuntaqui",
        "Repartidor Ibarra",
        "Zeta Repartidor",
      ]);
      expect((await repos.usuarios.listar({ rol: "REPARTIDOR", activo: true })).map((u) => u.id)).toEqual([REP.id, zeta.id]);
      expect((await repos.usuarios.listar({ clienteId: cliente })).map((u) => u.email)).toEqual(["bodega@textiles.ec", "compras@textiles.ec"]);
      const { passwordHash: _, ...sinHash } = bodega;
      expect(await repos.usuarios.obtener(bodega.id)).toEqual(sinHash);
      expect(await repos.usuarios.buscarPorId(bodega.id)).toBeNull(); // inactivo
      expect(await repos.usuarios.buscarPorEmail("compras@textiles.ec")).toMatchObject({ clienteId: cliente, activo: true });
      expect(await repos.usuarios.accesosPortalPorCliente()).toEqual(new Map([[cliente, 1]]));

      expect(await repos.usuarios.actualizar(zeta.id, { nombre: "Alfa Repartidor", rol: "OPERADOR", activo: false, passwordHash: "hash:Otra1234" })).toMatchObject({
        nombre: "Alfa Repartidor",
        rol: "OPERADOR",
        activo: false,
      });
      expect(await repos.usuarios.buscarPorEmail("zeta@pcargo.ec")).toMatchObject({ passwordHash: "hash:Otra1234", activo: false });
      await expect(repos.usuarios.actualizar(zeta.id, { email: "admin@pcargo.ec" })).rejects.toMatchObject({ code: "CONFLICTO" });

      // eliminar el cliente desactiva y desvincula a sus usuarios del portal (cuenta solo los que estaban activos)
      expect(await repos.clientes.eliminar(cliente)).toBe(1);
      expect((await repos.usuarios.listar({ rol: "CLIENTE" })).filter((u) => u.id !== USUARIOS_SEED[3]!.id).map((u) => [u.activo, u.clienteId])).toEqual([
        [false, null],
        [false, null],
      ]);
      expect(await repos.usuarios.accesosPortalPorCliente()).toEqual(new Map());
    });

    it("envíos (v12): asignación atómica de repartidor (con su nombre) y filtros de reparto y retención", async () => {
      const [e1, e2, e3] = [envioV12("PAGADO", 1), envioV12("AL_COBRO", 2), envioV12("CONTRATO", 3)];
      for (const e of [e1, e2, e3]) await repos.envios.guardar(e!);
      e3!.cambiarEstado("CANCELADO", { ahora: fecha(10), actor: OPERADOR });
      await repos.envios.guardar(e3!);

      expect(await repos.envios.asignarRepartidor([e1!.id, e2!.id], REP.id, fecha(20))).toBe(2);
      expect((await repos.envios.buscarPorId(e1!.id))!.toSnapshot()).toMatchObject({
        repartidor: { id: REP.id, nombre: REP.nombre },
        asignadoEn: fecha(20),
        historial: [{ estado: "REGISTRADO" }],
      });
      await expect(repos.envios.asignarRepartidor([e1!.id, e3!.id], null, fecha(21))).rejects.toMatchObject({ code: "ESTADO_INVALIDO" });
      await expect(repos.envios.asignarRepartidor([e1!.id, "00000000-0000-4000-c000-0000000000ff"], null, fecha(21))).rejects.toMatchObject({ code: "NO_ENCONTRADO" });
      expect((await repos.envios.buscarPorId(e1!.id))!.repartidor?.id).toBe(REP.id);
      // guardar un cambio de estado (con una copia leída antes de asignar) no pisa la asignación
      e1!.cambiarEstado("EN_TRANSITO", { ahora: fecha(22), actor: OPERADOR });
      await repos.envios.guardar(e1!);
      expect((await repos.envios.buscarPorId(e1!.id))!.repartidor?.id).toBe(REP.id);

      const guias = async (f: Parameters<typeof repos.envios.listar>[0]) => (await repos.envios.listar(f)).map((e) => e.numeroGuia).sort();
      expect(await guias({ repartidorId: REP.id })).toEqual([e1!.numeroGuia, e2!.numeroGuia]);
      expect(await guias({ repartidorId: null })).toEqual([e3!.numeroGuia]);
      expect(await guias({ estados: ["REGISTRADO", "CANCELADO"] })).toEqual([e2!.numeroGuia, e3!.numeroGuia]);
      expect(await guias({ actualizadoDesde: fecha(10) })).toEqual([e1!.numeroGuia, e3!.numeroGuia]);
      expect(await guias({ telefono: "0987654321" })).toEqual([e1!.numeroGuia, e2!.numeroGuia, e3!.numeroGuia]);
      expect(await guias({ telefono: "0980000000" })).toEqual([]);
      const pagina = await repos.envios.listarPagina({ repartidorId: REP.id, estados: ["EN_TRANSITO"] }, { pagina: 1, porPagina: 10 });
      expect([pagina.total, pagina.envios[0]?.id]).toEqual([1, e1!.id]);
      // quitar la asignación
      expect(await repos.envios.asignarRepartidor([e1!.id], null, fecha(30))).toBe(1);
      expect((await repos.envios.buscarPorId(e1!.id))!.toSnapshot()).toMatchObject({ repartidor: null, asignadoEn: null });
    });

    it("envíos (v12): anonimizar persiste los datos borrados y las notas; sin anonimizar los datos personales no cambian", async () => {
      const e = envioV12("CONTRATO", 1);
      await repos.envios.guardar(e);
      e.cambiarEstado("CANCELADO", { ahora: fecha(5), actor: OPERADOR, nota: "Desistió el cliente" });
      await repos.envios.guardar(e);
      const copia = (await repos.envios.buscarPorId(e.id))!;
      e.anonimizar(fecha(100));
      await repos.envios.guardar(e);
      const leido = (await repos.envios.buscarPorId(e.id))!.toSnapshot();
      expect(leido).toMatchObject({
        remitente: { nombre: "Anonimizado", telefono: "", direccion: null },
        destinatario: { nombre: "Anonimizado", telefono: "", direccion: "Anonimizado" },
        descripcion: null,
        anonimizadoEn: fecha(100),
        estado: "CANCELADO",
        costo: 3,
        actualizadoEn: fecha(5),
      });
      expect(leido.historial.map((h) => [h.estado, h.nota])).toEqual([
        ["REGISTRADO", null],
        ["CANCELADO", null],
      ]);
      // una copia vieja (sin anonimizar) no restaura los datos
      await repos.envios.guardar(copia);
      expect((await repos.envios.buscarPorId(e.id))!.toSnapshot()).toMatchObject({ remitente: { nombre: "Anonimizado" }, anonimizadoEn: fecha(100) });
    });

    it("caja: cobros en la misma transacción del envío, anulación o devolución, cierre atómico y listados", async () => {
      const pagado = envioV12("PAGADO", 1);
      const origen = cobroDe(pagado, "ORIGEN", 3, OPERADOR, 1);
      await repos.envios.guardar(pagado, { caja: { cobros: [origen], anulaciones: [] } });
      expect(await repos.caja.pendientes()).toEqual([origen]);
      expect(await repos.caja.cobrosDeEnvio(pagado.id)).toEqual([origen]);

      // un segundo ORIGEN del mismo envío se rechaza y el cambio del envío tampoco se guarda
      pagado.cambiarEstado("EN_TRANSITO", { ahora: fecha(2), actor: OPERADOR });
      await expect(
        repos.envios.guardar(pagado, { caja: { cobros: [cobroDe(pagado, "ORIGEN", 3)], anulaciones: [] } }),
      ).rejects.toMatchObject({ code: "CONFLICTO" });
      expect((await repos.envios.buscarPorId(pagado.id))!.estado).toBe("REGISTRADO");

      const alCobro = envioV12("AL_COBRO", 3);
      await repos.envios.guardar(alCobro);
      const contra = cobroDe(alCobro, "CONTRA_ENTREGA", 3, REP, 4);
      await repos.envios.guardar(alCobro, { caja: { cobros: [contra], anulaciones: [] } });
      expect((await repos.caja.pendientes(REP.id)).map((c) => c.id)).toEqual([contra.id]);

      // cierre: toma todos los pendientes de la persona; uno simultáneo no los vuelve a tomar
      const [r1, r2] = await Promise.allSettled([
        repos.caja.cerrar(OPERADOR.id, (p) => cierreDe("00000000-0000-4000-c400-000000000001", p)),
        repos.caja.cerrar(OPERADOR.id, (p) => cierreDe("00000000-0000-4000-c400-000000000002", p)),
      ]);
      const ok = [r1, r2].filter((r) => r.status === "fulfilled");
      const fallo = [r1, r2].filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      expect(ok).toHaveLength(1);
      expect(fallo.map((f) => (f.reason as { code: string }).code)).toEqual(["SIN_COBROS"]);
      const { cierre, cobros } = (ok[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof repos.caja.cerrar>>>).value;
      expect(cobros).toEqual([{ ...origen, cierreId: cierre.id }]);
      expect(await repos.caja.pendientes(OPERADOR.id)).toEqual([]);
      expect(await repos.caja.buscarCierre(cierre.id)).toEqual({
        id: cierre.id,
        usuario: { id: OPERADOR.id, nombre: OPERADOR.nombre, rol: "OPERADOR" },
        recibidoPor: { id: ADMIN.id, nombre: ADMIN.nombre },
        fecha: fecha(30),
        esperado: 3,
        entregado: 3,
        diferencia: 0,
        cantidad: 1,
        nota: null,
        porTipo: [
          { tipo: "ORIGEN", cantidad: 1, monto: 3 },
          { tipo: "CONTRA_ENTREGA", cantidad: 0, monto: 0 },
          { tipo: "DEVOLUCION", cantidad: 0, monto: 0 },
        ],
      });
      expect(await repos.caja.cobrosDeCierre(cierre.id)).toEqual([{ ...origen, cierreId: cierre.id }]);

      // cancelar con el ORIGEN ya cerrado: la anulación se convierte en devolución
      const devolucion = cobroDe(pagado, "DEVOLUCION", -3, ADMIN, 40);
      await repos.envios.guardar(pagado, { caja: { cobros: [], anulaciones: [{ cobroId: origen.id, siYaCerrado: devolucion }] } });
      expect(await repos.caja.pendientes(ADMIN.id)).toEqual([devolucion]);
      // con el ORIGEN pendiente: desaparece
      const otro = envioV12("PAGADO", 41);
      const origen2 = cobroDe(otro, "ORIGEN", 3, OPERADOR, 41);
      await repos.envios.guardar(otro, { caja: { cobros: [origen2], anulaciones: [] } });
      otro.cambiarEstado("CANCELADO", { ahora: fecha(42), actor: OPERADOR });
      await repos.envios.guardar(otro, { caja: { cobros: [], anulaciones: [{ cobroId: origen2.id, siYaCerrado: cobroDe(otro, "DEVOLUCION", -3) }] } });
      expect(await repos.caja.cobrosDeEnvio(otro.id)).toEqual([]);

      // listados de cierres: recientes primero, filtros y páginas
      const segundo = await repos.caja.cerrar(REP.id, (p) => cierreDe("00000000-0000-4000-c400-000000000003", p, REP, 90));
      const lista = await repos.caja.listarCierres({}, { pagina: 1, porPagina: 10 });
      expect([lista.total, lista.cierres.map((k) => k.id)]).toEqual([2, [segundo.cierre.id, cierre.id]]);
      expect((await repos.caja.listarCierres({ usuarioId: REP.id }, { pagina: 1, porPagina: 10 })).cierres.map((k) => k.usuario)).toEqual([
        { id: REP.id, nombre: REP.nombre, rol: "REPARTIDOR" },
      ]);
      expect((await repos.caja.listarCierres({ desde: fecha(31), hasta: fecha(91) }, { pagina: 1, porPagina: 10 })).cierres.map((k) => k.id)).toEqual([segundo.cierre.id]);
      expect((await repos.caja.listarCierres({ hasta: fecha(30) }, { pagina: 1, porPagina: 10 })).total).toBe(0);
      const p2 = await repos.caja.listarCierres({}, { pagina: 2, porPagina: 1 });
      expect([p2.total, p2.cierres.map((k) => k.id)]).toEqual([2, [cierre.id]]);
      expect(await repos.caja.buscarCierre("00000000-0000-4000-c400-0000000000ff")).toBeNull();
    });

    it("datos personales: solicitudes atendidas paginadas", async () => {
      const solicitud = (n: number, min: number) => ({
        id: `00000000-0000-4000-c500-${String(n).padStart(12, "0")}`,
        tipo: "ELIMINACION" as const,
        nombreTitular: `Titular ${n}`,
        telefonoFinal: "…4567",
        canal: "CORREO" as const,
        nota: n === 1 ? null : "Por correo",
        fecha: fecha(min),
        atendidaPor: ADMIN.nombre,
        resultado: { envios: n, clientes: 1, evidencias: 0, usuariosDesactivados: 0, enCurso: 0 },
      });
      for (const [n, min] of [[1, 10], [2, 30], [3, 20]] as const) await repos.datosPersonales.crearSolicitud(solicitud(n, min));
      const p1 = await repos.datosPersonales.listarSolicitudes({ pagina: 1, porPagina: 2 });
      expect(p1.total).toBe(3);
      expect(p1.solicitudes).toEqual([solicitud(2, 30), solicitud(3, 20)]);
      expect((await repos.datosPersonales.listarSolicitudes({ pagina: 2, porPagina: 2 })).solicitudes).toEqual([solicitud(1, 10)]);
    });
  });
}
