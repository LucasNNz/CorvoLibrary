import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const text = (path) => readFile(new URL(path, root), 'utf8');

test('Cloudflare config persists R2 and keeps legacy D1 recovery optional', async () => {
  const [crypto, secure, route, page, runtime] = await Promise.all([
    text('lib/config-crypto.ts'), text('lib/secure-settings.ts'), text('app/api/cloudflare-connection/route.ts'), text('app/page.tsx'), text('lib/platform/runtime.ts'),
  ]);
  assert.match(crypto, /TURSO_AUTH_TOKEN/);
  assert.match(crypto, /CORVO_CONFIG_ENCRYPTION_KEY/);
  assert.match(secure, /d1ApiToken/);
  assert.match(secure, /needsReconfigure/);
  assert.match(route, /testR2Connection/);
  assert.match(page, /Salvar e cravar configuração/);
  assert.match(page, /O Turso já é o banco oficial/);
  assert.match(page, /D1 LEGADO \(OPCIONAL\)/);
  assert.match(runtime, /decryptPersistedConfig/);
});

test('safe config response never exposes stored secret values', async () => {
  const secure = await text('lib/secure-settings.ts');
  const start = secure.indexOf('export function safeCloudflareConnection');
  const block = secure.slice(start);
  assert.ok(start >= 0);
  assert.doesNotMatch(block, /secretAccessKey:\s*connection\.secretAccessKey/);
  assert.doesNotMatch(block, /d1ApiToken:\s*connection\.d1ApiToken/);
  assert.match(block, /hasSecret/);
  assert.match(block, /hasD1Token/);
});
