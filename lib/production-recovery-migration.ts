import { createHash } from "node:crypto";
import { getLibsqlClient } from "./platform/runtime";
import { ensureCurrentApplicationSchema, CURRENT_SCHEMA_TABLE_COUNT } from "./current-schema-bootstrap";

const ALLOWED_TABLES = [
  "assets",
  "asset_usage",
  "asset_consultations",
  "requests",
  "imports",
  "batches",
  "batch_assets",
  "collection_sources",
  "source_profiles",
  "source_route_metrics",
  "operational_policies",
  "worker_capacity_limits",
  "semantic_stock_policies",
  "settings",
] as const;

type AllowedTable = (typeof ALLOWED_TABLES)[number];
type Row = Record<string, unknown>;
export type ProductionRecoveryPayload = {
  formatVersion?: unknown;
  source?: unknown;
  snapshot?: Record<string, unknown>;
  tables?: Record<string, unknown>;
  validation?: Record<string, unknown>;
};

const TABLE_LIMITS: Record<AllowedTable, number> = {
  assets: 5000,
  asset_usage: 20000,
  asset_consultations: 10000,
  requests: 5000,
  imports: 5000,
  batches: 5000,
  batch_assets: 20000,
  collection_sources: 1000,
  source_profiles: 1000,
  source_route_metrics: 10000,
  operational_policies: 5000,
  worker_capacity_limits: 1000,
  semantic_stock_policies: 5000,
  settings: 1000,
};

const PROTECTED_SETTING_KEYS = new Set([
  "mcp_connection_code",
  "secret_cloudflare_connection",
  "secret_supervisor_connection",
  "library_auth_v1",
  "library_master_key_v1",
  "cloudflare_connection_manifest_v1",
  "catalog_recovery_v1",
  "production_recovery_v1",
]);

function isProtectedSetting(key: string) {
  return PROTECTED_SETTING_KEYS.has(key) || key.startsWith("library_auth_session:");
}

function rowsFor(payload: ProductionRecoveryPayload, table: AllowedTable): Row[] {
  const raw = payload.tables?.[table];
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`PRODUCTION_RECOVERY_TABLE_INVALID:${table}`);
  if (raw.length > TABLE_LIMITS[table]) throw new Error(`PRODUCTION_RECOVERY_TABLE_TOO_LARGE:${table}:${raw.length}`);
  return raw.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`PRODUCTION_RECOVERY_ROW_INVALID:${table}:${index}`);
    return row as Row;
  });
}

function normalizePayload(payload: ProductionRecoveryPayload) {
  if (Number(payload.formatVersion) !== 1) throw new Error("PRODUCTION_RECOVERY_FORMAT_UNSUPPORTED");
  if (!payload.tables || typeof payload.tables !== "object") throw new Error("PRODUCTION_RECOVERY_TABLES_REQUIRED");
  const tables = Object.fromEntries(ALLOWED_TABLES.map((table) => [table, rowsFor(payload, table)])) as Record<AllowedTable, Row[]>;
  if (!tables.assets.length) throw new Error("PRODUCTION_RECOVERY_ASSETS_REQUIRED");
  const assetIds = tables.assets.map((row) => String(row.id || "")).filter(Boolean);
  if (assetIds.length !== tables.assets.length || new Set(assetIds).size !== assetIds.length) throw new Error("PRODUCTION_RECOVERY_ASSET_IDS_INVALID");
  const usageIds = tables.asset_usage.map((row) => String(row.id || "")).filter(Boolean);
  if (usageIds.length !== tables.asset_usage.length || new Set(usageIds).size !== usageIds.length) throw new Error("PRODUCTION_RECOVERY_USAGE_IDS_INVALID");
  tables.settings = tables.settings.filter((row) => {
    const key = String(row.key || "");
    const value = String(row.value ?? "");
    return Boolean(key) && !isProtectedSetting(key) && value !== "[REDACTED_SECRET]";
  });
  return { tables, source:String(payload.source || "unknown"), snapshot:payload.snapshot || {}, validation:payload.validation || {} };
}

async function tableInfo(table: AllowedTable) {
  const client = getLibsqlClient();
  const result = await client.execute(`PRAGMA table_info("${table}")`);
  const columns = result.rows.map((row) => String(row.name));
  const pk = result.rows
    .filter((row) => Number(row.pk || 0) > 0)
    .sort((a,b) => Number(a.pk || 0) - Number(b.pk || 0))
    .map((row) => String(row.name));
  if (!columns.length || !pk.length) throw new Error(`PRODUCTION_RECOVERY_SCHEMA_INVALID:${table}`);
  return { columns, pk };
}

function upsertStatement(table: AllowedTable, row: Row, columns: string[], pk: string[], conflictMode: "update-existing" | "preserve-existing" = "update-existing") {
  const selected = columns.filter((column) => Object.prototype.hasOwnProperty.call(row, column));
  if (!selected.length) throw new Error(`PRODUCTION_RECOVERY_EMPTY_ROW:${table}`);
  for (const key of pk) if (!selected.includes(key) || row[key] === null || row[key] === undefined || row[key] === "") {
    throw new Error(`PRODUCTION_RECOVERY_PRIMARY_KEY_REQUIRED:${table}:${key}`);
  }
  const escaped = selected.map((column) => `"${column}"`);
  const updates = selected.filter((column) => !pk.includes(column)).map((column) => `"${column}"=excluded."${column}"`);
  const conflict = pk.map((column) => `"${column}"`).join(",");
  const action = conflictMode === "preserve-existing" ? "NOTHING" : (updates.length ? `UPDATE SET ${updates.join(",")}` : "NOTHING");
  const sql = `INSERT INTO "${table}" (${escaped.join(",")}) VALUES (${selected.map(() => "?").join(",")}) ON CONFLICT(${conflict}) DO ${action}`;
  return { sql, args:selected.map((column) => row[column] === undefined ? null : row[column] as never) };
}

async function importTable(table: AllowedTable, rows: Row[], conflictMode: "update-existing" | "preserve-existing") {
  if (!rows.length) return { table, imported:0 };
  const client = getLibsqlClient();
  const info = await tableInfo(table);
  for (let index=0; index<rows.length; index+=75) {
    const chunk = rows.slice(index,index+75).map((row) => upsertStatement(table,row,info.columns,info.pk,conflictMode));
    await client.batch(chunk,"write");
  }
  return { table, imported:rows.length };
}

async function countMatching(table: AllowedTable, key: string, values: string[]) {
  if (!values.length) return 0;
  const client = getLibsqlClient();
  let total=0;
  for (let index=0; index<values.length; index+=200) {
    const chunk=values.slice(index,index+200);
    const result=await client.execute({ sql:`SELECT COUNT(*) AS n FROM "${table}" WHERE "${key}" IN (${chunk.map(()=>"?").join(",")})`, args:chunk });
    total += Number(result.rows[0]?.n || 0);
  }
  return total;
}

async function currentCounts() {
  const client=getLibsqlClient();
  const [assets,usage,tables]=await Promise.all([
    client.execute("SELECT COUNT(*) AS n FROM assets"),
    client.execute("SELECT COUNT(*) AS n FROM asset_usage"),
    client.execute("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"),
  ]);
  return { assets:Number(assets.rows[0]?.n||0), assetUsage:Number(usage.rows[0]?.n||0), schemaTables:Number(tables.rows[0]?.n||0) };
}

export async function getProductionRecoveryPreflight() {
  await ensureCurrentApplicationSchema();
  return { ready:true, ...(await currentCounts()), expectedSchemaTables:CURRENT_SCHEMA_TABLE_COUNT, mode:"NON_DESTRUCTIVE_PRODUCTION_MERGE" };
}

export async function importProductionRecovery(payload: ProductionRecoveryPayload, options: { conflictMode?: "update-existing" | "preserve-existing" } = {}) {
  const normalized=normalizePayload(payload);
  await ensureCurrentApplicationSchema();

  const order: AllowedTable[] = [
    "assets","asset_usage","asset_consultations","requests","imports","batches","batch_assets",
    "collection_sources","source_profiles","source_route_metrics","operational_policies","worker_capacity_limits","semantic_stock_policies","settings",
  ];
  const imported=[];
  const conflictMode = options.conflictMode || "update-existing";
  for (const table of order) imported.push(await importTable(table,normalized.tables[table],conflictMode));

  const assetIds=normalized.tables.assets.map((row)=>String(row.id));
  const usageIds=normalized.tables.asset_usage.map((row)=>String(row.id));
  const [matchedAssets,matchedUsage,counts]=await Promise.all([
    countMatching("assets","id",assetIds),
    countMatching("asset_usage","id",usageIds),
    currentCounts(),
  ]);
  if (matchedAssets!==assetIds.length) throw new Error(`PRODUCTION_RECOVERY_ASSET_VALIDATION_FAILED:${matchedAssets}/${assetIds.length}`);
  if (matchedUsage!==usageIds.length) throw new Error(`PRODUCTION_RECOVERY_USAGE_VALIDATION_FAILED:${matchedUsage}/${usageIds.length}`);
  if (counts.schemaTables!==CURRENT_SCHEMA_TABLE_COUNT) throw new Error(`PRODUCTION_RECOVERY_SCHEMA_COUNT_MISMATCH:${counts.schemaTables}/${CURRENT_SCHEMA_TABLE_COUNT}`);

  const uniqueR2Keys=new Set(normalized.tables.assets.map((row)=>String(row.r2_key||"")).filter(Boolean));
  const fingerprint=createHash("sha256").update(JSON.stringify({assetIds,usageIds,source:normalized.source})).digest("hex");
  const now=Date.now();
  const marker={
    version:1,
    mode:"NON_DESTRUCTIVE_PRODUCTION_MERGE",
    source:normalized.source,
    sourceExportedAt:normalized.snapshot.exported_at || null,
    imported,
    matchedAssets,
    matchedUsage,
    uniqueR2Keys:uniqueR2Keys.size,
    schemaTables:counts.schemaTables,
    intentionallySkipped:["collection_runtime","materialization_runtime","mcp_audit","supervisor_runtime","worker_runtime","project_test_runtime","telemetry_history"],
    fingerprint,
    importedAt:new Date(now).toISOString(),
  };
  await getLibsqlClient().execute({
    sql:"INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
    args:["production_recovery_v1",JSON.stringify(marker),now],
  });
  return { ok:true,...marker,current:counts };
}
