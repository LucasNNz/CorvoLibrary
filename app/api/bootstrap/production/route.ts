import { isOwnerRequest, ownerOnly } from "../../../../lib/mcp-access";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  return Response.json({
    error: "PARTIAL_RUNTIME_BOOTSTRAP_DISABLED",
    message: "Execute npm run db:migrate:vercel uma única vez contra um Turso vazio. O bootstrap parcial em requisições foi removido.",
  }, { status:410, headers:{"cache-control":"no-store"} });
}
