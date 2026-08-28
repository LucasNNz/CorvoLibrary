import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { automaticProjects } from "../db/schema";
import { ensureMediaDeliverySchema } from "./media-delivery";
import { env, getLibsqlClient } from "./platform/runtime";
import { exportCompleteProjectZip } from "./project-production-package";
import { createSignedR2GetUrl } from "./r2-download";
import { toArrayBuffer } from "./web-crypto";

const clean = (value: unknown) => String(value ?? "").trim();
const makeId = (prefix: string) => `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

function normalizeType(value: unknown) {
  const type = clean(value).toUpperCase().replace(/[- ]/g, "_") || "FULL_PROJECT_ZIP";
  if (["FULL_PROJECT_ZIP", "PRODUCTION_COMPLETE", "PRODUCTION_ZIP"].includes(type)) return "FULL_PROJECT_ZIP";
  throw new Error("PACKAGE_TYPE_NOT_SUPPORTED");
}

async function sha256Hex(bytes: Uint8Array) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes)));
  return Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
}

function normalizePackage(row: Record<string, unknown>) {
  return {
    package_id: clean(row.id), operation_id: clean(row.operation_id), project_id: clean(row.project_id),
    project_revision: Number(row.project_revision || 0), type: clean(row.type), status: clean(row.status),
    r2_key: clean(row.r2_key) || null, filename: clean(row.file_name) || null,
    size_bytes: Number(row.size_bytes || 0), sha256: clean(row.sha256) || null,
    created_at: row.created_at ? new Date(Number(row.created_at)).toISOString() : null,
    ready_at: row.ready_at ? new Date(Number(row.ready_at)).toISOString() : null,
    downloaded_at: row.downloaded_at ? new Date(Number(row.downloaded_at)).toISOString() : null,
    machine_name: clean(row.machine_name) || null, sha256_verified: row.sha256_verified == null ? null : Boolean(Number(row.sha256_verified)),
    download_count: Number(row.download_count || 0), error: clean(row.error) || null,
  };
}

async function packageById(id: string) {
  await ensureMediaDeliverySchema();
  const result = await getLibsqlClient().execute({ sql: `SELECT * FROM download_packages WHERE id=? LIMIT 1`, args: [id] });
  return result.rows[0] ? normalizePackage(result.rows[0] as Record<string, unknown>) : null;
}

export async function queueFinalPackage(input: Record<string, unknown>) {
  await ensureMediaDeliverySchema();
  const projectId = clean(input.project_id), type = normalizeType(input.type || input.tipo), operationId = clean(input.operation_id);
  if (!projectId) throw new Error("PROJECT_ID_REQUIRED");
  const [project] = await getDb().select().from(automaticProjects).where(eq(automaticProjects.id, projectId)).limit(1);
  if (!project) throw new Error("PROJECT_NOT_FOUND");
  const client = getLibsqlClient();
  if (operationId) {
    const byOperation = await client.execute({ sql: `SELECT * FROM download_packages WHERE operation_id=? LIMIT 1`, args: [operationId] });
    if (byOperation.rows[0]) return { reused: true, ...normalizePackage(byOperation.rows[0] as Record<string, unknown>) };
  }
  const existing = await client.execute({ sql: `SELECT * FROM download_packages WHERE project_id=? AND project_revision=? AND type=? LIMIT 1`, args: [projectId, project.productionRevision, type] });
  if (existing.rows[0]) {
    const normalized = normalizePackage(existing.rows[0] as Record<string, unknown>);
    if (normalized.status === "FAILED") {
      await client.execute({ sql:`UPDATE download_packages SET status='QUEUED',error=NULL,updated_at=? WHERE id=?`, args:[Date.now(), normalized.package_id] });
      return { reused:true, retried:true, ...normalized, status:"QUEUED" };
    }
    return { reused: true, ...normalized };
  }
  const id = makeId("PKG"), op = operationId || makeId("PKGOP"), now = Date.now();
  try {
    await client.execute({ sql: `INSERT INTO download_packages(id,operation_id,project_id,project_revision,type,status,created_at,updated_at) VALUES(?,?,?,?,?,'QUEUED',?,?)`, args: [id, op, projectId, project.productionRevision, type, now, now] });
  } catch (error) {
    const winner = await client.execute({ sql: `SELECT * FROM download_packages WHERE project_id=? AND project_revision=? AND type=? LIMIT 1`, args: [projectId, project.productionRevision, type] });
    if (winner.rows[0]) return { reused: true, ...normalizePackage(winner.rows[0] as Record<string, unknown>) };
    throw error;
  }
  return { reused: false, package_id: id, operation_id: op, project_id: projectId, project_revision: project.productionRevision, type, status: "QUEUED" };
}

async function processOnePackage(row: Record<string, unknown>) {
  const client = getLibsqlClient(), id = clean(row.id), projectId = clean(row.project_id), revision = Number(row.project_revision || 0);
  const now = Date.now();
  const claimed = await client.execute({ sql: `UPDATE download_packages SET status='PROCESSING',updated_at=?,error=NULL WHERE id=? AND status='QUEUED'`, args: [now, id] });
  if (claimed.rowsAffected !== 1) return { ok:true, package_id:id, status:"SKIPPED_ALREADY_CLAIMED" };
  try {
    const [project] = await getDb().select().from(automaticProjects).where(eq(automaticProjects.id, projectId)).limit(1);
    if (!project) throw new Error("PROJECT_NOT_FOUND");
    let r2Key = "", fileName = "", sizeBytes = 0, sha256 = "";
    if (project.productionZipR2Key && project.productionZipRevision === revision) {
      const object = await env.BUCKET.get(project.productionZipR2Key);
      if (object) {
        const bytes = new Uint8Array(await object.arrayBuffer());
        r2Key = project.productionZipR2Key; fileName = project.productionZipFileName || `project-${projectId}.zip`; sizeBytes = bytes.byteLength; sha256 = await sha256Hex(bytes);
      }
    }
    if (!r2Key) {
      const exported = await exportCompleteProjectZip(projectId);
      r2Key = exported.r2Key; fileName = exported.fileName; sizeBytes = exported.sizeBytes; sha256 = exported.sha256;
    }
    const ready = Date.now();
    await client.execute({ sql: `UPDATE download_packages SET status='READY_FOR_DOWNLOAD',r2_key=?,file_name=?,size_bytes=?,sha256=?,ready_at=?,updated_at=?,error=NULL WHERE id=?`, args: [r2Key, fileName, sizeBytes, sha256, ready, ready, id] });
    return { ok: true, package_id: id, status: "READY_FOR_DOWNLOAD" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error), failed = Date.now();
    await client.execute({ sql: `UPDATE download_packages SET status='FAILED',error=?,updated_at=? WHERE id=?`, args: [message, failed, id] });
    return { ok: false, package_id: id, status: "FAILED", error: message };
  }
}

export async function processQueuedDownloadPackages(options: { maxJobs?: number } = {}) {
  await ensureMediaDeliverySchema();
  const limit = Math.max(1, Math.min(3, Number(options.maxJobs) || 1));
  const staleBefore = Date.now() - 10 * 60_000;
  await getLibsqlClient().execute({ sql:`UPDATE download_packages SET status='QUEUED',error='RECOVERED_STALE_PROCESSING',updated_at=? WHERE status='PROCESSING' AND updated_at<?`, args:[Date.now(), staleBefore] });
  const result = await getLibsqlClient().execute({ sql: `SELECT * FROM download_packages WHERE status='QUEUED' ORDER BY created_at ASC LIMIT ?`, args: [limit] });
  const processed: Array<Record<string, unknown>> = [];
  for (const row of result.rows) processed.push(await processOnePackage(row as Record<string, unknown>));
  const pending = await getLibsqlClient().execute({ sql: `SELECT COUNT(*) AS n FROM download_packages WHERE status='QUEUED'`, args: [] });
  return { processed, needs_reschedule: Number(pending.rows[0]?.n || 0) > 0 };
}

export async function listReadyDownloadPackages(input: Record<string, unknown> = {}) {
  await ensureMediaDeliverySchema();
  const projectId = clean(input.project_id), status = clean(input.status).toUpperCase() || "READY_FOR_DOWNLOAD";
  const sinceValue = clean(input.since), since = sinceValue ? Date.parse(sinceValue) || Number(sinceValue) || 0 : 0;
  const limit = Math.max(1, Math.min(200, Number(input.limit) || 100));
  const clauses: string[] = [], args: Array<string | number> = [];
  if (projectId) { clauses.push("project_id=?"); args.push(projectId); }
  if (status && status !== "ALL") { clauses.push("status=?"); args.push(status); }
  if (since > 0) { clauses.push("created_at>=?"); args.push(since); }
  args.push(limit);
  const result = await getLibsqlClient().execute({ sql: `SELECT p.*, a.name AS project_name FROM download_packages p LEFT JOIN automatic_projects a ON a.id=p.project_id ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY p.created_at ASC LIMIT ?`, args });
  return { total: result.rows.length, packages: result.rows.map((raw: unknown) => { const row = raw as Record<string, unknown>; return { ...normalizePackage(row), project_name: clean(row.project_name) || null }; }) };
}

export async function getDownloadPackageLink(input: Record<string, unknown>) {
  const packageId = clean(input.package_id); if (!packageId) throw new Error("PACKAGE_ID_REQUIRED");
  const row = await packageById(packageId); if (!row) throw new Error("PACKAGE_NOT_FOUND");
  if (!['READY_FOR_DOWNLOAD','DOWNLOADED'].includes(row.status)) throw new Error(`PACKAGE_NOT_READY:${row.status}`);
  if (!row.r2_key || !row.filename) throw new Error("PACKAGE_R2_REFERENCE_MISSING");
  const minutes = Math.max(1, Math.min(60, Number(input.validade_minutos) || 30));
  const downloadUrl = await createSignedR2GetUrl(row.r2_key, minutes, row.filename, "application/zip"), expires = Date.now() + minutes * 60_000;
  return { package_id: packageId, project_id: row.project_id, status: row.status, download_url: downloadUrl, expires_at: new Date(expires).toISOString(), filename: row.filename, size_bytes: row.size_bytes, sha256: row.sha256, direct_to_pc: true, chat_file_delivery: "DISABLED" };
}

export async function confirmDownloadPackage(input: Record<string, unknown>) {
  const packageId = clean(input.package_id); if (!packageId) throw new Error("PACKAGE_ID_REQUIRED");
  const row = await packageById(packageId); if (!row) throw new Error("PACKAGE_NOT_FOUND");
  if (!['READY_FOR_DOWNLOAD','DOWNLOADED'].includes(row.status)) throw new Error(`PACKAGE_NOT_READY:${row.status}`);
  const verified = input.sha256_verified !== false;
  if (!verified) throw new Error("PACKAGE_SHA256_NOT_VERIFIED");
  const downloadedInput = clean(input.downloaded_at), downloadedAt = downloadedInput ? Date.parse(downloadedInput) || Date.now() : Date.now(), machine = clean(input.machine_name).slice(0, 160);
  if (row.status === "DOWNLOADED") return { package_id: packageId, project_id: row.project_id, status: "DOWNLOADED", downloaded_at: row.downloaded_at, sha256_verified: true, machine_name: row.machine_name, idempotent_reused: true };
  const update = await getLibsqlClient().execute({ sql: `UPDATE download_packages SET status='DOWNLOADED',downloaded_at=?,machine_name=?,sha256_verified=1,download_count=download_count+1,updated_at=? WHERE id=? AND status='READY_FOR_DOWNLOAD'`, args: [downloadedAt, machine || null, Date.now(), packageId] });
  if (update.rowsAffected !== 1) {
    const latest = await packageById(packageId);
    if (latest?.status === "DOWNLOADED") return { package_id: packageId, project_id: latest.project_id, status: "DOWNLOADED", downloaded_at: latest.downloaded_at, sha256_verified: latest.sha256_verified ?? true, machine_name: latest.machine_name, idempotent_reused: true };
    throw new Error("PACKAGE_DOWNLOAD_CONFIRM_CONFLICT");
  }
  return { package_id: packageId, project_id: row.project_id, status: "DOWNLOADED", downloaded_at: new Date(downloadedAt).toISOString(), sha256_verified: true, machine_name: machine || null, idempotent_reused: false };
}
