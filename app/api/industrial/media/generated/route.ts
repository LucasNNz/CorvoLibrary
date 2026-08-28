import { isOwnerRequest, ownerOnly } from "../../../../../lib/mcp-access";
import { fastPushGeneratedMedia } from "../../../../../lib/media-delivery";
import { wakeDataPlane } from "../../../../../lib/data-plane";
export async function POST(request:Request){if(!await isOwnerRequest(request))return ownerOnly();try{const body=await request.json() as Record<string,unknown>;const result=await fastPushGeneratedMedia(body);wakeDataPlane(`API_GENERATED_MEDIA:${String(body.project_id||"")}`);return Response.json(result,{status:201});}catch(error){return Response.json({error:error instanceof Error?error.message:"GENERATED_MEDIA_FAILED"},{status:400});}}
