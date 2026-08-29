import { isOwnerRequest, ownerOnly } from "../../../../../../lib/mcp-access";
import { getDownloadPackageLink } from "../../../../../../lib/delivery-packages";
export async function GET(request:Request,context:{params:Promise<{id:string}>}){if(!await isOwnerRequest(request))return ownerOnly();try{const {id}=await context.params,url=new URL(request.url);return Response.json(await getDownloadPackageLink({package_id:id,validade_minutos:url.searchParams.get("validade_minutos")}));}catch(error){return Response.json({error:error instanceof Error?error.message:"PACKAGE_LINK_FAILED"},{status:400});}}
