import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');

test('V61.5 exposes one fast bulk decision core and short aliases', async () => {
  const tools = await read('lib/mcp-tools.ts');
  for (const name of ['decidir_candidatas_lote','aprovar_candidatas_lote','rejeitar_candidatas_lote','rejeitar_itens_lote','excluir_candidatas_lote']) {
    assert.match(tools, new RegExp(`tool\\("${name}"`));
    assert.match(tools, new RegExp(`case "${name}"`));
  }
  assert.match(tools, /AMBIGUOUS_REQUIRES_CANDIDATE_ID/);
});

test('bulk target rejection and ambiguous target approval are fail safe', async () => {
  const fast = await read('lib/fast-push.ts');
  assert.match(fast, /export async function decideFastPushBatch/);
  assert.match(fast, /decision === "REJECT"/);
  assert.match(fast, /AMBIGUOUS_REQUIRES_CANDIDATE_ID/);
  assert.match(fast, /PROJECT_MISMATCH/);
  assert.match(fast, /MAX_DECISION_ITEMS = 200/);
});

test('hard delete is explicitly destructive and R2 bytes are reference protected', async () => {
  const fast = await read('lib/fast-push.ts');
  const risk = await read('lib/mcp-risk-policy.ts');
  assert.match(risk, /DESTRUCTIVE_TOOLS[\s\S]*"excluir_candidatas_lote"/);
  assert.match(fast, /CONFIRMACAO_EXCLUSAO_PERMANENTE_REQUIRED/);
  assert.match(fast, /PROMOTED_PROTECTED/);
  assert.match(fast, /R2_KEY_NOT_OWNED_BY_CANDIDATE/);
  assert.match(fast, /R2_KEY_STILL_REFERENCED/);
  assert.match(fast, /projectProductionAssets/);
});

test('API keeps PATCH compatibility and adds protected DELETE', async () => {
  const route = await read('app/api/fast-push/route.ts');
  assert.match(route, /export async function PATCH/);
  assert.match(route, /decideFastPushBatch/);
  assert.match(route, /export async function DELETE/);
  assert.match(route, /deleteFastPushCandidatesBatch/);
});
