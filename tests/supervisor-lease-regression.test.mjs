import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const source = (relative) => readFile(new URL(relative, root), "utf8");

test("migration persists lease, resume and watchdog configuration", async () => {
  const sql = await source("drizzle/0011_supervisor_lease_resume.sql");
  for (const field of [
    "pipeline_status", "next_action", "supervisor_execution_id", "supervisor_lease_started_at",
    "supervisor_last_seen_at", "supervisor_lease_expires_at", "supervisor_status",
    "previous_execution_id", "abandoned_at", "resume_reason", "resumed_at",
  ]) assert.match(sql, new RegExp(field));
  assert.match(sql, /CREATE TABLE IF NOT EXISTS `supervisor_executions`/);
  assert.match(sql, /supervisor_lease_ttl_minutes','10'/);
  assert.match(sql, /supervisor_watchdog_interval_minutes','2'/);
  assert.match(sql, /supervisor_require_execution_id_for_writes','true'/);
  assert.match(sql, /supervisor_allow_old_execution_writes','false'/);
});

test("lease acquisition is compare-and-set and stale writes are blocked", async () => {
  const lease = await source("lib/supervisor-lease.ts");
  assert.match(lease, /supervisor_lease_expires_at < \? OR supervisor_execution_id=\?/);
  assert.match(lease, /throw new Error\(`LEASE_BUSY:/);
  assert.match(lease, /throw new Error\("SUPERVISOR_REPLACED"\)/);
  assert.match(lease, /throw new Error\("LEASE_NOT_OWNED"\)/);
  assert.match(lease, /supervisor_execution_id=\? AND supervisor_status='ATIVO'/);
});

test("watchdog only marks abandonment and never destroys work", async () => {
  const lease = await source("lib/supervisor-lease.ts");
  const start = lease.indexOf("export async function runSupervisorWatchdog");
  const end = lease.indexOf("export async function acquireSupervisorLease", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const body = lease.slice(start, end);
  assert.match(body, /supervisor_status='ABANDONADA'/);
  assert.match(body, /PRONTO_PARA_RETOMADA/);
  assert.match(body, /LEASE_SUPERVISOR_EXPIRADO/);
  assert.doesNotMatch(body, /\.delete\(|DELETE FROM|cancelar|rollback/i);
});

test("MCP exposes assume, watchdog and telemetry and carries execution_id", async () => {
  const tools = await source("lib/mcp-tools.ts");
  for (const name of ["assumir_proximo_trabalho_supervisor", "executar_watchdog_supervisor", "obter_telemetria_leases_supervisor"]) {
    assert.match(tools, new RegExp(`tool\\("${name}"`));
    assert.match(tools, new RegExp(`case "${name}"`));
  }
  assert.match(tools, /const executionField = text\(/);
  assert.match(tools, /requireSupervisorLeaseForWrite/);
  assert.match(tools, /renewSupervisorLease/);
});

test("project deletion removes lease history before project FK row", async () => {
  const projects = await source("lib/automatic-projects.ts");
  const start = projects.indexOf("export async function deleteAutomaticProjects");
  const end = projects.indexOf("export async function getAutomaticProjectLog", start);
  const body = projects.slice(start, end);
  assert.match(body, /db\.delete\(supervisorExecutions\)/);
  const leaseDelete = body.indexOf("db.delete(supervisorExecutions)");
  const projectDelete = body.indexOf("db.delete(automaticProjects)");
  assert.ok(leaseDelete >= 0 && projectDelete > leaseDelete, "supervisor execution history must be removed before project row");
});

test("Vercel recovery route owns watchdogs and MCP route instructs activity heartbeat", async () => {
  const plane = await source("lib/data-plane.ts");
  const recovery = await source("app/api/internal/data-plane/route.ts");
  const route = await source("app/mcp/route.ts");
  assert.match(plane, /runSupervisorWatchdog/);
  assert.match(plane, /runWorkerWatchdog/);
  assert.match(plane, /runDataPlaneRecovery/);
  assert.match(recovery, /MANUAL_RECOVERY/);
  assert.doesNotMatch(recovery, /scheduled\(/);
  assert.match(route, /assumir_proximo_trabalho_supervisor/);
  assert.match(route, /Não faça heartbeat artificial/);
  assert.match(route, /SUPERVISOR_REPLACED/);
  assert.match(route, /LEASE_NOT_OWNED/);
});

test("lease operations remain low-risk while permanent deletion policy stays unchanged", async () => {
  const policy = await source("lib/mcp-risk-policy.ts");
  assert.match(policy, /policyVersion: "V61"/);
  assert.match(policy, /"executar_watchdog_supervisor"/);
  for (const destructive of ["excluir_asset_permanentemente", "excluir_pendentes_permanentemente_em_lote", "limpar_temporarios_lote"]) {
    assert.match(policy, new RegExp(`"${destructive}"`));
  }
  assert.doesNotMatch(policy, /DESTRUCTIVE_TOOLS[\s\S]{0,800}"assumir_proximo_trabalho_supervisor"/);
});
