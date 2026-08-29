import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const source = (relative) => readFile(new URL(relative, root), "utf8");

test("D1 timestamp filters use Drizzle encoders instead of raw Date SQL bindings", async () => {
  const worker = await source("lib/worker-orchestration.ts");
  const performance = await source("lib/performance-control.ts");
  const projects = await source("lib/automatic-projects.ts");

  assert.match(worker, /gte\(workerEvents\.createdAt, new Date\(at-60\*60_000\)\)/);
  assert.doesNotMatch(worker, /sql`\$\{workerEvents\.createdAt\}\s*>=\s*\$\{new Date/);

  // V59: workerEvents saiu do snapshot operacional quente; métricas continuam usando encoder tipado.
  assert.doesNotMatch(performance, /getOperationalSnapshot[\s\S]{0,9000}workerEvents\.createdAt/);
  assert.match(performance, /gte\(mcpAudit\.createdAt, since\)/);
  assert.doesNotMatch(performance, /sql`\$\{(?:workerEvents|mcpAudit)\.createdAt\}\s*>=/);

  assert.match(projects, /lt\(automaticProjects\.updatedAt, cursorDate\)/);
  assert.match(projects, /eq\(automaticProjects\.updatedAt, cursorDate\)/);
  assert.doesNotMatch(projects, /sql`[^`]*automaticProjects\.updatedAt[^`]*new Date/);
});

test("operational dashboard degrades gracefully when historical worker telemetry is unavailable", async () => {
  const worker = await source("lib/worker-orchestration.ts");
  const start = worker.indexOf("export async function getOperationalDashboard");
  const end = worker.indexOf("export async function getManagementDashboard", start);
  const body = worker.slice(start, end);
  assert.match(body, /telemetryWarnings/);
  assert.match(body, /WORKER_EVENTS_UNAVAILABLE/);
  assert.match(body, /db\.select\(\{ eventType: workerEvents\.eventType \}\)/);
  assert.doesNotMatch(body, /db\.select\(\)\.from\(workerEvents\)/);
});
