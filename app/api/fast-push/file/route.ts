import { isOwnerRequest, ownerOnly } from "../../../../lib/mcp-access";
import { ingestFastPushFileBytes, type FastPushInput } from "../../../../lib/fast-push";

const MAX_FILES = 20;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseContexts(value: FormDataEntryValue | null): FastPushInput[] {
  if (typeof value !== "string" || !value.trim()) return [];
  const parsed = JSON.parse(value) as unknown;
  if (Array.isArray(parsed)) return parsed.map((item) => record(item) as FastPushInput);
  return [record(parsed) as FastPushInput];
}

export async function POST(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  try {
    const form = await request.formData();
    const files = form.getAll("file").filter((entry): entry is File => entry instanceof File).slice(0, MAX_FILES);
    if (!files.length) return Response.json({ error:"FAST_PUSH_FILE_REQUIRED" }, { status:400 });

    const contexts = parseContexts(form.get("context"));
    const singleContext = contexts.length === 1 ? contexts[0] : null;
    const batchId = String(form.get("batch_id") || "").trim();
    const results = [];
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const baseContext = (singleContext || contexts[index] || {}) as FastPushInput;
      const operationBase = String(baseContext.operation_id || "").trim();
      const context: FastPushInput = {
        ...baseContext,
        operation_id: files.length > 1 && operationBase ? `${operationBase}:${index + 1}:${file.name}` : operationBase,
        batch_id: batchId || baseContext.batch_id,
        source_type:"CHAT_FILE",
      };
      try {
        const result = await ingestFastPushFileBytes(new Uint8Array(await file.arrayBuffer()), file.name, file.type, context);
        const projectLinked = Boolean(result.projectId && result.projectItemId && result.supervisorCandidateId && String(result.projectLinkStatus || "").startsWith("LINKED_"));
        results.push({
          index:index + 1,
          file_name:file.name,
          status:result.status,
          candidate_id:result.id,
          asset_id:result.assetId || null,
          sha256:result.sha256 || null,
          project_id:result.projectId || null,
          project_item_id:result.projectItemId || null,
          project_link_status:result.projectLinkStatus || null,
          project_linked:projectLinked,
          requires_project_link:Boolean(result.projectId && !projectLinked),
          supervisor_candidate_id:result.supervisorCandidateId || null,
          input_mode:"CHAT_FILE_BYTES",
          idempotent_replay:Boolean(result.idempotent_replay),
          error:null,
        });
      } catch (error) {
        results.push({ index:index + 1, file_name:file.name, status:"FAILED_FILE_PUSH", candidate_id:null, error:error instanceof Error ? error.message : String(error) });
      }
    }
    const counts = results.reduce<Record<string, number>>((acc, item) => { acc[item.status] = (acc[item.status] || 0) + 1; return acc; }, {});
    return Response.json({ batch_id:batchId || null, requested:files.length, processed:results.length, route:"FAST_PUSH_FILE_DIRECT", counts, results }, { status:201 });
  } catch (error) {
    return Response.json({ error:error instanceof Error ? error.message : "FAST_PUSH_FILE_FAILED" }, { status:400 });
  }
}
