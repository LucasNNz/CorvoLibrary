import { env } from "../../../../lib/platform/runtime";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { assets } from "../../../../db/schema";
import { isOwnerRequest, validMcpCode } from "../../../../lib/mcp-access";
import { resolveMediaMime } from "../../../../lib/media-mime";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const ownerRequest = await isOwnerRequest(request);
  if (!ownerRequest && !(await validMcpCode(request))) return Response.json({ error: "Acesso ao arquivo não autorizado." }, { status: 401 });
  const url = new URL(request.url);
  if (!ownerRequest) {
    const expires = Number(url.searchParams.get("exp"));
    if (!Number.isFinite(expires) || Date.now() > expires) return Response.json({ error: "Link expirado." }, { status: 410 });
  }
  const { id } = await context.params;
  const [asset] = await getDb().select().from(assets).where(eq(assets.id, decodeURIComponent(id))).limit(1);
  if (!asset) return Response.json({ error: "Asset não encontrado." }, { status: 404 });
  const object = await env.BUCKET.get(asset.r2Key);
  if (!object) return Response.json({ error: "Arquivo não encontrado." }, { status: 404 });
  const safeName = asset.originalName.replace(/["\\\r\n]/g, "-");
  const encodedName = encodeURIComponent(asset.originalName).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  const disposition = url.searchParams.get("preview") === "1" ? "inline" : "attachment";
  const contentType = resolveMediaMime(object.httpMetadata?.contentType || asset.mimeType, asset.originalName, asset.r2Key);
  return new Response(object.body, { headers: {
    "content-type": contentType,
    "content-length": String(object.size),
    "content-disposition": `${disposition}; filename="${safeName}"; filename*=UTF-8''${encodedName}`,
    "etag": object.httpEtag,
    "cache-control": disposition === "inline" ? "private, max-age=300" : "private, no-store",
  } });
}
