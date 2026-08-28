import { decideProjectThumbnails, decideProjectTitles, getProductionThumbFile, getProjectProductionPackage, pushProjectThumbnailUrlBatch, pushProjectTitles } from "../../../../../lib/project-production-package";
import { isOwnerRequest, ownerOnly } from "../../../../../lib/mcp-access";
import { confirmMediaUpload, prepareMediaUpload } from "../../../../../lib/media-delivery";
import { queueFinalPackage } from "../../../../../lib/delivery-packages";
import { wakeDataPlane } from "../../../../../lib/data-plane";

function clean(value: unknown) { return String(value ?? "").trim(); }

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  try {
    const { id } = await context.params, thumbId = new URL(request.url).searchParams.get("thumb_id") || "";
    if (thumbId) {
      const { row, object } = await getProductionThumbFile(id, thumbId);
      return new Response(object.body, { headers: { "content-type": row.mimeType, "content-length": String(object.size), "content-disposition": `inline; filename="${row.name.replace(/["\\\r\n]/g, "-")}"`, "cache-control": "private, no-store" } });
    }
    return Response.json(await getProjectProductionPackage(id));
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Falha" }, { status: 400 }); }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  try {
    const { id } = await context.params, contentType = request.headers.get("content-type") || "";
    if (contentType.includes("multipart/form-data")) return Response.json({ error:"LINKS_ONLY_THUMB_UPLOAD: use prepare_thumb_upload + direct PUT to R2 + confirm_thumb_upload" }, { status:410 });
    const input = await request.json() as Record<string, unknown>, action = clean(input.action || input.acao).toLowerCase();
    if (action === "prepare_thumb_upload") return Response.json(await prepareMediaUpload({ ...input, project_id:id }), { status:201 });
    if (action === "confirm_thumb_upload") return Response.json(await confirmMediaUpload({ ...input, project_id:id }), { status:201 });
    if (action === "thumb_urls") {
      const rawItems = input.items ?? input.itens;
      const items = (Array.isArray(rawItems) ? rawItems : []).map((raw: unknown) => { const item = raw as Record<string, unknown>; return { operation_id:clean(item.operation_id) || undefined, project_id:id, source_url:clean(item.source_url), name:clean(item.name) || undefined, variant:clean(item.variant || item.variante) || undefined, agent_origin:clean(item.agent_origin || item.agente_origem) || undefined, observation:clean(item.observation || item.observacao) || undefined, source_type:clean(item.source_type) || "WEB" }; });
      return Response.json(await pushProjectThumbnailUrlBatch(id, items), { status: 201 });
    }
    if (action === "titles" || action === "titulos") return Response.json(await pushProjectTitles(id, (Array.isArray(input.titles || input.titulos) ? (input.titles || input.titulos) : []) as Array<Record<string, unknown>>), { status: 201 });
    if (action === "export") { const queued = await queueFinalPackage({ project_id:id, tipo:"FULL_PROJECT_ZIP" }); wakeDataPlane(`API_PRODUCTION_PACKAGE:${id}`); return Response.json(queued, { status:202 }); }
    return Response.json({ error: "ACTION_INVALID" }, { status: 400 });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Falha" }, { status: 400 }); }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  try {
    const { id } = await context.params, input = await request.json() as Record<string, unknown>, kind = clean(input.kind).toUpperCase(), decision = clean(input.decision || input.decisao).toUpperCase();
    const ids = Array.isArray(input.candidate_ids) ? input.candidate_ids : [input.candidate_id].filter(Boolean);
    const source = clean(input.source || input.origem_decisao) || "MANUAL", note = clean(input.note || input.observacao);
    const result = kind === "THUMB" ? await decideProjectThumbnails(ids, decision, source, note) : kind === "TITLE" ? await decideProjectTitles(ids, decision, source, note) : null;
    if (!result) return Response.json({ error: "KIND_INVALID" }, { status: 400 });
    const packageState = await getProjectProductionPackage(id);
    return Response.json({ ...result, producao: packageState });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Falha" }, { status: 400 }); }
}
