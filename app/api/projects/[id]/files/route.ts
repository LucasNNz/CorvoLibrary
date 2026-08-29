import { env } from "../../../../../lib/platform/runtime";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { automaticProjectFiles } from "../../../../../db/schema";
import { attachAutomaticProjectFile } from "../../../../../lib/automatic-projects";
import { isOwnerRequest, ownerOnly, validMcpCode } from "../../../../../lib/mcp-access";
import { validDownloadSignature } from "../../../../../lib/download-signature";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  try {
    const { id } = await context.params, form = await request.formData(), file = form.get("file"), role = String(form.get("role") || "");
    if (!(file instanceof File)) return Response.json({ error: "Arquivo ausente." }, { status: 400 });
    if (!file.name.toLowerCase().endsWith(".txt") && file.type !== "text/plain") return Response.json({ error: "Envie um arquivo TXT." }, { status: 400 });
    const result = await attachAutomaticProjectFile(id, role, file.name, file.type || "text/plain", new Uint8Array(await file.arrayBuffer()));
    return Response.json(result, { status: 201 });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Falha" }, { status: 400 }); }
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const owner = await isOwnerRequest(request);
  if (!owner && !validDownloadSignature(request) && !(await validMcpCode(request))) return ownerOnly();
  const url = new URL(request.url);
  if (!owner) {
    const expires = Number(url.searchParams.get("exp"));
    if (!Number.isFinite(expires) || Date.now() > expires) return Response.json({ error: "Link expirado." }, { status: 410 });
  }
  const { id } = await context.params, fileId = url.searchParams.get("file_id") || "";
  const [file] = await getDb().select().from(automaticProjectFiles).where(and(eq(automaticProjectFiles.projectId, id), eq(automaticProjectFiles.id, fileId))).limit(1);
  if (!file) return Response.json({ error: "Arquivo não encontrado." }, { status: 404 });
  const object = await env.BUCKET.get(file.r2Key);
  if (!object) return Response.json({ error: "Arquivo não encontrado no R2." }, { status: 404 });
  return new Response(object.body, { headers: { "content-type": file.mimeType, "content-length": String(object.size), "content-disposition": `attachment; filename="${file.fileName.replace(/["\\\r\n]/g, "-")}"`, "cache-control": "private, no-store" } });
}
