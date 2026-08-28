import { env } from "./platform/runtime";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import { getDb } from "../db";
import {
  assets,
  automaticProjectEvents,
  automaticProjectFiles,
  automaticProjectItems,
  automaticProjects,
  projectProductionAssets,
  projectTitleCandidates,
} from "../db/schema";

const MAX_BATCH_ITEMS = 20;
const MAX_THUMB_BYTES = 25 * 1024 * 1024;
const MAX_PRODUCTION_ZIP_BYTES = 180 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 12_000;
const THUMB_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/avif", "image/gif"]);
const RESOLVED_ITEM_STATUSES = new Set(["APPROVED", "LINKED_FROM_LIBRARY", "LINKED_FROM_FAMILY", "FROZEN"]);

type Decision = "APPROVE" | "REJECT" | "SELECT";
type DecisionSource = "MANUAL" | "SUPERVISOR" | "AI" | string;

export type ProjectThumbInput = {
  operation_id?: string;
  project_id?: string;
  source_url?: string;
  name?: string;
  variant?: string;
  variante?: string;
  agent_origin?: string;
  agente_origem?: string;
  observation?: string;
  observacao?: string;
  source_type?: string;
};

export type ProjectTitleInput = {
  operation_id?: string;
  text?: string;
  texto?: string;
  variant?: string;
  variante?: string;
  agent_origin?: string;
  agente_origem?: string;
  observation?: string;
  observacao?: string;
  score?: number;
};

const now = () => new Date();
const clean = (value: unknown) => String(value ?? "").trim();
const safeName = (value: string) => (value || "arquivo").replace(/[\\/]/g, "-").replace(/[^a-zA-Z0-9À-ÿ._ -]/g, "-").replace(/\s+/g, " ").slice(0, 180) || "arquivo";
const makeId = (prefix: string) => `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

function extensionForMime(mime: string) {
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  if (mime === "image/avif") return "avif";
  if (mime === "image/gif") return "gif";
  return "bin";
}

function sniffMime(bytes: Uint8Array, hint = "") {
  void hint;
  let detected = "";
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) detected = "image/png";
  else if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) detected = "image/jpeg";
  else if (bytes.length > 12 && new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP") detected = "image/webp";
  else if (bytes.length > 6 && new TextDecoder().decode(bytes.subarray(0, 6)).startsWith("GIF8")) detected = "image/gif";
  else if (bytes.length > 16 && new TextDecoder().decode(bytes.subarray(4, 12)).includes("ftyp") && new TextDecoder().decode(bytes.subarray(8, 28)).toLowerCase().includes("avif")) detected = "image/avif";
  if (!detected) return "";
  return detected;
}

async function sha256Hex(bytes: Uint8Array) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
}

async function stableOperationId(prefix: string, value: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return `${prefix}-${Array.from(digest.subarray(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

async function requireProject(projectId: string) {
  const [project] = await getDb().select().from(automaticProjects).where(eq(automaticProjects.id, projectId)).limit(1);
  if (!project) throw new Error("PROJECT_NOT_FOUND");
  return project;
}

async function bumpProductionRevision(projectId: string, event: string, detail: Record<string, unknown>) {
  const db = getDb(), at = now();
  await db.update(automaticProjects).set({ productionRevision: sql`${automaticProjects.productionRevision} + 1`, updatedAt: at }).where(eq(automaticProjects.id, projectId));
  await db.insert(automaticProjectEvents).values({ id: makeId("PEVT"), projectId, event, status: "PRODUCTION_CHANGED", detail: JSON.stringify(detail), createdAt: at });
}

async function logProductionEvent(projectId: string, event: string, status: string, detail: Record<string, unknown>) {
  await getDb().insert(automaticProjectEvents).values({ id: makeId("PEVT"), projectId, event, status, detail: JSON.stringify(detail), createdAt: now() });
}

function normalizeThumbRow(row: typeof projectProductionAssets.$inferSelect) {
  return {
    ...row,
    download_path: `/api/projects/${encodeURIComponent(row.projectId)}/production?thumb_id=${encodeURIComponent(row.id)}`,
  };
}

export async function pushProjectThumbnailFileBytes(bytes: Uint8Array, fileName: string, mimeHint: string, context: ProjectThumbInput) {
  const projectId = clean(context.project_id);
  if (!projectId) throw new Error("PROJECT_ID_REQUIRED");
  await requireProject(projectId);
  if (!bytes.byteLength) throw new Error("EMPTY_FILE");
  if (bytes.byteLength > MAX_THUMB_BYTES) throw new Error("THUMB_LIMIT_25_MB");
  const mime = sniffMime(bytes, mimeHint);
  if (!mime || !THUMB_MIMES.has(mime)) throw new Error("THUMB_INVALID_MIME");
  const sha256 = await sha256Hex(bytes), variant = clean(context.variant || context.variante), agentOrigin = clean(context.agent_origin || context.agente_origem);
  const operationId = clean(context.operation_id) || await stableOperationId("THOP", `${projectId}|${sha256}|${variant}|${agentOrigin}`);
  const db = getDb();
  const [existingOperation] = await db.select().from(projectProductionAssets).where(eq(projectProductionAssets.operationId, operationId)).limit(1);
  if (existingOperation) return { status: "IDEMPOTENT_REUSED", candidate: normalizeThumbRow(existingOperation) };

  const [sameProjectFile] = await db.select().from(projectProductionAssets).where(and(eq(projectProductionAssets.projectId, projectId), eq(projectProductionAssets.kind, "THUMB"), eq(projectProductionAssets.sha256, sha256))).orderBy(desc(projectProductionAssets.createdAt)).limit(1);
  const [catalogAsset] = sameProjectFile ? [] : await db.select().from(assets).where(eq(assets.sha256, sha256)).orderBy(desc(assets.createdAt)).limit(1);
  const id = makeId("PTHUMB"), at = now();
  const rawName = safeName(clean(context.name) || fileName || `thumb-${id}`);
  const inputName = rawName.includes(".") ? rawName : `${rawName}.${extensionForMime(mime)}`;
  let r2Key = sameProjectFile?.r2Key || catalogAsset?.r2Key || "";
  let storedNewBytes = false;
  if (!r2Key) {
    const ext = inputName.includes(".") ? "" : `.${extensionForMime(mime)}`;
    r2Key = `projects/${projectId}/production/thumbs/${id}-${inputName}${ext}`;
    await env.BUCKET.put(r2Key, bytes, { httpMetadata: { contentType: mime }, customMetadata: { projectId, productionKind: "THUMB", sha256, originalName: inputName } });
    storedNewBytes = true;
  }
  const sourceType = clean(context.source_type).toUpperCase() || "CHAT_FILE";
  const sourceUrl = sourceType === "CHAT_FILE" ? `chat-file://${encodeURIComponent(inputName)}` : clean(context.source_url) || null;
  try {
    await db.insert(projectProductionAssets).values({
      id, operationId, projectId, kind: "THUMB", name: inputName,
      variant: variant || null, agentOrigin: agentOrigin || null,
      note: clean(context.observation || context.observacao) || null,
      status: "THUMB_CANDIDATE", selected: false, sourceType, sourceUrl,
      r2Key, mimeType: mime, sizeBytes: bytes.byteLength, sha256, createdAt: at, updatedAt: at,
    });
  } catch (error) {
    if (storedNewBytes) await env.BUCKET.delete(r2Key).catch(() => undefined);
    const [winner] = await db.select().from(projectProductionAssets).where(eq(projectProductionAssets.operationId, operationId)).limit(1);
    if (winner) return { status: "IDEMPOTENT_REUSED", candidate: normalizeThumbRow(winner) };
    throw error;
  }
  await bumpProductionRevision(projectId, "production_thumb_pushed", { thumb_id: id, operation_id: operationId, source_type: sourceType, sha256, reused_r2: !storedNewBytes, agent_origin: agentOrigin || null });
  const [row] = await db.select().from(projectProductionAssets).where(eq(projectProductionAssets.id, id)).limit(1);
  return { status: sameProjectFile || catalogAsset ? "DUPLICATE_REUSED" : "THUMB_CANDIDATE", candidate: normalizeThumbRow(row) };
}

export async function pushProjectThumbnailUrl(input: ProjectThumbInput) {
  const projectId = clean(input.project_id), sourceUrl = clean(input.source_url), operationId = clean(input.operation_id);
  if (!projectId) throw new Error("PROJECT_ID_REQUIRED");
  if (operationId) {
    const [existing] = await getDb().select().from(projectProductionAssets).where(eq(projectProductionAssets.operationId, operationId)).limit(1);
    if (existing) return { status:"IDEMPOTENT_REUSED", candidate:normalizeThumbRow(existing) };
  }
  if (!sourceUrl.startsWith("https://") && !sourceUrl.startsWith("http://")) throw new Error("SOURCE_URL_INVALID");
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response: Response;
  try { response = await fetch(sourceUrl, { signal: controller.signal, redirect: "follow" }); }
  catch (error) { throw new Error(error instanceof Error && error.name === "AbortError" ? "FAILED_DOWNLOAD_TIMEOUT" : "FAILED_DOWNLOAD"); }
  finally { clearTimeout(timer); }
  if (!response.ok) throw new Error(`FAILED_HTTP_${response.status}`);
  const length = Number(response.headers.get("content-length") || 0);
  if (length > MAX_THUMB_BYTES) throw new Error("THUMB_LIMIT_25_MB");
  const bytes = new Uint8Array(await response.arrayBuffer());
  const urlName = (() => { try { return decodeURIComponent(new URL(sourceUrl).pathname.split("/").pop() || ""); } catch { return ""; } })();
  return pushProjectThumbnailFileBytes(bytes, clean(input.name) || urlName || "thumb", response.headers.get("content-type") || "", { ...input, source_type: clean(input.source_type) || "WEB", source_url: sourceUrl });
}

export async function pushProjectThumbnailUrlBatch(projectId: string, items: ProjectThumbInput[]) {
  const pid = clean(projectId);
  if (!pid) throw new Error("PROJECT_ID_REQUIRED");
  await requireProject(pid);
  if (!Array.isArray(items) || !items.length) throw new Error("ITEMS_REQUIRED");
  if (items.length > MAX_BATCH_ITEMS) throw new Error("FAST_PUSH_BATCH_LIMIT_20");
  const results: Array<Record<string, unknown>> = [];
  for (let index = 0; index < items.length; index += 4) {
    const group = items.slice(index, index + 4);
    const settled = await Promise.all(group.map(async (item, localIndex) => {
      try { return { index: index + localIndex + 1, ok: true, ...(await pushProjectThumbnailUrl({ ...item, project_id: pid })) } as Record<string, unknown>; }
      catch (error) { return { index: index + localIndex + 1, ok: false, status: error instanceof Error ? error.message : "FAILED" } as Record<string, unknown>; }
    }));
    results.push(...settled);
  }
  return { project_id: pid, total: items.length, successful: results.filter((row) => row.ok).length, failed: results.filter((row) => !row.ok).length, results };
}

export async function pushProjectTitles(projectId: string, titles: ProjectTitleInput[]) {
  const pid = clean(projectId);
  if (!pid) throw new Error("PROJECT_ID_REQUIRED");
  await requireProject(pid);
  if (!Array.isArray(titles) || !titles.length) throw new Error("TITLES_REQUIRED");
  if (titles.length > MAX_BATCH_ITEMS) throw new Error("FAST_PUSH_TITLES_LIMIT_20");
  const db = getDb(), results: Array<Record<string, unknown>> = [];
  let changed = 0;
  for (let index = 0; index < titles.length; index++) {
    const input = titles[index], textValue = clean(input.text || input.texto);
    if (!textValue) { results.push({ index: index + 1, ok: false, status: "TITLE_EMPTY" }); continue; }
    const variant = clean(input.variant || input.variante), agent = clean(input.agent_origin || input.agente_origem);
    const operationId = clean(input.operation_id) || await stableOperationId("TIOP", `${pid}|${textValue}|${variant}|${agent}`);
    const [existing] = await db.select().from(projectTitleCandidates).where(eq(projectTitleCandidates.operationId, operationId)).limit(1);
    if (existing) { results.push({ index: index + 1, ok: true, status: "IDEMPOTENT_REUSED", candidate: existing }); continue; }
    const id = makeId("PTITLE"), at = now(), score = Number.isFinite(Number(input.score)) ? Math.max(0, Math.min(100, Math.round(Number(input.score)))) : null;
    await db.insert(projectTitleCandidates).values({
      id, operationId, projectId: pid, text: textValue, variant: variant || null, agentOrigin: agent || null,
      note: clean(input.observation || input.observacao) || null, score,
      status: "TITLE_CANDIDATE", selected: false, createdAt: at, updatedAt: at,
    });
    changed++;
    results.push({ index: index + 1, ok: true, status: "TITLE_CANDIDATE", candidate_id: id, operation_id: operationId, text: textValue });
  }
  if (changed) await bumpProductionRevision(pid, "production_titles_pushed", { inserted: changed, total: titles.length });
  return { project_id: pid, total: titles.length, inserted: changed, reused: results.filter((row) => row.status === "IDEMPOTENT_REUSED").length, failed: results.filter((row) => !row.ok).length, results };
}

export async function decideProjectThumbnails(idsInput: unknown, decisionInput: string, source: DecisionSource = "SUPERVISOR", note = "") {
  const ids = [...new Set((Array.isArray(idsInput) ? idsInput : [idsInput]).map(clean).filter(Boolean))].slice(0, 100);
  const decision = clean(decisionInput).toUpperCase() as Decision;
  if (!ids.length) throw new Error("CANDIDATE_IDS_REQUIRED");
  if (!["APPROVE", "REJECT", "SELECT"].includes(decision)) throw new Error("DECISION_INVALID");
  const db = getDb(), rows = await db.select().from(projectProductionAssets).where(inArray(projectProductionAssets.id, ids));
  const results: Array<Record<string, unknown>> = [], changedProjects = new Set<string>();
  for (const row of rows) {
    let status = row.status, selected = row.selected, changed = false;
    if (decision === "APPROVE") {
      if (row.status !== "THUMB_APPROVED") { status = "THUMB_APPROVED"; changed = true; }
    } else if (decision === "REJECT") {
      if (row.status !== "THUMB_REJECTED" || row.selected) { status = "THUMB_REJECTED"; selected = false; changed = true; }
    } else {
      const [currentSelected] = await db.select({ id: projectProductionAssets.id }).from(projectProductionAssets).where(and(eq(projectProductionAssets.projectId, row.projectId), eq(projectProductionAssets.kind, "THUMB"), eq(projectProductionAssets.selected, true))).limit(1);
      if (!row.selected || row.status !== "THUMB_APPROVED" || (currentSelected && currentSelected.id !== row.id)) changed = true;
      if (changed) await db.update(projectProductionAssets).set({ selected: false, updatedAt: now() }).where(and(eq(projectProductionAssets.projectId, row.projectId), eq(projectProductionAssets.kind, "THUMB")));
      status = "THUMB_APPROVED"; selected = true;
    }
    if (changed) {
      const at = now();
      await db.update(projectProductionAssets).set({ status, selected, decisionSource: clean(source) || "SUPERVISOR", decisionNote: clean(note) || null, decidedAt: at, updatedAt: at }).where(eq(projectProductionAssets.id, row.id));
      changedProjects.add(row.projectId);
    }
    results.push({ candidate_id: row.id, project_id: row.projectId, decision, status, selected, changed });
  }
  for (const projectId of changedProjects) await bumpProductionRevision(projectId, "production_thumb_decision", { decision, source, candidate_ids: results.filter((row) => row.project_id === projectId && row.changed).map((row) => row.candidate_id) });
  return { decision, requested: ids.length, found: rows.length, changed: results.filter((row) => row.changed).length, results };
}

export async function decideProjectTitles(idsInput: unknown, decisionInput: string, source: DecisionSource = "SUPERVISOR", note = "") {
  const ids = [...new Set((Array.isArray(idsInput) ? idsInput : [idsInput]).map(clean).filter(Boolean))].slice(0, 100);
  const decision = clean(decisionInput).toUpperCase() as Decision;
  if (!ids.length) throw new Error("CANDIDATE_IDS_REQUIRED");
  if (!["APPROVE", "REJECT", "SELECT"].includes(decision)) throw new Error("DECISION_INVALID");
  const db = getDb(), rows = await db.select().from(projectTitleCandidates).where(inArray(projectTitleCandidates.id, ids));
  const results: Array<Record<string, unknown>> = [], changedProjects = new Set<string>();
  for (const row of rows) {
    let status = row.status, selected = row.selected, changed = false;
    if (decision === "APPROVE") {
      if (row.status !== "TITLE_APPROVED") { status = "TITLE_APPROVED"; changed = true; }
    } else if (decision === "REJECT") {
      if (row.status !== "TITLE_REJECTED" || row.selected) { status = "TITLE_REJECTED"; selected = false; changed = true; }
    } else {
      const [currentSelected] = await db.select({ id: projectTitleCandidates.id }).from(projectTitleCandidates).where(and(eq(projectTitleCandidates.projectId, row.projectId), eq(projectTitleCandidates.selected, true))).limit(1);
      if (!row.selected || row.status !== "TITLE_APPROVED" || (currentSelected && currentSelected.id !== row.id)) changed = true;
      if (changed) await db.update(projectTitleCandidates).set({ selected: false, updatedAt: now() }).where(eq(projectTitleCandidates.projectId, row.projectId));
      status = "TITLE_APPROVED"; selected = true;
    }
    if (changed) {
      const at = now();
      await db.update(projectTitleCandidates).set({ status, selected, decisionSource: clean(source) || "SUPERVISOR", decisionNote: clean(note) || null, decidedAt: at, updatedAt: at }).where(eq(projectTitleCandidates.id, row.id));
      changedProjects.add(row.projectId);
    }
    results.push({ candidate_id: row.id, project_id: row.projectId, decision, status, selected, changed });
  }
  for (const projectId of changedProjects) await bumpProductionRevision(projectId, "production_title_decision", { decision, source, candidate_ids: results.filter((row) => row.project_id === projectId && row.changed).map((row) => row.candidate_id) });
  return { decision, requested: ids.length, found: rows.length, changed: results.filter((row) => row.changed).length, results };
}

async function latestProjectFiles(projectId: string) {
  const rows = await getDb().select().from(automaticProjectFiles).where(eq(automaticProjectFiles.projectId, projectId)).orderBy(desc(automaticProjectFiles.version), desc(automaticProjectFiles.createdAt));
  return {
    rows,
    script: rows.find((row) => row.role === "SCRIPT") || null,
    requirements: rows.find((row) => row.role === "REQUIREMENTS") || null,
  };
}

async function readR2Text(r2Key: string | null | undefined) {
  if (!r2Key) return "";
  const object = await env.BUCKET.get(r2Key);
  if (!object) return "";
  return new TextDecoder().decode(await object.arrayBuffer());
}

export async function getProjectProductionPackage(projectId: string) {
  const project = await requireProject(clean(projectId));
  const db = getDb();
  const [files, thumbs, titles, itemRows] = await Promise.all([
    latestProjectFiles(project.id),
    db.select().from(projectProductionAssets).where(and(eq(projectProductionAssets.projectId, project.id), eq(projectProductionAssets.kind, "THUMB"))).orderBy(desc(projectProductionAssets.createdAt)),
    db.select().from(projectTitleCandidates).where(eq(projectTitleCandidates.projectId, project.id)).orderBy(desc(projectTitleCandidates.createdAt)),
    db.select({ item: automaticProjectItems, asset: assets }).from(automaticProjectItems).leftJoin(assets, eq(automaticProjectItems.linkedAssetId, assets.id)).where(and(eq(automaticProjectItems.projectId, project.id), eq(automaticProjectItems.version, project.activeVersion))).orderBy(asc(automaticProjectItems.priority)),
  ]);
  const resolvedImages = itemRows.filter((row) => RESOLVED_ITEM_STATUSES.has(row.item.status) && row.asset?.r2Key);
  const selectedThumb = thumbs.find((row) => row.selected && row.status !== "THUMB_REJECTED") || null;
  const selectedTitle = titles.find((row) => row.selected && row.status !== "TITLE_REJECTED") || null;
  const agents = [...new Set([...thumbs.map((row) => row.agentOrigin), ...titles.map((row) => row.agentOrigin)].filter((value): value is string => Boolean(value)))];
  return {
    project_id: project.id,
    project_name: project.name,
    project_status: project.status,
    project_domain: project.projectDomain,
    active_version: project.activeVersion,
    production_revision: project.productionRevision,
    production_zip_revision: project.productionZipRevision,
    production_zip_current: Boolean(project.productionZipR2Key && project.productionZipRevision === project.productionRevision),
    production_zip: project.productionZipR2Key ? { r2_key: project.productionZipR2Key, file_name: project.productionZipFileName, size_bytes: project.productionZipSizeBytes, revision: project.productionZipRevision, download_path: `/api/projects/${encodeURIComponent(project.id)}/production-zip` } : null,
    script: files.script,
    requirements: files.requirements,
    images: resolvedImages.map(({ item, asset }) => ({ item_id: item.id, item_key: item.itemKey, target_file: item.targetFile, status: item.status, asset_id: asset?.id, name: asset?.name, r2_key: asset?.r2Key, mime_type: asset?.mimeType, size_bytes: asset?.sizeBytes })),
    thumbs: thumbs.map(normalizeThumbRow),
    titles,
    selected_thumb: selectedThumb ? normalizeThumbRow(selectedThumb) : null,
    selected_title: selectedTitle,
    contributing_agents: agents,
    metrics: {
      images_resolved: resolvedImages.length,
      thumbs_total: thumbs.length,
      thumbs_candidates: thumbs.filter((row) => row.status === "THUMB_CANDIDATE").length,
      thumbs_approved: thumbs.filter((row) => row.status === "THUMB_APPROVED").length,
      thumbs_rejected: thumbs.filter((row) => row.status === "THUMB_REJECTED").length,
      titles_total: titles.length,
      titles_candidates: titles.filter((row) => row.status === "TITLE_CANDIDATE").length,
      titles_approved: titles.filter((row) => row.status === "TITLE_APPROVED").length,
      titles_rejected: titles.filter((row) => row.status === "TITLE_REJECTED").length,
    },
  };
}

function productionFileName(projectName: string) {
  const base = safeName(projectName).replace(/\s+/g, "_").replace(/_+/g, "_").toUpperCase().slice(0, 100) || "PROJETO";
  return `${base}_PRODUCAO.zip`;
}

function uniqueZipName(name: string, used: Set<string>) {
  const safe = safeName(name);
  if (!used.has(safe)) { used.add(safe); return safe; }
  const dot = safe.lastIndexOf("."), stem = dot > 0 ? safe.slice(0, dot) : safe, ext = dot > 0 ? safe.slice(dot) : "";
  let index = 2, candidate = `${stem}-${index}${ext}`;
  while (used.has(candidate)) candidate = `${stem}-${++index}${ext}`;
  used.add(candidate); return candidate;
}

export async function exportCompleteProjectZip(projectId: string) {
  const pid = clean(projectId), project = await requireProject(pid), db = getDb();
  const files = await latestProjectFiles(pid);
  const entries: Record<string, Uint8Array> = {};
  const scriptText = await readR2Text(files.script?.r2Key);
  const requirementsText = await readR2Text(files.requirements?.r2Key);
  entries["ROTEIRO.txt"] = strToU8(scriptText || "ROTEIRO NÃO ANEXADO\n");
  entries["IMAGENS_NECESSARIAS.txt"] = strToU8(requirementsText || "IMAGENS NECESSÁRIAS NÃO ANEXADAS\n");

  const itemRows = await db.select({ item: automaticProjectItems, asset: assets }).from(automaticProjectItems).leftJoin(assets, eq(automaticProjectItems.linkedAssetId, assets.id)).where(and(eq(automaticProjectItems.projectId, pid), eq(automaticProjectItems.version, project.activeVersion))).orderBy(asc(automaticProjectItems.priority));
  const usedImages = new Set<string>();
  let totalBytes = entries["ROTEIRO.txt"].byteLength + entries["IMAGENS_NECESSARIAS.txt"].byteLength, imageCount = 0;
  for (const { item, asset } of itemRows) {
    if (!RESOLVED_ITEM_STATUSES.has(item.status) || !asset?.r2Key) continue;
    const object = await env.BUCKET.get(asset.r2Key);
    if (!object) continue;
    const bytes = new Uint8Array(await object.arrayBuffer());
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_PRODUCTION_ZIP_BYTES) throw new Error("PRODUCTION_ZIP_LIMIT_180_MB");
    const target = uniqueZipName(item.targetFile || asset.originalName || `${item.itemKey}.${extensionForMime(asset.mimeType)}`, usedImages);
    entries[`IMAGENS/${target}`] = bytes; imageCount++;
  }

  const thumbRows = await db.select().from(projectProductionAssets).where(and(eq(projectProductionAssets.projectId, pid), eq(projectProductionAssets.kind, "THUMB"))).orderBy(asc(projectProductionAssets.createdAt));
  const usedThumbs = new Set<string>();
  let thumbCount = 0;
  for (const thumb of thumbRows) {
    if (thumb.status === "THUMB_REJECTED") continue;
    const object = await env.BUCKET.get(thumb.r2Key);
    if (!object) continue;
    const bytes = new Uint8Array(await object.arrayBuffer());
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_PRODUCTION_ZIP_BYTES) throw new Error("PRODUCTION_ZIP_LIMIT_180_MB");
    const base = thumb.selected ? `SELECIONADA-${thumb.name}` : thumb.name;
    entries[`THUMBS/${uniqueZipName(base, usedThumbs)}`] = bytes; thumbCount++;
  }

  const titleRows = await db.select().from(projectTitleCandidates).where(eq(projectTitleCandidates.projectId, pid)).orderBy(asc(projectTitleCandidates.createdAt));
  const selectedTitle = titleRows.find((row) => row.selected && row.status !== "TITLE_REJECTED") || null;
  const otherTitles = titleRows.filter((row) => row.status !== "TITLE_REJECTED" && row.id !== selectedTitle?.id);
  const titlesText = [
    "TÍTULO APROVADO:", selectedTitle?.text || "Nenhum título selecionado.", "",
    "OUTRAS IDEIAS:", ...(otherTitles.length ? otherTitles.map((row, index) => `${index + 1}. ${row.text}${row.status === "TITLE_APPROVED" ? " [APROVADO]" : ""}`) : ["Nenhuma outra ideia ativa."]), "",
  ].join("\n");
  entries["TITULOS.txt"] = strToU8(titlesText);

  const selectedThumb = thumbRows.find((row) => row.selected && row.status !== "THUMB_REJECTED") || null;
  const contributors = [...new Set([...thumbRows.map((row) => row.agentOrigin), ...titleRows.map((row) => row.agentOrigin)].filter((value): value is string => Boolean(value)))];
  const metadata = {
    project_id: project.id,
    nome: project.name,
    universo: itemRows.find((row) => clean(row.item.universe))?.item.universe || null,
    status: project.status,
    active_version: project.activeVersion,
    production_revision: project.productionRevision,
    titulo_aprovado: selectedTitle?.text || null,
    titulo_id: selectedTitle?.id || null,
    thumb_aprovada: selectedThumb?.name || null,
    thumb_id: selectedThumb?.id || null,
    quantidade_imagens: imageCount,
    quantidade_thumbs: thumbCount,
    data_exportacao: new Date().toISOString(),
    versoes_arquivos: { roteiro: files.script?.version || null, imagens_necessarias: files.requirements?.version || null },
    agentes_que_contribuiram: contributors,
  };
  entries["PROJETO.json"] = strToU8(JSON.stringify(metadata, null, 2));

  const zip = zipSync(entries, { level: 6 });
  if (zip.byteLength > MAX_PRODUCTION_ZIP_BYTES) throw new Error("PRODUCTION_ZIP_LIMIT_180_MB");
  const fileName = productionFileName(project.name), r2Key = `projects/${pid}/production/exports/r${project.productionRevision}-${Date.now()}-${fileName}`;
  await env.BUCKET.put(r2Key, zip, { httpMetadata: { contentType: "application/zip", contentDisposition: `attachment; filename=\"${fileName.replace(/[\"\\\r\n]/g, "-")}\"` }, customMetadata: { projectId: pid, productionRevision: String(project.productionRevision), packageType: "PRODUCTION_COMPLETE" } });
  const previousKey = project.productionZipR2Key;
  await db.update(automaticProjects).set({ productionZipR2Key: r2Key, productionZipFileName: fileName, productionZipSizeBytes: zip.byteLength, productionZipRevision: project.productionRevision, updatedAt: now() }).where(eq(automaticProjects.id, pid));
  if (previousKey && previousKey !== r2Key && previousKey.startsWith(`projects/${pid}/production/exports/`)) await env.BUCKET.delete(previousKey).catch(() => undefined);
  await logProductionEvent(pid, "production_zip_exported", "READY", { production_revision: project.productionRevision, file_name: fileName, bytes: zip.byteLength, images: imageCount, thumbs: thumbCount, titles: titleRows.length });
  const freshPackage = await getProjectProductionPackage(pid);
  return { project_id: pid, production_revision: project.productionRevision, production_zip_revision: project.productionRevision, r2Key, r2_key: r2Key, fileName, file_name: fileName, sizeBytes: zip.byteLength, size_bytes: zip.byteLength, images: imageCount, thumbs: thumbCount, titles: titleRows.length, package: freshPackage };
}

export async function getProductionThumbFile(projectId: string, thumbId: string) {
  const [row] = await getDb().select().from(projectProductionAssets).where(and(eq(projectProductionAssets.projectId, clean(projectId)), eq(projectProductionAssets.id, clean(thumbId)), eq(projectProductionAssets.kind, "THUMB"))).limit(1);
  if (!row) throw new Error("THUMB_NOT_FOUND");
  const object = await env.BUCKET.get(row.r2Key);
  if (!object) throw new Error("THUMB_R2_NOT_FOUND");
  return { row, object };
}
