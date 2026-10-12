import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AlmacenArchivos } from "../../../src/application/ports/services.js";
import { CARPETA_STORAGE_DEFECTO, cargarConfig } from "../../../src/infrastructure/config/env.js";
import { crearAlmacen } from "../../../src/infrastructure/container.js";
import { AlmacenDisco } from "../../../src/infrastructure/storage/AlmacenDisco.js";
import { AlmacenMemoria } from "../../../src/infrastructure/storage/AlmacenMemoria.js";
import { AlmacenR2, type ClienteS3 } from "../../../src/infrastructure/storage/AlmacenR2.js";
import { IMAGENES } from "../../helpers/fakes.js";

/** Comportamiento común que debe cumplir cualquier almacén. */
function contratoAlmacen(nombre: string, crear: () => Promise<AlmacenArchivos>) {
  describe(`Contrato de AlmacenArchivos — ${nombre}`, () => {
    let almacen: AlmacenArchivos;
    beforeEach(async () => {
      almacen = await crear();
    });

    it("guarda, obtiene y elimina (idempotente)", async () => {
      const clave = "evidencias/00000000-0000-4000-a000-000000000001/foto-1.png";
      expect(await almacen.obtener(clave)).toBeNull();
      await almacen.guardar(clave, IMAGENES.png, "image/png");
      expect(Buffer.from((await almacen.obtener(clave))!).equals(IMAGENES.png)).toBe(true);
      await almacen.guardar(clave, IMAGENES.jpeg, "image/jpeg"); // sobrescribe
      expect(Buffer.from((await almacen.obtener(clave))!).equals(IMAGENES.jpeg)).toBe(true);
      await almacen.eliminar(clave);
      expect(await almacen.obtener(clave)).toBeNull();
      await expect(almacen.eliminar(clave)).resolves.toBeUndefined();
    });

    it("lo leído es una copia: mutarlo no altera lo guardado", async () => {
      await almacen.guardar("evidencias/x/a.jpg", IMAGENES.jpeg, "image/jpeg");
      const leido = (await almacen.obtener("evidencias/x/a.jpg"))!;
      leido[0] = 0;
      expect((await almacen.obtener("evidencias/x/a.jpg"))![0]).toBe(0xff);
    });
  });
}

contratoAlmacen("memoria", async () => new AlmacenMemoria());

describe("AlmacenDisco", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pcargo-almacen-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  contratoAlmacen("disco", async () => new AlmacenDisco(dir));

  it("crea las subcarpetas de la clave dentro de la carpeta raíz", async () => {
    const almacen = new AlmacenDisco(dir);
    await almacen.guardar("evidencias/e1/u1.webp", IMAGENES.webp, "image/webp");
    expect(await readdir(join(dir, "evidencias", "e1"))).toEqual(["u1.webp"]);
  });

  it.each(["../fuera.png", "evidencias/../../fuera.png", "/etc/passwd", "evidencias/./a.png", "C:\\x.png", "evidencias//a.png", ""])(
    "rechaza claves que escapan de la carpeta: %s",
    async (clave) => {
      const almacen = new AlmacenDisco(dir);
      await expect(almacen.guardar(clave, IMAGENES.png, "image/png")).rejects.toThrow(/Clave de almacén/);
      await expect(almacen.obtener(clave)).rejects.toThrow(/Clave de almacén/);
    },
  );
});

/** Doble del cliente S3: un bucket en memoria que responde como R2 (NoSuchKey al leer una clave inexistente). */
function clienteS3Falso() {
  const objetos = new Map<string, { bytes: Uint8Array; tipo?: string; cacheControl?: string }>();
  const send = vi.fn(async (cmd: unknown) => {
    if (cmd instanceof PutObjectCommand) {
      const i = cmd.input;
      objetos.set(`${i.Bucket}/${i.Key}`, { bytes: new Uint8Array(i.Body as Uint8Array), tipo: i.ContentType, cacheControl: i.CacheControl });
      return {};
    }
    if (cmd instanceof GetObjectCommand) {
      const o = objetos.get(`${cmd.input.Bucket}/${cmd.input.Key}`);
      if (!o) throw Object.assign(new Error("The specified key does not exist."), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
      return { Body: { transformToByteArray: async () => new Uint8Array(o.bytes) }, ContentType: o.tipo };
    }
    if (cmd instanceof DeleteObjectCommand) {
      objetos.delete(`${cmd.input.Bucket}/${cmd.input.Key}`);
      return {};
    }
    throw new Error("comando inesperado");
  });
  return { cliente: { send } as unknown as ClienteS3, send, objetos };
}

describe("AlmacenR2 (cliente S3 simulado, sin red)", () => {
  contratoAlmacen("r2", async () => new AlmacenR2(clienteS3Falso().cliente, "pcargo-evidencias"));

  it("sube al bucket privado con Content-Type y Cache-Control privados", async () => {
    const { cliente, send, objetos } = clienteS3Falso();
    const almacen = new AlmacenR2(cliente, "pcargo-evidencias");
    await almacen.guardar("evidencias/e1/u1.jpg", IMAGENES.jpeg, "image/jpeg");
    const put = send.mock.calls[0]![0] as PutObjectCommand;
    expect(put.input).toMatchObject({
      Bucket: "pcargo-evidencias",
      Key: "evidencias/e1/u1.jpg",
      ContentType: "image/jpeg",
      ContentLength: IMAGENES.jpeg.length,
      CacheControl: "private, no-store",
    });
    expect(put.input).not.toHaveProperty("ACL");
    expect(objetos.get("pcargo-evidencias/evidencias/e1/u1.jpg")?.tipo).toBe("image/jpeg");
  });

  it("propaga errores que no son 'no existe' (credenciales, red)", async () => {
    const send = vi.fn(async () => {
      throw Object.assign(new Error("Access Denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
    });
    const almacen = new AlmacenR2({ send } as unknown as ClienteS3, "b");
    await expect(almacen.obtener("evidencias/x.png")).rejects.toThrow("Access Denied");
    await expect(almacen.guardar("evidencias/x.png", IMAGENES.png, "image/png")).rejects.toThrow("Access Denied");
  });

  it("desdeConfig apunta al endpoint de la cuenta de R2 con región auto", async () => {
    const almacen = AlmacenR2.desdeConfig({ accountId: "abc123", accessKeyId: "k", secretAccessKey: "s", bucket: "b" });
    const cliente = (almacen as unknown as { cliente: { config: { region: () => Promise<string>; endpoint: () => Promise<{ hostname: string; protocol: string }> } } }).cliente;
    expect(await cliente.config.region()).toBe("auto");
    expect(await cliente.config.endpoint()).toMatchObject({ hostname: "abc123.r2.cloudflarestorage.com", protocol: "https:" });
  });
});

describe("Configuración del almacén (STORAGE_DRIVER)", () => {
  const base = { JWT_SECRET: "x".repeat(16) };
  const r2 = { R2_ACCOUNT_ID: "acc", R2_ACCESS_KEY_ID: "id", R2_SECRET_ACCESS_KEY: "secreto", R2_BUCKET: "pcargo" };

  it("por defecto: local en <backend>/storage; memory si DB_DRIVER=memory", () => {
    const c = cargarConfig(base);
    expect(c.STORAGE_DRIVER).toBe("local");
    expect(c.STORAGE_LOCAL_DIR).toBe(CARPETA_STORAGE_DEFECTO);
    expect(CARPETA_STORAGE_DEFECTO.replace(/\\/g, "/")).toMatch(/\/backend\/storage$/);
    expect(cargarConfig({ ...base, DB_DRIVER: "memory" }).STORAGE_DRIVER).toBe("memory");
    expect(cargarConfig({ ...base, DB_DRIVER: "memory", STORAGE_DRIVER: "local" }).STORAGE_DRIVER).toBe("local");
    expect(cargarConfig({ ...base, STORAGE_DRIVER: "" }).STORAGE_DRIVER).toBe("local");
  });

  it("STORAGE_LOCAL_DIR se resuelve a ruta absoluta", () => {
    const c = cargarConfig({ ...base, STORAGE_LOCAL_DIR: "./mis-archivos" });
    expect(c.STORAGE_LOCAL_DIR).toBe(join(process.cwd(), "mis-archivos"));
  });

  it("r2 exige las cuatro variables y dice cuáles faltan", () => {
    expect(() => cargarConfig({ ...base, STORAGE_DRIVER: "r2" })).toThrow(
      "STORAGE_DRIVER=r2 requiere R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET",
    );
    expect(() => cargarConfig({ ...base, STORAGE_DRIVER: "r2", ...r2, R2_BUCKET: " " })).toThrow("requiere R2_BUCKET");
    expect(cargarConfig({ ...base, STORAGE_DRIVER: "r2", ...r2 })).toMatchObject({ STORAGE_DRIVER: "r2", R2_BUCKET: "pcargo" });
  });

  it("driver desconocido → error de configuración", () => {
    expect(() => cargarConfig({ ...base, STORAGE_DRIVER: "s3" })).toThrow(/Configuración inválida: STORAGE_DRIVER/);
  });

  it("crearAlmacen elige el adaptador según el driver", () => {
    expect(crearAlmacen(cargarConfig({ ...base, STORAGE_DRIVER: "memory" }))).toBeInstanceOf(AlmacenMemoria);
    expect(crearAlmacen(cargarConfig(base))).toBeInstanceOf(AlmacenDisco);
    expect(crearAlmacen(cargarConfig({ ...base, STORAGE_DRIVER: "r2", ...r2 }))).toBeInstanceOf(AlmacenR2);
  });
});
