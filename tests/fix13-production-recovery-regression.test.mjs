import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const route=readFileSync(new URL("../app/api/migration/production-recovery/route.ts",import.meta.url),"utf8");
const page=readFileSync(new URL("../app/migrar-backup/page.tsx",import.meta.url),"utf8");
test("partial production snapshot import is disabled",()=>{
  assert.match(route,/PARTIAL_RECOVERY_DISABLED/);
  assert.doesNotMatch(route,/importProductionRecovery/);
});
test("legacy recovery API remains owner-only and points to full migration",()=>{
  assert.match(route,/isOwnerRequest/);
  assert.match(route,/full-backup\/database\.sql/);
  assert.match(page,/Migração/);
});
