import { env } from "../../../lib/platform/runtime";
import { getDb } from "../../../db";
import { requests } from "../../../db/schema";
import { isOwnerRequest, ownerOnly } from "../../../lib/mcp-access";

export async function GET(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  await getDb().select({ id: requests.id }).from(requests).limit(1);
  await env.BUCKET.list({ limit: 1 });
  return Response.json({ ok: true, database: "connected", storage: "connected" });
}
