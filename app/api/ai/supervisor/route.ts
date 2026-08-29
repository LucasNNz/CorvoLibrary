import { runSupervisor, type SupervisorInput } from "../../../../lib/ai-supervisor";
import { isOwnerRequest, ownerOnly } from "../../../../lib/mcp-access";

export async function POST(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  try {
    const raw = await request.json() as SupervisorInput & { allow_cloud_ai_fallback?: boolean };
    if (raw.allow_cloud_ai_fallback !== true) {
      return Response.json({ error: "CLOUD_AI_FALLBACK_DISABLED", message: "O Supervisor principal é ChatGPT via MCP. Cloud AI só pode ser acionado como fallback explícito." }, { status: 409 });
    }
    const { allow_cloud_ai_fallback: _explicit, ...input } = raw;
    if (!input?.event || !input?.project?.id || !input?.item?.id || !input?.item?.term) {
      return Response.json({ error: "SUPERVISOR_INPUT_INVALID" }, { status: 400 });
    }
    return Response.json(await runSupervisor(input as SupervisorInput));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Falha" }, { status: 400 });
  }
}
