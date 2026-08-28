import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const page=fs.readFileSync(new URL('../app/page.tsx',import.meta.url),'utf8');
const css=fs.readFileSync(new URL('../app/globals.css',import.meta.url),'utf8');
const cloudflareRoute=fs.readFileSync(new URL('../app/api/cloudflare-connection/route.ts',import.meta.url),'utf8');

test('first-use blocks empty catalog until legacy D1 migration is resolved',()=>{
  assert.match(page,/legacyMigrationRequired/);
  assert.match(page,/Trazer Library existente/);
  assert.match(page,/!legacyMigration!\.targetHasApplicationData/);
  assert.match(page,/Migrar|transferir|trazer/i);
});

test('D1-only bootstrap does not require R2 credentials',()=>{
  assert.match(cloudflareRoute,/const hasAnyR2 = Boolean\(connection\.accessKeyId \|\| connection\.secretAccessKey \|\| connection\.endpoint\)/);
  assert.doesNotMatch(cloudflareRoute,/Boolean\(connection\.bucket \|\| connection\.accessKeyId/);
});

test('sidebar is viewport-safe and independently scrollable',()=>{
  assert.match(css,/height:100dvh/);
  assert.match(css,/overflow-y:auto/);
  assert.match(css,/overscroll-behavior:contain/);
});
