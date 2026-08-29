import { env } from "../../../../lib/platform/runtime";
import { validMcpCode } from "../../../../lib/mcp-access";
import { validDownloadSignature } from "../../../../lib/download-signature";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!validDownloadSignature(request) && !(await validMcpCode(request))) return Response.json({ error: "Código inválido." }, { status: 401 });
  const expires = Number(new URL(request.url).searchParams.get("exp"));
  if (!Number.isFinite(expires) || Date.now() > expires) return Response.json({ error: "Link expirado." }, { status: 410 });
  const { id } = await context.params;
  const exportId = decodeURIComponent(id);
  if (!/^EXP-[A-Z0-9-]+$/.test(exportId)) return Response.json({ error: "Exportação inválida." }, { status: 400 });
  const cacheHash = exportId.match(/^EXP-([A-F0-9]{64})$/)?.[1]?.toLowerCase();
  const r2Key = cacheHash ? `exports/zips/${cacheHash}.zip` : `exports/${exportId}.zip`;
  const object = await env.BUCKET.get(r2Key);
  if (!object) return Response.json({ error: "Exportação não encontrada." }, { status: 404 });
  const fileName = object.customMetadata?.fileName || `${exportId}.zip`;
  return new Response(object.body, { headers: { "content-type": "application/zip", "content-length": String(object.size), "content-disposition": `attachment; filename="${fileName.replace(/["\\]/g, "-")}"`, "cache-control": "private, no-store" } });
}
