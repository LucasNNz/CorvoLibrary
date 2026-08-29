import { isOwnerRequest, ownerOnly } from "../../../../../../lib/mcp-access";
import { confirmDownloadPackage } from "../../../../../../lib/delivery-packages";
export async function POST(request:Request,context:{params:Promise<{id:string}>}){if(!await isOwnerRequest(request))return ownerOnly();try{const {id}=await context.params,body=await request.json() as Record<string,unknown>;return Response.json(await confirmDownloadPackage({...body,package_id:id}));}catch(error){return Response.json({error:error instanceof Error?error.message:"PACKAGE_CONFIRM_FAILED"},{status:400});}}
