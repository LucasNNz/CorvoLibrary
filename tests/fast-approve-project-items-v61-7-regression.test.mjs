import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');

test('V61.7 publishes FAST_APPROVE_PROJECT_ITEMS in MCP and API', async () => {
  const tools = await read('lib/mcp-tools.ts');
  const mcpRoute = await read('app/mcp/route.ts');
  const apiRoute = await read('app/api/fast-approve/project-items/route.ts');
  assert.match(tools, /tool\("FAST_APPROVE_PROJECT_ITEMS"/);
  assert.match(tools, /case "FAST_APPROVE_PROJECT_ITEMS"/);
  assert.match(tools, /enqueueFastApproveProjectItems/);
  assert.match(mcpRoute, /FAST_APPROVE_PROJECT_ITEMS/);
  assert.match(apiRoute, /withProjectLease/);
  assert.match(apiRoute, /status:202/);
});

test('FAST_APPROVE_PROJECT_ITEMS persists compact FAST ACK receipt and dedicated job kind', async () => {
  const fast = await read('lib/fast-supervisor-decisions.ts');
  const risk = await read('lib/mcp-risk-policy.ts');
  assert.match(fast, /export async function enqueueFastApproveProjectItems/);
  assert.match(fast, /compact_ack:\s*true/);
  assert.match(fast, /tool:\s*"FAST_APPROVE_PROJECT_ITEMS"/);
  assert.match(fast, /kind:\s*"FAST_APPROVE_PROJECT_ITEMS"/);
  assert.match(fast, /OPERATION_ID_ALREADY_USED_BY/);
  assert.match(fast, /db\.insert\(operationResults\)/);
  assert.match(fast, /db\.insert\(supervisorDecisionJobs\)/);
  assert.match(risk, /"FAST_APPROVE_PROJECT_ITEMS"/);
});

test('worker-side fast approve resolves item+candidate then reuses QA finalization asynchronously', async () => {
  const fast = await read('lib/fast-supervisor-decisions.ts');
  assert.match(fast, /resolveProjectItemBySelector/);
  assert.match(fast, /resolveSupervisorCandidateForApproval/);
  assert.match(fast, /prepareFastApproveSelection/);
  assert.match(fast, /job\.kind === "FAST_APPROVE_PROJECT_ITEMS"/);
  assert.match(fast, /status:\s*"QA_READY"/);
  assert.match(fast, /qaAutomaticProject\(\{ projeto_id: job\.projectId, decisoes: decisions, processar_apos: false \}\)/);
});
