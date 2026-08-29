import { isOwnerRequest, ownerOnly } from "../../../../lib/mcp-access";

export const maxDuration = 300;
export const dynamic = "force-dynamic";
const headers = { "cache-control":"no-store" };

export async function GET(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  return Response.json({ enabled:false, source:"migration/full-backup/database.sql", message:"A restauração parcial de catálogo foi substituída pela migração integral." }, { headers });
}

export async function POST(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  return Response.json({ error:"PARTIAL_CATALOG_RECOVERY_DISABLED", message:"Use npm run db:migrate:vercel antes do deploy." }, { status:410, headers });
}
