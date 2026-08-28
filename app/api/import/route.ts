import { env } from "../../../lib/platform/runtime";
import { getDb } from "../../../db";
import { imports } from "../../../db/schema";
import { isOwnerRequest, ownerOnly, validMcpCode } from "../../../lib/mcp-access";
import { processZipImport } from "../../../lib/import-processor";

export async function POST(request: Request) {
  if (!await isOwnerRequest(request) && !(await validMcpCode(request))) return ownerOnly();
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return Response.json({ error: "Arquivo ausente." }, { status: 400 });
  if (!file.name.toLowerCase().endsWith(".zip")) return Response.json({ error: "Envie um arquivo ZIP." }, { status: 400 });
  if (file.size > 250 * 1024 * 1024) return Response.json({ error: "O ZIP excede o limite de 250 MB." }, { status: 413 });
  const id = `IMP-${Date.now().toString(36).toUpperCase()}`;
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "-");
  const r2Key = `incoming/${id}/${safeName}`;
  await env.BUCKET.put(r2Key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type || "application/zip" } });
  const [created] = await getDb().insert(imports).values({ id, fileName: file.name, r2Key, sizeBytes: file.size, status: "Recebido" }).returning();
  const processing = await processZipImport(id);
  return Response.json({ import: created, processing }, { status: 201 });
}
