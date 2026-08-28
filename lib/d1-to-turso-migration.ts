import { getLibsqlClient } from "./platform/runtime";
import { exportD1Sql, getD1TableCounts, resolveCorvoD1Database } from "./cloudflare-admin";
import { getCloudflareConnection, saveCloudflareConnection } from "./secure-settings";
import { ensureBootstrapSettingsTable } from "./bootstrap-db";
import { env } from "./platform/runtime";

export type MigrationPreflight = {
  ready: boolean;
  sourceDatabaseId: string;
  sourceDatabaseName: string;
  sourceCounts: Record<string, number>;
  targetCounts: Record<string, number>;
  targetHasApplicationData: boolean;
  targetTables: string[];
  rollbackAvailable: boolean;
  backupKey: string;
  lastMigrationAt: string;
};

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function sanitizeD1Dump(raw: string) {
  return raw
    .replace(/^PRAGMA\s+foreign_keys\s*=.*$/gmi, "")
    .replace(/^PRAGMA\s+defer_foreign_keys\s*=.*$/gmi, "")
    .replace(/^BEGIN(?:\s+TRANSACTION)?;?$/gmi, "")
    .replace(/^COMMIT;?$/gmi, "")
    .trim();
}

async function targetCounts() {
  const client = getLibsqlClient();
  const tablesResult = await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  const tables = tablesResult.rows.map((row) => String(row.name)).filter(Boolean);
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const result = await client.execute(`SELECT COUNT(*) AS n FROM ${quoteIdentifier(table)}`);
    counts[table] = Number(result.rows[0]?.n || 0);
  }
  return { tables, counts };
}

function hasApplicationData(counts: Record<string, number>) {
  return Object.entries(counts).some(([table, count]) => table !== "settings" && count > 0);
}

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString("hex")}'`;
  if (value instanceof ArrayBuffer) return `X'${Buffer.from(value).toString("hex")}'`;
  return `'${String(value).replaceAll("'", "''")}'`;
}


async function captureVercelBootstrapSettings() {
  await ensureBootstrapSettingsTable();
  const result = await getLibsqlClient().execute({
    sql: "SELECT key,value,updated_at FROM settings WHERE key IN ('library_auth_v1','library_master_key_v1') OR key LIKE 'library_auth_session:%'",
    args: [],
  });
  return result.rows.map((row) => ({ key:String(row.key), value:String(row.value), updatedAt:Number(row.updated_at || Date.now()) }));
}

async function restoreVercelBootstrapSettings(rows: Array<{key:string;value:string;updatedAt:number}>) {
  for (const row of rows) {
    await getLibsqlClient().execute({
      sql: "INSERT INTO settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
      args: [row.key, row.value, row.updatedAt],
    });
  }
}

async function migrationRecord() {
  try {
    const result = await getLibsqlClient().execute({ sql:"SELECT value FROM settings WHERE key='vercel_d1_migration_v1' LIMIT 1", args:[] });
    const raw = String(result.rows[0]?.value || "");
    return raw ? JSON.parse(raw) as { backupKey?:string; migratedAt?:string } : null;
  } catch { return null; }
}

async function exportTargetDatabaseSql() {
  const client = getLibsqlClient();
  const schema = await client.execute("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 2 ELSE 1 END,name");
  const tableRows = schema.rows.filter((row) => String(row.type) === "table");
  const deferred = schema.rows.filter((row) => String(row.type) !== "table");
  const chunks: string[] = ["PRAGMA foreign_keys=OFF;", "BEGIN;"];
  for (const row of tableRows) chunks.push(`${String(row.sql).replace(/;\s*$/, "")};`);
  for (const row of tableRows) {
    const table = String(row.name);
    const result = await client.execute(`SELECT * FROM ${quoteIdentifier(table)}`);
    const columns = result.columns.map((column) => quoteIdentifier(String(column)));
    if (!columns.length) continue;
    for (const data of result.rows) {
      const values = result.columns.map((column) => sqlLiteral((data as Record<string, unknown>)[String(column)]));
      chunks.push(`INSERT INTO ${quoteIdentifier(table)} (${columns.join(",")}) VALUES (${values.join(",")});`);
    }
  }
  for (const row of deferred) chunks.push(`${String(row.sql).replace(/;\s*$/, "")};`);
  chunks.push("COMMIT;", "PRAGMA foreign_keys=ON;");
  return chunks.join("\n");
}

async function createTargetBackup() {
  const sql = await exportTargetDatabaseSql();
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const key = `corvo-library/backups/turso-before-d1/${stamp}.sql`;
  await env.BUCKET.put(key, sql, { httpMetadata:{ contentType:"application/sql; charset=utf-8" }, customMetadata:{ source:"TURSO_PRE_D1_REPLACE", created_at:new Date().toISOString() } });
  return { key, sql, bytes:Buffer.byteLength(sql) };
}

async function restoreSqlSnapshot(sql: string) {
  await clearTargetDatabase();
  await getLibsqlClient().executeMultiple(sql);
}

export async function getD1ToTursoPreflight(): Promise<MigrationPreflight> {
  await ensureBootstrapSettingsTable();
  const stored = await getCloudflareConnection();
  const connection = stored.connection;
  if (!connection?.accountId || !connection.d1ApiToken) {
    const target = await targetCounts();
    return {
      ready: false, sourceDatabaseId: "", sourceDatabaseName: "", sourceCounts: {},
      targetCounts: target.counts, targetHasApplicationData: hasApplicationData(target.counts), targetTables: target.tables,
      rollbackAvailable: false, backupKey: "", lastMigrationAt: "",
    };
  }
  const database = await resolveCorvoD1Database(connection.accountId, connection.d1ApiToken, connection.d1DatabaseId, connection.d1DatabaseName);
  const [sourceCounts, target] = await Promise.all([
    getD1TableCounts(connection.accountId, connection.d1ApiToken, database.id),
    targetCounts(),
  ]);
  const previous = await migrationRecord();
  return {
    ready: true,
    sourceDatabaseId: database.id,
    sourceDatabaseName: database.name,
    sourceCounts,
    targetCounts: target.counts,
    targetHasApplicationData: hasApplicationData(target.counts),
    targetTables: target.tables,
    rollbackAvailable: Boolean(previous?.backupKey),
    backupKey: previous?.backupKey || "",
    lastMigrationAt: previous?.migratedAt || "",
  };
}

async function clearTargetDatabase() {
  const client = getLibsqlClient();
  const result = await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  const tables = result.rows.map((row) => String(row.name)).filter(Boolean);
  if (!tables.length) return;
  const drops = tables.map((table) => `DROP TABLE IF EXISTS ${quoteIdentifier(table)};`).join("\n");
  await client.executeMultiple(`PRAGMA foreign_keys=OFF;\n${drops}\nPRAGMA foreign_keys=ON;`);
}

export async function migrateD1ToTurso(options: { replaceExisting?: boolean } = {}) {
  await ensureBootstrapSettingsTable();
  const stored = await getCloudflareConnection();
  const connection = stored.connection;
  if (!connection?.accountId || !connection.d1ApiToken) throw new Error("D1_PERSISTENT_CONFIGURATION_REQUIRED");

  const database = await resolveCorvoD1Database(connection.accountId, connection.d1ApiToken, connection.d1DatabaseId, connection.d1DatabaseName);
  const sourceCounts = await getD1TableCounts(connection.accountId, connection.d1ApiToken, database.id);
  const before = await targetCounts();
  const targetHasData = hasApplicationData(before.counts);
  if (targetHasData && !options.replaceExisting) throw new Error("TURSO_TARGET_HAS_APPLICATION_DATA");

  const workingConnection = { ...connection, d1DatabaseId: database.id, d1DatabaseName: database.name };
  const rawDump = await exportD1Sql(connection.accountId, connection.d1ApiToken, database.id);
  const sql = sanitizeD1Dump(rawDump);
  if (!sql || !/CREATE\s+TABLE/i.test(sql)) throw new Error("D1_EXPORT_INVALID_SQL");

  // A replacement is never destructive-first: snapshot the entire Turso DB to
  // the existing R2 bucket before dropping any table.
  const bootstrapSettings = await captureVercelBootstrapSettings();
  const backup = targetHasData && options.replaceExisting ? await createTargetBackup() : null;

  try {
    await clearTargetDatabase();
    await getLibsqlClient().executeMultiple(sql);
    await restoreVercelBootstrapSettings(bootstrapSettings);
    await saveCloudflareConnection(workingConnection);
    const now = Date.now();
    const migrationMeta = {
      sourceDatabaseId: database.id,
      sourceDatabaseName: database.name,
      migratedAt: new Date(now).toISOString(),
      backupKey: backup?.key || "",
      backupBytes: backup?.bytes || 0,
    };
    await getLibsqlClient().execute({
      sql: "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
      args: ["vercel_d1_migration_v1", JSON.stringify(migrationMeta), now],
    });

    const after = await targetCounts();
    const mismatches = Object.entries(sourceCounts)
      .filter(([table]) => table !== "settings")
      .filter(([table, count]) => Number(after.counts[table] ?? -1) !== Number(count))
      .map(([table, source]) => ({ table, source: Number(source), target: Number(after.counts[table] ?? -1) }));
    if (mismatches.length) throw new Error(`D1_TURSO_COUNT_MISMATCH:${JSON.stringify(mismatches.slice(0, 20))}`);
    return {
      ok: true,
      sourceDatabaseId: database.id,
      sourceDatabaseName: database.name,
      sourceCounts,
      targetCounts: after.counts,
      tablesCompared: Object.keys(sourceCounts).filter((table) => table !== "settings").length,
      settingsSourceCount: Number(sourceCounts.settings || 0),
      settingsTargetCount: Number(after.counts.settings || 0),
      dumpBytes: Buffer.byteLength(sql),
      migratedAt: new Date(now).toISOString(),
      backupKey: backup?.key || "",
      backupBytes: backup?.bytes || 0,
    };
  } catch (error) {
    if (backup?.sql) {
      try { await restoreSqlSnapshot(backup.sql); }
      catch (rollbackError) {
        throw new Error(`D1_MIGRATION_FAILED_AND_AUTO_ROLLBACK_FAILED:${error instanceof Error ? error.message : String(error)}:${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
      throw new Error(`D1_MIGRATION_FAILED_AUTO_ROLLBACK_OK:${error instanceof Error ? error.message : String(error)}`);
    }
    await ensureBootstrapSettingsTable().catch(() => undefined);
    throw error;
  }
}

export async function rollbackLastD1Migration() {
  await ensureBootstrapSettingsTable();
  const record = await migrationRecord();
  if (!record?.backupKey) throw new Error("NO_D1_MIGRATION_BACKUP_AVAILABLE");
  const object = await env.BUCKET.get(record.backupKey);
  if (!object) throw new Error("D1_MIGRATION_BACKUP_NOT_FOUND");
  const sql = Buffer.from(await object.arrayBuffer()).toString("utf8");
  if (!sql.includes("CREATE TABLE")) throw new Error("D1_MIGRATION_BACKUP_INVALID");
  await restoreSqlSnapshot(sql);
  const after = await targetCounts();
  return { ok:true, restoredBackupKey:record.backupKey, targetCounts:after.counts, restoredAt:new Date().toISOString() };
}

