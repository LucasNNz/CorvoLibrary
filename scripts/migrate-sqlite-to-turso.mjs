import { readFile } from 'node:fs/promises';
import { createClient } from '@libsql/client';

const source = process.argv[2];
if (!source) {
  console.error('Uso: npm run db:migrate:vercel -- caminho/para/d1-export.sql');
  process.exit(2);
}
const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url) throw new Error('TURSO_DATABASE_URL_REQUIRED');

const raw = await readFile(source, 'utf8');
// D1 exporta pragmas/transaction wrappers que não são necessários no destino remoto.
const sql = raw
  .replace(/^PRAGMA foreign_keys=.*$/gmi, '')
  .replace(/^BEGIN TRANSACTION;?$/gmi, '')
  .replace(/^COMMIT;?$/gmi, '')
  .trim();

const client = createClient({ url, authToken });
const existingTables = await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
if (existingTables.rows.length && process.env.ALLOW_NONEMPTY_TURSO !== '1') {
  throw new Error(`TURSO_TARGET_NOT_EMPTY:${existingTables.rows.map((row) => String(row.name)).join(',')}`);
}
console.log(`[migration] source=${source} bytes=${Buffer.byteLength(sql)}`);
await client.executeMultiple(sql);

// Preserve the imported encrypted settings byte-for-byte. Add only a non-secret
// recovery/reference manifest when the old D1 did not have one yet.
const configManifestKey = 'cloudflare_connection_manifest_v1';
const manifestExists = await client.execute({ sql: 'SELECT value FROM settings WHERE key = ? LIMIT 1', args: [configManifestKey] }).catch(() => ({ rows: [] }));
if (!manifestExists.rows.length) {
  const now = Date.now();
  const legacyManifest = JSON.stringify({
    version: 1, accountId: '', bucket: 'corvo-library', accessKeyId: '', endpoint: '',
    d1DatabaseId: '', d1DatabaseName: '', source: 'legacy-reference', updatedAt: new Date(now).toISOString(),
  });
  await client.execute({
    sql: 'INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)',
    args: [configManifestKey, legacyManifest, now],
  });
}
const inheritedCloudflare = await client.execute({
  sql: 'SELECT key, LENGTH(value) AS bytes FROM settings WHERE key IN (?, ?) ORDER BY key',
  args: ['secret_cloudflare_connection', configManifestKey],
}).catch(() => ({ rows: [] }));
console.log('[migration] cloudflare_profile_reference=', inheritedCloudflare.rows.map((row) => ({ key: String(row.key), bytes: Number(row.bytes || 0) })));

const checks = await client.execute(`
  SELECT 'assets' AS name, COUNT(*) AS count FROM assets
  UNION ALL SELECT 'automatic_projects', COUNT(*) FROM automatic_projects
  UNION ALL SELECT 'automatic_project_items', COUNT(*) FROM automatic_project_items
  UNION ALL SELECT 'settings', COUNT(*) FROM settings
`);
console.table(checks.rows.map((row) => ({ table: String(row.name), count: Number(row.count) })));
client.close();
console.log('[migration] concluída');
