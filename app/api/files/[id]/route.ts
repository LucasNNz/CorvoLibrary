import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { assets } from "../../../../db/schema";
import { isOwnerRequest, validMcpCode } from "../../../../lib/mcp-access";
import { resolveMediaMime } from "../../../../lib/media-mime";
import { createSignedR2GetUrl } from "../../../../lib/r2-download";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const ownerRequest = await isOwnerRequest(request);
  if (!ownerRequest && !(await validMcpCode(request))) {
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

  const preview = url.searchParams.get("preview") === "1";
  const contentType = resolveMediaMime(asset.mimeType, asset.originalName, asset.r2Key);

  try {
    // Links-only delivery: never proxy R2 bytes through Vercel. This uses the
    // same signed-R2 path used by obter_link_download, already proven against
    // the configured external bucket.
    const signedUrl = await createSignedR2GetUrl(
      asset.r2Key,
      preview ? 15 : 5,
      preview ? undefined : asset.originalName,
      contentType,
    );
    return Response.redirect(signedUrl, 307);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const notFound = /NOT_FOUND|404|NoSuchKey|R2_DELIVERY_SOURCE_NOT_FOUND/i.test(message);
    return Response.json({
      error: notFound ? "Arquivo não encontrado no R2 configurado." : "Não foi possível gerar o link direto do R2.",
      code: notFound ? "R2_OBJECT_NOT_FOUND" : "R2_SIGNED_URL_FAILED",
      details: message,
    }, { status: notFound ? 404 : 502, headers: { "cache-control": "no-store" } });
  }
}
