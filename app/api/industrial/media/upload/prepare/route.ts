import { isOwnerRequest, ownerOnly } from "../../../../../../lib/mcp-access";
import { prepareMediaUpload } from "../../../../../../lib/media-delivery";
export async function POST(request:Request){if(!await isOwnerRequest(request))return ownerOnly();try{return Response.json(await prepareMediaUpload(await request.json() as Record<string,unknown>),{status:201});}catch(error){return Response.json({error:error instanceof Error?error.message:"PREPARE_UPLOAD_FAILED"},{status:400});}}
