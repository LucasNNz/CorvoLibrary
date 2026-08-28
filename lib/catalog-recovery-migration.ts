import { createHash } from "node:crypto";
import { getLibsqlClient } from "./platform/runtime";
import { ensureBootstrapSettingsTable } from "./bootstrap-db";
import { ensureCurrentApplicationSchema, CURRENT_SCHEMA_TABLE_COUNT } from "./current-schema-bootstrap";

type SourceAsset = {
  id?: unknown;
  name?: unknown;
  universe?: unknown;
  kind?: unknown;
  subject?: unknown;
  status?: unknown;
  previousStatus?: unknown;
  tags?: unknown;
  r2Key?: unknown;
  originalName?: unknown;
  mimeType?: unknown;
  sizeBytes?: unknown;
  sha256?: unknown;
  semanticFamily?: unknown;
  useCount?: unknown;
  projectOrigin?: unknown;
  scriptReference?: unknown;
  visualReference?: unknown;
  sourceUrl?: unknown;
  operationalNote?: unknown;
  qaStatus?: unknown;
  lastUsedAt?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
};

type CatalogRecoveryPayload = {
  assets?: unknown;
  stats?: Record<string, unknown>;
  returned?: unknown;
  limit?: unknown;
};

type NormalizedAsset = {
  id: string;
  name: string;
  universe: string;
  kind: string;
  subject: string | null;
  status: string;
  previousStatus: string | null;
  tags: string;
  r2Key: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string | null;
  semanticFamily: string | null;
  useCount: number;
  projectOrigin: string | null;
  scriptReference: string | null;
  visualReference: string | null;
  sourceUrl: string | null;
  operationalNote: string | null;
  qaStatus: string;
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

function text(value: unknown, fallback = "") {
  return typeof value === "string" ? value.trim() || fallback : fallback;
}

function nullableText(value: unknown) {
  if (value === null || value === undefined) return null;
  const result = String(value).trim();
  return result ? result : null;
}

function finiteInt(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : fallback;
}

function timestamp(value: unknown, fallback: number | null) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeTags(value: unknown) {
  if (Array.isArray(value)) return JSON.stringify(value.map((item) => String(item)));
  if (typeof value !== "string" || !value.trim()) return "[]";
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? JSON.stringify(parsed) : JSON.stringify([String(parsed)]);
  } catch {
    return JSON.stringify(value.split(/[|,]/).map((item) => item.trim()).filter(Boolean));
  }
}

function normalizeAsset(value: SourceAsset, index: number): NormalizedAsset {
  const now = Date.now();
  const id = text(value.id);
  const r2Key = text(value.r2Key);
  if (!id) throw new Error(`CATALOG_RECOVERY_ASSET_ID_REQUIRED:${index}`);
  if (!r2Key) throw new Error(`CATALOG_RECOVERY_R2_KEY_REQUIRED:${id}`);
  const originalName = text(value.originalName, r2Key.split("/").pop() || `${id}.bin`);
  const createdAt = timestamp(value.createdAt, now) ?? now;
  const updatedAt = timestamp(value.updatedAt, createdAt) ?? createdAt;
  return {
    id,
    name: text(value.name, originalName),
    universe: text(value.universe, "Sem universo"),
    kind: text(value.kind, "Imagem"),
    subject: nullableText(value.subject),
    status: text(value.status, "Pendente"),
    previousStatus: nullableText(value.previousStatus),
    tags: normalizeTags(value.tags),
    r2Key,
    originalName,
    mimeType: text(value.mimeType, "application/octet-stream"),
    sizeBytes: finiteInt(value.sizeBytes),
    sha256: nullableText(value.sha256),
    semanticFamily: nullableText(value.semanticFamily),
    useCount: finiteInt(value.useCount),
    projectOrigin: nullableText(value.projectOrigin),
    scriptReference: nullableText(value.scriptReference),
    visualReference: nullableText(value.visualReference),
    sourceUrl: nullableText(value.sourceUrl),
    operationalNote: nullableText(value.operationalNote),
    qaStatus: text(value.qaStatus, "NAO_AVALIADO"),
    lastUsedAt: timestamp(value.lastUsedAt, null),
    createdAt,
    updatedAt,
  };
}

function validatePayload(payload: CatalogRecoveryPayload) {
  if (!Array.isArray(payload.assets) || payload.assets.length === 0) throw new Error("CATALOG_RECOVERY_ASSETS_REQUIRED");
  if (payload.assets.length > 5000) throw new Error("CATALOG_RECOVERY_TOO_MANY_ASSETS");
  const assets = payload.assets.map((asset, index) => normalizeAsset((asset || {}) as SourceAsset, index));
  const ids = new Set<string>();
  for (const asset of assets) {
    if (ids.has(asset.id)) throw new Error(`CATALOG_RECOVERY_DUPLICATE_ID:${asset.id}`);
    ids.add(asset.id);
  }
  const expected = finiteInt(payload.stats?.totalAssets ?? payload.returned, assets.length);
  if (expected !== assets.length) throw new Error(`CATALOG_RECOVERY_COUNT_MISMATCH:expected=${expected}:received=${assets.length}`);
  return { assets, expected, sourceStats: payload.stats || {} };
}

async function targetCatalogIds() {
  const client = getLibsqlClient();
  try {
    const result = await client.execute("SELECT id FROM assets");
    return result.rows.map((row) => String(row.id)).filter(Boolean);
  } catch {
    return [];
  }
}

function insertStatement(asset: NormalizedAsset) {
  return {
    sql: `INSERT INTO assets (
      id,name,universe,kind,subject,status,previous_status,tags,r2_key,original_name,mime_type,size_bytes,sha256,semantic_family,use_count,
      project_origin,script_reference,visual_reference,source_url,operational_note,qa_status,last_used_at,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name,universe=excluded.universe,kind=excluded.kind,subject=excluded.subject,status=excluded.status,previous_status=excluded.previous_status,
      tags=excluded.tags,r2_key=excluded.r2_key,original_name=excluded.original_name,mime_type=excluded.mime_type,size_bytes=excluded.size_bytes,sha256=excluded.sha256,
      semantic_family=excluded.semantic_family,use_count=excluded.use_count,project_origin=excluded.project_origin,script_reference=excluded.script_reference,
      visual_reference=excluded.visual_reference,source_url=excluded.source_url,operational_note=excluded.operational_note,qa_status=excluded.qa_status,
      last_used_at=excluded.last_used_at,created_at=excluded.created_at,updated_at=excluded.updated_at`,
    args: [
      asset.id, asset.name, asset.universe, asset.kind, asset.subject, asset.status, asset.previousStatus, asset.tags, asset.r2Key, asset.originalName,
      asset.mimeType, asset.sizeBytes, asset.sha256, asset.semanticFamily, asset.useCount, asset.projectOrigin, asset.scriptReference, asset.visualReference,
      asset.sourceUrl, asset.operationalNote, asset.qaStatus, asset.lastUsedAt, asset.createdAt, asset.updatedAt,
    ],
  };
}

async function catalogStats() {
  const client = getLibsqlClient();
  const result = await client.execute(`SELECT
    COUNT(*) AS totalAssets,
    SUM(CASE WHEN status='Aprovado' THEN 1 ELSE 0 END) AS catalogAssets,
    COUNT(DISTINCT CASE WHEN status='Aprovado' THEN universe END) AS universes,
    SUM(CASE WHEN status LIKE 'Pendente%' THEN 1 ELSE 0 END) AS pending,
    SUM(CASE WHEN status='Rejeitado' THEN 1 ELSE 0 END) AS rejected,
    SUM(CASE WHEN status='Aprovado' AND use_count>0 THEN 1 ELSE 0 END) AS reused,
    SUM(CASE WHEN status='Aprovado' THEN use_count ELSE 0 END) AS totalUses
    FROM assets`);
  const row = result.rows[0] || {};
  return Object.fromEntries(["totalAssets","catalogAssets","universes","pending","rejected","reused","totalUses"].map((key) => [key, Number((row as Record<string, unknown>)[key] || 0)]));
}

export async function getCatalogRecoveryPreflight() {
  await ensureBootstrapSettingsTable();
  const client = getLibsqlClient();
  const tables = await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  const ids = await targetCatalogIds();
  let marker: Record<string, unknown> | null = null;
  try {
    const result = await client.execute({ sql:"SELECT value FROM settings WHERE key='catalog_recovery_v1' LIMIT 1", args:[] });
    marker = result.rows[0]?.value ? JSON.parse(String(result.rows[0].value)) as Record<string, unknown> : null;
  } catch { marker = null; }
  return { ready:true, currentAssets:ids.length, tableCount:tables.rows.length, marker };
}

export async function importRecoveredCatalog(payload: CatalogRecoveryPayload) {
  await ensureBootstrapSettingsTable();
  const validated = validatePayload(payload);
  await ensureCurrentApplicationSchema();

  const targetIds = await targetCatalogIds();
  const sourceIds = new Set(validated.assets.map((asset) => asset.id));
  const extras = targetIds.filter((id) => !sourceIds.has(id));
  if (extras.length) throw new Error(`CATALOG_TARGET_HAS_EXTRA_ASSETS:${extras.slice(0, 10).join(",")}`);

  const client = getLibsqlClient();
  for (let index = 0; index < validated.assets.length; index += 100) {
    const chunk = validated.assets.slice(index, index + 100).map(insertStatement);
    await client.batch(chunk, "write");
  }

  const stats = await catalogStats();
  if (Number(stats.totalAssets) !== validated.expected) {
    throw new Error(`CATALOG_RECOVERY_TARGET_COUNT_MISMATCH:expected=${validated.expected}:target=${stats.totalAssets}`);
  }

  const sourceStats = validated.sourceStats;
  const comparable = ["catalogAssets","universes","pending","rejected","reused","totalUses"];
  const mismatches = comparable.flatMap((key) => {
    if (sourceStats[key] === undefined || sourceStats[key] === null) return [];
    const expected = Number(sourceStats[key]);
    const actual = Number(stats[key]);
    return Number.isFinite(expected) && expected !== actual ? [{ key, expected, actual }] : [];
  });
  if (mismatches.length) throw new Error(`CATALOG_RECOVERY_STATS_MISMATCH:${JSON.stringify(mismatches)}`);

  const canonical = JSON.stringify(validated.assets.map((asset) => ({ id:asset.id, r2Key:asset.r2Key, updatedAt:asset.updatedAt })));
  const fingerprint = createHash("sha256").update(canonical).digest("hex");
  const now = Date.now();
  const marker = {
    version:1,
    mode:"CLEAN_CATALOG_RECOVERY",
    assets:validated.expected,
    stats,
    sourceStats,
    schemaTables:CURRENT_SCHEMA_TABLE_COUNT,
    fingerprint,
    importedAt:new Date(now).toISOString(),
    intentionallySkipped:["asset_usage_rows","automatic_projects","project_execution_state","queues","leases","supervisor_decisions","candidates","materializations","test_runtime_history"],
  };
  await client.execute({
    sql:"INSERT INTO settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
    args:["catalog_recovery_v1", JSON.stringify(marker), now],
  });
  return { ok:true, mode:marker.mode, imported:validated.expected, stats, schemaTables:CURRENT_SCHEMA_TABLE_COUNT, fingerprint, importedAt:marker.importedAt };
}
