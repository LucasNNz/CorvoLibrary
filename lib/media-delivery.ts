import sharp from "sharp";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../db";
import { projectProductionAssets } from "../db/schema";
import { env, getLibsqlClient } from "./platform/runtime";
import { createSignedR2GetUrl, createSignedR2PutUrl } from "./r2-download";
import {
  decideProjectThumbnails,
  pushProjectThumbnailUrl,
  registerProjectThumbnailExistingR2,
  type ProjectThumbInput,
} from "./project-production-package";

const MAX_THUMB_BYTES = 25 * 1024 * 1024;
const THUMB_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/avif", "image/gif"]);
const clean = (value: unknown) => String(value ?? "").trim();
const safeName = (value: string) => (value || "thumb").replace(/[\\/]/g, "-").replace(/[^a-zA-Z0-9À-ÿ._ -]/g, "-").replace(/\s+/g, " ").slice(0, 180) || "thumb";
const makeId = (prefix: string) => `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

let schemaPromise: Promise<void> | null = null;
export function ensureMediaDeliverySchema() {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    const client = getLibsqlClient();
    await client.executeMultiple(`
      CREATE TABLE IF NOT EXISTS direct_media_uploads (
        upload_token TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        r2_key TEXT NOT NULL,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        production_asset_id TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        confirmed_at INTEGER,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS direct_media_uploads_project_idx ON direct_media_uploads(project_id, status, created_at);
      CREATE TABLE IF NOT EXISTS download_packages (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        project_revision INTEGER NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        r2_key TEXT,
        file_name TEXT,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        sha256 TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        ready_at INTEGER,
        downloaded_at INTEGER,
        machine_name TEXT,
        sha256_verified INTEGER,
        download_count INTEGER NOT NULL DEFAULT 0,
        last_link_expires_at INTEGER,
        error TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS download_packages_revision_idx ON download_packages(project_id, project_revision, type);
      CREATE INDEX IF NOT EXISTS download_packages_status_idx ON download_packages(status, created_at);
    `);
    try { await client.execute(`ALTER TABLE download_packages ADD COLUMN sha256_verified INTEGER`); } catch {}
  })().catch((error) => { schemaPromise = null; throw error; });
  return schemaPromise;
}

function normalizeKind(kind: unknown) {
  const value = clean(kind).toUpperCase().replace(/[- ]/g, "_");
  if (!value || value === "THUMB" || value === "THUMBNAIL") return "THUMBNAIL";
  throw new Error("MEDIA_KIND_NOT_SUPPORTED");
}

function normalizeMime(value: unknown) {
  const mime = clean(value).toLowerCase();
  if (!THUMB_MIMES.has(mime)) throw new Error("THUMB_INVALID_MIME");
  return mime;
}

function thumbContext(input: Record<string, unknown>): ProjectThumbInput {
  return {
    operation_id: clean(input.operation_id),
    project_id: clean(input.project_id),
    source_url: clean(input.image_url || input.source_url),
    name: clean(input.name || input.filename),
    variant: clean(input.variant || input.variante),
    agent_origin: clean(input.agent_origin || input.agente_origem),
    observation: clean(input.observation || input.observacao),
    source_type: clean(input.source_type),
    universe: clean(input.universe || input.universo),
    tags: Array.isArray(input.tags) ? input.tags.map(clean).filter(Boolean) : [],
    script_reference: clean(input.script_reference || input.referencia_roteiro),
    status_qa: clean(input.status_qa),
    metadata: input.metadata && typeof input.metadata === "object" ? input.metadata as Record<string, unknown> : {},
  };
}

export async function fastPushGeneratedMedia(input: Record<string, unknown>) {
  normalizeKind(input.kind);
  const context = thumbContext(input);
  if (!context.project_id) throw new Error("PROJECT_ID_REQUIRED");
  if (!context.source_url) throw new Error("IMAGE_URL_REQUIRED");
  let imageUrl: URL;
  try { imageUrl = new URL(context.source_url); } catch { throw new Error("IMAGE_URL_INVALID"); }
  if (imageUrl.protocol !== "https:") throw new Error("IMAGE_URL_HTTPS_REQUIRED");
  const rawResult = await pushProjectThumbnailUrl({ ...context, source_url: imageUrl.toString(), source_type: clean(input.source_type) || "GENERATED_URL" });
  const result = rawResult as unknown as Record<string, unknown>;
  const candidate = result.candidate && typeof result.candidate === "object" ? result.candidate as Record<string, unknown> : undefined;
  return {
    project_id: context.project_id,
    kind: "THUMBNAIL",
    status: clean(result.status),
    operation_id: clean(result.operation_id || candidate?.operationId || context.operation_id) || null,
    asset_id: clean(result.asset_id || candidate?.id) || null,
    r2_key: clean(result.r2_key || candidate?.r2Key) || null,
    width: Number(result.width || 0) || null,
    height: Number(result.height || 0) || null,
    mime_type: clean(candidate?.mimeType) || null,
    size_bytes: Number(candidate?.sizeBytes || 0) || null,
    sha256: clean(result.sha256 || candidate?.sha256) || null,
    chat_file_delivery: "DISABLED",
  };
}

export async function prepareMediaUpload(input: Record<string, unknown>) {
  await ensureMediaDeliverySchema();
  const kind = normalizeKind(input.kind), projectId = clean(input.project_id), filename = safeName(clean(input.filename || input.name)), mime = normalizeMime(input.mime_type);
  if (!projectId) throw new Error("PROJECT_ID_REQUIRED");
  if (!filename) throw new Error("FILENAME_REQUIRED");
  const exists = await getLibsqlClient().execute({ sql: `SELECT id FROM automatic_projects WHERE id=? LIMIT 1`, args: [projectId] });
  if (!exists.rows[0]) throw new Error("PROJECT_NOT_FOUND");
  const token = makeId("UPL"), extName = filename.includes(".") ? filename : `${filename}.${mime === "image/jpeg" ? "jpg" : mime.split("/")[1]}`;
  const r2Key = `projects/${projectId}/production/thumbs/direct/${token}-${extName}`;
  const ttlMinutes = Math.max(1, Math.min(60, Number(input.validade_minutos) || 15));
  const created = Date.now(), expires = created + ttlMinutes * 60_000;
  const metadata = JSON.stringify({ ...thumbContext(input), kind });
  await getLibsqlClient().execute({ sql: `INSERT INTO direct_media_uploads(upload_token,project_id,kind,r2_key,filename,mime_type,status,metadata_json,created_at,expires_at) VALUES(?,?,?,?,?,?,'PENDING',?,?,?)`, args: [token, projectId, kind, r2Key, extName, mime, metadata, created, expires] });
  const signed = await createSignedR2PutUrl(r2Key, ttlMinutes, mime);
  return { project_id: projectId, kind, upload_token: token, future_r2_key: r2Key, upload_url: signed.url, upload_method: signed.method, upload_headers: signed.headers, expires_at: signed.expires_at, chat_file_delivery: "DISABLED" };
}

export async function confirmMediaUpload(input: Record<string, unknown>) {
  await ensureMediaDeliverySchema();
  const token = clean(input.upload_token), projectId = clean(input.project_id);
  if (!token) throw new Error("UPLOAD_TOKEN_REQUIRED");
  const client = getLibsqlClient();
  const found = await client.execute({ sql: `SELECT * FROM direct_media_uploads WHERE upload_token=? LIMIT 1`, args: [token] });
  const row = found.rows[0] as Record<string, unknown> | undefined;
  if (!row) throw new Error("UPLOAD_TOKEN_NOT_FOUND");
  if (projectId && clean(row.project_id) !== projectId) throw new Error("UPLOAD_PROJECT_MISMATCH");
  if (clean(row.status) === "CONFIRMED" && row.production_asset_id) return { status: "IDEMPOTENT_REUSED", project_id: row.project_id, asset_id: row.production_asset_id, r2_key: row.r2_key, upload_token: token };
  if (Number(row.expires_at || 0) < Date.now()) throw new Error("UPLOAD_TOKEN_EXPIRED");
  const r2Key = clean(row.r2_key), object = await env.BUCKET.get(r2Key);
  if (!object) throw new Error("UPLOAD_OBJECT_NOT_FOUND");
  if (!object.size || object.size > MAX_THUMB_BYTES) throw new Error(object.size > MAX_THUMB_BYTES ? "THUMB_LIMIT_25_MB" : "EMPTY_FILE");
  const bytes = new Uint8Array(await object.arrayBuffer());
  const meta = await sharp(bytes, { animated: true }).metadata();
  if (!meta.width || !meta.height) throw new Error("THUMB_DIMENSIONS_UNAVAILABLE");
  const stored = (() => { try { return JSON.parse(clean(row.metadata_json) || "{}") as Record<string, unknown>; } catch { return {}; } })();
  const context = { ...stored, ...input, project_id: clean(row.project_id), source_type: "DIRECT_R2_UPLOAD", name: clean(input.name) || clean(row.filename) };
  try {
    const result = await registerProjectThumbnailExistingR2(r2Key, clean(row.filename), clean(row.mime_type), thumbContext(context));
    const assetId = clean(result.asset_id || (result.candidate as Record<string, unknown> | undefined)?.id);
    await client.execute({ sql: `UPDATE direct_media_uploads SET status='CONFIRMED', production_asset_id=?, confirmed_at=?, error=NULL WHERE upload_token=?`, args: [assetId, Date.now(), token] });
    return { ...result, project_id: clean(row.project_id), kind: "THUMBNAIL", upload_token: token, asset_id: assetId, width: result.width || meta.width, height: result.height || meta.height, chat_file_delivery: "DISABLED" };
  } catch (error) {
    await client.execute({ sql: `UPDATE direct_media_uploads SET status='FAILED', error=? WHERE upload_token=?`, args: [error instanceof Error ? error.message : String(error), token] }).catch(() => undefined);
    throw error;
  }
}

async function dimensionsForThumb(row: typeof projectProductionAssets.$inferSelect) {
  const head = await env.BUCKET.head(row.r2Key);
  const width = Number(head?.customMetadata?.width || 0), height = Number(head?.customMetadata?.height || 0);
  if (width && height) return { width, height };
  const object = await env.BUCKET.get(row.r2Key);
  if (!object) return { width: null, height: null };
  const meta = await sharp(new Uint8Array(await object.arrayBuffer()), { animated: true }).metadata();
  return { width: meta.width || null, height: meta.height || null };
}

export async function getProjectThumbnailLinks(input: Record<string, unknown>) {
  const projectId = clean(input.project_id), limit = Math.max(1, Math.min(100, Number(input.limit) || 20));
  if (!projectId) throw new Error("PROJECT_ID_REQUIRED");
  const requestedStatus = clean(input.status).toUpperCase();
  let rows = await getDb().select().from(projectProductionAssets).where(and(eq(projectProductionAssets.projectId, projectId), eq(projectProductionAssets.kind, "THUMB"))).orderBy(desc(projectProductionAssets.createdAt)).limit(limit);
  if (requestedStatus) rows = rows.filter((row: typeof projectProductionAssets.$inferSelect) => row.status.toUpperCase() === requestedStatus || (requestedStatus === "READY_FOR_QA" && row.status === "THUMB_CANDIDATE"));
  const links = await Promise.all(rows.map(async (row: typeof projectProductionAssets.$inferSelect) => {
    const dimensions = await dimensionsForThumb(row);
    let preview_signed_url: string | null = null, signing_error: string | null = null;
    try { preview_signed_url = await createSignedR2GetUrl(row.r2Key, Math.max(1, Math.min(60, Number(input.validade_minutos) || 30)), undefined, row.mimeType); }
    catch (error) { signing_error = error instanceof Error ? error.message : String(error); }
    return { asset_id: row.id, candidate_id: row.id, project_id: row.projectId, kind: "THUMBNAIL", name: row.name, status: row.status === "THUMB_CANDIDATE" ? "READY_FOR_QA" : row.selected ? "PUBLISHED_THUMB" : row.status, selected: row.selected, r2_key: row.r2Key, mime_type: row.mimeType, size_bytes: row.sizeBytes, sha256: row.sha256, width: dimensions.width, height: dimensions.height, context: row.note, preview_signed_url, ...(signing_error ? { signing_error } : {}) };
  }));
  return { project_id: projectId, mode: "LINKS_ONLY", total: links.length, thumbs: links };
}

export async function decideThumbnailBatch(input: Record<string, unknown>) {
  const ids = (Array.isArray(input.asset_ids) ? input.asset_ids : Array.isArray(input.candidate_ids) ? input.candidate_ids : []).map(clean).filter(Boolean).slice(0, 100);
  if (!ids.length) throw new Error("THUMB_IDS_REQUIRED");
  const action = clean(input.action || input.decisao).toUpperCase();
  if (!['APPROVE','REJECT','SELECT'].includes(action)) throw new Error("THUMB_DECISION_INVALID");
  const result = await decideProjectThumbnails(ids, action, clean(input.source || input.origem_decisao) || "SUPERVISOR", clean(input.reason || input.observacao));
  return { operation_id: clean(input.operation_id) || makeId("THDEC"), accepted_count: ids.length, action, ...result };
}
