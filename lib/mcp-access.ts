import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { settings } from "../db/schema";
import { ensureBootstrapSettingsTable } from "./bootstrap-db";
import { getLibrarySession } from "./auth";

const MCP_KEY = "mcp_connection_code";

function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export async function getOrCreateMcpCode() {
  await ensureBootstrapSettingsTable();
  const db = getDb();
  const [existing] = await db.select().from(settings).where(eq(settings.key, MCP_KEY)).limit(1);
  if (existing?.value && existing.value !== "[REDACTED_SECRET]") return existing.value;
  const code = newCode();
  await db.insert(settings).values({ key: MCP_KEY, value: code, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value: code, updatedAt: new Date() } });
  const [created] = await db.select().from(settings).where(eq(settings.key, MCP_KEY)).limit(1);
  return created?.value ?? code;
}

export async function rotateMcpCode() {
  await ensureBootstrapSettingsTable();
  const code = newCode();
  await getDb().insert(settings).values({ key: MCP_KEY, value: code, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value: code, updatedAt: new Date() } });
  return code;
}

export function getMcpCodeFromRequest(request: Request) {
  const url = new URL(request.url);
  const pathMatch = url.pathname.match(/^\/c\/([^/]+)\/mcp\/?$/);
  return url.searchParams.get("code") ?? (pathMatch ? decodeURIComponent(pathMatch[1]) : "");
}

export async function validMcpCode(request: Request) {
  const supplied = getMcpCodeFromRequest(request);
  if (!supplied) return false;
  const expected = await getOrCreateMcpCode();
  if (supplied.length !== expected.length) return false;
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) mismatch |= supplied.charCodeAt(index) ^ expected.charCodeAt(index);
  return mismatch === 0;
}

export async function isOwnerRequest(request: Request) {
  const session = await getLibrarySession(request);
  return session.authenticated === true;
}

export function ownerOnly() {
  return Response.json({ error: "Apenas o proprietário pode acessar esta configuração." }, { status: 403 });
}
