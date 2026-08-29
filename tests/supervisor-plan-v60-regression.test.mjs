import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = (p) => readFile(new URL(p, root), 'utf8');

test('V60 migration creates persistent plans, branches and source routing', async () => {
  const sql = await read('drizzle/0016_supervisor_plans_fanout_source_routing.sql');
  for (const table of ['supervisor_plans','plan_branches','source_routing_plans']) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  assert.match(sql, /active_plan_id/);
  assert.match(sql, /can_discover/);
  assert.match(sql, /can_materialize/);
  assert.match(sql, /SRC-FANDOM-NARUTO-DISCOVERY/);
  assert.match(sql, /SRC-FANDOM-MHA-DISCOVERY/);
});

test('supervisor_exchange persists fan-out and ACKs without running heavy processing inline', async () => {
  const source = await read('lib/supervisor-plan-engine.ts');
  const exchange = source.slice(source.indexOf('export async function supervisorExchange'), source.indexOf('export async function executeUntilDivergence'));
  assert.match(exchange, /createPlan/);
  assert.match(exchange, /createBranchesForPlan/);
  assert.match(exchange, /ack_immediate:true/);
  assert.match(exchange, /background_execution:true/);
  assert.doesNotMatch(exchange, /processAutomaticProject\(/);
  assert.doesNotMatch(exchange, /executeCollection\(/);
  assert.doesNotMatch(exchange, /materializeBatch\(/);
});

test('plan tick delegates data-plane work to internal dispatcher outside supervisor exchange', async () => {
  const source = await read('lib/supervisor-plan-engine.ts');
  const dispatcher = await read('lib/internal-worker-dispatcher.ts');
  const tick = source.slice(source.indexOf('export async function runSupervisorPlansTick'));
  assert.match(tick, /runInternalWorkerDispatcher\(/);
  assert.match(dispatcher, /processAutomaticProject\(/);
  assert.match(dispatcher, /max_qa_backlog: 40/);
  assert.match(source, /ensureCandidateBuffer/);
});

test('V60 MCP exposes plan hot path and keeps it low risk/idempotent', async () => {
  const tools = await read('lib/mcp-tools.ts');
  const policy = await read('lib/mcp-risk-policy.ts');
  const route = await read('app/mcp/route.ts');
  for (const name of ['supervisor_exchange','executar_ate_divergencia','obter_work_packet','obter_status_plano','obter_excecoes_plano','executar_tick_planos','obter_plano_roteamento_fonte']) {
    assert.match(tools, new RegExp(`tool\\("${name}"`));
  }
  for (const name of ['supervisor_exchange','executar_ate_divergencia','executar_tick_planos','pausar_plano','retomar_plano','cancelar_plano']) assert.match(policy, new RegExp(`"${name}"`));
  assert.match(policy, /policyVersion: "V61"/);
  assert.match(route, /version: "6\.1\.9"/);
  assert.match(route, /1 comando do Supervisor cria um SUPERVISOR_PLAN/);
});

test('project deletion removes V60 foreign-key state before deleting project', async () => {
  const source = await read('lib/automatic-projects.ts');
  const block = source.slice(source.indexOf('export async function deleteAutomaticProjects'));
  const iBranches = block.indexOf('db.delete(planBranches)');
  const iRouting = block.indexOf('db.delete(sourceRoutingPlans)');
  const iPlans = block.indexOf('db.delete(supervisorPlans)');
  const iProject = block.indexOf('db.delete(automaticProjects)');
  assert.ok(iBranches >= 0 && iRouting >= 0 && iPlans >= 0 && iProject >= 0);
  assert.ok(iBranches < iProject && iRouting < iProject && iPlans < iProject);
});
