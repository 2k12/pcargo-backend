import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { AlmacenArchivos } from "../../application/ports/services.js";

export interface ConfigR2 {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

/** Cliente S3 apuntando a Cloudflare R2 (API compatible con S3; región `auto`). */
export function crearClienteR2(c: Omit<ConfigR2, "bucket">): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: `https://${c.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
  });
}

/** Subconjunto del cliente S3 que usa el adaptador (permite inyectar un doble en los tests). */
export type ClienteS3 = Pick<S3Client, "send">;

const noExiste = (e: unknown): boolean => {
  const err = e as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return err.name === "NoSuchKey" || err.Code === "NoSuchKey" || err.$metadata?.httpStatusCode === 404;
};

/**
 * Almacén en un bucket **privado** de Cloudflare R2. Los objetos no tienen URL pública:
 * la API los lee con sus credenciales y los entrega a usuarios autenticados.
 */
export class AlmacenR2 implements AlmacenArchivos {
  constructor(
    private readonly cliente: ClienteS3,
    private readonly bucket: string,
  ) {}

  static desdeConfig(c: ConfigR2): AlmacenR2 {
    return new AlmacenR2(crearClienteR2(c), c.bucket);
  }

  async guardar(clave: string, bytes: Uint8Array, tipo: string): Promise<void> {
    await this.cliente.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: clave,
        Body: bytes,
        ContentType: tipo,
        ContentLength: bytes.length,
        CacheControl: "private, no-store",
      }),
    );
  }

  async obtener(clave: string): Promise<Uint8Array | null> {
    try {
      const r = await this.cliente.send(new GetObjectCommand({ Bucket: this.bucket, Key: clave }));
      if (!r.Body) return null;
      return await r.Body.transformToByteArray();
    } catch (e) {
      if (noExiste(e)) return null;
      throw e;
    }
  }

  async eliminar(clave: string): Promise<void> {
    // S3/R2 responden 204 aunque la clave no exista: borrar es idempotente.
    await this.cliente.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: clave }));
  }
}
