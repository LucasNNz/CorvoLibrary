import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("Next.js root layout carries Corvo Library metadata without legacy Worker dist", async () => {
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts.build, "npm run typecheck && next build");
  assert.match(layout, /title:\s*"Corvo Library"/);
  assert.match(layout, /metadataBase/);
  assert.doesNotMatch(layout, /chatgpt\.site\/og\.png/);
});
