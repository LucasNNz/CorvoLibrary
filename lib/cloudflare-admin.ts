const API = "https://api.cloudflare.com/client/v4";

type CloudflareEnvelope<T> = { success?: boolean; result?: T; errors?: Array<{ code?: number; message?: string; documentation_url?: string }> };

export class CloudflareAdminError extends Error {
  code: string;
  httpStatus?: number;
  details?: string;
  constructor(code: string, message: string, options: { httpStatus?: number; details?: string } = {}) {
    super(message);
    this.name = "CloudflareAdminError";
    this.code = code;
    this.httpStatus = options.httpStatus;
    this.details = options.details;
  }
}
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
    const code = response.status === 401 ? "CLOUDFLARE_TOKEN_INVALID"
      : response.status === 403 ? "CLOUDFLARE_TOKEN_FORBIDDEN"
      : response.status === 404 ? "CLOUDFLARE_RESOURCE_NOT_FOUND"
      : "CLOUDFLARE_API_ERROR";
    throw new CloudflareAdminError(code, reason, { httpStatus: response.status, details: JSON.stringify(body.errors || []) });
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
  if (!databases.length) {
    throw new CloudflareAdminError(
      "CLOUDFLARE_D1_NONE_IN_ACCOUNT",
      "O token é válido, mas nenhuma base D1 foi encontrada nesta conta Cloudflare."
    );
  }
  if (requestedId) {
    const match = databases.find((database) => database.id === requestedId);
    if (!match) throw new CloudflareAdminError("CLOUDFLARE_D1_ID_NOT_FOUND", "O Database ID informado não existe nesta conta Cloudflare.");
    await getD1TableNames(accountId, apiToken, match.id);
    return match;
  }
  const byName = requestedName ? databases.filter((database) => database.name === requestedName) : databases;
  if (!byName.length) throw new CloudflareAdminError("CLOUDFLARE_D1_NAME_NOT_FOUND", "Nenhum D1 com o nome informado foi encontrado nesta conta.");
  if (byName.length === 1) {
    const names = await getD1TableNames(accountId, apiToken, byName[0].id);
    const signatures = ["assets", "automatic_projects", "automatic_project_items", "settings"];
    if (!signatures.every((table) => names.has(table))) {
      throw new CloudflareAdminError(
        "CLOUDFLARE_D1_CORVO_SIGNATURE_NOT_FOUND",
        `O D1 ${byName[0].name} foi encontrado, mas não contém as tabelas esperadas da Corvo Library.`
      );
    }
    return byName[0];
  }
  const signatures = ["assets", "automatic_projects", "automatic_project_items", "settings"];
  const matches: D1DatabaseSummary[] = [];
  const probeErrors: string[] = [];
  for (const database of byName) {
    try {
      const names = await getD1TableNames(accountId, apiToken, database.id);
      if (signatures.every((table) => names.has(table))) matches.push(database);
    } catch (error) {
      probeErrors.push(`${database.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new CloudflareAdminError(
      "CLOUDFLARE_D1_MULTIPLE_CORVO_DATABASES",
      `Mais de um D1 parece ser da Corvo Library (${matches.map((db) => db.name).join(", ")}). Informe o Database ID.`
    );
  }
  if (probeErrors.length === byName.length) {
    throw new CloudflareAdminError(
      "CLOUDFLARE_D1_PROBE_FAILED",
      "O token conseguiu listar D1, mas não conseguiu consultar as tabelas de nenhum banco. Verifique a permissão D1 Read.",
      { details: probeErrors.join(" | ") }
    );
  }
  throw new CloudflareAdminError(
    "CLOUDFLARE_D1_CORVO_NOT_FOUND",
    `Foram encontrados ${byName.length} banco(s) D1 nesta conta, mas nenhum possui a assinatura da Corvo Library. O D1 antigo pode estar em outra conta ou ser gerenciado pelo Sites.`
  );
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
