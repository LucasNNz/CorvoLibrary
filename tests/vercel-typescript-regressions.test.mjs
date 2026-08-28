import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('collection source parser explicitly supports optional thumbnailPath', () => {
  const source = read('lib/auto-collector.ts');
  assert.match(source, /flatMap<SourceInput>\(\(block, index\): SourceInput\[\]/);
  assert.match(source, /thumbnailPath\?: string/);
});

test('image inspection is a discriminated union instead of never', () => {
  const source = read('lib/materializer.ts');
  assert.match(source, /type ValidInspection = \{ ok: true;/);
  assert.match(source, /type InspectionResult = ValidInspection \| InvalidInspection/);
  assert.match(source, /function inspectBytes\(bytes: Uint8Array\): InspectionResult/);
  assert.doesNotMatch(source, /Extract<ReturnType<typeof inspectBytes>/);
});

test('bootstrap settings always returns a Promise', () => {
  const source = read('lib/bootstrap-db.ts');
  assert.match(source, /ensureBootstrapSettingsTable\(\): Promise<void>/);
  assert.match(source, /return inFlight!/);
});

test('deterministic replan does not compare impossible TRY_NEXT_SOURCE action', () => {
  const source = read('lib/automatic-projects.ts');
  const start = source.indexOf('async function replanFailedItem');
  const end = source.indexOf('async function syncProjectFromCollection', start);
  const block = source.slice(start, end);
  assert.doesNotMatch(block, /plan\.action\s*[!=]==?\s*["']TRY_NEXT_SOURCE["']/);
});

test('FAST PUSH optional batch id is normalized to undefined', () => {
  const source = read('lib/mcp-tools.ts');
  assert.match(source, /optional\(input\.batch_id\) \|\| undefined/);
});
