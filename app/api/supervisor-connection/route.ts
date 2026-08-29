import { isOwnerRequest, ownerOnly } from "../../../lib/mcp-access";
import { getSupervisorMode, setSupervisorMode } from "../../../lib/supervisor-control";

const headers = { "cache-control": "no-store" };

export async function GET(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  return Response.json(await getSupervisorMode(), { headers });
}

export async function PUT(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  const payload = await request.json() as Record<string, unknown>;
  const enabled = typeof payload.enabled === "boolean" ? payload.enabled : String(payload.enabled) !== "false";
  return Response.json(await setSupervisorMode(enabled, "Alterado pela interface da Corvo Library"), { headers });
}
