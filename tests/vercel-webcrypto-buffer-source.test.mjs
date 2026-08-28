import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('Vercel/Node Web Crypto receives ArrayBuffer-backed BufferSource values', () => {
  const helper = read('lib/web-crypto.ts');
  const auth = read('lib/auth.ts');
  const master = read('lib/master-key.ts');
  const config = read('lib/config-crypto.ts');

  assert.match(helper, /function toArrayBuffer\(bytes: Uint8Array\): ArrayBuffer/);
  assert.match(auth, /salt: toArrayBuffer\(salt\)/);
  assert.match(master, /iv: toArrayBuffer\(iv\)/);
  assert.match(master, /toArrayBuffer\(raw\)/);
  assert.match(config, /toArrayBuffer\(base64ToBytes\(ivValue\)\)/);
  assert.doesNotMatch(auth, /name:"PBKDF2", salt, iterations/);
});
