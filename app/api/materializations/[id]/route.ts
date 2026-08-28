import { env } from "../../../../lib/platform/runtime";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { materializationFiles, materializationItems } from "../../../../db/schema";
import { isOwnerRequest, validMcpCode } from "../../../../lib/mcp-access";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const ownerRequest = await isOwnerRequest(request);
  if (!ownerRequest && !(await validMcpCode(request))) return Response.json({ error: "Acesso ao arquivo não autorizado." }, { status: 401 });
  const url = new URL(request.url);
  if (!ownerRequest) {
    const expires = Number(url.searchParams.get("exp"));
    if (!Number.isFinite(expires) || Date.now() > expires) return Response.json({ error: "Link expirado." }, { status: 410 });
  }
  const { id } = await context.params;
  const [file] = await getDb().select().from(materializationFiles).where(eq(materializationFiles.id, decodeURIComponent(id))).limit(1);
  if (!file) return Response.json({ error: "Materialização não encontrada." }, { status: 404 });
  const [item] = await getDb().select().from(materializationItems).where(eq(materializationItems.id, file.itemDbId)).limit(1);
  const object = await env.BUCKET.get(file.r2Key);
  if (!object) return Response.json({ error: "Arquivo temporário não encontrado." }, { status: 404 });
  const fallbackExtension = file.mimeType.split("/").pop() || "bin";
  const originalName = item?.targetName || `${file.id}.${fallbackExtension}`;
  const safeName = originalName.replace(/["\\\r\n]/g, "-");
  const encodedName = encodeURIComponent(originalName).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return new Response(object.body, { headers: {
    "content-type": object.httpMetadata?.contentType || file.mimeType || "application/octet-stream",
    "content-length": String(object.size),
    "content-disposition": `inline; filename="${safeName}"; filename*=UTF-8''${encodedName}`,
    "etag": object.httpEtag,
    "cache-control": "private, max-age=300",
    "x-content-type-options": "nosniff",
  } });
}
