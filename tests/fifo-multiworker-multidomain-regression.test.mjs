import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const source = (relative) => readFile(new URL(relative, root), "utf8");

test("migration creates granular worker, analytics and multi-domain structures", async () => {
  const sql = await source("drizzle/0012_fifo_multiworker_multidomain_operations.sql");
  for (const table of ["worker_sessions","worker_work_items","worker_events","stage_metrics","queue_snapshots","project_runs","export_jobs","worker_capacity_limits"]) assert.match(sql, new RegExp("CREATE TABLE IF NOT EXISTS `" + table + "`"));
  for (const column of ["project_domain","queue_priority","ready_at","original_ready_at","item_domain","stage_ready_at"]) assert.match(sql, new RegExp(column));
  assert.match(sql, /fifo_enabled','true'/);
  assert.match(sql, /skip_locked','true'/);
  assert.match(sql, /fallback_between_domains','false'/);
});

test("work acquisition is FIFO, skip-locked, atomic and domain aware", async () => {
  const worker = await source("lib/worker-orchestration.ts");
  assert.match(worker, /orderBy\(desc\(workerWorkItems\.priority\), desc\(workerWorkItems\.resumePriority\), asc\(workerWorkItems\.originalReadyAt\), asc\(workerWorkItems\.attempts\), asc\(workerWorkItems\.id\)\)/);
  assert.match(worker, /UPDATE worker_work_items SET status='LEASED'/);
  assert.match(worker, /WHERE id=\? AND status='READY'/);
  assert.match(worker, /if \(!changes\) continue; \/\/ SKIP LOCKED/);
  assert.match(worker, /domainAllowed\(workerDomain, row\.projectDomain, allowedDomains, config\.fallbackBetweenDomains\)/);
  assert.match(worker, /perProject >= Number\(capacity\.maxPerProject/);
});

test("ZIP/export uses an independent EXPORT_JOB work scope", async () => {
  const worker = await source("lib/worker-orchestration.ts");
  assert.match(worker, /scopeType: "EXPORT_JOB"/);
  assert.match(worker, /scopeId: job\.id/);
  assert.match(worker, /candidate\.scopeType === "EXPORT_JOB"/);
  assert.match(worker, /work\.scopeType === "EXPORT_JOB"/);
});

test("expired worker lease requeues only its unit and preserves original queue age", async () => {
  const worker = await source("lib/worker-orchestration.ts");
  const start = worker.indexOf("export async function runWorkerWatchdog");
  const end = worker.indexOf("async function capacityFor", start);
  const body = worker.slice(start, end);
  assert.match(body, /status: config\.requeueExpired \? "READY"/);
  assert.match(body, /resumePriority: 1/);
  assert.match(body, /original_ready_at/);
  assert.doesNotMatch(body, /DELETE FROM|\.delete\(|rollback/i);
});

test("dependency waits are not sent prematurely to collection", async () => {
  const worker = await source("lib/worker-orchestration.ts");
  assert.match(worker, /WAITING_FAMILY_SEED/);
  assert.match(worker, /WAITING_DEPENDENCY/);
  assert.match(worker, /if \(!stage\)/);
});

test("MCP exposes multiworker queue and dashboards", async () => {
  const tools = await source("lib/mcp-tools.ts");
  for (const name of ["assumir_proximo_trabalho","concluir_trabalho_worker","registrar_falha_worker","executar_watchdog_workers","obter_painel_operacional_producao","obter_dashboard_gerencial","configurar_limite_workers","configurar_dominio_projeto","sincronizar_filas_workers","exportar_txt_operacao"]) {
    assert.match(tools, new RegExp(`tool\\("${name}"`));
    assert.match(tools, new RegExp(`case "${name}"`));
  }
});

test("dashboard UI and TXT export are wired to the same operation backend", async () => {
  const page = await source("app/page.tsx");
  const route = await source("app/api/operations/route.ts");
  assert.match(page, /Produção em tempo real/);
  assert.match(page, /Gerencial \/ diretoria/);
  assert.match(page, /\/api\/operations\?view=/);
  assert.match(route, /getOperationalDashboard/);
  assert.match(route, /getManagementDashboard/);
  assert.match(route, /format === "txt"/);
});

test("project deletion removes V55 operational foreign-key rows before project", async () => {
  const projects = await source("lib/automatic-projects.ts");
  const start = projects.indexOf("export async function deleteAutomaticProjects");
  const end = projects.indexOf("export async function getAutomaticProjectLog", start);
  const body = projects.slice(start, end);
  for (const table of ["workerEvents","stageMetrics","projectRuns","exportJobs","workerSessions","workerWorkItems"]) assert.match(body, new RegExp(`db\\.delete\\(${table}\\)`));
  assert.ok(body.indexOf("db.delete(workerWorkItems)") < body.indexOf("db.delete(automaticProjectItems)"));
  assert.ok(body.indexOf("db.delete(automaticProjectItems)") < body.indexOf("db.delete(automaticProjects)"));
});

test("risk policy keeps routine multiworker operations continuous and low-risk", async () => {
  const policy = await source("lib/mcp-risk-policy.ts");
  assert.match(policy, /policyVersion: "V61"/);
  for (const name of ["assumir_proximo_trabalho","concluir_trabalho_worker","registrar_falha_worker","executar_watchdog_workers","sincronizar_filas_workers"]) assert.match(policy, new RegExp(`"${name}"`));
});
