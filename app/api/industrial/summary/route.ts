import { isOwnerRequest, ownerOnly } from "../../../../lib/mcp-access";
import { getOperationalSummaryShort } from "../../../../lib/industrial-supervisor";
export async function GET(request:Request){if(!await isOwnerRequest(request))return ownerOnly();const url=new URL(request.url);try{return Response.json(await getOperationalSummaryShort(url.searchParams.get("project_id")));}catch(error){return Response.json({error:error instanceof Error?error.message:"SUMMARY_FAILED"},{status:400});}}
