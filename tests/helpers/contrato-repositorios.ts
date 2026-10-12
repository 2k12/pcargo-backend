import { beforeEach, describe, expect, it } from "vitest";
import type {
  CiudadRepository,
  ClienteRepository,
  EnvioRepository,
  RutaRepository,
  TipoCargaRepository,
  UsuarioRepository,
} from "../../src/application/ports/repositories.js";
import { Envio } from "../../src/domain/envio/Envio.js";
import { TIPOS_CARGA_SEED, USUARIOS_SEED } from "../../src/infrastructure/persistence/seed-data.js";
import { ADMIN, OPERADOR, solicitudEnvio } from "./fakes.js";

export interface FabricaRepos {
  envios: EnvioRepository;
  rutas: RutaRepository;
  ciudades: CiudadRepository;
  clientes: ClienteRepository;
  tiposCarga: TipoCargaRepository;
  /** Con los usuarios semilla en su estado original (nombre, correo y contraseña). */
  usuarios: UsuarioRepository;
}

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
      });
      expect(await repos.tiposCarga.buscarPorCodigo("CARTON")).toMatchObject({ precio: 3, precioRural: null, mayoreo: null, pesoMaxKg: 35 });
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
  });
}
