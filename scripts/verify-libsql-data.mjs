import { createClient } from '@libsql/client';
const url = process.env.TURSO_DATABASE_URL?.trim();
const authToken = process.env.TURSO_AUTH_TOKEN?.trim() || undefined;
if (!url) throw new Error('TURSO_DATABASE_URL_REQUIRED');
const client = createClient({ url, authToken });
const tablesResult = await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
const tables = tablesResult.rows.map((r) => String(r.name));
const counts = [];
for (const table of tables) {
  const safe = table.replaceAll('"', '""');
  const result = await client.execute(`SELECT COUNT(*) AS n FROM \"${safe}\"`);
  counts.push({ table, rows: Number(result.rows[0]?.n || 0) });
}
console.table(counts);
const required = ['assets','automatic_projects','automatic_project_items','settings'];
const missing = required.filter((name) => !tables.includes(name));
if (missing.length) throw new Error(`MISSING_REQUIRED_TABLES:${missing.join(',')}`);
const assetSample = await client.execute("SELECT id, r2_key FROM assets WHERE r2_key IS NOT NULL LIMIT 5").catch(() => ({ rows: [] }));
console.log('[verify] tables=', tables.length, 'rows_total=', counts.reduce((a,b)=>a+b.rows,0));
console.log('[verify] asset_r2_samples=', assetSample.rows);
client.close();
