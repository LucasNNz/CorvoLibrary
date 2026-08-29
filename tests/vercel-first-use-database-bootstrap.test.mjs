import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('first-use auth is gated behind persistent Turso bootstrap', async () => {
  const state = await read('lib/platform/database-bootstrap.ts');
  const status = await read('app/api/auth/status/route.ts');
  const setup = await read('app/api/auth/setup/route.ts');
  const page = await read('app/page.tsx');
  assert.match(state, /TURSO_DATABASE_URL/);
  assert.match(state, /TURSO_AUTH_TOKEN/);
  assert.match(status, /bootstrapRequired/);
  assert.match(setup, /DATABASE_BOOTSTRAP_REQUIRED/);
  assert.match(page, /DatabaseBootstrapScreen/);
  assert.match(page, /Conectar banco da Library/);
  assert.match(page, /Conectar Turso na Vercel/);
});

test('login form is only rendered after database bootstrap is ready', async () => {
  const page = await read('app/page.tsx');
  const gate = page.indexOf('if (authStatus.bootstrapRequired) return <DatabaseBootstrapScreen');
  const auth = page.indexOf('if (!authStatus.authenticated) return <AuthScreen');
  assert.ok(gate >= 0 && auth > gate);
});
