import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const perf = fs.readFileSync('lib/performance-control.ts', 'utf8');
const worker = fs.readFileSync('lib/worker-orchestration.ts', 'utf8');
const fastPush = fs.readFileSync('lib/fast-push.ts', 'utf8');

test('operational snapshot reads QA media fields from materialization_files', () => {
  assert.match(perf, /materializationFiles\.mimeType/);
  assert.match(perf, /materializationFiles\.width/);
  assert.match(perf, /materializationFiles\.height/);
  assert.match(perf, /leftJoin\(materializationFiles,\s*eq\(materializationFiles\.id,\s*supervisorProjectCandidates\.materializationFileId\)\)/);
  assert.doesNotMatch(perf, /supervisorProjectCandidates\.(?:mimeType|width|height)/);
});

test('worker completion batches are concrete tuples instead of heterogeneous cast arrays', () => {
  assert.doesNotMatch(worker, /statements\.push\([\s\S]*as typeof statements\[number\]/);
  assert.doesNotMatch(worker, /db\.batch\(statements\)/);
  assert.match(worker, /db\.batch\(\[completeWork, releaseSession, insertMetric, completeExport\]\)/);
  assert.match(worker, /db\.batch\(\[completeWork, releaseSession, insertMetric\]\)/);
});

test('FAST PUSH freezes nullable candidate media fields before Drizzle eq calls', () => {
  assert.match(fastPush, /const candidateSha256 = candidate\.sha256;/);
  assert.match(fastPush, /if \(!candidateSha256 \|\| !candidateR2Key \|\| !candidateMimeType\)/);
  assert.match(fastPush, /eq\(assets\.sha256, candidateSha256\)/);
  assert.doesNotMatch(fastPush, /eq\(assets\.sha256, candidate\.sha256\)/);
});
