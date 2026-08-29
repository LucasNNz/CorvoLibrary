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

test("legacy D1 to Turso migration remains available as a guarded fallback", async () => {
  const migration = await read("lib/d1-to-turso-migration.ts");
  const route = await read("app/api/migration/d1-to-turso/route.ts");
  assert.match(migration, /exportD1Sql/);
  assert.match(migration, /TURSO_TARGET_HAS_APPLICATION_DATA/);
  assert.match(migration, /D1_TURSO_COUNT_MISMATCH/);
  assert.match(route, /SUBSTITUIR_TURSO_PELO_D1/);
  assert.match(route, /maxDuration = 300/);
});

test("FIX14 production UI no longer requires legacy D1 migration", async () => {
  const page = await read("app/page.tsx");
  assert.match(page, /Base de produção — automática/);
  assert.match(page, /Turso é a fonte oficial/);
  assert.match(page, /D1 LEGADO \(OPCIONAL\)/);
  assert.match(page, /const legacyMigrationRequired = false/);
});
