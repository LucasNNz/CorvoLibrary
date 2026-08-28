import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const root=new URL('../',import.meta.url); const read=(p)=>readFile(new URL(p,root),'utf8');

test('workspace migration creates gaps policies events and seeds safe learned policies',async()=>{
  const sql=await read('drizzle/0017_operational_policy_workspace.sql');
  for(const table of ['operational_gaps','operational_policies','operational_policy_events']) assert.match(sql,new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  assert.match(sql,/ANIME_BLOCK_POKEAPI_NON_POKEMON/);
  assert.match(sql,/GLOBAL_SKIP_NOT_CONFIGURED/);
  assert.match(sql,/operational_policy_cache_ttl_ms/);
});

test('workspace keeps core rules immutable and uses scope precedence',async()=>{
  const source=await read('lib/operational-policy-workspace.ts');
  assert.match(source,/CORE_RULES/);
  assert.match(source,/CORE_RULE_IMMUTABLE/);
  assert.match(source,/ITEM:9/);
  assert.match(source,/GLOBAL:1/);
  assert.match(source,/loadActiveOperationalPolicies/);
  assert.match(source,/policyCache/);
});

test('source routing resolves learned policies before score/fanout',async()=>{
  const source=await read('lib/source-routing.ts');
  assert.match(source,/resolveOperationalPolicies/);
  assert.match(source,/policyResolution\.block_source/);
  assert.ok(source.indexOf('policyResolution.block_source') < source.indexOf('const score = routeScore'));
  assert.match(source,/detectOperationalGap/);
});

test('MCP exposes operational learning lifecycle and global promotion gate',async()=>{
  const tools=await read('lib/mcp-tools.ts');
  const workspace=await read('lib/operational-policy-workspace.ts');
  for(const name of ['detectar_gap_operacional','criar_politica_operacional','testar_politica_operacional','ativar_politica_operacional','promover_politica_operacional','rollback_politica_operacional','obter_politicas_aplicadas','resolver_gap_e_aprender']) assert.match(tools,new RegExp(`tool\\("${name}"`));
  assert.match(workspace,/GLOBAL_PROMOTION_REQUIRES_EXPLICIT_GATE/);
  assert.match(workspace,/POLICY_DRY_RUN/);
  assert.match(workspace,/POLICY_ROLLED_BACK/);
});

test('project deletion removes workspace foreign-key rows before project',async()=>{
  const source=await read('lib/automatic-projects.ts');
  const block=source.slice(source.indexOf('export async function deleteAutomaticProjects'));
  for(const name of ['operationalPolicyEvents','operationalPolicies','operationalGaps']) assert.match(block,new RegExp(`db\\.delete\\(${name}\\)`));
  assert.ok(block.indexOf('db.delete(operationalPolicyEvents)') < block.indexOf('db.delete(automaticProjects)'));
});

test('UI includes policies workspace backed by local API',async()=>{
  const page=await read('app/page.tsx'); const route=await read('app/api/policies/route.ts');
  assert.match(page,/Políticas operacionais/);
  assert.match(page,/Memória de gaps/);
  assert.match(page,/CORE_RULES/);
  assert.match(route,/getOperationalPolicyWorkspaceDashboard/);
});
