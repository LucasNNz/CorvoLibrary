import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

test('legacy catalog recovery is owner-only and disabled in favor of full migration', async () => {
  const route = await read('app/api/migration/catalog-recovery/route.ts');
  assert.match(route, /isOwnerRequest/);
  assert.match(route, /PARTIAL_CATALOG_RECOVERY_DISABLED/);
  assert.doesNotMatch(route, /importRecoveredCatalog/);
  assert.match(route, /export async function POST/);
});

test('full migrator preserves asset IDs and r2 keys before applying current schema', async () => {
  const recovery = await read('scripts/migrate-sqlite-to-turso.mjs');
  const schema = await read('lib/current-schema-bootstrap.ts');
  assert.match(recovery, /MIGRATION_ASSET_R2_KEY_MISMATCH/);
  assert.match(recovery, /asset-r2-map\.json/);
  assert.match(recovery, /MIGRATION_COUNT_MISMATCH/);
  assert.match(schema, /CURRENT_SCHEMA_TABLE_COUNT = 53/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS \\`assets\\`/);
  assert.match(schema, /INSERT OR IGNORE INTO \\`source_profiles\\`/);
  assert.match(schema, /INSERT OR IGNORE INTO \\`operational_policies\\`/);
});

test('operator migration page points only to the resumable CLI', async () => {
  const page = await read('app/migrar-backup/page.tsx');
  assert.match(page, /npm run db:migrate:vercel/);
  assert.doesNotMatch(page, /type="file"|fetch\(/);
});

test('FIX11 current schema bootstrap executes from empty SQLite and keeps operational defaults', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const source = await read('lib/current-schema-bootstrap.ts');
  const match = source.match(/CURRENT_SCHEMA_SQL = `([\s\S]*?)`;\n\nexport const CURRENT_SCHEMA_SEED_SQL = `([\s\S]*?)`;/);
  assert.ok(match, 'schema and seed SQL must be embedded');
  const unescapeTemplateTicks = (value) => value.replaceAll('\\`','`');
  const db = new DatabaseSync(':memory:');
  db.exec(unescapeTemplateTicks(match[1]));
  db.exec(unescapeTemplateTicks(match[2]));
  const tables = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get();
  assert.equal(Number(tables.n), 53);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM source_profiles').get().n), 4);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM operational_policies').get().n), 5);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM worker_capacity_limits').get().n), 11);
  db.close();
});
