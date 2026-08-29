import { getOperationalPolicyWorkspaceDashboard } from "../../../lib/operational-policy-workspace";
import { isOwnerRequest, ownerOnly } from "../../../lib/mcp-access";

export async function GET(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  try { return Response.json(await getOperationalPolicyWorkspaceDashboard(), { headers:{"cache-control":"no-store"} }); }
  catch (error) { return Response.json({ error:error instanceof Error?error.message:String(error) }, { status:500 }); }
}
