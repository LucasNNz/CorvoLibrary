import { isOwnerRequest, ownerOnly } from "../../../../lib/mcp-access";
import { getFastVisualPacket } from "../../../../lib/industrial-supervisor";

export async function GET(request:Request){
  if(!await isOwnerRequest(request)) return ownerOnly();
  const url=new URL(request.url);
  const split=(key:string)=>(url.searchParams.get(key)||"").split(",").map((v)=>v.trim()).filter(Boolean);
  try{return Response.json(await getFastVisualPacket({project_id:url.searchParams.get("project_id"),limit:Number(url.searchParams.get("limit")||20),item_ids:split("item_ids"),target_files:split("target_files"),only_waiting_qa:url.searchParams.get("only_waiting_qa")!=="false",include_original_url:url.searchParams.get("include_original_url")==="true"}));}
  catch(error){return Response.json({error:error instanceof Error?error.message:"FAST_VISUAL_PACKET_FAILED"},{status:400});}
}
