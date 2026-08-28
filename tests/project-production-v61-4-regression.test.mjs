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

test('V61.9 thumbnail production keeps URL/R2 ingestion, SHA reuse and no chat-file URL on the THUMB MCP surface', async () => {
  const source = await read('lib/project-production-package.ts');
  const tools = await read('lib/mcp-tools.ts');
  assert.match(source, /pushProjectThumbnailUrlBatch/);
  assert.match(source, /registerProjectThumbnailExistingR2/);
  assert.match(source, /MAX_BATCH_ITEMS = 20/);
  assert.match(source, /FETCH_TIMEOUT_MS = 12_000/);
  assert.match(source, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(source, /eq\(assets\.sha256, sha256\)/);
  assert.match(source, /sameProjectFile\?\.r2Key \|\| catalogAsset\?\.r2Key \|\| uploadedR2Key/);
  assert.doesNotMatch(tools, /tool\("fast_push_thumb_arquivo"/);
  assert.match(tools, /tool\("fast_push_generated_media"/);
  assert.match(tools, /tool\("preparar_upload_midia"/);
  assert.match(tools, /tool\("confirmar_upload_midia"/);
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

test('V61.9 complete production export still contains all required production artifacts and is reusable by package queue', async () => {
  const source = await read('lib/project-production-package.ts');
  const packages = await read('lib/delivery-packages.ts');
  for (const token of ['ROTEIRO.txt','IMAGENS_NECESSARIAS.txt','IMAGENS/','THUMBS/','TITULOS.txt','PROJETO.json']) assert.match(source, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(source, /production\/exports/);
  assert.match(source, /productionZipRevision: project\.productionRevision/);
  assert.match(source, /SELECIONADA-/);
  assert.match(source, /agentes_que_contribuiram/);
  assert.match(packages, /project\.productionZipR2Key && project\.productionZipRevision === revision/);
  const automatic = await read('lib/automatic-projects.ts');
  const performance = await read('lib/performance-control.ts');
  assert.match(automatic, /productionRevision: sql`\$\{automaticProjects\.productionRevision\} \+ 1`/);
  assert.match(performance, /productionRevision: sql`\$\{automaticProjects\.productionRevision\} \+ 1`/);
});

test('V61.9 MCP exposes links-only THUMB ingress/QA and asynchronous final-package egress', async () => {
  const tools = await read('lib/mcp-tools.ts');
  for (const name of ['fast_push_generated_media','importar_midia_por_url','preparar_upload_midia','confirmar_upload_midia','obter_thumbs_links','fast_decidir_thumbs_lote','gerar_pacote_final','listar_pacotes_prontos_para_download','obter_link_download_pacote','confirmar_download_pacote','exportar_projeto_completo_zip']) {
    assert.match(tools, new RegExp(`tool\\("${name}"`));
    assert.match(tools, new RegExp(`case "${name}"`));
  }
  assert.doesNotMatch(tools, /tool\("fast_push_thumb_arquivo"/);
  assert.match(tools, /exportar_projeto_completo_zip[\s\S]*queueFinalPackage/);
  const risk = await read('lib/mcp-risk-policy.ts');
  for (const name of ['fast_push_generated_media','confirmar_upload_midia','gerar_pacote_final','confirmar_download_pacote']) assert.match(risk, new RegExp(`"${name}"`));
  const mcp = await read('app/mcp/route.ts');
  assert.match(mcp, /FAST PUSH THUMB por arquivo do chat está desativado/);
  assert.match(mcp, /gerar_pacote_final → listar_pacotes_prontos_para_download → obter_link_download_pacote → confirmar_download_pacote/);
  assert.match(mcp, /version: "6\.1\.9"/);
});

test('V61.9 owner API blocks multipart THUMB bytes and uses direct R2 upload plus async package queue', async () => {
  const route = await read('app/api/projects/[id]/production/route.ts');
  const page = await read('app/page.tsx');
  assert.match(route, /LINKS_ONLY_THUMB_UPLOAD/);
  assert.match(route, /prepareMediaUpload/);
  assert.match(route, /confirmMediaUpload/);
  assert.match(route, /pushProjectThumbnailUrlBatch/);
  assert.match(route, /pushProjectTitles/);
  assert.match(route, /decideProjectThumbnails/);
  assert.match(route, /decideProjectTitles/);
  assert.match(route, /queueFinalPackage/);
  assert.match(route, /wakeDataPlane/);
  assert.match(page, /PACOTE DE PRODUÇÃO/);
  assert.match(page, /productionDecision/);
  assert.match(page, /production_zip_current/);
  assert.match(page, /READY_FOR_DOWNLOAD/);
});
