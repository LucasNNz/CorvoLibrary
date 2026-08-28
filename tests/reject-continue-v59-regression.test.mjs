import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const source = (relative) => readFile(new URL(relative, root), "utf8");

test("V59 migration normalizes ANIME profiles, prunes expired breakers and indexes operation recovery", async () => {
  const sql = await source("drizzle/0015_reject_continue_chatter_reduction.sql");
  assert.match(sql,/UPDATE source_profiles/);
  assert.match(sql,/domain = 'ANIME'/);
  assert.match(sql,/domain = 'MULTI'/);
  assert.match(sql,/FANDOM-WIKIA-ANIME|FANDOM_WIKIA_ANIME/i);
  assert.match(sql,/YOUTUBE-CONTEXTUAL/);
  assert.match(sql,/UPDATE materialization_host_health/);
  assert.match(sql,/blocked_until\s*(?:<|<=).*strftime\('%s','now'\)/i);
  assert.match(sql,/idx_operation_results_project_tool_updated/);
  assert.doesNotMatch(sql,/DELETE FROM|DROP TABLE|DROP COLUMN/i);
});

test("reject candidate is idempotent reject-and-continue and returns next work packet", async () => {
  const tools = await source("lib/mcp-tools.ts");
  const start = tools.indexOf('case "rejeitar_candidata"');
  const end = tools.indexOf('case "relinkar_item"', start);
  const body = tools.slice(start,end);
  assert.match(tools,/tool\("rejeitar_candidata"[\s\S]{0,1200}candidate_id/);
  assert.match(tools,/tool\("rejeitar_candidata"[\s\S]{0,1600}operation_id/);
  assert.match(body,/beginOperation\(/);
  assert.match(body,/qaAutomaticProject\([\s\S]*?processar_apos:\s*false\s*}\)/);
  assert.match(body,/syncWorkerItemsQueue/);
  assert.match(body,/next_work_packet/);
  assert.match(body,/item_state/);
  assert.match(body,/project_state/);
  assert.match(body,/completeOperation/);
});

test("QA rejection automatically chooses next candidate or relink without blocking project", async () => {
  const projects = await source("lib/automatic-projects.ts");
  const start = projects.indexOf("async function applyProjectQaDecisions");
  const end = projects.indexOf("async function runAutomaticVisualQa",start);
  const body = projects.slice(start,end);
  assert.match(body,/semanticRejectCount/);
  assert.match(body,/autoRelink/);
  assert.match(body,/next_state:"NEXT_CANDIDATE"/);
  assert.match(body,/next_state:relinkNow\?"RELINK_QUEUE":"NEXT_CANDIDATE"/);
  assert.doesNotMatch(body,/processAutomaticProject\(/);
});

test("Supervisor lease acquisition hot path does not reconcile or backfill before returning execution id", async () => {
  const tools = await source("lib/mcp-tools.ts");
  const start = tools.indexOf('case "assumir_proximo_trabalho_supervisor"');
  const end = tools.indexOf('case "backfill_projetos_legados"',start);
  const body = tools.slice(start,end);
  assert.match(body,/acquireNextSupervisorWork/);
  assert.match(body,/lease_fast_path:\s*true/);
  assert.doesNotMatch(body,/reconcileAutomaticProject|backfillLegacyProjects|backfillAutomaticProjectItemsFromFiles|syncWorkerQueue/);
});

test("operational snapshot is compact and defensively handles empty batch data", async () => {
  const performance = await source("lib/performance-control.ts");
  const start = performance.indexOf("export async function getOperationalSnapshot");
  const end = performance.indexOf("export async function beginOperation",start);
  const body = performance.slice(start,end);
  assert.match(body,/Array\.isArray\(decisionsRaw\)/);
  assert.match(body,/work_packet/);
  assert.match(body,/counts/);
  assert.match(body,/lease/);
  assert.doesNotMatch(body,/sourceProfiles|workerEvents|workerCapacityLimits|materializationHostHealth|throughput/);

  const tools = await source("lib/mcp-tools.ts");
  const batchStart = tools.indexOf('case "aplicar_decisoes_supervisor_lote"');
  const batchEnd = tools.indexOf('case "relinkar_itens_lote"',batchStart);
  const batch = tools.slice(batchStart,batchEnd);
  assert.match(batch,/Array\.isArray\(input\.decisoes\)/);
  assert.match(batch,/DECISOES_REQUIRED/);
  assert.match(batch,/next_work_packet/);
});

test("semantic URL precheck rejects explicit conflicting anime entity before materialization", async () => {
  const collector = await source("lib/auto-collector.ts");
  assert.match(collector,/UNIVERSE_ENTITY_GATES/);
  assert.match(collector,/semanticCandidatePrecheck/);
  assert.match(collector,/SEMANTIC_URL_CONFLICT/);
  const routing = await source("lib/source-routing.ts");
  assert.match(routing,/BROAD_GENERIC/);
  assert.match(routing,/isBroadFallback/);
  assert.match(collector,/allowGenericFallback:term\.rounds >= 2/);
  assert.match(collector,/\.filter\(\(candidate\) => semanticCandidatePrecheck|\.filter\(candidate => semanticCandidatePrecheck/);
});

test("Supervisor state uses only the compact operational snapshot for a project", async () => {
  const supervisor = await source("lib/supervisor-control.ts");
  const start = supervisor.indexOf("export async function getSupervisorState");
  const branchEnd = supervisor.indexOf("const mode = await getSupervisorMode", start);
  const body = supervisor.slice(start,branchEnd);
  assert.match(body,/getOperationalSnapshot\(projectId, 0, 20\)/);
  assert.match(body,/counts:snapshot\.counts/);
  assert.match(body,/lease:snapshot\.lease/);
  assert.match(body,/next_actions:snapshot\.next_actions/);
  assert.doesNotMatch(body,/circuit_breakers|perfis_ativos|collectionBatches|failureRows|throughput/);
});


test("lease internals skip watchdog scans and pipeline derivation on acquisition hot path", async () => {
  const lease = await source("lib/supervisor-lease.ts");
  const start = lease.indexOf("export async function acquireNextSupervisorWork");
  const body = lease.slice(start);
  assert.match(body,/SELECT id FROM automatic_projects/);
  assert.match(body,/supervisor_lease_expires_at < \?/);
  assert.doesNotMatch(body,/runSupervisorWatchdog|deriveProjectPipelineState/);
  const acquireStart = lease.indexOf("export async function acquireSupervisorLease");
  const acquireEnd = lease.indexOf("export async function renewSupervisorLease",acquireStart);
  const acquire = lease.slice(acquireStart,acquireEnd);
  assert.doesNotMatch(acquire,/runSupervisorWatchdog/);
  assert.match(acquire,/previousLeaseExpired/);
});
test("MCP exposes operation recovery by operation id and latest reject operation", async () => {
  const tools = await source("lib/mcp-tools.ts");
  for (const name of ["obter_resultado_operacao","obter_ultima_operacao"]) {
    assert.match(tools,new RegExp(`tool\\("${name}"`));
    assert.match(tools,new RegExp(`case "${name}"`));
  }
});
