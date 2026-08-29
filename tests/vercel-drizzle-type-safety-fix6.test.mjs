import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const fastPush = fs.readFileSync(new URL('../lib/fast-push.ts', import.meta.url), 'utf8');

test('FAST PUSH bridge freezes nullable media fields before all typed materialization uses', () => {
  assert.match(fastPush, /const materializedR2Key: string = candidateInput\.r2Key;/);
  assert.match(fastPush, /const materializedSha256: string = candidateInput\.sha256;/);
  assert.match(fastPush, /const materializedMimeType: string = candidateInput\.mimeType;/);
  const start = fastPush.indexOf('async function bridgeFastPushToCanonicalPending');
  const end = fastPush.indexOf('async function finalizeCandidateProjectBridge', start);
  assert.ok(start >= 0 && end > start);
  const bridge = fastPush.slice(start, end);
  assert.match(bridge, /extForMime\(materializedMimeType\)/);
  assert.match(bridge, /const materializationFileRow: typeof materializationFiles\.\$inferInsert/);
  assert.match(bridge, /values\(materializationFileRow\)/);
  assert.match(bridge, /r2Key:materializedR2Key/);
  assert.match(bridge, /mimeType:materializedMimeType/);
  assert.match(bridge, /sha256:materializedSha256/);
  assert.doesNotMatch(bridge, /extForMime\(candidate\.mimeType\)/);
  assert.doesNotMatch(bridge, /r2Key:candidate\.r2Key/);
  assert.doesNotMatch(bridge, /sha256:candidate\.sha256/);
});
