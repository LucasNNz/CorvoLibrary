import { writeFile } from 'node:fs/promises';

const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
let databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID?.trim();
const databaseName = process.env.CLOUDFLARE_D1_DATABASE_NAME?.trim();
const output = process.argv[2] || './d1-export.sql';

if (!token) throw new Error('CLOUDFLARE_API_TOKEN_REQUIRED');
if (!accountId) throw new Error('CLOUDFLARE_ACCOUNT_ID_REQUIRED');

const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}`;
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

async function cf(path, init = {}) {
  const response = await fetch(`${base}${path}`, { ...init, headers: { ...headers, ...(init.headers || {}) } });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!response.ok || body?.success === false) {
    throw new Error(`CLOUDFLARE_HTTP_${response.status}:${JSON.stringify(body?.errors || body)}`);
  }
  return body;
}

if (!databaseId) {
  const listed = await cf('/d1/database?per_page=100');
  const rows = Array.isArray(listed.result) ? listed.result : [];
  if (!rows.length) throw new Error('NO_D1_DATABASES_FOUND');
  const expectedTables = ['assets','automatic_projects','automatic_project_items','settings'];
  const candidates = databaseName ? rows.filter((row) => String(row.name || '') === databaseName) : rows;
  if (!candidates.length) throw new Error(`D1_DATABASE_NAME_NOT_FOUND:${databaseName}`);
  if (candidates.length === 1) {
    databaseId = String(candidates[0].uuid || candidates[0].id || '');
  } else {
    // Identify the Corvo Library database by schema signatures without mutating anything.
    for (const candidate of candidates) {
      const id = String(candidate.uuid || candidate.id || '');
      if (!id) continue;
      try {
        const q = await cf(`/d1/database/${encodeURIComponent(id)}/query`, {
          method: 'POST',
          body: JSON.stringify({ sql: "SELECT name FROM sqlite_master WHERE type='table'" }),
        });
        const names = new Set((q.result?.[0]?.results || q.result?.results || []).map((r) => String(r.name)));
        if (expectedTables.every((t) => names.has(t))) { databaseId = id; break; }
      } catch {}
    }
  }
  if (!databaseId) {
    console.error('D1 databases encontrados:');
    console.table(candidates.map((row) => ({ name: row.name, id: row.uuid || row.id })));
    throw new Error('D1_DATABASE_AMBIGUOUS_SET_CLOUDFLARE_D1_DATABASE_ID');
  }
}

console.log(`[d1-export] account=${accountId} database=${databaseId}`);
let bookmark;
let signedUrl;
for (let attempt = 0; attempt < 120; attempt++) {
  const body = { output_format: 'polling', ...(bookmark ? { current_bookmark: bookmark } : {}) };
  const response = await cf(`/d1/database/${encodeURIComponent(databaseId)}/export`, {
    method: 'POST', body: JSON.stringify(body),
  });
  const result = response.result || {};
  bookmark ||= result.at_bookmark;
  if (result.status === 'error') throw new Error(`D1_EXPORT_FAILED:${result.error || 'unknown'}`);
  if (result.status === 'complete' && result.result?.signed_url) {
    signedUrl = result.result.signed_url;
    break;
  }
  process.stdout.write('.');
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
if (!signedUrl) throw new Error('D1_EXPORT_TIMEOUT');

const download = await fetch(signedUrl);
if (!download.ok) throw new Error(`D1_EXPORT_DOWNLOAD_HTTP_${download.status}`);
const sql = await download.text();
await writeFile(output, sql, 'utf8');
console.log(`\n[d1-export] salvo=${output} bytes=${Buffer.byteLength(sql)}`);
console.log(`[d1-export] database_id=${databaseId}`);
