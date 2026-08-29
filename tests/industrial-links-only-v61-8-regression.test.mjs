import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const read=(file)=>readFile(new URL(`../${file}`,import.meta.url),'utf8');

test('V61.8 defaults MCP file delivery to LINKS_ONLY and suppresses resource_link centrally', async()=>{
  const industrial=await read('lib/industrial-supervisor.ts');
  const route=await read('app/mcp/route.ts');
  assert.match(industrial,/CHAT_FILE_DELIVERY_MODE/);
  assert.match(industrial,/MCP_FILE_RESOURCE_DELIVERY/);
  assert.match(industrial,/Industrial-safe default/);
  assert.match(industrial,/IDS_METADATA_SIGNED_R2_URLS_ONLY/);
  assert.match(route,/isMcpFileResourceDeliveryEnabled/);
  assert.match(route,/resourceDeliveryEnabled \? resources\.flatMap/);
});

test('V61.8 publishes fast visual packet and redirects legacy QA surfaces to links-only', async()=>{
  const tools=await read('lib/mcp-tools.ts');
  const industrial=await read('lib/industrial-supervisor.ts');
  for(const name of ['fast_visual_packet','obter_candidatas_qa_links','obter_work_packet_lite','obter_resumo_operacional_curto']) assert.match(tools,new RegExp(`tool\\(\\"${name}\\"`));
  assert.match(tools,/obter_candidatas_qa_visual[\s\S]*getFastVisualPacket/);
  assert.match(tools,/obter_assets_para_qa_lote[\s\S]*getMaterializationQaLinks/);
  assert.match(tools,/obter_pendentes_para_qa_catalogo[\s\S]*getPendingCatalogQaLinks/);
  assert.match(industrial,/signed_preview_url/);
  assert.match(industrial,/signed_original_url/);
  assert.match(industrial,/canonical_source:\"R2\"/);
  assert.doesNotMatch(industrial,/__resources/);
});

test('V61.8 adds async mixed FAST DECIDE and quick aliases', async()=>{
  const tools=await read('lib/mcp-tools.ts');
  const fast=await read('lib/fast-supervisor-decisions.ts');
  for(const name of ['fast_decidir_candidatas_lote','aprovar_itens_lote','aprovar_target_files_lote','relink_itens_lote']) assert.match(tools,new RegExp(`tool\\(\\"${name}\\"`));
  assert.match(fast,/enqueueFastCandidateDecisionBatch/);
  assert.match(fast,/kind:\"FAST_DECIDE_PROJECT_CANDIDATES\"/);
  assert.match(fast,/fastDecideAckPayload/);
  assert.match(fast,/AMBIGUOUS_REQUIRES_CANDIDATE_ID/);
  assert.match(fast,/"APROVADO"/);
  assert.match(fast,/"REJEITADO"/);
  assert.match(fast,/"RELINK_REQUIRED"/);
  assert.match(fast,/reject_all/);
  assert.match(fast,/REJECTED_ALL_ACTIVE/);
});

test('V61.8 adds contact sheet and QA JSON export without MCP file resources', async()=>{
  const tools=await read('lib/mcp-tools.ts');
  const industrial=await read('lib/industrial-supervisor.ts');
  assert.match(tools,/tool\("gerar_grid_candidatas"/);
  assert.match(tools,/tool\("exportar_pacote_qa_json"/);
  assert.match(industrial,/sharp/);
  assert.match(industrial,/qa-grids\//);
  assert.match(industrial,/exports\/qa-json\//);
  assert.match(industrial,/row-major positions; no MCP file resource/);
});

test('V61.8 keeps FAST PUSH URL as explicit industrial route', async()=>{
  const tools=await read('lib/mcp-tools.ts');
  assert.match(tools,/tool\("fast_push_urls_lote"/);
  assert.match(tools,/case "fast_push_urls_lote"[\s\S]*ingestFastPushBatch/);
});

test('industrial POST APIs wake the Vercel data plane', async()=>{
  const api=await read('app/api/industrial/decide/route.ts');
  const plane=await read('lib/data-plane.ts');
  assert.match(api,/enqueueFastCandidateDecisionBatch/);
  assert.match(api,/wakeDataPlane/);
  assert.match(api,/status:202/);
  assert.match(plane,/waitUntil/);
  assert.match(plane,/pumpDataPlane/);
});
