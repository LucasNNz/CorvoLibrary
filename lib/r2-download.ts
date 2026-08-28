import { env } from "./platform/runtime";
import { AwsClient } from "aws4fetch";
import { getCloudflareConnection } from "./secure-settings";

const DELIVERY_PART_BYTES = 5 * 1024 * 1024;

function encodeR2Key(key: string) {
  return key.split("/").map((part) => encodeURIComponent(part)).join("/");
}

function normalizedR2Endpoint(accountId: string, configuredEndpoint?: string) {
  const raw = configuredEndpoint?.trim() || accountId.trim();
  let endpoint: URL;
  if (/^https:\/\//i.test(raw)) endpoint = new URL(raw);
  else endpoint = new URL(`https://${raw}.r2.cloudflarestorage.com`);
  if (endpoint.protocol !== "https:" || !endpoint.hostname.endsWith(".r2.cloudflarestorage.com")) {
    throw new Error("R2_ENDPOINT_INVALID");
  }
  endpoint.pathname = "/";
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint;
}


async function resolveR2SigningConnection() {
  const saved = await getCloudflareConnection();
  const envAccountId = process.env.R2_ACCOUNT_ID?.trim() || process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || "";
  const envEndpoint = process.env.R2_ENDPOINT?.trim() || "";
  const envBucket = process.env.R2_BUCKET?.trim() || process.env.CLOUDFLARE_R2_BUCKET?.trim() || "";
  const envAccessKeyId = process.env.R2_ACCESS_KEY_ID?.trim() || "";
  const envSecretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim() || "";
  const connection = saved?.connection || ((envAccountId || envEndpoint) && envBucket && envAccessKeyId && envSecretAccessKey ? {
    accountId: envAccountId || new URL(envEndpoint).hostname.replace(/\.r2\.cloudflarestorage\.com$/, ""),
    bucket: envBucket, accessKeyId: envAccessKeyId, secretAccessKey: envSecretAccessKey, endpoint: envEndpoint,
  } : null);
  if (!connection) throw new Error("R2_SIGNING_NOT_CONFIGURED");
  const endpoint = normalizedR2Endpoint(connection.accountId, connection.endpoint);
  const aws = new AwsClient({ accessKeyId: connection.accessKeyId, secretAccessKey: connection.secretAccessKey, service: "s3", region: "auto" });
  return { connection, endpoint, aws };
}

export async function createSignedR2PutUrl(r2Key: string, minutes: number, mimeType: string) {
  const { connection, endpoint, aws } = await resolveR2SigningConnection();
  const objectUrl = new URL(`${encodeURIComponent(connection.bucket)}/${encodeR2Key(r2Key)}`, endpoint);
  const url = new URL(objectUrl);
  url.searchParams.set("X-Amz-Expires", String(Math.max(60, Math.min(3600, minutes * 60))));
  const headers = { "content-type": mimeType || "application/octet-stream" };
  const signed = await aws.sign(url, { method: "PUT", headers, aws: { signQuery: true } });
  return { url: signed.url, method: "PUT" as const, headers, expires_at: new Date(Date.now() + Math.max(60, Math.min(3600, minutes * 60)) * 1000).toISOString() };
}
export async function createSignedR2GetUrl(r2Key: string, minutes: number, fileName?: string, mimeType?: string) {
  const { connection, endpoint, aws } = await resolveR2SigningConnection();
  const objectUrl = new URL(`${encodeURIComponent(connection.bucket)}/${encodeR2Key(r2Key)}`, endpoint);
  await ensureDeliveryObject(aws, objectUrl, r2Key, mimeType);
  const url = new URL(objectUrl);
  url.searchParams.set("X-Amz-Expires", String(Math.max(60, Math.min(3600, minutes * 60))));
  if (fileName) url.searchParams.set("response-content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
  if (mimeType) url.searchParams.set("response-content-type", mimeType);
  const signed = await aws.sign(url, { method: "GET", aws: { signQuery: true } });
  return signed.url;
}

function takeBytes(chunks: Uint8Array[], size: number) {
  const output = new Uint8Array(size);
  let offset = 0;
  while (offset < size) {
    const current = chunks[0];
    const count = Math.min(current.byteLength, size - offset);
    output.set(current.subarray(0, count), offset);
    offset += count;
    if (count === current.byteLength) chunks.shift();
    else chunks[0] = current.subarray(count);
  }
  return output;
}

async function ensureDeliveryObject(aws: AwsClient, objectUrl: URL, r2Key: string, mimeType?: string) {
  const exists = await aws.fetch(objectUrl, { method: "HEAD" });
  if (exists.ok) return;
  if (exists.status !== 404) throw new Error(`R2_DIRECT_HEAD_FAILED:${exists.status}`);
  const source = await env.BUCKET.get(r2Key);
  if (!source?.body) throw new Error("R2_SOURCE_NOT_FOUND");
  const contentType = mimeType || source.httpMetadata?.contentType || "application/octet-stream";
  if (source.size <= DELIVERY_PART_BYTES) {
    const body = await source.arrayBuffer();
    const response = await aws.fetch(objectUrl, { method: "PUT", headers: { "content-type": contentType, "x-amz-meta-corvo-source": "sites-r2" }, body });
    if (!response.ok) throw new Error(`R2_DIRECT_PUT_FAILED:${response.status}`);
    return;
  }

  const createUrl = new URL(objectUrl);
  createUrl.searchParams.set("uploads", "");
  const created = await aws.fetch(createUrl, { method: "POST", headers: { "content-type": contentType, "x-amz-meta-corvo-source": "sites-r2" } });
  const createdText = await created.text();
  const uploadId = createdText.match(/<UploadId>([^<]+)<\/UploadId>/)?.[1];
  if (!created.ok || !uploadId) throw new Error(`R2_DIRECT_MULTIPART_CREATE_FAILED:${created.status}`);
  const parts: Array<{ number: number; etag: string }> = [];
  const chunks: Uint8Array[] = [];
  const reader = source.body.getReader();
  let queued = 0, partNumber = 1;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      chunks.push(chunk); queued += chunk.byteLength;
      while (queued >= DELIVERY_PART_BYTES) {
        const part = takeBytes(chunks, DELIVERY_PART_BYTES);
        const partUrl = new URL(objectUrl);
        partUrl.searchParams.set("partNumber", String(partNumber));
        partUrl.searchParams.set("uploadId", uploadId);
        const uploaded = await aws.fetch(partUrl, { method: "PUT", body: part });
        const etag = uploaded.headers.get("etag")?.replace(/^\"|\"$/g, "");
        if (!uploaded.ok || !etag) throw new Error(`R2_DIRECT_MULTIPART_PART_FAILED:${uploaded.status}`);
        parts.push({ number: partNumber++, etag }); queued -= DELIVERY_PART_BYTES;
      }
    }
    if (queued > 0) {
      const partUrl = new URL(objectUrl);
      partUrl.searchParams.set("partNumber", String(partNumber));
      partUrl.searchParams.set("uploadId", uploadId);
      const uploaded = await aws.fetch(partUrl, { method: "PUT", body: takeBytes(chunks, queued) });
      const etag = uploaded.headers.get("etag")?.replace(/^\"|\"$/g, "");
      if (!uploaded.ok || !etag) throw new Error(`R2_DIRECT_MULTIPART_PART_FAILED:${uploaded.status}`);
      parts.push({ number: partNumber, etag });
    }
    const completeUrl = new URL(objectUrl);
    completeUrl.searchParams.set("uploadId", uploadId);
    const xml = `<CompleteMultipartUpload>${parts.map((part) => `<Part><PartNumber>${part.number}</PartNumber><ETag>\"${part.etag}\"</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
    const completed = await aws.fetch(completeUrl, { method: "POST", headers: { "content-type": "application/xml" }, body: xml });
    if (!completed.ok) throw new Error(`R2_DIRECT_MULTIPART_COMPLETE_FAILED:${completed.status}`);
  } catch (error) {
    const abortUrl = new URL(objectUrl);
    abortUrl.searchParams.set("uploadId", uploadId);
    await aws.fetch(abortUrl, { method: "DELETE" }).catch(() => undefined);
    throw error;
  }
}
