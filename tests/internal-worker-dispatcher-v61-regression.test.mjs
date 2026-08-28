import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = (p) => readFile(new URL(p, root), 'utf8');

test('V61 migration configures internal dispatcher, chunk size and dispatch indexes', async () => {
  const sql = await read('drizzle/0018_internal_worker_dispatcher.sql');
  for (const key of ['internal_dispatcher_enabled','internal_dispatcher_max_workers','internal_dispatcher_max_cycles','supervisor_plan_branch_insert_chunk_size','supervisor_plan_max_wip']) assert.match(sql, new RegExp(key));
  assert.match(sql, /supervisor_plan_branch_insert_chunk_size','20'/);
  assert.match(sql, /supervisor_plan_max_wip','200'/);
  assert.match(sql, /WHERE settings\.value='80'/);
  assert.match(sql, /worker_work_items_dispatch_idx/);
  assert.match(sql, /plan_branches_dispatch_idx/);
});

test('fan-out persists branches in internal D1 chunks and honors scope max_items', async () => {
  const source = await read('lib/supervisor-plan-engine.ts');
  const create = source.slice(source.indexOf('async function createBranchesForPlan'), source.indexOf('async function ensureCandidateBuffer'));
  assert.match(create, /supervisor_plan_branch_insert_chunk_size/);
  assert.match(create, /for \(const group of chunk\(rows, chunkSize\)\)/);
  assert.match(create, /PLAN_BRANCH_INSERT_FAILED/);
  const exchange = source.slice(source.indexOf('export async function supervisorExchange'), source.indexOf('export async function executeUntilDivergence'));
  assert.match(exchange, /scope\.max_items/);
  assert.match(exchange, /branch_insert_chunks/);
  assert.match(exchange, /branch_insert_chunk_size/);
  assert.match(exchange, /if \(existing\) return getOperationResult\(operationId\)/);
});

test('failed branch creation aborts plan and cancels partial branches', async () => {
  const source = await read('lib/supervisor-plan-engine.ts');
  const exchange = source.slice(source.indexOf('export async function supervisorExchange'), source.indexOf('export async function executeUntilDivergence'));
  assert.match(exchange, /status:"FAILED"/);
  assert.match(exchange, /PLAN_CREATION_ABORTED/);
  assert.match(exchange, /status:"CANCELLED"/);
  assert.match(exchange, /PLAN_FAILED:/);
});

test('internal dispatcher atomically consumes READY work with granular leases', async () => {
  const source = await read('lib/internal-worker-dispatcher.ts');
  assert.match(source, /UPDATE worker_work_items SET status='LEASED'/);
  assert.match(source, /WHERE id=\? AND status='READY'/);
  assert.match(source, /INTERNAL_WORK_ASSIGNED/);
  assert.match(source, /worker_sessions/);
  assert.match(source, /runWorkerWatchdog/);
  assert.match(source, /syncWorkerQueue/);
  assert.match(source, /processAutomaticProject/);
});

test('dispatcher leaves visual QA for supervisor and auto-runs authorized relink', async () => {
  const source = await read('lib/internal-worker-dispatcher.ts');
  assert.match(source, /INTERNAL_STAGES = new Set\(\["COLETA", "MATERIALIZACAO", "RELINK"\]\)/);
  assert.match(source, /row\.scopeType === "ITEM"/);
  assert.doesNotMatch(source, /INTERNAL_STAGES = new Set\([^\n]*"QA"/);
  assert.match(source, /WAITING_SUPERVISOR/);
  assert.match(source, /activateRelink/);
  const plans = await read('lib/supervisor-plan-engine.ts');
  assert.match(plans, /hasAuthorizedRoute/);
  assert.match(plans, /spec\.status = "READY"/);
});

test('MCP mutations wake dispatcher in background via waitUntil without delaying ACK', async () => {
  const dataPlane = await read('lib/data-plane.ts');
  assert.match(dataPlane, /waitUntil\(pumpDataPlane/);
  assert.match(dataPlane, /maxPasses = 4/);
  assert.match(dataPlane, /needs_reschedule/);
  const route = await read('app/mcp/route.ts');
  assert.match(route, /!definition\.annotations\.readOnlyHint/);
  assert.match(route, /x-corvo-dispatch-wake/);
  assert.match(route, /MCP_WAKE:/);
  const exchange = await read('lib/supervisor-plan-engine.ts');
  const hot = exchange.slice(exchange.indexOf('export async function supervisorExchange'), exchange.indexOf('export async function executeUntilDivergence'));
  assert.match(hot, /ack_immediate:true/);
  assert.doesNotMatch(hot, /runInternalWorkerDispatcher\(/);
});

test('manual/external MCP recovery self-heals READY queues and then performs plan fan-in', async () => {
  const dataPlane = await read('lib/data-plane.ts');
  assert.match(dataPlane, /runDataPlaneRecovery/);
  assert.match(dataPlane, /await pumpDataPlane\(source/);
  const route = await read('app/api/internal/data-plane/route.ts');
  assert.match(route, /MANUAL_RECOVERY:/);
  const vercel = JSON.parse(await read('vercel.json'));
  assert.ok(!Array.isArray(vercel.crons) || vercel.crons.length === 0);
  const plan = await read('lib/supervisor-plan-engine.ts');
  const tick = plan.slice(plan.indexOf('export async function runSupervisorPlansTick'));
  assert.match(tick, /runInternalWorkerDispatcher/);
  assert.match(tick, /refreshPlanBranches/);
});

test('dashboard exposes starvation state READY without internal consumer', async () => {
  const worker = await read('lib/worker-orchestration.ts');
  assert.match(worker, /STARVED_READY_WITHOUT_CONSUMER/);
  assert.match(worker, /self_healing:true/);
  assert.match(worker, /wake_on_mcp_mutation:true/);
  assert.match(worker, /wake_on_cron:false/);
  assert.match(worker, /wake_on_mcp_scheduler:true/);
});

test('MCP exposes dispatcher diagnostics and continuar_processamento becomes async plan command', async () => {
  const tools = await read('lib/mcp-tools.ts');
  for (const name of ['executar_dispatcher_workers','obter_saude_dispatcher']) {
    assert.match(tools, new RegExp(`tool\\("${name}"`));
    assert.match(tools, new RegExp(`case "${name}"`));
  }
  const continueCase = tools.slice(tools.indexOf('case "continuar_processamento"'), tools.indexOf('case "pausar_processamento"'));
  assert.match(continueCase, /executeUntilDivergence/);
  assert.doesNotMatch(continueCase, /processAutomaticProject/);
  const risk = await read('lib/mcp-risk-policy.ts');
  assert.match(risk, /"executar_dispatcher_workers"/);
  assert.match(risk, /policyVersion: "V61"/);
});
