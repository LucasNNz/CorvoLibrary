import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');

test('V61.6 supervisor QA mutation is a durable FAST ACK instead of inline freeze', async () => {
  const tools = await read('lib/mcp-tools.ts');
  const fast = await read('lib/fast-supervisor-decisions.ts');
  assert.match(tools, /case "aplicar_decisoes_supervisor_lote"/);
  assert.match(tools, /enqueueSupervisorDecisionBatch/);
  assert.match(tools, /slice\(0,\s*200\)/);
  assert.match(fast, /fast_ack:\s*true/);
  assert.match(fast, /phase:\s*"QUEUED"|ackPayload\([^)]*"QUEUED"/);
  assert.match(fast, /recovery:\s*\{\s*tool:\s*"obter_resultado_operacao"/);
  // Freeze/catalog QA is deliberately isolated in the worker-side job processor.
  assert.match(fast, /async function processClaim[\s\S]*qaAutomaticProject/);
});

test('operation receipt and supervisor decision job are persisted atomically and idempotently', async () => {
  const fast = await read('lib/fast-supervisor-decisions.ts');
  const migration = await read('drizzle/0022_fast_supervisor_decision_ack.sql');
  assert.match(fast, /await db\.batch\(\[/);
  assert.match(fast, /db\.insert\(operationResults\)/);
  assert.match(fast, /db\.insert\(supervisorDecisionJobs\)/);
  assert.match(fast, /OPERATION_ID_ALREADY_USED_BY/);
  assert.match(fast, /idempotent_replay:\s*true/);
  assert.match(migration, /CREATE TABLE\s+supervisor_decision_jobs/);
  assert.match(migration, /operation_id\s+text\s+NOT NULL\s+UNIQUE/i);
  assert.match(migration, /idx_supervisor_decision_jobs_status_created/);
});

test('worker resumes durable decision jobs through waitUntil/external MCP scheduler data plane', async () => {
  const dataPlane = await read('lib/data-plane.ts');
  assert.match(dataPlane, /processSupervisorDecisionJobs/);
  assert.match(dataPlane, /FAST_DECISIONS/);
  assert.match(dataPlane, /needs_reschedule/);
  assert.match(dataPlane, /waitUntil\(pumpDataPlane/);
});

test('finalization is sliced and approvals for distinct PITEMs can run concurrently', async () => {
  const fast = await read('lib/fast-supervisor-decisions.ts');
  const materializer = await read('lib/materializer.ts');
  assert.match(fast, /const DECISION_SLICE = 12/);
  assert.match(fast, /const JOB_LEASE_MS = 45_000/);
  assert.match(fast, /const MAX_ATTEMPTS = 5/);
  assert.match(fast, /"PROCESSING"/);
  assert.match(fast, /"RETRYING"/);
  assert.match(fast, /"COMPLETED"/);
  assert.match(materializer, /qaParallelism|parallelism|Math\.min\(8/i);
});

test('project deletion removes queued decision jobs before project FK row', async () => {
  const projects = await read('lib/automatic-projects.ts');
  const jobDelete = projects.indexOf('db.delete(supervisorDecisionJobs)');
  const projectDelete = projects.indexOf('db.delete(automaticProjects)');
  assert.ok(jobDelete >= 0, 'expected supervisorDecisionJobs cleanup');
  assert.ok(projectDelete >= 0, 'expected automaticProjects cleanup');
  assert.ok(jobDelete < projectDelete, 'decision jobs must be deleted before project');
});
