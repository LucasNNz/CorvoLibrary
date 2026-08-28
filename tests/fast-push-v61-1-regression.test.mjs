import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = (p) => readFile(new URL(p, root), 'utf8');

test('V61.1 migration creates idempotent FAST PUSH inbox with hot indexes', async () => {
  const sql = await read('drizzle/0019_fast_push_batch_inbox.sql');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS fast_push_candidates/);
  assert.match(sql, /operation_id text NOT NULL/);
  assert.match(sql, /UNIQUE INDEX IF NOT EXISTS fast_push_candidates_operation_id_unique/);
  assert.match(sql, /fast_push_candidates_project_slot_idx/);
  assert.match(sql, /fast_push_candidates_sha_idx/);
});

test('FAST PUSH URL path is bounded, parallel, hash-deduplicated and per-item resilient', async () => {
  const source = await read('lib/fast-push.ts');
  assert.match(source, /MAX_BATCH_ITEMS = 20/);
  assert.match(source, /PARALLELISM = 4/);
  assert.match(source, /FETCH_TIMEOUT_MS = 12_000/);
  assert.match(source, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(source, /eq\(assets\.sha256, digest\)/);
  assert.match(source, /eq\(fastPushCandidates\.sha256, digest\)/);
  assert.match(source, /DUPLICATE_REUSED/);
  assert.match(source, /PENDING_ANALYSIS/);
  assert.match(source, /FAILED_INVALID_MIME/);
  assert.match(source, /results = await mapConcurrent/);
  assert.match(source, /catch \(error\).*FAILED_DOWNLOAD/s);
});

test('FAST PUSH promotion records approval, asset usage and project slot resolution', async () => {
  const source = await read('lib/fast-push.ts');
  assert.match(source, /APPROVED_CANDIDATE/);
  assert.match(source, /PROMOTED_TO_ASSET/);
  assert.match(source, /db\.insert\(assetUsage\)/);
  assert.match(source, /linkedAssetId: assetId/);
  assert.match(source, /status: "FROZEN"/);
  assert.match(source, /decisionSource: source/);
});

test('MCP exposes URL batch, chat-file fast path, inbox and manual decisions', async () => {
  const tools = await read('lib/mcp-tools.ts');
  for (const name of ['listar_destinos_fast_push_projeto','importar_candidatas_url_lote','importar_candidata_arquivo_fast_push','vincular_candidatas_fast_push_ao_projeto','listar_inbox_candidatas','aprovar_candidatas_fast_push_lote','rejeitar_candidatas_fast_push_lote']) {
    assert.match(tools, new RegExp(`tool\\("${name}"`));
    assert.match(tools, new RegExp(`case "${name}"`));
  }
  const risk = await read('lib/mcp-risk-policy.ts');
  assert.match(risk, /"importar_candidatas_url_lote"/);
  assert.match(risk, /"aprovar_candidatas_fast_push_lote"/);
  assert.match(risk, /"vincular_candidatas_fast_push_ao_projeto"/);
});

test('App exposes visual Inbox with filtering and manual batch approve/reject', async () => {
  const page = await read('app/page.tsx');
  assert.match(page, /Inbox candidatas/);
  assert.match(page, /function FastPushInbox/);
  assert.match(page, /\/api\/fast-push/);
  assert.match(page, /Aprovar e promover/);
  assert.match(page, /Rejeitar/);
});


test('V61.2 FAST PUSH uses the canonical pending/QA bridge for project linkage', async () => {
  const source = await read('lib/fast-push.ts');
  const migration = await read('drizzle/0020_fast_push_project_bridge.sql');
  assert.match(source, /bridgeMaterializationToSupervisor/);
  assert.match(source, /FAST_PUSH_CANONICAL/);
  assert.match(source, /supervisorProjectCandidates/);
  assert.match(source, /LINKED_PARA_QA_VISUAL/);
  assert.match(source, /LINKED_PARA_ANALISE/);
  assert.match(source, /project_link_status/);
  assert.match(source, /listFastPushProjectTargets/);
  assert.match(source, /linkFastPushCandidatesToProject/);
  assert.match(migration, /project_item_id/);
  assert.match(migration, /supervisor_candidate_id/);
  assert.match(migration, /materialization_item_id/);
});

test('V61.2 standard project QA treats FAST PUSH exactly as canonical pending evidence', async () => {
  const materializer = await read('lib/materializer.ts');
  const bridge = await read('lib/supervisor-materialization-bridge.ts');
  const control = await read('lib/supervisor-control.ts');
  const automatic = await read('lib/automatic-projects.ts');
  const tools = await read('lib/mcp-tools.ts');
  assert.match(materializer, /item\.routeClass === "FAST_PUSH_CANONICAL"/);
  assert.match(materializer, /status: "PROMOTED_TO_ASSET"/);
  assert.match(materializer, /projectLinkStatus: "RESOLVED_APPROVED"/);
  assert.match(materializer, /status === "REJEITADO" && item\.routeClass !== "FAST_PUSH_CANONICAL"/);
  assert.match(bridge, /fastPushCandidates/);
  assert.match(bridge, /LINKED_PARA_QA_VISUAL/);
  assert.match(control, /supervisorProjectCandidates/);
  assert.match(control, /materializationFiles/);
  assert.match(control, /PARA_QA_VISUAL/);
  assert.match(automatic, /registerQaBatch/);
  assert.match(automatic, /linkedAssetId:updatedMaterialized\.frozenAssetId/);
  assert.match(tools, /incluindo candidatas FAST PUSH já ligadas pela ponte canônica/);
});

test('V61.2 batch result fails closed when project linkage is missing', async () => {
  const source = await read('lib/fast-push.ts');
  assert.match(source, /project_linked: projectLinked/);
  assert.match(source, /requires_project_link: Boolean\(result\.projectId && !projectLinked\)/);
  assert.match(source, /PROJECT_ITEM_NOT_FOUND/);
  assert.match(source, /AMBIGUOUS_PROJECT_ITEM/);
});

test('V61.3 FAST PUSH FILE ingests attached bytes without treating transport URL as web source', async () => {
  const source = await read('lib/fast-push.ts');
  const tools = await read('lib/mcp-tools.ts');
  const route = await read('app/api/fast-push/file/route.ts');
  const mcp = await read('app/mcp/route.ts');

  assert.match(source, /ingestFastPushFileBytes/);
  assert.match(source, /chat-file:\/\//);
  assert.match(source, /source_type: "CHAT_FILE"/);
  assert.match(source, /target_file\?: string/);
  assert.match(source, /item_projeto_id\?: string/);
  assert.match(source, /semantic_reference\?: string/);
  assert.match(source, /targetName: clean\(input\.target_name \|\| input\.target_file\)/);
  assert.match(source, /visualReference: clean\(input\.visual_reference \|\| input\.semantic_reference\)/);

  assert.match(route, /request\.formData\(\)/);
  assert.match(route, /MAX_FILES = 20/);
  assert.match(route, /file\.arrayBuffer\(\)/);
  assert.match(route, /FAST_PUSH_FILE_DIRECT/);
  assert.match(route, /ingestFastPushFileBytes/);

  assert.match(tools, /A rota principal continua sendo importar_candidatas_url_lote/);
  assert.match(tools, /transport:"OPENAI_FILE_PARAM"/);
  assert.match(tools, /ingestFastPushFileBytes/);
  assert.match(tools, /target_file:text/);
  assert.match(tools, /item_projeto_id:text/);
  assert.match(tools, /semantic_reference:text/);

  assert.match(mcp, /V61\.3 mantém FAST PUSH URL como rota principal/);
  assert.match(mcp, /endpoint \/api\/fast-push\/file também aceita bytes multipart diretamente/);
});
