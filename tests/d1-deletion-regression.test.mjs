import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

async function source(relative) {
  return readFile(new URL(relative, root), "utf8");
}

test("permanent pending deletion uses D1 batch instead of generic transaction", async () => {
  const text = await source("lib/asset-catalog-admin.ts");
  const start = text.indexOf("export async function deleteAssetsPermanently");
  assert.notEqual(start, -1);
  const body = text.slice(start);
  assert.equal(body.includes("db.transaction("), false);
  assert.equal(body.includes("await db.batch(["), true);
  const batch = body.indexOf("await db.batch([");
  const r2 = body.indexOf("await env.BUCKET.delete(key)");
  assert.ok(batch >= 0 && r2 > batch, "R2 cleanup must happen after the D1 batch");
});

test("project deletion uses D1 batch instead of generic transaction", async () => {
  const text = await source("lib/automatic-projects.ts");
  const start = text.indexOf("export async function deleteAutomaticProjects");
  const end = text.indexOf("export async function getAutomaticProjectLog", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const body = text.slice(start, end);
  assert.equal(body.includes("db.transaction("), false);
  assert.equal(body.includes("await db.batch(["), true);
  const batch = body.indexOf("await db.batch([");
  const r2 = body.indexOf("await env.BUCKET.delete(key)");
  assert.ok(batch >= 0 && r2 > batch, "R2 cleanup must happen after the D1 batch");
});
