import { isOwnerRequest, ownerOnly } from "../../../../lib/mcp-access";
import { getProductionRecoveryPreflight, importProductionRecovery } from "../../../../lib/production-recovery-migration";

export const maxDuration = 300;
export const dynamic = "force-dynamic";
const headers = { "cache-control":"no-store" };

export async function GET(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  try { return Response.json(await getProductionRecoveryPreflight(),{headers}); }
  catch (error) { return Response.json({error:error instanceof Error?error.message:String(error)},{status:500,headers}); }
}

export async function POST(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  try {
    const payload=await request.json();
    return Response.json(await importProductionRecovery(payload),{headers});
  } catch (error) {
    const message=error instanceof Error?error.message:String(error);
    return Response.json({error:message},{status:message.startsWith("PRODUCTION_RECOVERY_")?400:500,headers});
  }
}
