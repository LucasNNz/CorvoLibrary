import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";

const auto=readFileSync(new URL("../lib/automatic-production-bootstrap.ts",import.meta.url),"utf8");
const migration=readFileSync(new URL("../lib/production-recovery-migration.ts",import.meta.url),"utf8");
const status=readFileSync(new URL("../app/api/auth/status/route.ts",import.meta.url),"utf8");
const page=readFileSync(new URL("../app/page.tsx",import.meta.url),"utf8");
const r2=readFileSync(new URL("../lib/r2-catalog-integrity.ts",import.meta.url),"utf8");
const recovery=JSON.parse(readFileSync(new URL("../data/production-recovery-v1.json",import.meta.url),"utf8"));

test("FIX14 bundles the production recovery snapshot",()=>{
  assert.equal(recovery.tables.assets.length,929);
  assert.equal(recovery.tables.asset_usage.length,1176);
  assert.equal(recovery.tables.settings.length,39);
  assert.ok(statSync(new URL("../data/production-recovery-v1.json",import.meta.url)).size>1_000_000);
});

test("FIX14 bootstraps automatically and preserves existing rows",()=>{
  assert.match(auto,/ZERO_TOUCH_PRESERVE_EXISTING/);
  assert.match(auto,/EXPECTED_ASSETS = 929/);
  assert.match(auto,/EXPECTED_USAGE = 1176/);
  assert.match(auto,/conflictMode:"preserve-existing"/);
  assert.match(migration,/preserve-existing/);
  assert.match(status,/ensureAutomaticProductionBootstrap/);
  assert.match(status,/productionBootstrap/);
});

test("FIX14 no longer gates the app behind legacy D1 migration",()=>{
  assert.match(page,/const legacyMigrationRequired = false/);
  assert.match(page,/const libraryDataReady = authStatus\.authenticated/);
  assert.doesNotMatch(page,/if \(legacyMigrationRequired\) return <LegacyDataBootstrapScreen/);
  assert.match(page,/Turso \+ R2 persistentes/);
  assert.match(page,/Base de produção — automática/);
});


test("FIX14 reconciles R2 automatically without blocking app bootstrap",()=>{
  assert.match(r2,/expectedUniqueKeys/);
  assert.match(r2,/env\.BUCKET\.list/);
  assert.match(status,/waitUntil\(reconcileR2CatalogIntegrity/);
});
