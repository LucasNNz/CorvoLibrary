import { isOwnerRequest, ownerOnly } from "../../../../lib/mcp-access";

export const maxDuration = 300;
export const dynamic = "force-dynamic";
const headers = { "cache-control": "no-store" };

export async function GET(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  return Response.json({ runtimeMigration:false, source:"migration/full-backup/database.sql", message:"A migração integral é executada uma única vez pelo migrador retomável antes do deploy." }, { headers });
}

export async function POST(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  return Response.json({ error:"RUNTIME_D1_MIGRATION_DISABLED", message:"Use o migrador retomável incluído no pacote antes do deploy." }, { status:410, headers });
}

export async function DELETE(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  return Response.json({ error:"RUNTIME_D1_ROLLBACK_DISABLED", message:"Nenhuma operação destrutiva de banco é permitida por HTTP." }, { status:410, headers });
}
