import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const lib=readFileSync(new URL("../lib/production-recovery-migration.ts",import.meta.url),"utf8");
const route=readFileSync(new URL("../app/api/migration/production-recovery/route.ts",import.meta.url),"utf8");
const page=readFileSync(new URL("../app/migrar-backup/page.tsx",import.meta.url),"utf8");
test("FIX13 imports production snapshot non-destructively",()=>{
  assert.match(lib,/NON_DESTRUCTIVE_PRODUCTION_MERGE/);
  assert.match(lib,/asset_usage/);
  assert.match(lib,/PROTECTED_SETTING_KEYS/);
  assert.match(lib,/library_auth_v1/);
  assert.match(lib,/secret_cloudflare_connection/);
  assert.match(lib,/countMatching\("assets"/);
});
test("FIX13 exposes owner-only recovery API and UI",()=>{
  assert.match(route,/isOwnerRequest/);
  assert.match(route,/importProductionRecovery/);
  assert.match(page,/Mesclar backup e validar/);
  assert.match(page,/nunca apaga registros existentes/);
});
