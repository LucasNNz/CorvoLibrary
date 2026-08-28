import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const source = (relative) => readFile(new URL(relative, root), "utf8");

test("V56 persists materialized project counters, state_version, operation results and hot indexes", async () => {
  const sql = await source("drizzle/0013_fast_control_parallel_data.sql");
  for (const field of ["state_version","total_items","approved_count","frozen_count","waiting_qa_count","relink_count","pending_count","last_frozen_at"]) assert.match(sql,new RegExp(field));
  assert.match(sql,/CREATE TABLE operation_results/);
  assert.match(sql,/CREATE TABLE source_route_metrics/);
  assert.match(sql,/idx_project_items_project_status_priority/);
  assert.match(sql,/idx_supervisor_candidates_project_status_created/);
  assert.match(sql,/idx_worker_items_queue_fifo/);
});

test("legacy parallelism 3 is raised to 8 without overwriting explicit tuning", async () => {
  const sql = await source("drizzle/0013_fast_control_parallel_data.sql");
  const supervisor = await source("lib/supervisor-control.ts");
  assert.match(sql,/WHERE key='collection_parallelism' AND value='3'/);
  assert.match(sql,/VALUES\('collection_parallelism','8'/);
  assert.match(supervisor,/parallelism: Number\(values\.get\(GLOBAL_PARALLELISM_KEY\) \|\| 8\)/);
});

test("simple project reads use materialized summary and cursor pagination without implicit reconciliation", async () => {
  const projects = await source("lib/automatic-projects.ts");
  const summaryStart = projects.indexOf("export async function getAutomaticProjectSummary");
  const summaryEnd = projects.indexOf("export async function listAutomaticProjectsFast",summaryStart);
  const summary = projects.slice(summaryStart,summaryEnd);
  assert.doesNotMatch(summary,/reconcileAutomaticProject|BUCKET|materializationItems/);
  const listStart = summaryEnd;
  const listEnd = projects.indexOf("export async function getAutomaticProject",listStart);
  const list = projects.slice(listStart,listEnd);
  assert.match(list,/cursor\.split\("\|"\)/);
  assert.match(list,/orderBy\(desc\(automaticProjects\.updatedAt\), desc\(automaticProjects\.id\)\)/);
  assert.doesNotMatch(list,/OFFSET|reconcileAutomaticProject|BUCKET/);
});

test("operational snapshot supports delta sync and a work packet of at most 20", async () => {
  const performance = await source("lib/performance-control.ts");
  assert.match(performance,/sinceVersion > 0 && sinceVersion >= version/);
  assert.match(performance,/Math\.min\(20,\s*(?:Number\()?packetLimit/);
  assert.match(performance,/work_packet:/);
  assert.match(performance,/lease:/);
  assert.match(performance,/next_actions:/);
  // V59: stall/capacity/history saem do snapshot quente e ficam no painel operacional.
  const start = performance.indexOf("export async function getOperationalSnapshot");
  const end = performance.indexOf("export async function beginOperation", start);
  const body = performance.slice(start,end);
  assert.doesNotMatch(body,/pipeline_stalled|CAPACIDADE_DISPONIVEL_COM_FILA|workerEvents|workerCapacityLimits|materializationHostHealth/);
});

test("MCP exposes compact snapshot, batch decisions, batch relink, batch materialization and operation recovery", async () => {
  const tools = await source("lib/mcp-tools.ts");
  for (const name of ["obter_snapshot_operacional","aplicar_decisoes_supervisor_lote","relinkar_itens_lote","materializar_urls_lote","obter_resultado_operacao","obter_performance_mcp","obter_ranking_rotas_fontes"]) {
    assert.match(tools,new RegExp(`tool\\("${name}"`));
    assert.match(tools,new RegExp(`case "${name}"`));
  }
  assert.match(tools,/beginOperation\(operationId/);
  assert.match(tools,/completeOperation\(operationId/);
});

test("QA batch prefetch removes the item/materialization N+1 pattern", async () => {
  const projects = await source("lib/automatic-projects.ts");
  const start = projects.indexOf("async function applyProjectQaDecisions");
  const end = projects.indexOf("export async function processAutomaticProject",start);
  const body = projects.slice(start,end);
  assert.match(body,/inArray\(automaticProjectItems\.id,keys\)/);
  assert.match(body,/inArray\(materializationItems\.id,materializationIds\)/);
  assert.match(body,/grouped = new Map/);
  assert.match(body,/registerQaBatch/);
});

test("collection works wide across 10 terms by default and isolates failures", async () => {
  const collector = await source("lib/auto-collector.ts");
  assert.match(collector,/Number\(input\.paralelismo_termos\) \|\| 10/);
  assert.match(collector,/Promise\.allSettled\(terms\.map/);
  assert.match(collector,/EXCECAO_ISOLADA/);
});

test("obvious unconfigured sources are disabled automatically instead of repeatedly asking Supervisor", async () => {
  const collector = await source("lib/auto-collector.ts");
  assert.match(collector,/SOURCE_NOT_CONFIGURED/);
  assert.match(collector,/collectionSources\)\.set\(\{ active: false/);
  const supervisor = await source("lib/supervisor-control.ts");
  assert.match(supervisor,/SOURCE_NOT_CONFIGURED/);
  assert.match(supervisor,/if \(!obviousInfra\)/);
});

test("adaptive circuit breaker does not globally block historically healthy host after two bad URLs", async () => {
  const materializer = await source("lib/materializer.ts");
  assert.match(materializer,/historicalSuccessRate/);
  assert.match(materializer,/nextSuccess >= 20 && historicalSuccessRate >= 0\.8 \? 5/);
  assert.match(materializer,/recentFailures >= threshold/);
});

test("source routing learns by universe and composition class", async () => {
  const supervisor = await source("lib/supervisor-control.ts");
  assert.match(supervisor,/getRouteRanking\(universe \|\| undefined, composition \|\| undefined/);
  assert.match(supervisor,/profileSpecificToUniverse/);
  assert.match(supervisor,/profileSpecificToComposition/);
  assert.match(supervisor,/strict_preferred_sources/);
});

test("MCP audit persists timing fields, payload size and cold-start flag", async () => {
  const schema = await source("db/schema.ts");
  const tools = await source("lib/mcp-tools.ts");
  for (const field of ["durationMs","authMs","parseMs","dbMs","dbQueryCount","r2Ms","r2RequestCount","externalHttpMs","externalHttpCount","serializationMs","responseBytes","rowsRead","rowsWritten","cacheHit","coldStart"]) assert.match(schema,new RegExp(field));
  assert.match(tools,/responseBytes/);
  assert.match(tools,/serializationMs/);
  assert.match(tools,/coldStart/);
  assert.match(tools,/getMcpPerformanceSummary/);
});

test("processing loop implements skip waiting so QA/relink blocks only its item", async () => {
  const projects = await source("lib/automatic-projects.ts");
  const start = projects.indexOf("export async function processAutomaticProject");
  const end = projects.indexOf("export async function qaAutomaticProject",start);
  const body = projects.slice(start,end);
  assert.match(body,/SKIP WAITING/);
  assert.match(body,/WAITING_FAMILY_SEED/);
  assert.match(body,/RELINK_REQUIRED/);
  assert.match(body,/productive/);
});
