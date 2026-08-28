import { isOwnerRequest, ownerOnly } from "../../../../lib/mcp-access";
import { getCatalogRecoveryPreflight, importRecoveredCatalog } from "../../../../lib/catalog-recovery-migration";

export const maxDuration = 300;
export const dynamic = "force-dynamic";
const headers = { "cache-control":"no-store" };

export async function GET(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  try {
    return Response.json(await getCatalogRecoveryPreflight(), { headers });
  } catch (error) {
    return Response.json({ error:error instanceof Error ? error.message : String(error) }, { status:500, headers });
  }
}

export async function POST(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  try {
    const payload = await request.json();
    return Response.json(await importRecoveredCatalog(payload), { headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.startsWith("CATALOG_") ? 400 : 500;
    return Response.json({ error:message }, { status, headers });
  }
}
