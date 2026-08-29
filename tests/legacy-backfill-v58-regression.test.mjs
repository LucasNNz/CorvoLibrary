import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const source = (relative) => readFile(new URL(relative, root), "utf8");

test("V58 migration backfills active version, counters and Naruto domain without deleting assets", async () => {
  const sql = await source("drizzle/0014_legacy_backfill_safe_lease.sql");
  assert.match(sql,/MAX\(i\.version\)/);
  assert.match(sql,/project_domain = 'ANIME'/);
  assert.match(sql,/NARUTO/);
  for (const field of ["total_items","approved_count","frozen_count","waiting_qa_count","relink_count","pending_count","state_version"]) assert.match(sql,new RegExp(field));
  assert.doesNotMatch(sql,/DELETE FROM|DROP TABLE|DROP COLUMN/i);
});

test("legacy runtime backfill can reconstruct canonical items from stored REQUIREMENTS without starting search", async () => {
  const projects = await source("lib/automatic-projects.ts");
  const start = projects.indexOf("export async function backfillAutomaticProjectItemsFromFiles");
  const end = projects.indexOf("export async function startAutomaticProject",start);
  const body = projects.slice(start,end);
  assert.match(body,/readTextFile\(files\.requirements\)/);
  assert.match(body,/parseProjectRequirements/);
  assert.match(body,/prepareVersionItems/);
  assert.doesNotMatch(body,/resolveProjectFromLibrary|executeCollection|createCollectionBatch/);
});

test("Supervisor acquisition is explicitly low-risk reversible and idempotent", async () => {
  const tools = await source("lib/mcp-tools.ts");
  const policy = await source("lib/mcp-risk-policy.ts");
  const line = tools.split("\n").find((row)=>row.includes('tool("assumir_proximo_trabalho_supervisor"')) || "";
  assert.match(line,/corvo\/reversible/);
  assert.match(line,/corvo\/leaseOnly/);
  assert.match(line,/corvo\/autoUseAllowed/);
  assert.match(policy,/"assumir_proximo_trabalho_supervisor"/);
  assert.match(policy,/"backfill_projetos_legados"/);
  assert.match(tools,/tool\("backfill_projetos_legados"/);
  assert.match(tools,/case "backfill_projetos_legados"/);
});

test("V59 Supervisor acquisition returns the lease on a fast path while legacy repair stays independently available", async () => {
  const tools = await source("lib/mcp-tools.ts");
  const start = tools.indexOf('case "assumir_proximo_trabalho_supervisor"');
  const end = tools.indexOf('case "backfill_projetos_legados"',start);
  const body = tools.slice(start,end);
  assert.match(body,/lease_fast_path:\s*true/);
  assert.doesNotMatch(body,/backfillAutomaticProjectItemsFromFiles|backfillLegacyProjects|syncWorkerQueue|reconcileAutomaticProject/);
  assert.match(tools,/case "backfill_projetos_legados"/);
  assert.match(tools,/backfillAutomaticProjectItemsFromFiles/);
  assert.match(tools,/backfillLegacyProjects/);
});
