import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("fresh Turso can bootstrap settings without terminal migrations", async () => {
  const bootstrap = await read("lib/bootstrap-db.ts");
  const secure = await read("lib/secure-settings.ts");
  assert.match(bootstrap, /CREATE TABLE IF NOT EXISTS settings/);
  assert.match(secure, /ensureBootstrapSettingsTable/);
});

test("D1 to Turso migration exports, replaces only with confirmation and verifies counts", async () => {
  const migration = await read("lib/d1-to-turso-migration.ts");
  const route = await read("app/api/migration/d1-to-turso/route.ts");
  assert.match(migration, /exportD1Sql/);
  assert.match(migration, /TURSO_TARGET_HAS_APPLICATION_DATA/);
  assert.match(migration, /D1_TURSO_COUNT_MISMATCH/);
  assert.match(migration, /saveCloudflareConnection\(workingConnection\)/);
  assert.match(route, /SUBSTITUIR_TURSO_PELO_D1/);
  assert.match(route, /maxDuration = 300/);
});

test("Settings UI exposes one-click D1 migration and keeps R2 untouched", async () => {
  const page = await read("app/page.tsx");
  assert.match(page, /Migração da Library — D1 → Turso/);
  assert.match(page, /Migrar D1 → Turso/);
  assert.match(page, /O R2 não será alterado/);
  assert.match(page, /SUBSTITUIR_TURSO_PELO_D1/);
});
