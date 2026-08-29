import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const page=fs.readFileSync(new URL('../app/page.tsx',import.meta.url),'utf8');
const css=fs.readFileSync(new URL('../app/globals.css',import.meta.url),'utf8');
const cloudflareRoute=fs.readFileSync(new URL('../app/api/cloudflare-connection/route.ts',import.meta.url),'utf8');
const auto=fs.readFileSync(new URL('../lib/automatic-production-bootstrap.ts',import.meta.url),'utf8');

test('FIX14 automatically restores production data instead of blocking first-use on D1',()=>{
  assert.match(page,/const legacyMigrationRequired = false/);
  assert.match(page,/Base de produção — automática/);
  assert.match(auto,/production-recovery-v1\.json/);
  assert.match(auto,/ZERO_TOUCH_PRESERVE_EXISTING/);
});

test('D1-only legacy bootstrap still does not require R2 credentials',()=>{
  assert.match(cloudflareRoute,/const hasAnyR2 = Boolean\(connection\.accessKeyId \|\| connection\.secretAccessKey \|\| connection\.endpoint\)/);
  assert.doesNotMatch(cloudflareRoute,/Boolean\(connection\.bucket \|\| connection\.accessKeyId/);
});

test('sidebar is viewport-safe and independently scrollable',()=>{
  assert.match(css,/height:100dvh/);
  assert.match(css,/overflow-y:auto/);
  assert.match(css,/overscroll-behavior:contain/);
});
