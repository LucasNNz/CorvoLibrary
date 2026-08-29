import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("full D1 snapshot is migrated only by the resumable pre-deploy CLI", async () => {
  const migration = await read("scripts/migrate-sqlite-to-turso.mjs");
  const route = await read("app/api/migration/d1-to-turso/route.ts");
  assert.match(migration, /migration.*full-backup.*database\.sql/s);
  assert.match(migration, /corvo_migration_state/);
  assert.match(migration, /MIGRATION_COUNT_MISMATCH/);
  assert.match(route, /RUNTIME_D1_MIGRATION_DISABLED/);
  assert.match(route, /RUNTIME_D1_ROLLBACK_DISABLED/);
  assert.doesNotMatch(route, /getD1ToTursoPreflight/);
});

test("production UI describes the persistent integral base", async () => {
  const page = await read("app/page.tsx");
  assert.match(page, /Base integral migrada/);
  assert.match(page, /47 tabelas · 39\.294 registros originais · 929 assets/);
  assert.match(page, /const legacyMigrationRequired = false/);
});
