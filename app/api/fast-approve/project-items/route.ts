import { isOwnerRequest, ownerOnly } from "../../../../lib/mcp-access";
import { enqueueFastApproveProjectItems } from "../../../../lib/fast-supervisor-decisions";
import { withProjectLease } from "../../../../lib/supervisor-lease";
import { wakeDataPlane } from "../../../../lib/data-plane";

export async function POST(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  try {
    const body = await request.json() as { project_id?:string; items?:Record<string, unknown>[]; operation_id?:string; execution_id?:string };
    const projectId = typeof body.project_id === "string" ? body.project_id.trim() : "";
    const items = Array.isArray(body.items) ? body.items.filter((row): row is Record<string,unknown> => Boolean(row && typeof row === "object" && !Array.isArray(row))).slice(0,100) : [];
    if (!projectId) return Response.json({ error:"PROJECT_ID_REQUIRED" }, { status:400 });
    if (!items.length) return Response.json({ error:"ITENS_REQUIRED" }, { status:400 });
    const operationId = typeof body.operation_id === "string" && body.operation_id.trim() ? body.operation_id.trim() : `FAST-APPROVE-${projectId}-${Date.now().toString(36)}`;
    const result = await withProjectLease(projectId, body as Record<string, unknown>, "FAST_APPROVE_PROJECT_ITEMS", () => enqueueFastApproveProjectItems({
      operationId,
      projectId,
      items,
      executionId: typeof body.execution_id === "string" ? body.execution_id.trim() || null : null,
      source: "API_FAST_APPROVE_PROJECT_ITEMS",
    }));
    wakeDataPlane(`API_FAST_APPROVE:${projectId}`);
    return Response.json(result, { status:202 });
  } catch (error) {
    return Response.json({ error:error instanceof Error ? error.message : "FAST_APPROVE_PROJECT_ITEMS_FAILED" }, { status:400 });
  }
}
