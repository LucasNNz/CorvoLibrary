import { env } from "../../../../lib/platform/runtime";
import { getFastPushCandidate } from "../../../../lib/fast-push";
import { isOwnerRequest, ownerOnly, validMcpCode } from "../../../../lib/mcp-access";

export async function GET(request: Request, context: { params: Promise<{ id:string }> }) {
  if (!await isOwnerRequest(request) && !(await validMcpCode(request))) return ownerOnly();
  const { id } = await context.params;
  const candidate = await getFastPushCandidate(id);
  if (!candidate?.r2Key) return Response.json({ error:"Candidata/arquivo não encontrado." }, { status:404 });
  const object = await env.BUCKET.get(candidate.r2Key);
  if (!object) return Response.json({ error:"Arquivo R2 ausente." }, { status:404 });
  const url = new URL(request.url);
  const inline = url.searchParams.get("preview") === "1";
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("content-type", candidate.mimeType || object.httpMetadata?.contentType || "application/octet-stream");
  headers.set("cache-control", "private, max-age=60");
  headers.set("content-disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(candidate.targetName || candidate.id)}`);
  return new Response(object.body, { headers });
}
