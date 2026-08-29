import { isOwnerRequest, ownerOnly } from "../../../../../../lib/mcp-access";
import { confirmMediaUpload } from "../../../../../../lib/media-delivery";
import { wakeDataPlane } from "../../../../../../lib/data-plane";
export async function POST(request:Request){if(!await isOwnerRequest(request))return ownerOnly();try{const body=await request.json() as Record<string,unknown>;const result=await confirmMediaUpload(body);wakeDataPlane(`API_CONFIRM_MEDIA:${String(body.project_id||"")}`);return Response.json(result);}catch(error){return Response.json({error:error instanceof Error?error.message:"CONFIRM_UPLOAD_FAILED"},{status:400});}}
