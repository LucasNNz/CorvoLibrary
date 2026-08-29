import bundledRecovery from "../data/production-recovery-v1.json";
import { getLibsqlClient } from "./platform/runtime";
import { ensureCurrentApplicationSchema } from "./current-schema-bootstrap";
import { importProductionRecovery } from "./production-recovery-migration";

const AUTO_BOOTSTRAP_KEY = "automatic_production_bootstrap_v1";
const EXPECTED_ASSETS = 929;
const EXPECTED_USAGE = 1176;
const EXPECTED_SAFE_SETTINGS = 39;

let inFlight: Promise<AutomaticProductionBootstrapResult> | null = null;

export type AutomaticProductionBootstrapResult = {
  ok: true;
  status: "READY" | "IMPORTED";
  assets: number;
  assetUsage: number;
  expectedAssets: number;
  expectedAssetUsage: number;
  snapshotExportedAt: string | null;
};

async function counts() {
  const client = getLibsqlClient();
  const [assets, usage, marker] = await Promise.all([
    client.execute("SELECT COUNT(*) AS n FROM assets"),
    client.execute("SELECT COUNT(*) AS n FROM asset_usage"),
    client.execute({ sql:"SELECT value FROM settings WHERE key=? LIMIT 1", args:[AUTO_BOOTSTRAP_KEY] }),
  ]);
  return {
    assets:Number(assets.rows[0]?.n || 0),
    assetUsage:Number(usage.rows[0]?.n || 0),
    marker:String(marker.rows[0]?.value || ""),
  };
}

function snapshotExportedAt() {
  const snapshot = (bundledRecovery as { snapshot?: { exported_at?: unknown } }).snapshot;
  return snapshot?.exported_at ? String(snapshot.exported_at) : null;
}

async function runAutomaticBootstrap(): Promise<AutomaticProductionBootstrapResult> {
  await ensureCurrentApplicationSchema();
  const before = await counts();
  if (before.marker && before.assets >= EXPECTED_ASSETS && before.assetUsage >= EXPECTED_USAGE) {
    return {
      ok:true,
      status:"READY",
      assets:before.assets,
      assetUsage:before.assetUsage,
      expectedAssets:EXPECTED_ASSETS,
      expectedAssetUsage:EXPECTED_USAGE,
      snapshotExportedAt:snapshotExportedAt(),
    };
  }

  // Zero-touch bootstrap is deliberately non-destructive: it only fills rows
  // that are missing. Existing production rows win on primary-key conflicts.
  await importProductionRecovery(
    bundledRecovery as unknown as Parameters<typeof importProductionRecovery>[0],
    { conflictMode:"preserve-existing" },
  );

  const after = await counts();
  if (after.assets < EXPECTED_ASSETS) throw new Error(`AUTO_BOOTSTRAP_ASSETS_INCOMPLETE:${after.assets}/${EXPECTED_ASSETS}`);
  if (after.assetUsage < EXPECTED_USAGE) throw new Error(`AUTO_BOOTSTRAP_USAGE_INCOMPLETE:${after.assetUsage}/${EXPECTED_USAGE}`);

  const marker = {
    version:1,
    mode:"ZERO_TOUCH_PRESERVE_EXISTING",
    expectedAssets:EXPECTED_ASSETS,
    expectedAssetUsage:EXPECTED_USAGE,
    safeSettings:EXPECTED_SAFE_SETTINGS,
    snapshotExportedAt:snapshotExportedAt(),
    completedAt:new Date().toISOString(),
  };
  await getLibsqlClient().execute({
    sql:"INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
    args:[AUTO_BOOTSTRAP_KEY,JSON.stringify(marker),Date.now()],
  });

  return {
    ok:true,
    status:"IMPORTED",
    assets:after.assets,
    assetUsage:after.assetUsage,
    expectedAssets:EXPECTED_ASSETS,
    expectedAssetUsage:EXPECTED_USAGE,
    snapshotExportedAt:snapshotExportedAt(),
  };
}

export function ensureAutomaticProductionBootstrap() {
  if (!inFlight) {
    const task = runAutomaticBootstrap().finally(() => { if (inFlight === task) inFlight = null; });
    inFlight = task;
  }
  return inFlight;
}
