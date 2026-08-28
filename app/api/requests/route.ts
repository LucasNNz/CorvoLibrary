import { desc } from "drizzle-orm";
import { getDb } from "../../../db";
import { requests } from "../../../db/schema";
import { isOwnerRequest, ownerOnly } from "../../../lib/mcp-access";

export async function GET(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  const rows = await getDb().select().from(requests).orderBy(desc(requests.createdAt)).limit(50);
  return Response.json({ requests: rows });
}

export async function POST(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  const payload = await request.json() as { project?: string; items?: string };
  const project = payload.project?.trim();
  const items = payload.items?.trim();
  if (!project || !items) return Response.json({ error: "Projeto e itens são obrigatórios." }, { status: 400 });
  const itemCount = items.split("\n").filter(Boolean).length;
  const id = `SOL-${Date.now().toString(36).toUpperCase()}`;
  const [created] = await getDb().insert(requests).values({ id, project, rawItems: items, itemCount, status: "Validando" }).returning();
  return Response.json({ request: created }, { status: 201 });
}
