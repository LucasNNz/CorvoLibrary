import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../lib/mcp-tools.ts', import.meta.url), 'utf8');
const policy = fs.readFileSync(new URL('../lib/mcp-risk-policy.ts', import.meta.url), 'utf8');
const route = fs.readFileSync(new URL('../app/mcp/route.ts', import.meta.url), 'utf8');

function lineFor(name) {
  return source.split('\n').find((line) => line.includes(`tool("${name}"`)) || '';
}

test('MCP exposes standard risk annotations including idempotency', () => {
  assert.match(source, /idempotentHint: boolean/);
  assert.match(source, /destructiveHint: risk\.riskLevel === "destructive"/);
  assert.match(source, /"corvo\/continuousEligible"/);
  assert.match(source, /"openai\/isConsequential"/);
});

test('routine production tools are not annotated destructive', () => {
  const routine = [
    'buscar_assets',
    'importar_zip_arquivo',
    'importar_midia_arquivo',
    'sincronizar_r2',
    'materializar_url',
    'materializar_lote',
    'adicionar_itens_fila_materializacao',
    'aprovar_pendentes_em_lote',
    'aprovar_candidata',
    'registrar_qa_lote',
    'obter_link_download',
    'obter_links_download_lote',
    'exportar_assets_zip',
    'anexar_arquivo_projeto',
    'baixar_arquivo_projeto',
    'executar_coleta_automatica',
    'continuar_processamento',
    'processar_projeto_automatico',
    'reconciliar_projeto_automatico',
    'cancelar_processamento',
    'cancelar_item',
    'cancelar_lote_materializacao',
    'controlar_lote_coleta',
    'reabrir_projeto_concluido',
    'assumir_proximo_trabalho_supervisor',
    'executar_watchdog_supervisor',
  ];
  for (const name of routine) {
    const line = lineFor(name);
    assert.ok(line, `tool missing: ${name}`);
    assert.doesNotMatch(line, /\), false, true\),?\s*$/, `${name} must not be destructive`);
  }
});

test('only irreversible storage deletions stay explicitly destructive', () => {
  for (const name of ['excluir_asset_permanentemente', 'excluir_pendentes_permanentemente_em_lote', 'limpar_temporarios_lote']) {
    const line = lineFor(name);
    assert.ok(line, `tool missing: ${name}`);
    assert.match(line, /\), false, true\),?\s*$/, `${name} must stay destructive`);
  }
  assert.match(policy, /const DESTRUCTIVE_TOOLS = new Set\(\[/);
  assert.match(policy, /"excluir_asset_permanentemente"/);
  assert.match(policy, /"excluir_pendentes_permanentemente_em_lote"/);
  assert.match(policy, /"limpar_temporarios_lote"/);
});

test('credential configuration stays outside continuous mode', () => {
  assert.match(policy, /const SENSITIVE_TOOLS = new Set\(\[/);
  assert.match(policy, /"configurar_cloudflare"/);
});

test('self-audit and continuous-use MCP instructions are published', () => {
  assert.match(source, /tool\("obter_politica_risco_mcp"/);
  assert.match(source, /case "obter_politica_risco_mcp"/);
  assert.match(route, /version: "6\.1\.0"/);
  assert.match(route, /baixo risco e elegíveis para uso contínuo/);
  assert.match(route, /não peça microconfirmações/);
});
