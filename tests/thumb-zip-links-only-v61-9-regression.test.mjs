import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const read=(file)=>readFile(new URL(`../${file}`,import.meta.url),'utf8');

test('V61.9 THUMB ingress is HTTPS URL or signed direct R2 upload only', async()=>{
  const media=await read('lib/media-delivery.ts');
  const r2=await read('lib/r2-download.ts');
  const tools=await read('lib/mcp-tools.ts');
  assert.match(media,/IMAGE_URL_HTTPS_REQUIRED/);
  assert.match(media,/createSignedR2PutUrl/);
  assert.match(media,/DIRECT_R2_UPLOAD/);
  assert.match(media,/registerProjectThumbnailExistingR2/);
  assert.match(r2,/aws\.sign\(url, \{ method: "PUT"/);
  assert.doesNotMatch(tools,/tool\("fast_push_thumb_arquivo"/);
});

test('V61.9 THUMB QA returns signed preview links and structural resource delivery remains disabled', async()=>{
  const media=await read('lib/media-delivery.ts');
  const industrial=await read('lib/industrial-supervisor.ts');
  const mcp=await read('app/mcp/route.ts');
  assert.match(media,/preview_signed_url/);
  assert.match(media,/mode: "LINKS_ONLY"/);
  assert.match(industrial,/mcp_file_resource_delivery: "DISABLED"/);
  assert.match(industrial,/return false;/);
  assert.match(mcp,/resourceDeliveryEnabled \? resources\.flatMap/);
});

test('V61.9 final ZIP uses an asynchronous idempotent package queue stored in R2', async()=>{
  const packages=await read('lib/delivery-packages.ts');
  const plane=await read('lib/data-plane.ts');
  const migration=await read('drizzle/0023_links_only_thumb_delivery.sql');
  for(const token of ['QUEUED','PROCESSING','READY_FOR_DOWNLOAD','DOWNLOADED','FAILED','SKIPPED_ALREADY_CLAIMED','RECOVERED_STALE_PROCESSING']) assert.match(packages,new RegExp(token));
  assert.match(packages,/project_id=\? AND project_revision=\? AND type=\?/);
  assert.match(packages,/createSignedR2GetUrl/);
  assert.match(packages,/direct_to_pc: true/);
  assert.match(packages,/PACKAGE_DOWNLOAD_CONFIRM_CONFLICT/);
  assert.match(plane,/processQueuedDownloadPackages/);
  assert.match(migration,/CREATE TABLE IF NOT EXISTS download_packages/);
  assert.match(migration,/sha256_verified integer/);
  assert.match(migration,/download_packages_revision_idx/);
});

test('V61.9 package link and confirmation never return MCP file resources', async()=>{
  const packages=await read('lib/delivery-packages.ts');
  const tools=await read('lib/mcp-tools.ts');
  assert.match(packages,/chat_file_delivery: "DISABLED"/);
  assert.match(tools,/listar_pacotes_prontos_para_download[\s\S]*Não retorna arquivo nem resource_link/);
  assert.match(tools,/obter_link_download_pacote[\s\S]*URL R2 assinada fresca/);
  assert.match(tools,/confirmar_download_pacote/);
});
