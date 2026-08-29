import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const read = (path) => readFile(new URL(`../${path}`,import.meta.url),"utf8");

test("definitive package bundles the complete validated Sites backup", async () => {
  const manifest=JSON.parse(await read("migration/full-backup/database-manifest.json"));
  const assetMap=JSON.parse(await read("migration/full-backup/asset-r2-map.json"));
  const inventory=JSON.parse(await read("migration/full-backup/r2-inventory.json"));
  assert.equal(manifest.total_tables,47);
  assert.equal(manifest.total_records,39294);
  assert.equal(assetMap.length,929);
  assert.equal(inventory.object_count,2321);
  assert.equal(inventory.objects.length,2321);
});

test("status is read-only and partial production recovery is disabled", async () => {
  const status=await read("app/api/auth/status/route.ts");
  const recovery=await read("app/api/migration/production-recovery/route.ts");
  assert.doesNotMatch(status,/ensureAutomaticProductionBootstrap|reconcileR2CatalogIntegrity|waitUntil/);
  assert.match(recovery,/PARTIAL_RECOVERY_DISABLED/);
  assert.doesNotMatch(recovery,/importProductionRecovery/);
});
