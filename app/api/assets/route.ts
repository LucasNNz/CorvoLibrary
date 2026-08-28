import { desc } from "drizzle-orm";
import { getDb } from "../../../db";
import { assets } from "../../../db/schema";
import { approvePendingAssets, deleteAssetsPermanently, getCatalogStats } from "../../../lib/asset-catalog-admin";
import { isOwnerRequest, ownerOnly } from "../../../lib/mcp-access";
import { resolveMediaMime } from "../../../lib/media-mime";

export async function GET(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  const url = new URL(request.url);
  const requestedLimit = Number(url.searchParams.get("limit") || 1000);
  const limit = Math.max(1, Math.min(Number.isFinite(requestedLimit) ? requestedLimit : 1000, 2000));
  const [storedRows, stats] = await Promise.all([
    getDb().select().from(assets).orderBy(desc(assets.createdAt)).limit(limit),
    getCatalogStats(),
  ]);
  const rows = storedRows.map((asset) => ({ ...asset, mimeType: resolveMediaMime(asset.mimeType, asset.originalName, asset.r2Key) }));
  return Response.json({ assets: rows, stats, returned: rows.length, limit });
}

export async function PATCH(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  try {
    const input = await request.json() as { action?: string; asset_ids?: string[] };
    if (input.action !== "approve_pending") return Response.json({ error: "Ação inválida." }, { status: 400 });
    const result = await approvePendingAssets(input.asset_ids, "Aprovado manualmente na aba Pendentes");
    return Response.json({ ...result, stats: await getCatalogStats() });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Falha ao aprovar assets." }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  if (!await isOwnerRequest(request)) return ownerOnly();
  try {
    const input = await request.json() as { asset_ids?: string[]; confirmar?: boolean };
    if (input.confirmar !== true) return Response.json({ error: "Confirmação obrigatória para exclusão permanente." }, { status: 400 });
    const result = await deleteAssetsPermanently(input.asset_ids, { pendingOnly: true });
    return Response.json({ ...result, stats: await getCatalogStats() });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Falha ao excluir assets." }, { status: 400 });
  }
}
