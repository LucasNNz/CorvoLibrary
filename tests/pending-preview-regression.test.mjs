import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const source = (relative) => readFile(new URL(relative, root), "utf8");

test("pending cards recover previews for legacy octet-stream image assets", async () => {
  const page = await source("app/page.tsx");
  assert.match(page, /resolveMediaMime/);
  assert.match(page, /isImageMedia/);
  assert.match(page, /row\.r2Key/);
});

test("file preview route infers content-type from stored filename/key", async () => {
  const route = await source("app/api/files/[id]/route.ts");
  assert.match(route, /resolveMediaMime\(object\.httpMetadata\?\.contentType \|\| asset\.mimeType, asset\.originalName, asset\.r2Key\)/);
});

test("future raw R2 synchronization persists inferred media MIME", async () => {
  const tools = await source("lib/mcp-tools.ts");
  const start = tools.indexOf('case "sincronizar_r2"');
  const end = tools.indexOf('case "obter_link_download"', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const body = tools.slice(start, end);
  assert.match(body, /resolveMediaMime\("application\/octet-stream", originalName, object\.key\)/);
  assert.match(body, /kindFromMediaMime\(mimeType\)/);
});
