import { createClient, type Client, type InValue } from '@libsql/client';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { decryptPersistedConfig } from '../config-crypto';

let sqlClient: Client | null = null;
let s3Runtime: { client: S3Client; bucket: string; fingerprint: string } | null = null;

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`VERCEL_ENV_REQUIRED:${name}`);
  return value;
}

export function getLibsqlClient() {
  if (!sqlClient) {
    sqlClient = createClient({
      url: required('TURSO_DATABASE_URL'),
      authToken: process.env.TURSO_AUTH_TOKEN?.trim() || undefined,
    });
  }
  return sqlClient;
}

export type R2RuntimeConfig = { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string };

async function decryptStoredR2Config(): Promise<R2RuntimeConfig | null> {
  const result = await getLibsqlClient().execute({ sql: "SELECT value FROM settings WHERE key='secret_cloudflare_connection' LIMIT 1", args: [] });
  const encrypted = String(result.rows[0]?.value || '');
  if (!encrypted) return null;
  try {
    const connection = await decryptPersistedConfig<{ accountId?: string; bucket?: string; accessKeyId?: string; secretAccessKey?: string; endpoint?: string }>(encrypted);
    const accountId = connection.accountId?.trim() || '';
    const endpoint = connection.endpoint?.trim() || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : '');
    if (!endpoint || !connection.bucket || !connection.accessKeyId || !connection.secretAccessKey) return null;
    return { endpoint, bucket: connection.bucket.trim(), accessKeyId: connection.accessKeyId.trim(), secretAccessKey: connection.secretAccessKey.trim() };
  } catch {
    return null;
  }
}

async function r2Config(): Promise<R2RuntimeConfig> {
  const accountId = process.env.R2_ACCOUNT_ID?.trim() || process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || '';
  const endpoint = process.env.R2_ENDPOINT?.trim() || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : '');
  const bucket = process.env.R2_BUCKET?.trim() || process.env.CLOUDFLARE_R2_BUCKET?.trim() || '';
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim() || '';
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim() || '';
  if (endpoint && bucket && accessKeyId && secretAccessKey) return { endpoint, bucket, accessKeyId, secretAccessKey };
  const stored = await decryptStoredR2Config();
  if (stored) return stored;
  throw new Error('R2_CONFIGURATION_REQUIRED');
}

function createS3(config: R2RuntimeConfig) {
  return new S3Client({
    region: 'auto',
    endpoint: config.endpoint,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    forcePathStyle: true,
  });
}

async function getR2Runtime() {
  const config = await r2Config();
  const fingerprint = `${config.endpoint}|${config.bucket}|${config.accessKeyId}`;
  if (!s3Runtime || s3Runtime.fingerprint !== fingerprint) s3Runtime = { client: createS3(config), bucket: config.bucket, fingerprint };
  return s3Runtime;
}

export async function testR2Connection(config: R2RuntimeConfig) {
  const client = createS3(config);
  await client.send(new ListObjectsV2Command({ Bucket: config.bucket, MaxKeys: 1 }));
  client.destroy();
  return true;
}

function asNodeBody(body: unknown) {
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body && typeof body === 'object' && 'getReader' in body) {
    return Readable.fromWeb(body as globalThis.ReadableStream<Uint8Array> as never);
  }
  return body as never;
}

function toWebStream(body: unknown): ReadableStream<Uint8Array> {
  if (body && typeof body === 'object' && 'transformToWebStream' in body && typeof (body as { transformToWebStream?: unknown }).transformToWebStream === 'function') {
    return (body as { transformToWebStream(): ReadableStream<Uint8Array> }).transformToWebStream();
  }
  if (body instanceof Readable) return Readable.toWeb(body) as ReadableStream<Uint8Array>;
  throw new Error('R2_BODY_STREAM_UNAVAILABLE');
}

async function toArrayBuffer(body: unknown): Promise<ArrayBuffer> {
  if (body && typeof body === 'object' && 'transformToByteArray' in body && typeof (body as { transformToByteArray?: unknown }).transformToByteArray === 'function') {
    const bytes = await (body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }
  if (body instanceof Readable) {
    const stream = body as Readable;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const buffer = Buffer.concat(chunks);
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
  }
  throw new Error('R2_BODY_ARRAYBUFFER_UNAVAILABLE');
}

export type BucketPutOptions = {
  httpMetadata?: { contentType?: string; contentDisposition?: string; cacheControl?: string; contentEncoding?: string; contentLanguage?: string };
  customMetadata?: Record<string, string>;
};

function writeHttpMetadata(headers: Headers, metadata: { contentType?: string; contentDisposition?: string; cacheControl?: string; contentEncoding?: string; contentLanguage?: string }) {
  if (metadata.contentType) headers.set('content-type', metadata.contentType);
  if (metadata.contentDisposition) headers.set('content-disposition', metadata.contentDisposition);
  if (metadata.cacheControl) headers.set('cache-control', metadata.cacheControl);
  if (metadata.contentEncoding) headers.set('content-encoding', metadata.contentEncoding);
  if (metadata.contentLanguage) headers.set('content-language', metadata.contentLanguage);
}

class VercelR2Bucket {
  async get(key: string) {
    try {
      const { client, bucket } = await getR2Runtime();
      const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!result.Body) return null;
      const bodySource = result.Body;
      return {
        key,
        size: Number(result.ContentLength || 0),
        etag: result.ETag?.replace(/^\"|\"$/g, '') || '',
        httpEtag: result.ETag || '',
        uploaded: result.LastModified || new Date(0),
        httpMetadata: {
          contentType: result.ContentType,
          contentDisposition: result.ContentDisposition,
          cacheControl: result.CacheControl,
          contentEncoding: result.ContentEncoding,
          contentLanguage: result.ContentLanguage,
        },
        customMetadata: result.Metadata || {},
        writeHttpMetadata(headers: Headers) {
          writeHttpMetadata(headers, {
            contentType: result.ContentType,
            contentDisposition: result.ContentDisposition,
            cacheControl: result.CacheControl,
            contentEncoding: result.ContentEncoding,
            contentLanguage: result.ContentLanguage,
          });
        },
        body: toWebStream(bodySource),
        arrayBuffer: async () => {
          const fresh = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
          if (!fresh.Body) throw new Error('R2_BODY_NOT_FOUND');
          return toArrayBuffer(fresh.Body);
        },
      };
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
      const name = (error as { name?: string })?.name;
      if (status === 404 || name === 'NoSuchKey' || name === 'NotFound') return null;
      throw error;
    }
  }

  async put(key: string, body: unknown, options: BucketPutOptions = {}) {
    const { client, bucket } = await getR2Runtime();
    const result = await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: asNodeBody(body),
      ContentType: options.httpMetadata?.contentType,
      ContentDisposition: options.httpMetadata?.contentDisposition,
      CacheControl: options.httpMetadata?.cacheControl,
      ContentEncoding: options.httpMetadata?.contentEncoding,
      ContentLanguage: options.httpMetadata?.contentLanguage,
      Metadata: options.customMetadata,
    }));
    return { key, etag: result.ETag?.replace(/^\"|\"$/g, '') || '' };
  }

  async head(key: string) {
    try {
      const { client, bucket } = await getR2Runtime();
      const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return {
        key,
        size: Number(result.ContentLength || 0),
        etag: result.ETag?.replace(/^\"|\"$/g, '') || '',
        httpEtag: result.ETag || '',
        uploaded: result.LastModified || new Date(0),
        httpMetadata: {
          contentType: result.ContentType,
          contentDisposition: result.ContentDisposition,
          cacheControl: result.CacheControl,
          contentEncoding: result.ContentEncoding,
          contentLanguage: result.ContentLanguage,
        },
        customMetadata: result.Metadata || {},
      };
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
      const name = (error as { name?: string })?.name;
      if (status === 404 || name === 'NotFound' || name === 'NoSuchKey') return null;
      throw error;
    }
  }

  async list(options: { prefix?: string; limit?: number; cursor?: string } = {}) {
    const { client, bucket } = await getR2Runtime();
    const result = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: options.prefix,
      MaxKeys: options.limit,
      ContinuationToken: options.cursor,
    }));
    return {
      objects: (result.Contents || []).map((object: { Key?: string; Size?: number; ETag?: string; LastModified?: Date }) => ({
        key: object.Key || '',
        size: Number(object.Size || 0),
        etag: object.ETag?.replace(/^\"|\"$/g, '') || '',
        uploaded: object.LastModified || new Date(0),
      })),
      truncated: Boolean(result.IsTruncated),
      cursor: result.NextContinuationToken,
    };
  }

  async delete(keyOrKeys: string | string[]) {
    if (Array.isArray(keyOrKeys)) {
      if (!keyOrKeys.length) return;
      const { client, bucket } = await getR2Runtime();
      await client.send(new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: keyOrKeys.map((Key) => ({ Key })), Quiet: true },
      }));
      return;
    }
    const { client, bucket } = await getR2Runtime();
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: keyOrKeys }));
  }

  async createMultipartUpload(key: string, options: BucketPutOptions = {}) {
    const { client, bucket } = await getR2Runtime();
    const created = await client.send(new CreateMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      ContentType: options.httpMetadata?.contentType,
      ContentDisposition: options.httpMetadata?.contentDisposition,
      CacheControl: options.httpMetadata?.cacheControl,
      Metadata: options.customMetadata,
    }));
    const uploadId = created.UploadId;
    if (!uploadId) throw new Error('R2_MULTIPART_CREATE_FAILED');
    return {
      uploadId,
      key,
      uploadPart: async (partNumber: number, body: unknown) => {
        const uploaded = await client.send(new UploadPartCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
          Body: asNodeBody(body),
        }));
        const etag = uploaded.ETag?.replace(/^\"|\"$/g, '') || '';
        if (!etag) throw new Error(`R2_MULTIPART_ETAG_MISSING:${partNumber}`);
        return { partNumber, etag };
      },
      complete: async (parts: Array<{ partNumber: number; etag: string }>) => {
        await client.send(new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: { Parts: parts.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })) },
        }));
      },
      abort: async () => {
        await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }));
      },
    };
  }
}

class D1CompatPrepared {
  private args: InValue[] = [];
  constructor(private readonly sql: string) {}
  bind(...args: unknown[]) {
    this.args = args.map((value) => value instanceof Date ? value.getTime() : value as InValue);
    return this;
  }
  async first<T>() {
    const result = await getLibsqlClient().execute({ sql: this.sql, args: this.args });
    return (result.rows[0] as unknown as T | undefined) ?? null;
  }
  async run() {
    const result = await getLibsqlClient().execute({ sql: this.sql, args: this.args });
    return { success: true, meta: { changes: result.rowsAffected, last_row_id: result.lastInsertRowid ? Number(result.lastInsertRowid) : undefined } };
  }
  async all<T>() {
    const result = await getLibsqlClient().execute({ sql: this.sql, args: this.args });
    return { success: true, results: result.rows as unknown as T[], meta: { changes: result.rowsAffected } };
  }
}

class D1CompatDatabase {
  prepare(sql: string) { return new D1CompatPrepared(sql); }
}

const BUCKET = new VercelR2Bucket();
const DB = new D1CompatDatabase();

export const env = new Proxy({ DB, BUCKET } as Record<string, unknown> & { DB: D1CompatDatabase; BUCKET: VercelR2Bucket }, {
  get(target, property, receiver) {
    if (typeof property === 'string' && !(property in target)) return process.env[property];
    return Reflect.get(target, property, receiver);
  },
  ownKeys(target) {
    return [...new Set([...Reflect.ownKeys(target), ...Object.keys(process.env)])];
  },
  getOwnPropertyDescriptor(target, property) {
    return Reflect.getOwnPropertyDescriptor(target, property) || { configurable: true, enumerable: true, writable: false, value: typeof property === 'string' ? process.env[property] : undefined };
  },
});
