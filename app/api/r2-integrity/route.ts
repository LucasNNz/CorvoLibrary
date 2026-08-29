import { isOwnerRequest, ownerOnly } from "../../../lib/mcp-access";
import { reconcileR2CatalogIntegrity } from "../../../lib/r2-catalog-integrity";

export const maxDuration=300;
export const dynamic="force-dynamic";

export async function GET(request:Request){
  if(!await isOwnerRequest(request))return ownerOnly();
  try{return Response.json(await reconcileR2CatalogIntegrity(),{headers:{"cache-control":"no-store"}});}
  catch(error){return Response.json({error:error instanceof Error?error.message:String(error)},{status:500,headers:{"cache-control":"no-store"}});}
}
