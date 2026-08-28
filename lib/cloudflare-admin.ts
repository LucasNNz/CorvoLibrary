const API = "https://api.cloudflare.com/client/v4";

type CloudflareEnvelope<T> = { success?: boolean; result?: T; errors?: Array<{ code?: number; message?: string }> };
export type D1DatabaseSummary = { id: string; name: string; createdAt?: string };

async function cf<T>(accountId: string, apiToken: string, path: string, init: RequestInit = {}) {
  const response = await fetch(`${API}/accounts/${encodeURIComponent(accountId)}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
      ...(init.headers || {}),
    },
    cache: "no-store",
  });
  const body = await response.json().catch(() => ({})) as CloudflareEnvelope<T>;
  if (!response.ok || body.success === false) {
    const reason = body.errors?.map((error) => error.message || error.code).filter(Boolean).join("; ") || `HTTP ${response.status}`;
    throw new Error(`CLOUDFLARE_API_ERROR:${reason}`);
  }
  return body.result as T;
}

export async function listD1Databases(accountId: string, apiToken: string): Promise<D1DatabaseSummary[]> {
  const rows = await cf<Array<Record<string, unknown>>>(accountId, apiToken, "/d1/database?per_page=100");
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    id: String(row.uuid || row.id || ""),
    name: String(row.name || ""),
    createdAt: row.created_at ? String(row.created_at) : undefined,
  })).filter((row) => row.id);
}

export async function getD1TableNames(accountId: string, apiToken: string, databaseId: string) {
  const result = await cf<Array<{ results?: Array<{ name?: string }> }>>(accountId, apiToken, `/d1/database/${encodeURIComponent(databaseId)}/query`, {
    method: "POST",
    body: JSON.stringify({ sql: "SELECT name FROM sqlite_master WHERE type='table'" }),
  });
  const rows = Array.isArray(result) ? result[0]?.results || [] : [];
  return new Set(rows.map((row) => String(row.name || "")).filter(Boolean));
}

export async function resolveCorvoD1Database(accountId: string, apiToken: string, requestedId = "", requestedName = "") {
  const databases = await listD1Databases(accountId, apiToken);
  if (!databases.length) throw new Error("CLOUDFLARE_D1_NOT_FOUND");
  if (requestedId) {
    const match = databases.find((database) => database.id === requestedId);
    if (!match) throw new Error("CLOUDFLARE_D1_ID_NOT_FOUND");
    await getD1TableNames(accountId, apiToken, match.id);
    return match;
  }
  const byName = requestedName ? databases.filter((database) => database.name === requestedName) : databases;
  if (!byName.length) throw new Error("CLOUDFLARE_D1_NAME_NOT_FOUND");
  if (byName.length === 1) {
    await getD1TableNames(accountId, apiToken, byName[0].id);
    return byName[0];
  }
  const signatures = ["assets", "automatic_projects", "automatic_project_items", "settings"];
  for (const database of byName) {
    try {
      const names = await getD1TableNames(accountId, apiToken, database.id);
      if (signatures.every((table) => names.has(table))) return database;
    } catch {
      // Keep scanning. A token may have access to more than one D1 database.
    }
  }
  throw new Error("CLOUDFLARE_D1_AMBIGUOUS");
}

export async function queryD1(accountId: string, apiToken: string, databaseId: string, sql: string) {
  const result = await cf<Array<{ results?: Array<Record<string, unknown>> }>>(accountId, apiToken, `/d1/database/${encodeURIComponent(databaseId)}/query`, {
    method: "POST",
    body: JSON.stringify({ sql }),
  });
  return Array.isArray(result) ? result[0]?.results || [] : [];
}

function quoteSqlIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

export async function getD1TableCounts(accountId: string, apiToken: string, databaseId: string) {
  const names = [...await getD1TableNames(accountId, apiToken, databaseId)]
    .filter((name) => !name.startsWith("sqlite_") && name !== "_cf_METADATA")
    .sort();
  if (!names.length) return {} as Record<string, number>;
  const sql = names.map((name, index) => `${index ? "UNION ALL " : ""}SELECT '${name.replaceAll("'", "''")}' AS name, COUNT(*) AS count FROM ${quoteSqlIdentifier(name)}`).join("\n");
  const rows = await queryD1(accountId, apiToken, databaseId, sql);
  return Object.fromEntries(rows.map((row) => [String(row.name || ""), Number(row.count || 0)]).filter(([name]) => Boolean(name)));
}

export async function exportD1Sql(accountId: string, apiToken: string, databaseId: string, options: { maxAttempts?: number; pollMs?: number } = {}) {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 120);
  const pollMs = Math.max(250, options.pollMs ?? 1500);
  let bookmark = "";
  let signedUrl = "";
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const result = await cf<Record<string, unknown>>(accountId, apiToken, `/d1/database/${encodeURIComponent(databaseId)}/export`, {
      method: "POST",
      body: JSON.stringify({ output_format: "polling", ...(bookmark ? { current_bookmark: bookmark } : {}) }),
    });
    const status = String(result?.status || "");
    bookmark ||= String(result?.at_bookmark || "");
    if (status === "error") throw new Error(`D1_EXPORT_FAILED:${String(result?.error || "unknown")}`);
    const nested = result?.result && typeof result.result === "object" ? result.result as Record<string, unknown> : null;
    if (status === "complete" && nested?.signed_url) {
      signedUrl = String(nested.signed_url);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  if (!signedUrl) throw new Error("D1_EXPORT_TIMEOUT");
  const download = await fetch(signedUrl, { cache: "no-store" });
  if (!download.ok) throw new Error(`D1_EXPORT_DOWNLOAD_HTTP_${download.status}`);
  return download.text();
}
