import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('dashboard owner access uses real persisted session instead of same-origin fallback', async () => {
  const access = await read('lib/mcp-access.ts');
  const auth = await read('lib/auth.ts');
  assert.match(access, /getLibrarySession/);
  assert.doesNotMatch(access, /sec-fetch-site|oai-authenticated-user-email/);
  for (const marker of ['library_auth_v1','corvo_library_session','PBKDF2','HttpOnly']) assert.match(auth, new RegExp(marker));
});

test('first access and settings UI expose simple username/password login', async () => {
  const page = await read('app/page.tsx');
  for (const marker of ['Criar login','Lembrar neste aparelho','Alterar login','/api/auth/login','/api/auth/setup']) assert.match(page, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('persisted secrets use stable master key with Turso and password recovery wrappers', async () => {
  const crypto = await read('lib/config-crypto.ts');
  const master = await read('lib/master-key.ts');
  assert.match(crypto, /v2\./);
  assert.match(crypto, /getLibraryMasterKey/);
  for (const marker of ['library_master_key_v1','passwordWrapSalt','TURSO_AUTH_TOKEN','rewrapLibraryMasterKeyForPassword']) assert.match(master, new RegExp(marker));
});

test('D1 replacement snapshots Turso and preserves Vercel auth/master-key bootstrap', async () => {
  const migration = await read('lib/d1-to-turso-migration.ts');
  for (const marker of ['createTargetBackup','rollbackLastD1Migration','restoreVercelBootstrapSettings','library_auth_v1','library_master_key_v1']) assert.match(migration, new RegExp(marker));
  assert.match(migration, /D1_MIGRATION_FAILED_AUTO_ROLLBACK_OK/);
});
