import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { assets } from "../../../../db/schema";
import { isOwnerRequest, validMcpCode } from "../../../../lib/mcp-access";
import { resolveMediaMime } from "../../../../lib/media-mime";
import { env } from "../../../../lib/platform/runtime";
import { validDownloadSignature } from "../../../../lib/download-signature";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function safeFileName(value: string) {
  return value.replace(/["\\\r\n]/g, "-");
}

function parseRange(value: string | null, total: number) {
  const match = value?.match(/^bytes=(\d*)-(\d*)$/i);
  if (!match || total <= 0) return null;
  if (!match[1] && !match[2]) return null;
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Math.max(1, Number(match[2]));
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : total - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= total || end < start) return null;
  return { offset: start, length: Math.min(end, total - 1) - start + 1 };
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const ownerRequest = await isOwnerRequest(request);
  if (!ownerRequest && !validDownloadSignature(request) && !(await validMcpCode(request))) {
    return Response.json({ error: "Acesso ao arquivo não autorizado." }, { status: 401 });
  }

  const url = new URL(request.url);
  if (!ownerRequest) {
    const expires = Number(url.searchParams.get("exp"));
    if (!Number.isFinite(expires) || Date.now() > expires) {
      return Response.json({ error: "Link expirado." }, { status: 410 });
    }
  }

  const { id } = await context.params;
  const [asset] = await getDb().select().from(assets).where(eq(assets.id, decodeURIComponent(id))).limit(1);
  if (!asset) return Response.json({ error: "Asset não encontrado." }, { status: 404 });

  try {
    const metadata = await env.BUCKET.head(asset.r2Key);
    if (!metadata) return Response.json({ error: "Arquivo não encontrado no R2 configurado.", code: "R2_OBJECT_NOT_FOUND" }, { status: 404 });

    const requestedRange = request.headers.get("range");
    const range = parseRange(requestedRange, metadata.size);
    if (requestedRange && !range) {
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${metadata.size}`, "cache-control": "no-store" } });
    }
    const object = await env.BUCKET.get(asset.r2Key, range ? { range } : undefined);
    if (!object?.body) return Response.json({ error: "Arquivo não encontrado no R2 configurado.", code: "R2_OBJECT_NOT_FOUND" }, { status: 404 });

    const preview = url.searchParams.get("preview") === "1";
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("content-type", resolveMediaMime(asset.mimeType, asset.originalName, asset.r2Key));
    headers.set("content-disposition", `${preview ? "inline" : "attachment"}; filename="${safeFileName(asset.originalName)}"`);
    headers.set("cache-control", preview ? "private, max-age=300, stale-while-revalidate=60" : "private, no-store");
    headers.set("accept-ranges", "bytes");
    if (metadata.httpEtag) headers.set("etag", metadata.httpEtag);
    if (metadata.uploaded.getTime() > 0) headers.set("last-modified", metadata.uploaded.toUTCString());
    if (range) {
      headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${metadata.size}`);
      headers.set("content-length", String(range.length));
    } else if (metadata.size > 0) {
      headers.set("content-length", String(metadata.size));
    }
    return new Response(object.body, { status: range ? 206 : 200, headers });
  } catch (error) {
    return Response.json({
      error: "Não foi possível ler o arquivo no R2 configurado.",
      code: "R2_READ_FAILED",
      details: error instanceof Error ? error.message : String(error),
    }, { status: 502, headers: { "cache-control": "no-store" } });
  }
}
