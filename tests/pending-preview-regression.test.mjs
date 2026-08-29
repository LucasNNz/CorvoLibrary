import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const source = (relative) => readFile(new URL(`../${relative}`, import.meta.url), "utf8");

test("file preview streams the existing R2 object with MIME and range support", async () => {
  const route = await source("app/api/files/[id]/route.ts");
  assert.match(route, /resolveMediaMime\(asset\.mimeType, asset\.originalName, asset\.r2Key\)/);
  assert.match(route, /env\.BUCKET\.head/);
  assert.match(route, /env\.BUCKET\.get/);
  assert.match(route, /content-range/);
  assert.match(route, /accept-ranges/);
  assert.doesNotMatch(route, /createSignedR2GetUrl|Response\.redirect/);
});

test("future raw R2 synchronization persists inferred media MIME", async () => {
  const tools = await source("lib/mcp-tools.ts");
  const start = tools.indexOf('case "sincronizar_r2"');
  const end = tools.indexOf('case "obter_link_download"', start);
  const body = tools.slice(start, end);
  assert.match(body, /resolveMediaMime\("application\/octet-stream", originalName, object\.key\)/);
  assert.match(body, /kindFromMediaMime\(mimeType\)/);
});
