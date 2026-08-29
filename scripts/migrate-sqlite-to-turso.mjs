import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createClient } from "@libsql/client";

const root = process.cwd();
const source = resolve(process.argv[2] || join(root, "migration", "full-backup", "database.sql"));
const manifestPath = resolve(process.argv[3] || join(root, "migration", "full-backup", "database-manifest.json"));
const assetMapPath = resolve(join(root, "migration", "full-backup", "asset-r2-map.json"));
const foreignKeyBaselinePath = resolve(join(root, "migration", "full-backup", "foreign-key-baseline.json"));
const url = process.env.TURSO_DATABASE_URL?.trim();
const authToken = process.env.TURSO_AUTH_TOKEN?.trim() || undefined;
if (!url) throw new Error("TURSO_DATABASE_URL_REQUIRED");
if (!authToken && !url.startsWith("file:")) throw new Error("TURSO_AUTH_TOKEN_REQUIRED");

function splitSql(input) {
  const statements = [];
  let current = "", quote = "", lineComment = false, blockComment = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i], next = input[i + 1] || "";
    if (lineComment) { if (char === "\n") lineComment = false; continue; }
    if (blockComment) { if (char === "*" && next === "/") { blockComment = false; i += 1; } continue; }
    if (!quote && char === "-" && next === "-") { lineComment = true; i += 1; continue; }
    if (!quote && char === "/" && next === "*") { blockComment = true; i += 1; continue; }
    if (quote) {
      current += char;
      if ((quote === "[" && char === "]") || (quote !== "[" && char === quote)) {
        if (quote !== "[" && next === quote) { current += next; i += 1; }
        else quote = "";
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`" || char === "[") { quote = char; current += char; continue; }
    if (char === ";") {
      const statement = current.trim();
      if (statement) statements.push(statement);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

function normalize(statement) {
  if (/^(?:PRAGMA\s+foreign_keys|BEGIN(?:\s+TRANSACTION)?|COMMIT)$/i.test(statement.trim())) return "";
  let sql = statement.trim();
  sql = sql.replace(/^CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/i, "CREATE TABLE IF NOT EXISTS ");
  sql = sql.replace(/^CREATE\s+UNIQUE\s+INDEX\s+(?!IF\s+NOT\s+EXISTS)/i, "CREATE UNIQUE INDEX IF NOT EXISTS ");
  sql = sql.replace(/^CREATE\s+INDEX\s+(?!IF\s+NOT\s+EXISTS)/i, "CREATE INDEX IF NOT EXISTS ");
  sql = sql.replace(/^CREATE\s+TRIGGER\s+(?!IF\s+NOT\s+EXISTS)/i, "CREATE TRIGGER IF NOT EXISTS ");
  sql = sql.replace(/^INSERT\s+INTO/i, "INSERT OR IGNORE INTO");
  return sql;
}

async function targetTables(client) {
  const result = await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  return result.rows.map((row) => String(row.name));
}

async function validateManifest(client, manifest, assetMap) {
  let total = 0;
  const mismatches = [];
  for (const table of manifest.tables) {
    const name = String(table.name);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`INVALID_MANIFEST_TABLE:${name}`);
    const result = await client.execute(`SELECT COUNT(*) AS n FROM "${name}"`);
    const actual = Number(result.rows[0]?.n || 0), expected = Number(table.record_count || 0);
    total += actual;
    if (actual !== expected) mismatches.push(`${name}:${actual}/${expected}`);
  }
  if (mismatches.length) throw new Error(`MIGRATION_COUNT_MISMATCH:${mismatches.join(",")}`);
  const badKeys = await client.execute("SELECT COUNT(*) AS n FROM assets WHERE r2_key IS NULL OR trim(r2_key)='' ");
  if (Number(badKeys.rows[0]?.n || 0) !== 0) throw new Error("MIGRATION_EMPTY_R2_KEYS");
  const importedAssets = await client.execute("SELECT id,r2_key FROM assets");
  const importedById = new Map(importedAssets.rows.map((row) => [String(row.id), String(row.r2_key)]));
  const changedKeys = assetMap.filter((asset) => importedById.get(String(asset.asset_id)) !== String(asset.r2_key));
  if (changedKeys.length) throw new Error(`MIGRATION_ASSET_R2_KEY_MISMATCH:${changedKeys.slice(0,5).map((asset) => asset.asset_id).join(",")}`);
  return { tables: manifest.tables.length, records: total, assets: assetMap.length };
}

const [raw, manifestRaw, assetMapRaw, foreignKeyBaselineRaw] = await Promise.all([readFile(source, "utf8"), readFile(manifestPath, "utf8"), readFile(assetMapPath, "utf8"), readFile(foreignKeyBaselinePath, "utf8")]);
const manifest = JSON.parse(manifestRaw);
const assetMap = JSON.parse(assetMapRaw);
const foreignKeyBaseline = JSON.parse(foreignKeyBaselineRaw);
const checksum = createHash("sha256").update(raw).digest("hex");
const sourceStatements = splitSql(raw).map(normalize).filter(Boolean);
const client = createClient(authToken ? { url, authToken } : { url });

try {
  // SQLite dumps commonly contain valid child rows before their parent table's
  // INSERT section. Keep the constraints in the schema, suspend enforcement only
  // for this import connection, then verify every relationship before validation.
  await client.execute("PRAGMA foreign_keys=OFF");
  const before = await targetTables(client);
  const applicationTables = before.filter((name) => !["corvo_migration_state", "corvo_schema_migrations"].includes(name));
  if (applicationTables.length && !before.includes("corvo_migration_state")) {
    throw new Error(`TURSO_TARGET_NOT_EMPTY:${applicationTables.join(",")}`);
  }
  await client.execute("CREATE TABLE IF NOT EXISTS corvo_migration_state (id TEXT PRIMARY KEY, source_sha256 TEXT NOT NULL, next_statement INTEGER NOT NULL DEFAULT 0, total_statements INTEGER NOT NULL, status TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  const stateResult = await client.execute({ sql: "SELECT source_sha256,next_statement,status FROM corvo_migration_state WHERE id='full-d1-v1'", args: [] });
  const state = stateResult.rows[0];
  if (state && String(state.source_sha256) !== checksum) throw new Error("MIGRATION_SOURCE_CHANGED");
  let next = Number(state?.next_statement || 0);
  const sourcePreviouslyValidated = String(state?.status || "") === "VALIDATED" && next === sourceStatements.length;
  await client.execute({
    sql: "INSERT INTO corvo_migration_state(id,source_sha256,next_statement,total_statements,status,updated_at) VALUES('full-d1-v1',?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET total_statements=excluded.total_statements,status=CASE WHEN corvo_migration_state.status='VALIDATED' THEN 'VALIDATED' ELSE 'IMPORTING' END,updated_at=excluded.updated_at",
    args: [checksum, next, sourceStatements.length, "IMPORTING", Date.now()],
  });
  const batchSize = 50;
  while (next < sourceStatements.length) {
    const end = Math.min(sourceStatements.length, next + batchSize);
    const requests = sourceStatements.slice(next, end).map((sql) => ({ sql, args: [] }));
    requests.push({ sql: "UPDATE corvo_migration_state SET next_statement=?,updated_at=? WHERE id='full-d1-v1'", args: [end, Date.now()] });
    await client.batch(requests, "write");
    next = end;
    if (next % 1000 === 0 || next === sourceStatements.length) console.log(`[migration] ${next}/${sourceStatements.length}`);
  }

  await client.execute("PRAGMA foreign_keys=ON");
  let validation = { tables:manifest.total_tables, records:manifest.total_records, assets:assetMap.length };
  let foreignKeySummary = "already-validated";
  if (!sourcePreviouslyValidated) {
    const foreignKeyErrors = await client.execute("PRAGMA foreign_key_check");
    const foreignKeyLines = foreignKeyErrors.rows.map((row) => `${row.table}|${row.rowid}|${row.parent}|${row.fkid}`).sort();
    const foreignKeyHash = createHash("sha256").update(foreignKeyLines.join("\n")).digest("hex");
    if (foreignKeyLines.length !== Number(foreignKeyBaseline.foreign_key_check_total) || foreignKeyHash !== String(foreignKeyBaseline.foreign_key_check_sha256)) {
      throw new Error(`MIGRATION_FOREIGN_KEY_BASELINE_MISMATCH:${foreignKeyLines.length}:${foreignKeyHash}`);
    }
    foreignKeySummary = `${foreignKeyLines.length} sha256=${foreignKeyHash}`;
    // Validate before Vercel-only migrations intentionally add settings/tables.
    validation = await validateManifest(client, manifest, assetMap);
  }

  await client.execute("CREATE TABLE IF NOT EXISTS corvo_schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const migrationDir = join(root, "drizzle");
  const migrationNames = (await readdir(migrationDir)).filter((name) => /^(0018|0019|0020|0021|0022|0023|0024)_.*\.sql$/.test(name)).sort();
  for (const name of migrationNames) {
    const applied = await client.execute({ sql: "SELECT 1 FROM corvo_schema_migrations WHERE name=?", args: [name] });
    if (applied.rows.length) continue;
    const statements = splitSql(await readFile(join(migrationDir, name), "utf8")).map(normalize).filter(Boolean);
    for (const sql of statements) {
      try { await client.execute(sql); }
      catch (error) {
        if (!/duplicate column name|already exists/i.test(error instanceof Error ? error.message : String(error))) throw error;
      }
    }
    await client.execute({ sql: "INSERT OR IGNORE INTO corvo_schema_migrations(name,applied_at) VALUES(?,?)", args: [name, Date.now()] });
    console.log(`[schema] ${name}`);
  }

  await client.execute({ sql: "UPDATE corvo_migration_state SET status='VALIDATED',next_statement=?,updated_at=? WHERE id='full-d1-v1'", args: [sourceStatements.length, Date.now()] });
  console.log(`[migration] VALIDATED source=${basename(source)} sha256=${checksum} tables=${validation.tables}/${manifest.total_tables} records=${validation.records}/${manifest.total_records} assets=${validation.assets}`);
  console.log(`[migration] SOURCE_FOREIGN_KEY_BASELINE=${foreignKeySummary} enforcement=ON`);
  console.log("[migration] R2_MODIFIED=NO D1_SOURCE_MODIFIED=NO");
} finally {
  client.close();
}
