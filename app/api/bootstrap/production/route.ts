import { isOwnerRequest, ownerOnly } from "../../../../lib/mcp-access";
import { ensureAutomaticProductionBootstrap } from "../../../../lib/automatic-production-bootstrap";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  try {
    return Response.json(await ensureAutomaticProductionBootstrap(), { headers:{"cache-control":"no-store"} });
  } catch (error) {
    return Response.json({ error:error instanceof Error ? error.message : String(error) }, { status:500, headers:{"cache-control":"no-store"} });
  }
}
