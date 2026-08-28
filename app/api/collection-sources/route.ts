import { configureCollectionSources, listCollectionSources } from "../../../lib/auto-collector";
import { isOwnerRequest, ownerOnly } from "../../../lib/mcp-access";

export async function GET(request: Request) { if (!await isOwnerRequest(request)) return ownerOnly(); return Response.json(await listCollectionSources()); }
export async function PUT(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  try { const payload = await request.json() as { fontes_texto?: string }; return Response.json(await configureCollectionSources(payload.fontes_texto || "")); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Falha" }, { status: 400 }); }
}
