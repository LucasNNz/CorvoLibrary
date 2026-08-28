import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = (p) => readFile(new URL(p, root), 'utf8');

test('V61.4 migration and schema add the central production package without replacing project items', async () => {
  const migration = await read('drizzle/0021_project_production_package.sql');
  const schema = await read('db/schema.ts');
  for (const token of ['production_revision','production_zip_revision','production_zip_r2_key','project_production_assets','project_title_candidates']) assert.match(migration, new RegExp(token));
  assert.match(schema, /projectProductionAssets/);
  assert.match(schema, /projectTitleCandidates/);
  assert.match(schema, /productionRevision/);
  assert.match(schema, /productionZipRevision/);
  assert.match(schema, /automaticProjectItems/);
});

test('V61.4 thumbnail push supports URL primary route, chat bytes secondary route and SHA/R2 reuse', async () => {
  const source = await read('lib/project-production-package.ts');
  assert.match(source, /pushProjectThumbnailUrlBatch/);
  assert.match(source, /pushProjectThumbnailFileBytes/);
  assert.match(source, /MAX_BATCH_ITEMS = 20/);
  assert.match(source, /FETCH_TIMEOUT_MS = 12_000/);
  assert.match(source, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(source, /eq\(assets\.sha256, sha256\)/);
  assert.match(source, /sameProjectFile\?\.r2Key \|\| catalogAsset\?\.r2Key/);
  assert.match(source, /sourceType === "CHAT_FILE" \? `chat-file:\/\//);
  assert.match(source, /THUMB_CANDIDATE/);
});

test('V61.4 titles are structured candidates and decisions keep approval separate from selection', async () => {
  const source = await read('lib/project-production-package.ts');
  assert.match(source, /pushProjectTitles/);
  assert.match(source, /TITLE_CANDIDATE/);
  assert.match(source, /TITLE_APPROVED/);
  assert.match(source, /TITLE_REJECTED/);
  assert.match(source, /type Decision = "APPROVE" \| "REJECT" \| "SELECT"/);
  assert.match(source, /selected: false/);
  assert.match(source, /status = "TITLE_APPROVED"; selected = true/);
  assert.match(source, /IDEMPOTENT_REUSED/);
});

test('V61.4 complete production export is separate and contains all required production artifacts', async () => {
  const source = await read('lib/project-production-package.ts');
  for (const token of ['ROTEIRO.txt','IMAGENS_NECESSARIAS.txt','IMAGENS/','THUMBS/','TITULOS.txt','PROJETO.json']) assert.match(source, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(source, /production\/exports/);
  assert.match(source, /productionZipRevision: project\.productionRevision/);
  assert.match(source, /SELECIONADA-/);
  assert.match(source, /agentes_que_contribuiram/);
  const automatic = await read('lib/automatic-projects.ts');
  const performance = await read('lib/performance-control.ts');
  assert.match(automatic, /productionRevision: sql`\$\{automaticProjects\.productionRevision\} \+ 1`/);
  assert.match(performance, /productionRevision: sql`\$\{automaticProjects\.productionRevision\} \+ 1`/);
});

test('V61.4 MCP exposes agents, decisions and full export on the same project id', async () => {
  const tools = await read('lib/mcp-tools.ts');
  for (const name of ['fast_push_thumbs_url_lote','fast_push_thumb_arquivo','fast_push_titulos','listar_pacote_producao_projeto','decidir_thumbs_projeto','decidir_titulos_projeto','exportar_projeto_completo_zip']) {
    assert.match(tools, new RegExp(`tool\\("${name}"`));
    assert.match(tools, new RegExp(`case "${name}"`));
  }
  assert.match(tools, /createSignedR2GetUrl\(exported\.r2Key/);
  const risk = await read('lib/mcp-risk-policy.ts');
  for (const name of ['fast_push_thumbs_url_lote','fast_push_thumb_arquivo','fast_push_titulos','decidir_thumbs_projeto','decidir_titulos_projeto','exportar_projeto_completo_zip']) assert.match(risk, new RegExp(`"${name}"`));
  const mcp = await read('app/mcp/route.ts');
  assert.match(mcp, /V61\.4 transforma cada project_id em pacote central de produção/);
  assert.match(mcp, /MESMO project_id/);
  assert.match(mcp, /version: "6\.1\.0"/);
});

test('V61.4 owner API and project UI expose thumbs, titles, selection and production ZIP freshness', async () => {
  const route = await read('app/api/projects/[id]/production/route.ts');
  const zipRoute = await read('app/api/projects/[id]/production-zip/route.ts');
  const page = await read('app/page.tsx');
  assert.match(route, /request\.formData\(\)/);
  assert.match(route, /pushProjectThumbnailFileBytes/);
  assert.match(route, /pushProjectThumbnailUrlBatch/);
  assert.match(route, /pushProjectTitles/);
  assert.match(route, /decideProjectThumbnails/);
  assert.match(route, /decideProjectTitles/);
  assert.match(route, /exportCompleteProjectZip/);
  assert.match(zipRoute, /productionZipR2Key/);
  assert.match(page, /PACOTE DE PRODUÇÃO/);
  assert.match(page, /productionDecision/);
  assert.match(page, /production_zip_current/);
  assert.match(page, /Exportar projeto completo/);
});
