import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = (p) => readFile(new URL(p, root), 'utf8');

test('source routing hard-filters domain/universe/config before scoring', async () => {
  const source = await read('lib/source-routing.ts');
  assert.match(source, /SOURCE_NOT_CONFIGURED/);
  assert.match(source, /DOMAIN_MISMATCH/);
  assert.match(source, /UNIVERSE_MISMATCH/);
  assert.match(source, /COMPOSITION_CLASS_MISMATCH/);
  assert.match(source, /PokeAPI|pokeapi/i);
  assert.match(source, /projectDomain === "ANIME"/);
  assert.ok(source.indexOf('if (baseReason)') < source.indexOf('const score = routeScore'));
});

test('discovery and materialization capabilities are separate', async () => {
  const source = await read('lib/source-routing.ts');
  assert.match(source, /source\.canMaterialize !== false/);
  assert.match(source, /!source\.canDiscover/);
  assert.match(source, /DISCOVERY_CAPABILITY_MISSING/);
  assert.match(source, /materialization\.push\(row\)/);
});

test('generic image sources are fallback for anime rather than first route', async () => {
  const source = await read('lib/source-routing.ts');
  assert.match(source, /BROAD_GENERIC/);
  assert.match(source, /isBroadFallback/);
  assert.match(source, /allowGenericFallback/);
  const collector = await read('lib/auto-collector.ts');
  assert.match(collector, /allowGenericFallback:term\.rounds >= 2/);
  assert.match(collector, /buildSourceRoutingPlan/);
});

test('Naruto direct discovery adapter exists without Brave dependency', async () => {
  const sql = await read('drizzle/0016_supervisor_plans_fanout_source_routing.sql');
  const naruto = sql.slice(sql.indexOf('SRC-FANDOM-NARUTO-DISCOVERY'), sql.indexOf('SRC-FANDOM-MHA-DISCOVERY'));
  assert.match(naruto, /ANIME/);
  assert.match(naruto, /can_discover|1/);
  assert.match(naruto, /naruto\.fandom\.com/);
  assert.doesNotMatch(naruto, /BRAVE_API_KEY/);
});

test('routing gaps are configuration/capability gaps, not false semantic no-source', async () => {
  const collector = await read('lib/auto-collector.ts');
  assert.match(collector, /ROUTING_CONFIGURATION_GAP/);
  const routing = await read('lib/source-routing.ts');
  assert.match(routing, /DISCOVERY_ADAPTER_MISSING/);
  assert.match(routing, /FALLBACK_ONLY/);
});
