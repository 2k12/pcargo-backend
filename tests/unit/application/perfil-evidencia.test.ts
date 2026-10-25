import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  adaptadoresEnMemoria,
  crearCasosDeUso,
  type Adaptadores,
  type CasosDeUso,
} from "../../../src/infrastructure/container.js";
import { AlmacenMemoria } from "../../../src/infrastructure/storage/AlmacenMemoria.js";
import { ADMIN, FakeClock, hasherFalso, IMAGENES, JWT_SECRET_TEST, OPERADOR, SecuenciaIds, solicitudEnvio } from "../../helpers/fakes.js";

let c: CasosDeUso;
let a: Adaptadores;
let clock: FakeClock;
let almacen: AlmacenMemoria;

beforeEach(async () => {
  clock = new FakeClock();
  almacen = new AlmacenMemoria();
  a = await adaptadoresEnMemoria({ jwtSecret: JWT_SECRET_TEST, hasher: hasherFalso, clock, ids: new SecuenciaIds(), almacen });
  c = crearCasosDeUso(a);
});

describe("ActualizarPerfil", () => {
  it("cambia nombre y correo (en minúsculas) y devuelve un token con el nombre nuevo", async () => {
    const r = await c.actualizarPerfil.ejecutar(OPERADOR, { nombre: "  Paola  Ruiz ", email: "Paola@PCargo.ec" });
    expect(r.usuario).toEqual({ id: OPERADOR.id, nombre: "Paola Ruiz", email: "paola@pcargo.ec", rol: "OPERADOR", clienteId: null });
    expect(c.tokens.verificar(r.token)).toEqual({ id: OPERADOR.id, nombre: "Paola Ruiz", rol: "OPERADOR" });
    expect(await c.perfil.ejecutar(OPERADOR)).toEqual(r.usuario);
    // con el correo nuevo se inicia sesión; con el viejo ya no
    await expect(c.login.ejecutar("paola@pcargo.ec", "Operador123!")).resolves.toMatchObject({ usuario: { nombre: "Paola Ruiz" } });
    await expect(c.login.ejecutar("operador@pcargo.ec", "Operador123!")).rejects.toMatchObject({ code: "CREDENCIALES_INVALIDAS" });
  });

  it("el nombre del token nuevo queda como operador en los historiales", async () => {
    const { token } = await c.actualizarPerfil.ejecutar(OPERADOR, { nombre: "Paola Ruiz" });
    const actor = c.tokens.verificar(token);
    const envio = await c.crearEnvio.ejecutar(actor, solicitudEnvio());
    expect(envio.registro.operador).toBe("Paola Ruiz");
    const cambio = await c.cambiarEstado.ejecutar(actor, envio.id, "EN_TRANSITO");
    expect(cambio.historial?.at(-1)?.usuario).toBe("Paola Ruiz");
  });

  it("conserva su propio correo y el rol no cambia", async () => {
    const r = await c.actualizarPerfil.ejecutar(ADMIN, { email: "ADMIN@pcargo.ec", nombre: "Admin" });
    expect(r.usuario).toMatchObject({ email: "admin@pcargo.ec", rol: "ADMIN" });
    // aunque el token diga otro rol, el rol sale del repositorio
    const r2 = await c.actualizarPerfil.ejecutar({ ...OPERADOR, rol: "ADMIN" }, { nombre: "Operador" });
    expect(r2.usuario.rol).toBe("OPERADOR");
    expect(c.tokens.verificar(r2.token).rol).toBe("OPERADOR");
  });

  it("correo de otro usuario → CONFLICTO; datos inválidos → VALIDACION; usuario inexistente → NO_AUTENTICADO", async () => {
    await expect(c.actualizarPerfil.ejecutar(OPERADOR, { email: "Admin@pcargo.ec" })).rejects.toMatchObject({ code: "CONFLICTO" });
    await expect(c.actualizarPerfil.ejecutar(OPERADOR, {})).rejects.toMatchObject({ code: "VALIDACION" });
    await expect(c.actualizarPerfil.ejecutar(OPERADOR, { nombre: "x" })).rejects.toMatchObject({ code: "VALIDACION" });
    const fantasma = { id: "00000000-0000-4000-8000-0000000000ff", nombre: "X", rol: "OPERADOR" as const };
    await expect(c.actualizarPerfil.ejecutar(fantasma, { nombre: "Nadie" })).rejects.toMatchObject({ code: "NO_AUTENTICADO" });
    expect((await c.perfil.ejecutar(OPERADOR)).email).toBe("operador@pcargo.ec");
  });
});

describe("CambiarContrasena", () => {
  it("cambia la contraseña con la actual correcta", async () => {
    await c.cambiarContrasena.ejecutar(OPERADOR, { actual: "Operador123!", nueva: "Nueva2026x" });
    await expect(c.login.ejecutar("operador@pcargo.ec", "Nueva2026x")).resolves.toBeDefined();
    await expect(c.login.ejecutar("operador@pcargo.ec", "Operador123!")).rejects.toMatchObject({ code: "CREDENCIALES_INVALIDAS" });
  });

  it("actual incorrecta → CONTRASENA_INCORRECTA y no cambia nada", async () => {
    await expect(c.cambiarContrasena.ejecutar(OPERADOR, { actual: "mala", nueva: "Nueva2026x" })).rejects.toMatchObject({
      code: "CONTRASENA_INCORRECTA",
    });
    await expect(c.login.ejecutar("operador@pcargo.ec", "Operador123!")).resolves.toBeDefined();
  });

  it("valida la nueva antes de comprobar la actual (VALIDACION)", async () => {
    const verificar = vi.spyOn(a.hasher, "verificar");
    for (const nueva of ["corta1", "sinnumeros", "12345678", "Operador123!"]) {
      await expect(c.cambiarContrasena.ejecutar(OPERADOR, { actual: "Operador123!", nueva })).rejects.toMatchObject({
        code: "VALIDACION",
      });
    }
    expect(verificar).not.toHaveBeenCalled();
  });
});

/** Crea un envío y lo lleva hasta ENTREGADO. */
async function envioEntregado(actor = OPERADOR) {
  const e = await c.crearEnvio.ejecutar(actor, solicitudEnvio());
  for (const estado of ["EN_TRANSITO", "EN_REPARTO", "ENTREGADO"]) await c.cambiarEstado.ejecutar(actor, e.id, estado);
  return e;
}

describe("Dirección del remitente", () => {
  it("se guarda al crear el envío y aparece en el DTO; vacía → null", async () => {
    const con = await c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio({
      remitente: { nombre: "María Pérez", telefono: "0991234567", direccion: " Sucre 4-56, Ibarra " },
    }));
    expect(con.remitente).toEqual({ nombre: "María Pérez", telefono: "0991234567", direccion: "Sucre 4-56, Ibarra" });
    expect((await c.obtenerEnvio.ejecutar(con.id)).remitente.direccion).toBe("Sucre 4-56, Ibarra");
    const sin = await c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio({ remitente: { nombre: "Ana", telefono: "0991112233", direccion: "" } }));
    expect(sin.remitente.direccion).toBeNull();
    expect((await c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio())).remitente.direccion).toBeNull();
  });
});

describe("SubirEvidencia / ObtenerEvidencia", () => {
  it("guarda la foto en el almacén y los metadatos en el envío (sin exponer la clave)", async () => {
    const e = await envioEntregado();
    clock.avanzar(30);
    const r = await c.subirEvidencia.ejecutar(OPERADOR, e.id, { foto: IMAGENES.jpeg, recibidoPor: " Rosa Cevallos " });
    expect(r.evidencia).toEqual({
      recibidoPor: "Rosa Cevallos",
      tipo: "image/jpeg",
      bytes: IMAGENES.jpeg.length,
      subidaEn: clock.ahora().toISOString(),
      subidaPor: OPERADOR.nombre,
    });
    expect(r.historial).toHaveLength(4);
    expect(JSON.stringify(r)).not.toContain("evidencias/");
    expect(almacen.claves()).toEqual([expect.stringMatching(new RegExp(`^evidencias/${e.id}/[0-9a-f-]+\\.jpg$`))]);

    const archivo = await c.obtenerEvidencia.ejecutar(e.id);
    expect(archivo.tipo).toBe("image/jpeg");
    expect(Buffer.from(archivo.bytes).equals(IMAGENES.jpeg)).toBe(true);
    // aparece en el detalle y en el listado
    expect((await c.obtenerEnvio.ejecutar(e.id)).evidencia?.recibidoPor).toBe("Rosa Cevallos");
    expect((await c.listarEnvios.ejecutar()).datos.find((x) => x.id === e.id)?.evidencia?.tipo).toBe("image/jpeg");
  });

  it("al reemplazarla borra la foto anterior del almacén", async () => {
    const e = await envioEntregado();
    await c.subirEvidencia.ejecutar(OPERADOR, e.id, { foto: IMAGENES.jpeg, recibidoPor: "Rosa" });
    const [primera] = almacen.claves();
    const r = await c.subirEvidencia.ejecutar(ADMIN, e.id, { foto: IMAGENES.webp, recibidoPor: "Luis" });
    expect(r.evidencia).toMatchObject({ recibidoPor: "Luis", tipo: "image/webp", subidaPor: ADMIN.nombre });
    expect(almacen.claves()).toHaveLength(1);
    expect(almacen.claves()[0]).not.toBe(primera);
    expect(almacen.claves()[0]).toMatch(/\.webp$/);
    expect((await c.obtenerEvidencia.ejecutar(e.id)).tipo).toBe("image/webp");
  });

  it("envío no ENTREGADO → ESTADO_INVALIDO y no guarda nada", async () => {
    const e = await c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio());
    await expect(c.subirEvidencia.ejecutar(OPERADOR, e.id, { foto: IMAGENES.png, recibidoPor: "Rosa" })).rejects.toMatchObject({
      code: "ESTADO_INVALIDO",
    });
    expect(almacen.claves()).toEqual([]);
    expect((await c.obtenerEnvio.ejecutar(e.id)).evidencia).toBeNull();
  });

  it("ni foto ni nombre, foto que no es imagen, pesada o nombre inválido → VALIDACION; envío inexistente → NO_ENCONTRADO", async () => {
    const e = await envioEntregado();
    const casos = [
      { foto: null },
      { foto: null, recibidoPor: null },
      { foto: IMAGENES.falsa, recibidoPor: "Rosa" },
      { foto: Buffer.concat([IMAGENES.jpeg, Buffer.alloc(5 * 1024 * 1024)]), recibidoPor: "Rosa" },
      { foto: IMAGENES.png, recibidoPor: "R" },
    ];
    for (const s of casos) {
      await expect(c.subirEvidencia.ejecutar(OPERADOR, e.id, s)).rejects.toMatchObject({ code: "VALIDACION" });
    }
    await expect(
      c.subirEvidencia.ejecutar(OPERADOR, "00000000-0000-4000-a000-0000000fffff", { foto: IMAGENES.png, recibidoPor: "Rosa" }),
    ).rejects.toMatchObject({ code: "NO_ENCONTRADO" });
    expect(almacen.claves()).toEqual([]);
  });

  it("si no se pueden guardar los metadatos, borra la foto nueva y conserva la anterior", async () => {
    const e = await envioEntregado();
    await c.subirEvidencia.ejecutar(OPERADOR, e.id, { foto: IMAGENES.jpeg, recibidoPor: "Rosa" });
    const antes = almacen.claves();
    vi.spyOn(a.envios, "guardar").mockRejectedValueOnce(new Error("BD caída"));
    await expect(c.subirEvidencia.ejecutar(OPERADOR, e.id, { foto: IMAGENES.png, recibidoPor: "Luis" })).rejects.toThrow("BD caída");
    expect(almacen.claves()).toEqual(antes);
    expect((await c.obtenerEvidencia.ejecutar(e.id)).tipo).toBe("image/jpeg");
  });

  it("si falla borrar la foto anterior, la nueva queda registrada igualmente", async () => {
    const e = await envioEntregado();
    await c.subirEvidencia.ejecutar(OPERADOR, e.id, { foto: IMAGENES.jpeg, recibidoPor: "Rosa" });
    vi.spyOn(almacen, "eliminar").mockRejectedValueOnce(new Error("R2 no responde"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await c.subirEvidencia.ejecutar(OPERADOR, e.id, { foto: IMAGENES.png, recibidoPor: "Luis" });
    expect(r.evidencia?.tipo).toBe("image/png");
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("obtener: sin evidencia, envío inexistente o archivo perdido → NO_ENCONTRADO", async () => {
    const e = await envioEntregado();
    await expect(c.obtenerEvidencia.ejecutar(e.id)).rejects.toMatchObject({ code: "NO_ENCONTRADO" });
    await expect(c.obtenerEvidencia.ejecutar("00000000-0000-4000-a000-0000000fffff")).rejects.toMatchObject({ code: "NO_ENCONTRADO" });
    await c.subirEvidencia.ejecutar(OPERADOR, e.id, { foto: IMAGENES.png, recibidoPor: "Rosa" });
    await almacen.eliminar(almacen.claves()[0]!);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(c.obtenerEvidencia.ejecutar(e.id)).rejects.toMatchObject({ code: "NO_ENCONTRADO" });
    error.mockRestore();
  });

  it("el seguimiento público no expone la evidencia", async () => {
    const e = await envioEntregado();
    await c.subirEvidencia.ejecutar(OPERADOR, e.id, { foto: IMAGENES.png, recibidoPor: "Rosa Cevallos" });
    const s = await c.seguimiento.ejecutar(String(e.numeroGuia));
    expect(s).not.toHaveProperty("evidencia");
    expect(JSON.stringify(s)).not.toContain("Rosa");
  });
});

describe("SubirEvidencia por partes (v19)", () => {
  it("solo nombre: no toca el almacén; GET de la foto → NO_ENCONTRADO", async () => {
    const e = await envioEntregado();
    const r = await c.subirEvidencia.ejecutar(OPERADOR, e.id, { foto: null, recibidoPor: "Rosa Vera" });
    expect(r.evidencia).toEqual({
      recibidoPor: "Rosa Vera",
      tipo: null,
      bytes: null,
      subidaEn: clock.ahora().toISOString(),
      subidaPor: OPERADOR.nombre,
    });
    expect(almacen.claves()).toEqual([]);
    await expect(c.obtenerEvidencia.ejecutar(e.id)).rejects.toMatchObject({ code: "NO_ENCONTRADO" });
  });

  it("solo foto conserva el nombre; solo nombre conserva la foto; subidaEn/subidaPor = última modificación", async () => {
    const e = await envioEntregado();
    await c.subirEvidencia.ejecutar(OPERADOR, e.id, { foto: null, recibidoPor: "Rosa Vera" });
    clock.avanzar(5);
    const conFoto = await c.subirEvidencia.ejecutar(ADMIN, e.id, { foto: IMAGENES.png });
    expect(conFoto.evidencia).toEqual({
      recibidoPor: "Rosa Vera",
      tipo: "image/png",
      bytes: IMAGENES.png.length,
      subidaEn: clock.ahora().toISOString(),
      subidaPor: ADMIN.nombre,
    });
    const [clave] = almacen.claves();
    clock.avanzar(5);
    const conNombre = await c.subirEvidencia.ejecutar(OPERADOR, e.id, { foto: null, recibidoPor: "Luis Andrade" });
    expect(conNombre.evidencia).toMatchObject({ recibidoPor: "Luis Andrade", tipo: "image/png", subidaEn: clock.ahora().toISOString(), subidaPor: OPERADOR.nombre });
    expect(almacen.claves()).toEqual([clave]); // la foto sigue
    expect((await c.obtenerEvidencia.ejecutar(e.id)).tipo).toBe("image/png");
  });

  it("solo foto sobre otra foto: reemplaza y borra la anterior, conserva el nombre", async () => {
    const e = await envioEntregado();
    await c.subirEvidencia.ejecutar(OPERADOR, e.id, { foto: IMAGENES.jpeg, recibidoPor: "Rosa" });
    const [primera] = almacen.claves();
    const r = await c.subirEvidencia.ejecutar(OPERADOR, e.id, { foto: IMAGENES.webp });
    expect(r.evidencia).toMatchObject({ recibidoPor: "Rosa", tipo: "image/webp" });
    expect(almacen.claves()).toHaveLength(1);
    expect(almacen.claves()[0]).not.toBe(primera);
  });

  it("solo nombre en un envío no ENTREGADO → ESTADO_INVALIDO", async () => {
    const e = await c.crearEnvio.ejecutar(OPERADOR, solicitudEnvio());
    await expect(c.subirEvidencia.ejecutar(OPERADOR, e.id, { foto: null, recibidoPor: "Rosa" })).rejects.toMatchObject({
      code: "ESTADO_INVALIDO",
    });
  });
});
