import { isOwnerRequest, ownerOnly } from "../../../../lib/mcp-access";
import { configureChatDeliveryMode, getChatDeliveryMode } from "../../../../lib/industrial-supervisor";
export async function GET(request:Request){if(!await isOwnerRequest(request))return ownerOnly();return Response.json(await getChatDeliveryMode());}
export async function POST(request:Request){if(!await isOwnerRequest(request))return ownerOnly();try{const body=await request.json() as {mode?:string};return Response.json(await configureChatDeliveryMode(body.mode));}catch(error){return Response.json({error:error instanceof Error?error.message:"DELIVERY_MODE_FAILED"},{status:400});}}
