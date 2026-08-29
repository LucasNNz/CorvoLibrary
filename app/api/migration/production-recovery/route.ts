import { isOwnerRequest, ownerOnly } from "../../../../lib/mcp-access";

export const maxDuration = 300;
export const dynamic = "force-dynamic";
const headers = { "cache-control":"no-store" };

export async function GET(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  return Response.json({ enabled:false, source:"migration/full-backup/database.sql", message:"A recuperação parcial foi desativada; use a migração integral antes do deploy." },{headers});
}

export async function POST(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  return Response.json({ error:"PARTIAL_RECOVERY_DISABLED", message:"Use npm run db:migrate:vercel com o backup integral incluído." },{status:410,headers});
}
