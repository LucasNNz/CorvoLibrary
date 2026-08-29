import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const admin=fs.readFileSync(new URL('../lib/cloudflare-admin.ts',import.meta.url),'utf8');
const route=fs.readFileSync(new URL('../app/api/cloudflare-connection/route.ts',import.meta.url),'utf8');
const page=fs.readFileSync(new URL('../app/page.tsx',import.meta.url),'utf8');

test('D1 diagnostics distinguish account, permission, signature and ambiguity failures',()=>{
  for(const code of ['CLOUDFLARE_TOKEN_INVALID','CLOUDFLARE_TOKEN_FORBIDDEN','CLOUDFLARE_D1_NONE_IN_ACCOUNT','CLOUDFLARE_D1_CORVO_NOT_FOUND','CLOUDFLARE_D1_PROBE_FAILED','CLOUDFLARE_D1_MULTIPLE_CORVO_DATABASES']) assert.match(admin,new RegExp(code));
});

test('Cloudflare connection route returns structured diagnostic instead of hiding error',()=>{
  assert.match(route,/instanceof CloudflareAdminError/);
  assert.match(route,/d1Diagnostic/);
  assert.match(route,/error\.code/);
});

test('legacy migration screen surfaces diagnostic code to operator',()=>{
  assert.match(page,/saved\?\.code/);
});
