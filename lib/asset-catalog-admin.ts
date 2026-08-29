import { env } from "./platform/runtime";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { getDb } from "../db";
import { assetConsultations, assetUsage, assets, automaticProjectItems, batchAssets } from "../db/schema";

const MAX_BULK_ASSETS = 200;

function cleanIds(input: unknown) {
  const ids = Array.isArray(input) ? input.map((value) => String(value || "").trim()).filter(Boolean) : [];
  return Array.from(new Set(ids)).slice(0, MAX_BULK_ASSETS);
}

export async function getCatalogStats() {
  const db = getDb();
  const [row] = await db.select({
    totalAssets: sql<number>`count(*)`,
    catalogAssets: sql<number>`sum(case when ${assets.status} = 'Aprovado' then 1 else 0 end)`,
    universes: sql<number>`count(distinct case when ${assets.status} = 'Aprovado' then ${assets.universe} end)`,
    pending: sql<number>`sum(case when ${assets.status} like 'Pendente%' then 1 else 0 end)`,
    rejected: sql<number>`sum(case when ${assets.status} = 'Rejeitado' then 1 else 0 end)`,
    reused: sql<number>`sum(case when ${assets.status} = 'Aprovado' and ${assets.useCount} > 0 then 1 else 0 end)`,
    totalUses: sql<number>`sum(case when ${assets.status} = 'Aprovado' then ${assets.useCount} else 0 end)`,
  }).from(assets);
  return {
    totalAssets: Number(row?.totalAssets ?? 0),
    catalogAssets: Number(row?.catalogAssets ?? 0),
    universes: Number(row?.universes ?? 0),
    pending: Number(row?.pending ?? 0),
    rejected: Number(row?.rejected ?? 0),
    reused: Number(row?.reused ?? 0),
    totalUses: Number(row?.totalUses ?? 0),
  };
}

export async function approvePendingAssets(inputIds: unknown, note = "Aprovado em lote") {
  const ids = cleanIds(inputIds);
  if (!ids.length) return { requested: 0, approved: 0, skipped: [], assets: [] };
  const db = getDb();
  const pending = await db.select().from(assets).where(and(inArray(assets.id, ids), like(assets.status, "Pendente%")));
  const pendingIds = pending.map((asset) => asset.id);
  if (pendingIds.length) {
    const now = new Date();
    await db.update(assets).set({
      previousStatus: "Pendente",
      status: "Aprovado",
      qaStatus: "APROVADO",
      operationalNote: sql`case when ${assets.operationalNote} is null or ${assets.operationalNote} = '' then ${note} else ${assets.operationalNote} || char(10) || ${note} end`,
      updatedAt: now,
    }).where(inArray(assets.id, pendingIds));
  }
  const approved = pendingIds.length ? await db.select().from(assets).where(inArray(assets.id, pendingIds)) : [];
  const approvedSet = new Set(pendingIds);
  return { requested: ids.length, approved: pendingIds.length, skipped: ids.filter((id) => !approvedSet.has(id)), assets: approved };
}

export async function deleteAssetsPermanently(inputIds: unknown, options: { pendingOnly?: boolean } = {}) {
  const ids = cleanIds(inputIds);
  if (!ids.length) return { requested: 0, deleted: 0, skipped: [], files: [] };
  const db = getDb();
  const condition = options.pendingOnly
    ? and(inArray(assets.id, ids), like(assets.status, "Pendente%"))
    : inArray(assets.id, ids);
  const rows = await db.select().from(assets).where(condition);
  const deletableIds = rows.map((asset) => asset.id);
  const files = rows.map((asset) => asset.r2Key).filter(Boolean);
  if (deletableIds.length) {
    const now = new Date();
    // Cloudflare D1 does not expose BEGIN/COMMIT through Drizzle's generic
    // transaction() API in this runtime. db.batch() is the D1-native atomic
    // primitive: if any statement fails, the whole database batch rolls back.
    await db.batch([
      db.update(automaticProjectItems).set({ linkedAssetId: null, updatedAt: now }).where(inArray(automaticProjectItems.linkedAssetId, deletableIds)),
      db.delete(assetUsage).where(inArray(assetUsage.assetId, deletableIds)),
      db.delete(assetConsultations).where(inArray(assetConsultations.assetId, deletableIds)),
      db.delete(batchAssets).where(inArray(batchAssets.assetId, deletableIds)),
      db.delete(assets).where(inArray(assets.id, deletableIds)),
    ]);
  }

  // Remove physical objects only after the D1 batch committed. This avoids the
  // old failure mode where R2 was deleted and BEGIN failed, leaving stale rows.
  const r2CleanupFailures: string[] = [];
  for (const key of files) {
    try { await env.BUCKET.delete(key); }
    catch { r2CleanupFailures.push(key); }
  }

  const deletedSet = new Set(deletableIds);
  return {
    requested: ids.length,
    deleted: deletableIds.length,
    skipped: ids.filter((id) => !deletedSet.has(id)),
    files,
    r2_cleanup_failures: r2CleanupFailures,
  };
}
