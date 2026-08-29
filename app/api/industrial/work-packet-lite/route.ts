import { isOwnerRequest, ownerOnly } from "../../../../lib/mcp-access";
import { getWorkPacketLite } from "../../../../lib/industrial-supervisor";
export async function GET(request:Request){if(!await isOwnerRequest(request))return ownerOnly();const url=new URL(request.url);try{return Response.json(await getWorkPacketLite(url.searchParams.get("project_id"),Number(url.searchParams.get("limit")||20)));}catch(error){return Response.json({error:error instanceof Error?error.message:"WORK_PACKET_LITE_FAILED"},{status:400});}}
