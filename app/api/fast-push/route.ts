import { isOwnerRequest, ownerOnly } from "../../../lib/mcp-access";
import { decideFastPushBatch, decideFastPushCandidates, deleteFastPushCandidatesBatch, ingestFastPushBatch, listFastPushCandidates } from "../../../lib/fast-push";

export async function GET(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  const url = new URL(request.url);
  return Response.json(await listFastPushCandidates({
    project_id:url.searchParams.get("project_id"), universe:url.searchParams.get("universe"), item_id:url.searchParams.get("item_id"),
    status:url.searchParams.get("status"), source_type:url.searchParams.get("source_type"), batch_id:url.searchParams.get("batch_id"),
    q:url.searchParams.get("q"), limit:Number(url.searchParams.get("limit") || 100),
  }));
}

export async function POST(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  try {
    const body = await request.json() as { items?:Record<string, unknown>[]; batch_id?:string };
    const result = await ingestFastPushBatch((body.items || []) as never[], body.batch_id);
    return Response.json(result, { status:201 });
  } catch (error) {
    return Response.json({ error:error instanceof Error ? error.message : "FAST_PUSH_FAILED" }, { status:400 });
  }
}

export async function PATCH(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  try {
    const body = await request.json() as { action?:string; project_id?:string; candidate_ids?:string[]; item_ids?:string[]; target_files?:string[]; note?:string; source?:string };
    if (body.action !== "approve" && body.action !== "reject") return Response.json({ error:"Ação inválida." }, { status:400 });
    const hasTargetSelectors = Boolean(body.project_id && ((body.item_ids?.length || 0) + (body.target_files?.length || 0)));
    const result = hasTargetSelectors || body.project_id
      ? await decideFastPushBatch({ project_id:body.project_id, candidate_ids:body.candidate_ids, item_ids:body.item_ids, target_files:body.target_files, action:body.action === "approve" ? "APROVAR" : "REJEITAR", source:body.source || "MANUAL", note:body.note })
      : await decideFastPushCandidates(body.candidate_ids, body.action === "approve" ? "APPROVE" : "REJECT", "MANUAL", body.note);
    return Response.json(result);
  } catch (error) {
    return Response.json({ error:error instanceof Error ? error.message : "FAST_PUSH_DECISION_FAILED" }, { status:400 });
  }
}

export async function DELETE(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  try {
    const body = await request.json() as { project_id?:string; candidate_ids?:string[]; confirmar?:boolean; apagar_materializacao?:boolean; apagar_bytes?:boolean; permitir_promovidas?:boolean; motivo?:string };
    return Response.json(await deleteFastPushCandidatesBatch(body));
  } catch (error) {
    return Response.json({ error:error instanceof Error ? error.message : "FAST_PUSH_DELETE_FAILED" }, { status:400 });
  }
}
