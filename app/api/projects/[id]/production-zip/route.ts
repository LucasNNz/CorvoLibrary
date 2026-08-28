import { env } from "../../../../../lib/platform/runtime";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { automaticProjects } from "../../../../../db/schema";
import { isOwnerRequest, ownerOnly, validMcpCode } from "../../../../../lib/mcp-access";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const owner = await isOwnerRequest(request);
  if (!owner && !(await validMcpCode(request))) return ownerOnly();
  if (!owner) { const expires = Number(new URL(request.url).searchParams.get("exp")); if (!Number.isFinite(expires) || Date.now() > expires) return Response.json({ error: "Link expirado." }, { status: 410 }); }
  const { id } = await context.params;
  const [project] = await getDb().select().from(automaticProjects).where(eq(automaticProjects.id, id)).limit(1);
  if (!project?.productionZipR2Key) return Response.json({ error: "ZIP de produção ainda não disponível." }, { status: 404 });
  const object = await env.BUCKET.get(project.productionZipR2Key);
  if (!object) return Response.json({ error: "ZIP de produção não encontrado no R2." }, { status: 404 });
  return new Response(object.body, { headers: { "content-type": "application/zip", "content-length": String(object.size), "content-disposition": `attachment; filename="${(project.productionZipFileName || "projeto-producao.zip").replace(/["\\\r\n]/g, "-")}"`, "cache-control": "private, no-store" } });
}
