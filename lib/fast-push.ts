import { env } from "./platform/runtime";
import { toArrayBuffer } from "./web-crypto";
import { and, desc, eq, inArray, like, or, sql } from "drizzle-orm";
import { getDb } from "../db";
import { assetUsage, assets, automaticProjectItems, automaticProjects, fastPushCandidates, materializationBatches, materializationCandidates, materializationFiles, materializationItems, projectProductionAssets, supervisorDecisionQueue, supervisorProjectCandidates } from "../db/schema";
import { kindFromMediaMime, resolveMediaMime } from "./media-mime";
import { bridgeMaterializationToSupervisor } from "./supervisor-materialization-bridge";

const MAX_BATCH_ITEMS = 20;
const MAX_DECISION_ITEMS = 200;
const ACTIVE_DECISION_STATUSES = ["PENDING_ANALYSIS", "DUPLICATE_REUSED", "APPROVED_CANDIDATE"] as const;
const MAX_ITEM_BYTES = 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 12_000;
const PARALLELISM = 4;
const SUPPORTED_MIME = new Set([
  "image/png", "image/jpeg", "image/webp", "image/gif", "image/avif", "image/svg+xml",
  "video/mp4", "video/webm", "video/quicktime", "video/x-m4v",
]);

export type FastPushInput = {
  operation_id?: string;
  batch_id?: string;
  project_id?: string;
  item_id?: string;
  project_item_id?: string;
  item_projeto_id?: string;
  slot?: string;
  target_name?: string;
  target_file?: string;
  source_url?: string;
  source_type?: string;
  universe?: string;
  subject?: string;
  concept?: string;
  visual_reference?: string;
  semantic_reference?: string;
  script_reference?: string;
  scene?: string;
  arc?: string;
  episode_candidate?: string;
  composition_class?: string;
  tags?: string[];
  used_for?: string;
  priority?: number;
  search_metadata?: unknown;
};

type FastPushDecision = "MANUAL" | "SUPERVISOR" | "AI";

function clean(value: unknown) { return String(value ?? "").trim(); }
function safeJson(value: unknown, fallback: unknown = {}) { try { return JSON.stringify(value ?? fallback); } catch { return JSON.stringify(fallback); } }
function parseJson<T>(value: string | null | undefined, fallback: T): T { try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; } }
function id(prefix: string) { return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`; }
function now() { return new Date(); }
function tagsOf(value: unknown) { return [...new Set((Array.isArray(value) ? value : []).map(clean).filter(Boolean))].slice(0, 40); }
function safeName(value: string) { return (value || "candidate").replace(/[\\/]/g, "-").replace(/[^a-zA-Z0-9À-ÿ._ -]/g, "-").slice(0, 180) || "candidate"; }
function urlFileName(sourceUrl: string) { try { return decodeURIComponent(new URL(sourceUrl).pathname.split("/").pop() || ""); } catch { return ""; } }
function extOf(value: string) { const cleanValue = value.split(/[?#]/, 1)[0]; const dot = cleanValue.lastIndexOf("."); return dot >= 0 ? cleanValue.slice(dot + 1).toLowerCase() : ""; }
function extForMime(mime: string) {
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  if (mime === "image/gif") return "gif";
  if (mime === "image/avif") return "avif";
  if (mime === "image/svg+xml") return "svg";
  if (mime === "video/webm") return "webm";
  if (mime === "video/quicktime") return "mov";
  if (mime === "video/x-m4v") return "m4v";
  return "mp4";
}
function normalizeMime(value: string | null) { return clean(value).toLowerCase().split(";", 1)[0]; }

function looksLike(bytes: Uint8Array, mime: string) {
  if (mime === "image/png") return bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (mime === "image/jpeg") return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === "image/gif") return bytes.length > 6 && new TextDecoder().decode(bytes.subarray(0, 6)).startsWith("GIF8");
  if (mime === "image/webp") return bytes.length > 12 && new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP";
  if (mime === "image/avif") return bytes.length > 16 && new TextDecoder().decode(bytes.subarray(4, 12)).includes("ftyp") && new TextDecoder().decode(bytes.subarray(8, 24)).toLowerCase().includes("avif");
  if (mime === "image/svg+xml") { const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 1024))).toLowerCase(); return head.includes("<svg") && !head.includes("<html"); }
  if (mime === "video/webm") return bytes.length > 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  if (["video/mp4", "video/quicktime", "video/x-m4v"].includes(mime)) return bytes.length > 12 && new TextDecoder().decode(bytes.subarray(4, 12)).includes("ftyp");
  return false;
}

async function sha256Hex(bytes: Uint8Array) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes)));
  return Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
}

function normalizeCandidate(row: typeof fastPushCandidates.$inferSelect) {
  return {
    ...row,
    tags: parseJson<string[]>(row.tags, []),
    searchMetadata: parseJson<Record<string, unknown>>(row.searchMetadata, {}),
  };
}

function normalizeKey(value: unknown) {
  return clean(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR").replace(/[^a-z0-9]+/g, " ").trim();
}

async function stableId(prefix: string, value: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return `${prefix}-${Array.from(digest.subarray(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

const FINAL_PROJECT_ITEM_STATUSES = new Set(["APPROVED", "FROZEN", "LINKED_FROM_LIBRARY", "LINKED_FROM_FAMILY"]);
const LOCKED_PROJECT_STATUSES = new Set(["CONCLUIDO_MANUAL", "COMPLETED", "COMPLETED_WITH_WARNINGS", "FORCED_CLOSED", "CANCELLED", "GROUPED_ARCHIVED"]);

async function resolveFastPushProjectItem(candidate: typeof fastPushCandidates.$inferSelect) {
  if (!candidate.projectId) return { item:null, project:null, reason:"NO_PROJECT", candidates:[] as Array<Record<string, unknown>> };
  const db = getDb();
  const [project] = await db.select().from(automaticProjects).where(eq(automaticProjects.id, candidate.projectId)).limit(1);
  if (!project) return { item:null, project:null, reason:"PROJECT_NOT_FOUND", candidates:[] as Array<Record<string, unknown>> };
  if (LOCKED_PROJECT_STATUSES.has(project.status)) return { item:null, project, reason:"PROJECT_LOCKED", candidates:[] as Array<Record<string, unknown>> };
  const rows = await db.select().from(automaticProjectItems).where(and(eq(automaticProjectItems.projectId, project.id), eq(automaticProjectItems.version, project.activeVersion)));
  const probes = [candidate.projectItemId, candidate.itemId, candidate.slot, candidate.targetName].map(clean).filter(Boolean);
  const normProbes = probes.map(normalizeKey).filter(Boolean);
  const concept = normalizeKey(candidate.concept || candidate.subject);
  const visual = normalizeKey(candidate.visualReference);
  const universe = normalizeKey(candidate.universe);
  const scene = normalizeKey(candidate.scene || candidate.scriptReference);
  const scored = rows.map((item) => {
    let score = 0;
    const reasons:string[] = [];
    const exactPairs:Array<[string | null | undefined, number, string]> = [
      [item.id, 240, "project_item_id"], [item.itemKey, 220, "item_key"], [item.targetFile, 210, "target_file"],
    ];
    for (const [value, weight, reason] of exactPairs) {
      const raw = clean(value);
      if (!raw) continue;
      if (probes.includes(raw)) { score = Math.max(score, weight); reasons.push(`exact_${reason}`); }
      else if (normProbes.includes(normalizeKey(raw))) { score = Math.max(score, weight - 20); reasons.push(`normalized_${reason}`); }
    }
    const term = normalizeKey(item.term);
    const semantic = normalizeKey(item.semanticReference || item.term);
    const itemUniverse = normalizeKey(item.universe);
    const context = normalizeKey(item.context || item.notes);
    if (concept && term && concept === term) { score += 35; reasons.push("concept_term"); }
    if (visual && semantic && visual === semantic) { score += 30; reasons.push("visual_reference"); }
    if (universe && itemUniverse && universe === itemUniverse) { score += 5; reasons.push("universe"); }
    if (scene && context && (context.includes(scene) || scene.includes(context))) { score += 10; reasons.push("scene_context"); }
    return { item, score, reasons };
  }).sort((a,b) => b.score - a.score || a.item.priority - b.item.priority);
  const best = scored[0];
  const candidates = scored.slice(0,5).filter((row) => row.score > 0).map((row) => ({ item_id:row.item.id, item_key:row.item.itemKey, target_file:row.item.targetFile, term:row.item.term, status:row.item.status, score:row.score, reasons:row.reasons }));
  if (!best || best.score < 180) return { item:null, project, reason:"PROJECT_ITEM_NOT_FOUND", candidates };
  if (scored[1] && scored[1].score === best.score && scored[1].item.id !== best.item.id) return { item:null, project, reason:"AMBIGUOUS_PROJECT_ITEM", candidates };
  if (FINAL_PROJECT_ITEM_STATUSES.has(best.item.status)) return { item:best.item, project, reason:"PROJECT_ITEM_ALREADY_RESOLVED", candidates };
  return { item:best.item, project, reason:"MATCHED", candidates };
}

function candidateHost(sourceUrl: string) {
  try { return new URL(sourceUrl).hostname.toLowerCase() || "fast-push"; } catch { return sourceUrl.startsWith("chat-file://") ? "chat-file" : "fast-push"; }
}

async function bridgeFastPushToCanonicalPending(candidateInput: typeof fastPushCandidates.$inferSelect) {
  if (!candidateInput.r2Key || !candidateInput.sha256 || !candidateInput.mimeType) return { linked:false, reason:"CANDIDATE_NOT_MATERIALIZED" };
  // Freeze the materialization-critical fields immediately after the guard.
  // `candidate` is mutable later in this function, so relying on narrowing from
  // candidateInput through that mutable alias makes Drizzle/TS widen them back
  // to `string | null`. These constants remain concrete `string`s.
  const materializedR2Key: string = candidateInput.r2Key;
  const materializedSha256: string = candidateInput.sha256;
  const materializedMimeType: string = candidateInput.mimeType;
  const db = getDb();
  let candidate = candidateInput;
  const resolution = await resolveFastPushProjectItem(candidate);
  if (!candidate.projectId) {
    await db.update(fastPushCandidates).set({ projectLinkStatus:"NO_PROJECT", updatedAt:now() }).where(eq(fastPushCandidates.id, candidate.id));
    return { linked:false, reason:"NO_PROJECT" };
  }
  if (!resolution.item || !resolution.project) {
    await db.update(fastPushCandidates).set({ projectLinkStatus:resolution.reason, updatedAt:now() }).where(eq(fastPushCandidates.id, candidate.id));
    return { linked:false, reason:resolution.reason, candidates:resolution.candidates };
  }
  const item = resolution.item;
  if (FINAL_PROJECT_ITEM_STATUSES.has(item.status)) {
    await db.update(fastPushCandidates).set({ projectItemId:item.id, projectLinkStatus:"PROJECT_ITEM_ALREADY_RESOLVED", linkedAt:now(), updatedAt:now() }).where(eq(fastPushCandidates.id, candidate.id));
    return { linked:false, reason:"PROJECT_ITEM_ALREADY_RESOLVED", project_id:candidate.projectId, item_id:item.id, asset_id:item.linkedAssetId || null };
  }

  const batchId = await stableId("MATFPB", candidate.operationId);
  const matItemId = await stableId("MATFPI", candidate.id);
  const matCandidateId = await stableId("MATFPC", candidate.id);
  const matFileId = await stableId("MATFPF", `${candidate.id}\n${materializedSha256}`);
  const date = now();
  const targetName = safeName(candidate.targetName || item.targetFile || item.itemKey || `${candidate.id}.${extForMime(materializedMimeType)}`);
  const sourceUrl = candidate.sourceUrl || `fast-push://${candidate.id}`;
  const sourceHost = candidateHost(sourceUrl);

  await db.insert(materializationBatches).values({
    id:batchId, project:resolution.project.name, status:"READY_FOR_VISUAL_QA", totalItems:1, completedItems:1, failedItems:0, cancelled:false, createdAt:date, updatedAt:date,
  }).onConflictDoUpdate({ target:materializationBatches.id, set:{ project:resolution.project.name, status:"READY_FOR_VISUAL_QA", totalItems:1, completedItems:1, failedItems:0, updatedAt:date } });

  await db.insert(materializationItems).values({
    id:matItemId, batchId, itemId:item.id, targetName, concept:candidate.concept || candidate.subject || item.term,
    visualReference:candidate.visualReference || item.semanticReference || item.term, universe:candidate.universe || item.universe,
    preset:null, slot:candidate.slot || item.itemKey, kind:"Imagem", subject:candidate.subject, tags:candidate.tags,
    scriptReference:candidate.scriptReference || item.context, usedFor:candidate.usedFor,
    minWidth:64, minHeight:64, requiresAlpha:candidate.compositionClass === "ISOLATED", compositionClass:candidate.compositionClass || item.compositionClass,
    status:"READY_FOR_VISUAL_QA", candidateCursor:0, selectedCandidateId:matCandidateId, selectedFileId:matFileId,
    frozenAssetId:null, failureReason:null, routeClass:"FAST_PUSH_CANONICAL", createdAt:date, updatedAt:date,
  }).onConflictDoUpdate({ target:materializationItems.id, set:{
    itemId:item.id, targetName, concept:candidate.concept || candidate.subject || item.term,
    visualReference:candidate.visualReference || item.semanticReference || item.term, universe:candidate.universe || item.universe,
    slot:candidate.slot || item.itemKey, subject:candidate.subject, tags:candidate.tags, scriptReference:candidate.scriptReference || item.context, usedFor:candidate.usedFor,
    compositionClass:candidate.compositionClass || item.compositionClass, status:"READY_FOR_VISUAL_QA", selectedCandidateId:matCandidateId, selectedFileId:matFileId,
    failureReason:null, routeClass:"FAST_PUSH_CANONICAL", updatedAt:date,
  } });

  await db.insert(materializationCandidates).values({
    id:matCandidateId, itemDbId:matItemId, priority:candidate.priority || 1, source:candidate.sourceType || "FAST_PUSH", originalUrl:sourceUrl,
    resolvedUrl:sourceUrl, host:sourceHost, adapter:"fast-push", status:"MATERIALIZED", failureReason:null, attempts:1,
    httpStatus:sourceUrl.startsWith("http") ? 200 : null, contentType:materializedMimeType, contentLength:candidate.sizeBytes || 0, redirectsCount:0, createdAt:date, updatedAt:date,
  }).onConflictDoUpdate({ target:materializationCandidates.id, set:{ source:candidate.sourceType || "FAST_PUSH", originalUrl:sourceUrl, resolvedUrl:sourceUrl, host:sourceHost, status:"MATERIALIZED", failureReason:null, contentType:materializedMimeType, contentLength:candidate.sizeBytes || 0, updatedAt:date } });

  const materializationFileRow: typeof materializationFiles.$inferInsert = {
    id:matFileId, itemDbId:matItemId, candidateId:matCandidateId, r2Key:materializedR2Key, mimeType:materializedMimeType, sizeBytes:candidate.sizeBytes || 0,
    width:null, height:null, sha256:materializedSha256, originalMimeType:materializedMimeType, originalSha256:materializedSha256,
    conversionType:null, sourceFileId:null, technicalOperation:null, technicalParameters:null, technicalStatus:"TECHNICAL_OK", finalAssetId:candidate.assetId || null, createdAt:date,
  };
  await db.insert(materializationFiles).values(materializationFileRow).onConflictDoNothing();

  const bridged = await bridgeMaterializationToSupervisor(matItemId, { projectId:candidate.projectId, itemId:item.id });
  if (!bridged.linked) {
    await db.update(fastPushCandidates).set({ projectItemId:item.id, projectLinkStatus:`BRIDGE_${bridged.reason || "FAILED"}`, materializationBatchId:batchId, materializationItemId:matItemId, materializationFileId:matFileId, updatedAt:now() }).where(eq(fastPushCandidates.id, candidate.id));
    return { ...bridged, project_id:candidate.projectId, item_id:item.id, materialization_item_id:matItemId };
  }
  const [supervisorCandidate] = await db.select().from(supervisorProjectCandidates).where(and(eq(supervisorProjectCandidates.projectId, candidate.projectId), eq(supervisorProjectCandidates.itemId, item.id), eq(supervisorProjectCandidates.materializationFileId, matFileId))).limit(1);
  const [updated] = await db.update(fastPushCandidates).set({
    itemId:item.id, projectItemId:item.id, projectLinkStatus:supervisorCandidate?.status === "PARA_QA_VISUAL" ? "LINKED_PARA_QA_VISUAL" : "LINKED_PARA_ANALISE",
    materializationBatchId:batchId, materializationItemId:matItemId, materializationFileId:matFileId, supervisorCandidateId:supervisorCandidate?.id || String(bridged.candidate_id || "") || null,
    linkedAt:now(), updatedAt:now(),
  }).where(eq(fastPushCandidates.id, candidate.id)).returning();
  candidate = updated || candidate;
  return { linked:true, reason:"CANONICAL_PENDING_BRIDGE", project_id:candidate.projectId, item_id:item.id, item_key:item.itemKey, target_file:item.targetFile, supervisor_candidate_id:candidate.supervisorCandidateId, supervisor_status:supervisorCandidate?.status || bridged.status, materialization_item_id:matItemId, materialization_file_id:matFileId };
}

async function finalizeCandidateProjectBridge(row: typeof fastPushCandidates.$inferSelect) {
  if (!row.projectId) return normalizeCandidate(row);
  try {
    await bridgeFastPushToCanonicalPending(row);
  } catch (error) {
    await getDb().update(fastPushCandidates).set({ projectLinkStatus:"BRIDGE_ERROR", updatedAt:now() }).where(eq(fastPushCandidates.id, row.id)).catch(() => undefined);
  }
  const [fresh] = await getDb().select().from(fastPushCandidates).where(eq(fastPushCandidates.id, row.id)).limit(1);
  return normalizeCandidate(fresh || row);
}

async function resolveProjectItem(projectId: string, rawItemId: string, slot: string) {
  if (!projectId) return null;
  const db = getDb();
  const probes = [rawItemId, slot].map(clean).filter(Boolean);
  if (!probes.length) return null;
  const conditions = probes.flatMap((probe) => [
    eq(automaticProjectItems.id, probe),
    eq(automaticProjectItems.itemKey, probe),
    eq(automaticProjectItems.targetFile, probe),
  ]);
  const [item] = await db.select().from(automaticProjectItems)
    .where(and(eq(automaticProjectItems.projectId, projectId), or(...conditions)))
    .limit(1);
  return item || null;
}

async function projectUsageName(projectId: string) {
  if (!projectId) return "";
  const [project] = await getDb().select({ name: automaticProjects.name }).from(automaticProjects).where(eq(automaticProjects.id, projectId)).limit(1);
  return project?.name || projectId;
}

async function registerUsageOnce(assetId: string, candidate: typeof fastPushCandidates.$inferSelect, note?: string | null) {
  if (!candidate.projectId) return null;
  const db = getDb();
  const usageProject = await projectUsageName(candidate.projectId);
  const usageId = `USE-FP-${candidate.operationId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80)}`;
  const inserted = await db.insert(assetUsage).values({
    id: usageId,
    assetId,
    project: usageProject,
    slot: candidate.slot || candidate.itemId,
    role: candidate.usedFor,
    scriptReference: candidate.scriptReference,
    note: note || `FAST_PUSH:${candidate.id}`,
    status: "Registrado",
    usedAt: now(),
  }).onConflictDoNothing().returning({ id: assetUsage.id });
  if (inserted.length) {
    await db.update(assets).set({ useCount: sql`${assets.useCount} + 1`, lastUsedAt: now(), updatedAt: now() }).where(eq(assets.id, assetId));
  }
  return inserted[0]?.id || usageId;
}

async function syncCanonicalDecision(candidate: typeof fastPushCandidates.$inferSelect, decision: "APPROVED" | "REJECTED", source: FastPushDecision, note?: string | null, assetId?: string | null) {
  if (!candidate.projectId || !candidate.projectItemId || !candidate.supervisorCandidateId) return { synced:false, reason:"NO_CANONICAL_BRIDGE" };
  const db = getDb();
  const [bridge] = await db.select().from(supervisorProjectCandidates).where(eq(supervisorProjectCandidates.id, candidate.supervisorCandidateId)).limit(1);
  if (!bridge) return { synced:false, reason:"SUPERVISOR_CANDIDATE_NOT_FOUND" };
  const metadata = (() => { try { return JSON.parse(bridge.metadata || "{}") as Record<string, unknown>; } catch { return {}; } })();
  if (decision === "APPROVED") {
    await db.update(supervisorProjectCandidates).set({ status:"PARA_ANALISE", updatedAt:now() }).where(and(eq(supervisorProjectCandidates.projectId, candidate.projectId), eq(supervisorProjectCandidates.itemId, candidate.projectItemId), eq(supervisorProjectCandidates.status, "PARA_QA_VISUAL")));
    await db.update(supervisorProjectCandidates).set({ status:"APROVADO", metadata:safeJson({ ...metadata, qa_decision:"APROVADO", qa_source:source, qa_observation:note || null, fast_push_candidate_id:candidate.id, asset_id:assetId || null, qa_resolved_at:new Date().toISOString() }), updatedAt:now() }).where(eq(supervisorProjectCandidates.id, bridge.id));
    await db.update(supervisorDecisionQueue).set({ state:"RESOLVIDA", candidateId:bridge.id, decision:"APROVADO", observation:note || null, source:source === "AI" ? "AUTOMATICO" : "SUPERVISOR_MCP", resolvedAt:now(), updatedAt:now() }).where(and(eq(supervisorDecisionQueue.projectId, candidate.projectId), eq(supervisorDecisionQueue.itemId, candidate.projectItemId), eq(supervisorDecisionQueue.type, "QA_VISUAL"), eq(supervisorDecisionQueue.state, "PENDENTE")));
    if (candidate.materializationFileId && assetId) await db.update(materializationFiles).set({ finalAssetId:assetId }).where(eq(materializationFiles.id, candidate.materializationFileId));
    if (candidate.materializationItemId && assetId) await db.update(materializationItems).set({ status:"FROZEN", frozenAssetId:assetId, updatedAt:now() }).where(eq(materializationItems.id, candidate.materializationItemId));
    return { synced:true, status:"APROVADO", supervisor_candidate_id:bridge.id };
  }

  const wasActive = bridge.status === "PARA_QA_VISUAL";
  await db.update(supervisorProjectCandidates).set({ status:"REJEITADO", metadata:safeJson({ ...metadata, qa_decision:"REJEITADO", qa_source:source, qa_observation:note || null, fast_push_candidate_id:candidate.id, qa_resolved_at:new Date().toISOString() }), updatedAt:now() }).where(eq(supervisorProjectCandidates.id, bridge.id));
  if (!wasActive) return { synced:true, status:"REJEITADO", supervisor_candidate_id:bridge.id, promoted_next:false };
  const [next] = await db.select().from(supervisorProjectCandidates).where(and(eq(supervisorProjectCandidates.projectId, candidate.projectId), eq(supervisorProjectCandidates.itemId, candidate.projectItemId), eq(supervisorProjectCandidates.status, "PARA_ANALISE"))).orderBy(supervisorProjectCandidates.createdAt).limit(1);
  if (next) {
    await db.update(supervisorProjectCandidates).set({ status:"PARA_QA_VISUAL", updatedAt:now() }).where(eq(supervisorProjectCandidates.id, next.id));
    await db.update(automaticProjectItems).set({ status:"QA_READY", sourceType:"FAST_PUSH", materializationBatchId:next.materializationBatchId, materializationItemId:next.materializationItemId, materializationFileId:next.materializationFileId, failureReason:null, updatedAt:now() }).where(eq(automaticProjectItems.id, candidate.projectItemId));
    await db.update(supervisorDecisionQueue).set({ state:"PENDENTE", candidateId:next.id, decision:null, observation:null, source:"AUTOMATICO", resolvedAt:null, updatedAt:now() }).where(and(eq(supervisorDecisionQueue.projectId, candidate.projectId), eq(supervisorDecisionQueue.itemId, candidate.projectItemId), eq(supervisorDecisionQueue.type, "QA_VISUAL")));
    return { synced:true, status:"REJEITADO", supervisor_candidate_id:bridge.id, promoted_next:true, next_supervisor_candidate_id:next.id };
  }
  await db.update(supervisorDecisionQueue).set({ state:"RESOLVIDA", candidateId:bridge.id, decision:"REJEITADO", observation:note || null, source:source === "AI" ? "AUTOMATICO" : "SUPERVISOR_MCP", resolvedAt:now(), updatedAt:now() }).where(and(eq(supervisorDecisionQueue.projectId, candidate.projectId), eq(supervisorDecisionQueue.itemId, candidate.projectItemId), eq(supervisorDecisionQueue.type, "QA_VISUAL"), eq(supervisorDecisionQueue.state, "PENDENTE")));
  await db.update(automaticProjectItems).set({ status:"RELINK_REQUIRED", failureReason:"FAST_PUSH_CANDIDATES_REJECTED", updatedAt:now() }).where(and(eq(automaticProjectItems.id, candidate.projectItemId), eq(automaticProjectItems.status, "QA_READY")));
  return { synced:true, status:"REJEITADO", supervisor_candidate_id:bridge.id, promoted_next:false };
}

async function linkProjectSlot(assetId: string, candidate: typeof fastPushCandidates.$inferSelect) {
  if (!candidate.projectId) return { linked: false, reason: "NO_PROJECT" };
  const item = candidate.projectItemId
    ? (await getDb().select().from(automaticProjectItems).where(and(eq(automaticProjectItems.id, candidate.projectItemId), eq(automaticProjectItems.projectId, candidate.projectId))).limit(1))[0]
    : await resolveProjectItem(candidate.projectId, candidate.itemId || "", candidate.slot || "");
  if (!item) return { linked: false, reason: "PROJECT_ITEM_NOT_FOUND" };
  await getDb().update(automaticProjectItems).set({
    linkedAssetId: assetId,
    status: "FROZEN",
    sourceType: candidate.sourceType || "FAST_PUSH",
    failureReason: null,
    updatedAt: now(),
  }).where(eq(automaticProjectItems.id, item.id));
  await getDb().update(automaticProjects).set({ lastAction: "FAST_PUSH_PROMOTED", stateVersion: sql`${automaticProjects.stateVersion} + 1`, updatedAt: now() }).where(eq(automaticProjects.id, candidate.projectId));
  return { linked: true, item_id: item.id, item_key: item.itemKey, target_file: item.targetFile };
}

function rowFromInput(candidateId: string, input: FastPushInput, sourceUrl: string, status = "INGESTING") {
  const operationId = clean(input.operation_id);
  const slot = clean(input.slot || input.item_id);
  return {
    id: candidateId,
    operationId,
    batchId: clean(input.batch_id) || null,
    projectId: clean(input.project_id) || null,
    itemId: clean(input.item_id || input.project_item_id || input.item_projeto_id) || null,
    projectItemId: clean(input.project_item_id || input.item_projeto_id) || null,
    projectLinkStatus: clean(input.project_id) ? "PENDING_PROJECT_BRIDGE" : "NO_PROJECT",
    slot: slot || null,
    targetName: clean(input.target_name || input.target_file) || null,
    sourceUrl,
    sourceType: clean(input.source_type) || "WEB",
    universe: clean(input.universe) || null,
    subject: clean(input.subject) || null,
    concept: clean(input.concept) || clean(input.subject) || clean(input.target_name || input.target_file) || "Candidata",
    visualReference: clean(input.visual_reference || input.semantic_reference) || null,
    scriptReference: clean(input.script_reference) || null,
    scene: clean(input.scene) || null,
    arc: clean(input.arc) || null,
    episodeCandidate: clean(input.episode_candidate) || null,
    compositionClass: clean(input.composition_class) || null,
    tags: safeJson(tagsOf(input.tags), []),
    usedFor: clean(input.used_for) || null,
    priority: Number.isFinite(Number(input.priority)) ? Math.max(0, Math.min(100, Number(input.priority))) : 1,
    searchMetadata: safeJson(input.search_metadata, {}),
    status,
    createdAt: now(),
    updatedAt: now(),
  };
}

async function beginCandidate(input: FastPushInput, sourceUrl: string) {
  const operationId = clean(input.operation_id);
  if (!operationId) throw new Error("OPERATION_ID_REQUIRED");
  const db = getDb();
  const [existing] = await db.select().from(fastPushCandidates).where(eq(fastPushCandidates.operationId, operationId)).limit(1);
  if (existing) return { existing, created: false };
  const candidateId = id("FPC");
  try {
    const [created] = await db.insert(fastPushCandidates).values(rowFromInput(candidateId, input, sourceUrl)).returning();
    return { existing: created, created: true };
  } catch (error) {
    const [raceWinner] = await db.select().from(fastPushCandidates).where(eq(fastPushCandidates.operationId, operationId)).limit(1);
    if (raceWinner) return { existing: raceWinner, created: false };
    throw error;
  }
}

async function markFailure(candidateId: string, status: string, reason: string, httpStatus?: number) {
  const [updated] = await getDb().update(fastPushCandidates).set({
    status,
    failureReason: [httpStatus ? `HTTP_${httpStatus}` : "", reason].filter(Boolean).join(":"),
    updatedAt: now(),
  }).where(eq(fastPushCandidates.id, candidateId)).returning();
  return normalizeCandidate(updated);
}

async function persistBytes(candidate: typeof fastPushCandidates.$inferSelect, bytes: Uint8Array, mimeType: string, fileNameHint: string) {
  const db = getDb();
  const digest = await sha256Hex(bytes);
  const [duplicateAsset] = await db.select().from(assets).where(eq(assets.sha256, digest)).limit(1);
  if (duplicateAsset) {
    const [updated] = await db.update(fastPushCandidates).set({
      status: "DUPLICATE_REUSED",
      sha256: digest,
      r2Key: duplicateAsset.r2Key,
      mimeType: duplicateAsset.mimeType,
      sizeBytes: duplicateAsset.sizeBytes,
      assetId: duplicateAsset.id,
      duplicateOfCandidateId: null,
      failureReason: null,
      updatedAt: now(),
    }).where(eq(fastPushCandidates.id, candidate.id)).returning();
    await registerUsageOnce(duplicateAsset.id, updated, "FAST PUSH deduplicou SHA e reutilizou asset existente").catch(() => undefined);
    return finalizeCandidateProjectBridge(updated);
  }
  const [duplicateCandidate] = await db.select().from(fastPushCandidates)
    .where(and(eq(fastPushCandidates.sha256, digest), inArray(fastPushCandidates.status, ["PENDING_ANALYSIS", "APPROVED_CANDIDATE", "PROMOTED_TO_ASSET", "DUPLICATE_REUSED"])))
    .orderBy(desc(fastPushCandidates.createdAt)).limit(1);
  if (duplicateCandidate && duplicateCandidate.id !== candidate.id && duplicateCandidate.r2Key) {
    const [updated] = await db.update(fastPushCandidates).set({
      status: "DUPLICATE_REUSED",
      sha256: digest,
      r2Key: duplicateCandidate.r2Key,
      mimeType: duplicateCandidate.mimeType || mimeType,
      sizeBytes: duplicateCandidate.sizeBytes || bytes.byteLength,
      assetId: duplicateCandidate.assetId,
      duplicateOfCandidateId: duplicateCandidate.id,
      failureReason: null,
      updatedAt: now(),
    }).where(eq(fastPushCandidates.id, candidate.id)).returning();
    if (updated.assetId) await registerUsageOnce(updated.assetId, updated, "FAST PUSH reutilizou candidata já promovida").catch(() => undefined);
    return finalizeCandidateProjectBridge(updated);
  }
  const ext = extForMime(mimeType);
  const hinted = safeName(fileNameHint || candidate.targetName || `${candidate.id}.${ext}`);
  const fileName = extOf(hinted) ? hinted : `${hinted}.${ext}`;
  const r2Key = `fast-push/${candidate.id}/${fileName}`;
  await env.BUCKET.put(r2Key, bytes, { httpMetadata: { contentType: mimeType }, customMetadata: { sha256: digest, operationId: candidate.operationId, fastPush: "true" } });
  const [updated] = await db.update(fastPushCandidates).set({
    status: "PENDING_ANALYSIS",
    sha256: digest,
    r2Key,
    mimeType,
    sizeBytes: bytes.byteLength,
    failureReason: null,
    updatedAt: now(),
  }).where(eq(fastPushCandidates.id, candidate.id)).returning();
  return finalizeCandidateProjectBridge(updated);
}

export async function ingestFastPushUrl(input: FastPushInput) {
  const sourceUrl = clean(input.source_url);
  if (!/^https:\/\//i.test(sourceUrl)) throw new Error("SOURCE_URL_HTTPS_REQUIRED");
  const begin = await beginCandidate(input, sourceUrl);
  if (!begin.created) {
    const replay = begin.existing.r2Key && begin.existing.sha256 && begin.existing.mimeType ? await finalizeCandidateProjectBridge(begin.existing) : normalizeCandidate(begin.existing);
    return { ...replay, idempotent_replay: true };
  }
  const candidate = begin.existing;
  let response: Response;
  try {
    response = await fetch(sourceUrl, { redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { "user-agent": "CorvoLibrary-FastPush/1.0" } });
  } catch (error) {
    return { ...(await markFailure(candidate.id, "FAILED_DOWNLOAD", error instanceof Error ? error.message : "FETCH_FAILED")), idempotent_replay: false };
  }
  if (!response.ok) return { ...(await markFailure(candidate.id, "FAILED_HTTP", response.statusText || "HTTP_ERROR", response.status)), idempotent_replay: false };
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_ITEM_BYTES) return { ...(await markFailure(candidate.id, "FAILED_DOWNLOAD", "FILE_TOO_LARGE")), idempotent_replay: false };
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.byteLength) return { ...(await markFailure(candidate.id, "FAILED_DOWNLOAD", "EMPTY_FILE")), idempotent_replay: false };
  if (bytes.byteLength > MAX_ITEM_BYTES) return { ...(await markFailure(candidate.id, "FAILED_DOWNLOAD", "FILE_TOO_LARGE")), idempotent_replay: false };
  const fileNameHint = clean(input.target_name) || urlFileName(sourceUrl) || candidate.id;
  const declaredMime = normalizeMime(response.headers.get("content-type"));
  const resolvedMime = normalizeMime(resolveMediaMime(declaredMime, fileNameHint, sourceUrl));
  if (!SUPPORTED_MIME.has(resolvedMime) || !looksLike(bytes, resolvedMime)) {
    return { ...(await markFailure(candidate.id, "FAILED_INVALID_MIME", `${declaredMime || "UNKNOWN"}->${resolvedMime || "UNKNOWN"}`)), idempotent_replay: false };
  }
  return { ...(await persistBytes(candidate, bytes, resolvedMime, fileNameHint)), idempotent_replay: false };
}

export async function ingestFastPushFileBytes(bytesInput: Uint8Array | ArrayBuffer, fileName: string, mimeHint: string, input: FastPushInput) {
  const bytes = bytesInput instanceof Uint8Array ? bytesInput : new Uint8Array(bytesInput);
  const preferredName = fileName || clean(input.target_name || input.target_file) || "candidate";
  const pseudoUrl = `chat-file://${safeName(preferredName)}`;
  const begin = await beginCandidate({ ...input, source_type: "CHAT_FILE" }, pseudoUrl);
  if (!begin.created) {
    const replay = begin.existing.r2Key && begin.existing.sha256 && begin.existing.mimeType ? await finalizeCandidateProjectBridge(begin.existing) : normalizeCandidate(begin.existing);
    return { ...replay, input_mode: "CHAT_FILE_BYTES", idempotent_replay: true };
  }
  const candidate = begin.existing;
  if (!bytes.byteLength || bytes.byteLength > MAX_ITEM_BYTES) return { ...(await markFailure(candidate.id, "FAILED_DOWNLOAD", bytes.byteLength ? "FILE_TOO_LARGE" : "EMPTY_FILE")), input_mode: "CHAT_FILE_BYTES", idempotent_replay: false };
  const resolvedMime = normalizeMime(resolveMediaMime(mimeHint, preferredName, clean(input.target_name || input.target_file)));
  if (!SUPPORTED_MIME.has(resolvedMime) || !looksLike(bytes, resolvedMime)) return { ...(await markFailure(candidate.id, "FAILED_INVALID_MIME", resolvedMime || "UNKNOWN")), input_mode: "CHAT_FILE_BYTES", idempotent_replay: false };
  return { ...(await persistBytes(candidate, bytes, resolvedMime, preferredName)), input_mode: "CHAT_FILE_BYTES", idempotent_replay: false };
}

// Compatibility wrapper for transports that expose an attached ChatGPT file as a temporary response.
// The transport URL is never stored as source_url and never enters the WEB/materializer path.
export async function ingestFastPushFile(response: Response, fileName: string, mimeHint: string, input: FastPushInput) {
  if (!response.ok) throw new Error(`CHAT_FILE_TRANSPORT_HTTP_${response.status}`);
  return ingestFastPushFileBytes(new Uint8Array(await response.arrayBuffer()), fileName, mimeHint, { ...input, source_type: "CHAT_FILE" });
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>) {
  const output = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      output[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return output;
}

export async function ingestFastPushBatch(rawItems: FastPushInput[], batchId?: string) {
  const items = Array.isArray(rawItems) ? rawItems.slice(0, MAX_BATCH_ITEMS) : [];
  if (!items.length) throw new Error("FAST_PUSH_ITEMS_REQUIRED");
  const duplicateOps = items.map((item) => clean(item.operation_id)).filter(Boolean).filter((value, index, all) => all.indexOf(value) !== index);
  if (duplicateOps.length) throw new Error(`DUPLICATE_OPERATION_ID_IN_BATCH:${[...new Set(duplicateOps)].join(",")}`);
  const startedAt = Date.now();
  const results = await mapConcurrent(items, PARALLELISM, async (item, index) => {
    try {
      const result = await ingestFastPushUrl({ ...item, batch_id: batchId || item.batch_id });
      if (batchId && result.id) await getDb().update(fastPushCandidates).set({ batchId, updatedAt: now() }).where(eq(fastPushCandidates.id, result.id));
      const projectLinked = Boolean(result.projectId && result.projectItemId && result.supervisorCandidateId && String(result.projectLinkStatus || "").startsWith("LINKED_"));
      return { index: index + 1, operation_id: clean(item.operation_id), status: result.status, candidate_id: result.id, asset_id: result.assetId || null, sha256: result.sha256 || null, project_id: result.projectId || null, project_item_id: result.projectItemId || null, project_link_status: result.projectLinkStatus || null, project_linked: projectLinked, requires_project_link: Boolean(result.projectId && !projectLinked), supervisor_candidate_id: result.supervisorCandidateId || null, error: null, idempotent_replay: Boolean(result.idempotent_replay) };
    } catch (error) {
      return { index: index + 1, operation_id: clean(item.operation_id), status: "FAILED_DOWNLOAD", candidate_id: null, asset_id: null, sha256: null, error: error instanceof Error ? error.message : String(error), idempotent_replay: false };
    }
  });
  const counts = results.reduce<Record<string, number>>((acc, item) => { acc[item.status] = (acc[item.status] || 0) + 1; return acc; }, {});
  return { batch_id: batchId || null, requested: items.length, processed: results.length, duration_ms: Date.now() - startedAt, parallelism: PARALLELISM, counts, results };
}

export async function listFastPushProjectTargets(projectIdInput: unknown, limitInput: unknown = 200) {
  const projectId = clean(projectIdInput);
  if (!projectId) throw new Error("PROJECT_ID_REQUIRED");
  const limit = Math.max(1, Math.min(500, Number(limitInput) || 200));
  const db = getDb();
  const [project] = await db.select().from(automaticProjects).where(eq(automaticProjects.id, projectId)).limit(1);
  if (!project) throw new Error("PROJECT_NOT_FOUND");
  const rows = await db.select().from(automaticProjectItems).where(and(eq(automaticProjectItems.projectId, projectId), eq(automaticProjectItems.version, project.activeVersion))).orderBy(automaticProjectItems.priority).limit(limit);
  return {
    projeto:{ id:project.id, nome:project.name, status:project.status, versao:project.activeVersion, state_version:project.stateVersion },
    instrucao:"Use project_id + project_item_id retornados aqui no FAST PUSH. project_item_id é o vínculo canônico e evita associação semântica ambígua.",
    itens:rows.map((item) => ({ project_item_id:item.id, item_key:item.itemKey, target_file:item.targetFile, termo:item.term, contexto:item.context, universo:item.universe, referencia_semantica:item.semanticReference, composition_class:item.compositionClass, status:item.status, priority:item.priority, linked_asset_id:item.linkedAssetId })),
  };
}

export async function linkFastPushCandidatesToProject(rawMappings: unknown) {
  const mappings = (Array.isArray(rawMappings) ? rawMappings : []).map((value) => value && typeof value === "object" ? value as Record<string, unknown> : {}).slice(0, 100);
  if (!mappings.length) throw new Error("FAST_PUSH_LINK_MAPPINGS_REQUIRED");
  const db = getDb();
  const results:Array<Record<string, unknown>> = [];
  for (const mapping of mappings) {
    const candidateId = clean(mapping.candidate_id);
    const projectId = clean(mapping.project_id);
    const projectItemId = clean(mapping.project_item_id || mapping.item_id);
    if (!candidateId || !projectId || !projectItemId) { results.push({ candidate_id:candidateId || null, status:"INVALID_MAPPING", error:"candidate_id, project_id e project_item_id são obrigatórios" }); continue; }
    const [candidate] = await db.select().from(fastPushCandidates).where(eq(fastPushCandidates.id, candidateId)).limit(1);
    if (!candidate) { results.push({ candidate_id:candidateId, status:"NOT_FOUND" }); continue; }
    const [project] = await db.select().from(automaticProjects).where(eq(automaticProjects.id, projectId)).limit(1);
    if (!project) { results.push({ candidate_id:candidateId, status:"PROJECT_NOT_FOUND" }); continue; }
    const [item] = await db.select().from(automaticProjectItems).where(and(eq(automaticProjectItems.id, projectItemId), eq(automaticProjectItems.projectId, projectId), eq(automaticProjectItems.version, project.activeVersion))).limit(1);
    if (!item) { results.push({ candidate_id:candidateId, status:"PROJECT_ITEM_NOT_FOUND" }); continue; }
    const alreadyLinkedElsewhere = candidate.projectLinkStatus?.startsWith("LINKED_") && candidate.projectItemId && candidate.projectItemId !== item.id;
    if (alreadyLinkedElsewhere) { results.push({ candidate_id:candidateId, status:"ALREADY_LINKED_DIFFERENT_TARGET", project_id:candidate.projectId, project_item_id:candidate.projectItemId, project_link_status:candidate.projectLinkStatus }); continue; }
    const [updated] = await db.update(fastPushCandidates).set({ projectId, itemId:item.id, projectItemId:item.id, slot:clean(mapping.slot) || candidate.slot || item.itemKey, targetName:candidate.targetName || item.targetFile || item.itemKey, projectLinkStatus:"PENDING_PROJECT_BRIDGE", updatedAt:now() }).where(eq(fastPushCandidates.id, candidate.id)).returning();
    if (!updated.r2Key || !updated.sha256 || !updated.mimeType) { results.push({ candidate_id:candidateId, status:"CANDIDATE_NOT_MATERIALIZED", project_id:projectId, project_item_id:item.id }); continue; }
    try {
      const bridge = await bridgeFastPushToCanonicalPending(updated);
      const [fresh] = await db.select().from(fastPushCandidates).where(eq(fastPushCandidates.id, candidate.id)).limit(1);
      results.push({ candidate_id:candidateId, status:bridge.linked ? "LINKED" : "LINK_REQUIRED", project_id:projectId, project_item_id:item.id, project_link_status:fresh?.projectLinkStatus || null, supervisor_candidate_id:fresh?.supervisorCandidateId || null, bridge });
    } catch (error) {
      await db.update(fastPushCandidates).set({ projectLinkStatus:"BRIDGE_ERROR", updatedAt:now() }).where(eq(fastPushCandidates.id, candidate.id)).catch(() => undefined);
      results.push({ candidate_id:candidateId, status:"BRIDGE_ERROR", project_id:projectId, project_item_id:item.id, error:error instanceof Error ? error.message : String(error) });
    }
  }
  const summary = results.reduce<Record<string, number>>((acc,row) => { const key=String(row.status || "UNKNOWN"); acc[key]=(acc[key]||0)+1; return acc; },{});
  return { requested:mappings.length, summary, results };
}

export async function listFastPushCandidates(input: Record<string, unknown> = {}) {
  const db = getDb();
  const limit = Math.max(1, Math.min(200, Number(input.limit || input.limite || 100) || 100));
  const filters = [];
  const projectId = clean(input.project_id || input.projeto_id);
  const universe = clean(input.universe || input.universo);
  const itemId = clean(input.item_id || input.slot);
  const status = clean(input.status);
  const sourceType = clean(input.source_type || input.fonte);
  const batchId = clean(input.batch_id || input.lote_id);
  if (projectId) filters.push(eq(fastPushCandidates.projectId, projectId));
  if (universe) filters.push(eq(fastPushCandidates.universe, universe));
  if (itemId) filters.push(or(eq(fastPushCandidates.itemId, itemId), eq(fastPushCandidates.slot, itemId))!);
  if (status) filters.push(eq(fastPushCandidates.status, status));
  if (sourceType) filters.push(eq(fastPushCandidates.sourceType, sourceType));
  if (batchId) filters.push(eq(fastPushCandidates.batchId, batchId));
  const query = clean(input.q || input.texto);
  if (query) filters.push(or(
    like(fastPushCandidates.concept, `%${query}%`), like(fastPushCandidates.subject, `%${query}%`),
    like(fastPushCandidates.scene, `%${query}%`), like(fastPushCandidates.sourceUrl, `%${query}%`),
  )!);
  const rows = await db.select().from(fastPushCandidates).where(filters.length ? and(...filters) : undefined).orderBy(desc(fastPushCandidates.createdAt)).limit(limit);
  const [totals] = await db.select({
    total: sql<number>`count(*)`,
    pending: sql<number>`sum(case when ${fastPushCandidates.status} in ('PENDING_ANALYSIS','DUPLICATE_REUSED') then 1 else 0 end)`,
    approved: sql<number>`sum(case when ${fastPushCandidates.status} in ('APPROVED_CANDIDATE','PROMOTED_TO_ASSET') then 1 else 0 end)`,
    rejected: sql<number>`sum(case when ${fastPushCandidates.status} = 'REJECTED' then 1 else 0 end)`,
    failed: sql<number>`sum(case when ${fastPushCandidates.status} like 'FAILED_%' then 1 else 0 end)`,
  }).from(fastPushCandidates);
  return { candidates: rows.map(normalizeCandidate), totals: { total:Number(totals?.total||0), pending:Number(totals?.pending||0), approved:Number(totals?.approved||0), rejected:Number(totals?.rejected||0), failed:Number(totals?.failed||0) }, returned: rows.length };
}

async function promoteCandidate(candidate: typeof fastPushCandidates.$inferSelect, source: FastPushDecision, note?: string) {
  const db = getDb();
  if (!candidate.sha256 || !candidate.r2Key || !candidate.mimeType) throw new Error("CANDIDATE_NOT_MATERIALIZED");
  const [approvedCandidate] = await db.update(fastPushCandidates).set({ status:"APPROVED_CANDIDATE", decisionSource:source, decisionNote:note || null, analyzedAt:now(), updatedAt:now() }).where(eq(fastPushCandidates.id, candidate.id)).returning();
  candidate = approvedCandidate || candidate;
  const candidateSha256 = candidate.sha256;
  const candidateR2Key = candidate.r2Key;
  const candidateMimeType = candidate.mimeType;
  if (!candidateSha256 || !candidateR2Key || !candidateMimeType) throw new Error("CANDIDATE_NOT_MATERIALIZED");
  let [asset] = await db.select().from(assets).where(eq(assets.sha256, candidateSha256)).limit(1);
  if (!asset) {
    const assetId = `AST-FP-${candidateSha256.slice(0, 16).toUpperCase()}`;
    const ext = extForMime(candidateMimeType);
    const originalName = safeName(candidate.targetName || `${candidate.concept || candidate.subject || candidate.id}.${ext}`);
    const fileName = extOf(originalName) ? originalName : `${originalName}.${ext}`;
    const targetKey = `assets/${assetId}/${fileName}`;
    const object = await env.BUCKET.get(candidateR2Key);
    if (!object) throw new Error("R2_CANDIDATE_NOT_FOUND");
    await env.BUCKET.put(targetKey, await object.arrayBuffer(), { httpMetadata: { contentType: candidateMimeType }, customMetadata: { sha256: candidateSha256, promotedFrom: candidate.id } });
    const value = {
      id: assetId,
      name: candidate.concept || candidate.subject || candidate.targetName || candidate.id,
      universe: candidate.universe || "Sem universo",
      kind: kindFromMediaMime(candidateMimeType),
      subject: candidate.subject,
      status: "Aprovado",
      previousStatus: "Pendente",
      tags: candidate.tags,
      r2Key: targetKey,
      originalName: fileName,
      mimeType: candidateMimeType,
      sizeBytes: candidate.sizeBytes || object.size,
      sha256: candidateSha256,
      semanticFamily: [candidate.universe, candidate.subject || candidate.concept].filter(Boolean).join("::").toLowerCase() || null,
      projectOrigin: candidate.projectId,
      scriptReference: candidate.scriptReference,
      visualReference: candidate.visualReference,
      sourceUrl: candidate.sourceUrl.startsWith("chat-file://") ? null : candidate.sourceUrl,
      operationalNote: [note, `Promovido via FAST PUSH (${source})`, candidate.scene && `Cena: ${candidate.scene}`, candidate.arc && `Arco: ${candidate.arc}`].filter(Boolean).join("\n"),
      qaStatus: "APROVADO",
      createdAt: now(), updatedAt: now(),
    };
    try { [asset] = await db.insert(assets).values(value).returning(); }
    catch (error) {
      [asset] = await db.select().from(assets).where(or(eq(assets.id, assetId), eq(assets.sha256, candidateSha256))).limit(1);
      if (!asset) throw error;
      if (asset.r2Key !== targetKey) await env.BUCKET.delete(targetKey).catch(() => undefined);
    }
  }
  await registerUsageOnce(asset.id, candidate, note || `Aprovado via FAST PUSH (${source})`).catch(() => undefined);
  const projectLink = await linkProjectSlot(asset.id, candidate).catch((error) => ({ linked:false, reason:error instanceof Error ? error.message : String(error) }));
  const [updated] = await db.update(fastPushCandidates).set({
    status: "PROMOTED_TO_ASSET",
    assetId: asset.id,
    decisionSource: source,
    decisionNote: note || null,
    analyzedAt: now(),
    promotedAt: now(),
    failureReason: null,
    updatedAt: now(),
  }).where(eq(fastPushCandidates.id, candidate.id)).returning();
  return { candidate: normalizeCandidate(updated), asset, project_link: projectLink };
}

export async function decideFastPushCandidates(idsInput: unknown, decision: "APPROVE" | "REJECT", source: FastPushDecision = "MANUAL", note?: string) {
  const ids = [...new Set((Array.isArray(idsInput) ? idsInput : []).map(clean).filter(Boolean))].slice(0, MAX_DECISION_ITEMS);
  if (!ids.length) throw new Error("CANDIDATE_IDS_REQUIRED");
  const rows = await getDb().select().from(fastPushCandidates).where(inArray(fastPushCandidates.id, ids));
  const byId = new Map(rows.map((row) => [row.id, row]));

  const decideOne = async (candidateId:string) => {
    let candidate = byId.get(candidateId);
    if (!candidate) return { candidate_id:candidateId, status:"NOT_FOUND" } as Record<string, unknown>;
    if (candidate.projectId && candidate.r2Key && candidate.sha256 && candidate.mimeType && !candidate.supervisorCandidateId) {
      await bridgeFastPushToCanonicalPending(candidate).catch(() => undefined);
      const [refreshed] = await getDb().select().from(fastPushCandidates).where(eq(fastPushCandidates.id, candidateId)).limit(1);
      if (refreshed) { candidate = refreshed; byId.set(candidateId, refreshed); }
    }
    if (source === "AI" && candidate.decisionSource === "MANUAL") return { candidate_id:candidateId, status:"MANUAL_DECISION_PRECEDENCE", candidate:normalizeCandidate(candidate) };
    if (decision === "REJECT") {
      if (candidate.status === "PROMOTED_TO_ASSET") return { candidate_id:candidateId, status:"ALREADY_PROMOTED", asset_id:candidate.assetId || null };
      if (candidate.status === "REJECTED") return { candidate_id:candidateId, status:"ALREADY_REJECTED" };
      const [updated] = await getDb().update(fastPushCandidates).set({ status:"REJECTED", decisionSource:source, decisionNote:note || null, analyzedAt:now(), updatedAt:now() }).where(eq(fastPushCandidates.id, candidateId)).returning();
      const canonical_sync = await syncCanonicalDecision(updated, "REJECTED", source, note).catch((error) => ({ synced:false, reason:error instanceof Error ? error.message : String(error) }));
      return { candidate_id:candidateId, status:"REJECTED", candidate:normalizeCandidate(updated), canonical_sync };
    }
    if (candidate.status === "PROMOTED_TO_ASSET") return { candidate_id:candidateId, status:"ALREADY_PROMOTED", asset_id:candidate.assetId || null };
    try {
      const promoted = await promoteCandidate(candidate, source, note);
      const canonical_sync = await syncCanonicalDecision(candidate, "APPROVED", source, note, promoted.asset.id).catch((error) => ({ synced:false, reason:error instanceof Error ? error.message : String(error) }));
      return { candidate_id:candidateId, status:"PROMOTED_TO_ASSET", asset_id:promoted.asset.id, project_link:promoted.project_link, canonical_sync };
    } catch (error) {
      return { candidate_id:candidateId, status:"FAILED_PROMOTION", error:error instanceof Error ? error.message : String(error) };
    }
  };

  // Different PITEMs can be decided in parallel. Candidates from the same PITEM remain
  // sequential so PARA_QA_VISUAL promotion/rotation cannot race with itself.
  const groups = new Map<string, string[]>();
  for (const candidateId of ids) {
    const row = byId.get(candidateId);
    const groupKey = row?.projectId && row?.projectItemId ? `${row.projectId}::${row.projectItemId}` : `candidate::${candidateId}`;
    const group = groups.get(groupKey) || [];
    group.push(candidateId); groups.set(groupKey, group);
  }
  const groupList = [...groups.values()];
  const parallelism = decision === "REJECT" ? 8 : 4;
  const groupedResults = await mapConcurrent(groupList, parallelism, async (group) => {
    const output:Array<Record<string, unknown>> = [];
    for (const candidateId of group) output.push(await decideOne(candidateId));
    return output;
  });
  const resultMap = new Map(groupedResults.flat().map((row) => [String(row.candidate_id || ""), row]));
  const results = ids.map((candidateId) => resultMap.get(candidateId) || { candidate_id:candidateId, status:"UNKNOWN" });
  const summary = results.reduce<Record<string, number>>((acc, row) => { acc[String(row.status)] = (acc[String(row.status)] || 0) + 1; return acc; }, {});
  return { requested:ids.length, decision, source, parallelism, groups:groupList.length, summary, results };
}

export async function getFastPushCandidate(candidateId: string) {
  const [row] = await getDb().select().from(fastPushCandidates).where(eq(fastPushCandidates.id, candidateId)).limit(1);
  return row ? normalizeCandidate(row) : null;
}


export type FastPushBatchDecisionInput = {
  project_id?: unknown;
  candidate_ids?: unknown;
  item_ids?: unknown;
  target_files?: unknown;
  action?: unknown;
  source?: unknown;
  note?: unknown;
};

function uniqueCleanArray(value: unknown, max = MAX_DECISION_ITEMS) {
  return [...new Set((Array.isArray(value) ? value : []).map(clean).filter(Boolean))].slice(0, max);
}

async function resolveDecisionTargets(projectIdInput: unknown, itemIdsInput: unknown, targetFilesInput: unknown) {
  const projectId = clean(projectIdInput);
  const selectors = uniqueCleanArray([...(Array.isArray(itemIdsInput) ? itemIdsInput : []), ...(Array.isArray(targetFilesInput) ? targetFilesInput : [])], MAX_DECISION_ITEMS);
  if (!selectors.length) return { projectId, itemIds:[] as string[], targets:[] as Array<Record<string, unknown>> };
  if (!projectId) throw new Error("PROJECT_ID_REQUIRED_FOR_ITEM_SELECTOR");
  const db = getDb();
  const [project] = await db.select().from(automaticProjects).where(eq(automaticProjects.id, projectId)).limit(1);
  if (!project) throw new Error("PROJECT_NOT_FOUND");
  const items = await db.select().from(automaticProjectItems).where(and(eq(automaticProjectItems.projectId, projectId), eq(automaticProjectItems.version, project.activeVersion)));
  const targets:Array<Record<string, unknown>> = [];
  const resolved = new Set<string>();
  for (const selector of selectors) {
    const normalized = normalizeKey(selector);
    const matches = items.filter((item) => [item.id, item.itemKey, item.targetFile].some((value) => clean(value) === selector || normalizeKey(value) === normalized));
    if (!matches.length) { targets.push({ selector, status:"PROJECT_ITEM_NOT_FOUND" }); continue; }
    if (matches.length > 1) { targets.push({ selector, status:"AMBIGUOUS_PROJECT_ITEM", matches:matches.map((item) => ({ project_item_id:item.id, item_key:item.itemKey, target_file:item.targetFile })) }); continue; }
    const item = matches[0];
    resolved.add(item.id);
    targets.push({ selector, status:"MATCHED", project_item_id:item.id, item_key:item.itemKey, target_file:item.targetFile });
  }
  return { projectId, itemIds:[...resolved], targets };
}

export async function decideFastPushBatch(input: FastPushBatchDecisionInput) {
  const actionRaw = clean(input.action).toUpperCase();
  const decision = actionRaw === "APROVAR" || actionRaw === "APPROVE" ? "APPROVE" : actionRaw === "REJEITAR" || actionRaw === "REJECT" ? "REJECT" : "";
  if (!decision) throw new Error("FAST_PUSH_DECISION_ACTION_INVALID");
  const sourceRaw = clean(input.source).toUpperCase();
  const source:FastPushDecision = sourceRaw === "MANUAL" || sourceRaw === "AI" || sourceRaw === "SUPERVISOR" ? sourceRaw as FastPushDecision : "SUPERVISOR";
  const projectId = clean(input.project_id);
  const explicitIds = uniqueCleanArray(input.candidate_ids);
  const targetResolution = await resolveDecisionTargets(projectId, input.item_ids, input.target_files);
  const preResults:Array<Record<string, unknown>> = [...targetResolution.targets.filter((row) => row.status !== "MATCHED")];
  const ids = new Set(explicitIds);
  const db = getDb();

  if (targetResolution.itemIds.length) {
    const targetRows = await db.select().from(fastPushCandidates).where(and(
      eq(fastPushCandidates.projectId, targetResolution.projectId),
      inArray(fastPushCandidates.projectItemId, targetResolution.itemIds),
      inArray(fastPushCandidates.status, [...ACTIVE_DECISION_STATUSES]),
    ));
    const byItem = new Map<string, typeof targetRows>();
    for (const row of targetRows) {
      const key = row.projectItemId || "";
      const list = byItem.get(key) || [];
      list.push(row); byItem.set(key, list);
    }
    for (const itemId of targetResolution.itemIds) {
      const candidates = byItem.get(itemId) || [];
      if (decision === "REJECT") {
        if (!candidates.length) preResults.push({ project_item_id:itemId, status:"NO_ACTIVE_CANDIDATES" });
        for (const row of candidates) ids.add(row.id);
      } else {
        if (candidates.length === 1) ids.add(candidates[0].id);
        else if (!candidates.length) preResults.push({ project_item_id:itemId, status:"NO_ACTIVE_CANDIDATES" });
        else preResults.push({ project_item_id:itemId, status:"AMBIGUOUS_REQUIRES_CANDIDATE_ID", candidate_ids:candidates.map((row) => row.id) });
      }
    }
  }

  let candidateIds = [...ids].slice(0, MAX_DECISION_ITEMS);
  if (projectId && candidateIds.length) {
    const scopedRows = await db.select({ id:fastPushCandidates.id, projectId:fastPushCandidates.projectId }).from(fastPushCandidates).where(inArray(fastPushCandidates.id, candidateIds));
    const scoped = new Set(scopedRows.filter((row) => row.projectId === projectId).map((row) => row.id));
    for (const row of scopedRows) if (row.projectId !== projectId) preResults.push({ candidate_id:row.id, status:"PROJECT_MISMATCH", actual_project_id:row.projectId });
    candidateIds = candidateIds.filter((candidateId) => scoped.has(candidateId));
  }

  const decided = candidateIds.length
    ? await decideFastPushCandidates(candidateIds, decision, source, clean(input.note))
    : { requested:0, decision, source, summary:{} as Record<string, number>, results:[] as Array<Record<string, unknown>> };
  const results = [...preResults, ...decided.results];
  const summary = results.reduce<Record<string, number>>((acc, row) => { const key=String(row.status || "UNKNOWN"); acc[key]=(acc[key]||0)+1; return acc; }, {});
  return { requested:results.length, selected_candidates:candidateIds.length, decision, source, project_id:projectId || null, summary, results };
}

async function canDeleteCandidateBytes(candidate: typeof fastPushCandidates.$inferSelect) {
  const r2Key = clean(candidate.r2Key);
  if (!r2Key) return { allowed:false, reason:"NO_R2_KEY" };
  if (!r2Key.startsWith(`fast-push/${candidate.id}/`)) return { allowed:false, reason:"R2_KEY_NOT_OWNED_BY_CANDIDATE" };
  const db = getDb();
  const [candidateRefs] = await db.select({ n:sql<number>`count(*)` }).from(fastPushCandidates).where(and(eq(fastPushCandidates.r2Key, r2Key), sql`${fastPushCandidates.id} <> ${candidate.id}`));
  const [assetRefs] = await db.select({ n:sql<number>`count(*)` }).from(assets).where(eq(assets.r2Key, r2Key));
  const [materializationRefs] = await db.select({ n:sql<number>`count(*)` }).from(materializationFiles).where(and(eq(materializationFiles.r2Key, r2Key), candidate.materializationFileId ? sql`${materializationFiles.id} <> ${candidate.materializationFileId}` : sql`1=1`));
  const [productionRefs] = await db.select({ n:sql<number>`count(*)` }).from(projectProductionAssets).where(eq(projectProductionAssets.r2Key, r2Key));
  const refs = Number(candidateRefs?.n || 0) + Number(assetRefs?.n || 0) + Number(materializationRefs?.n || 0) + Number(productionRefs?.n || 0);
  return refs ? { allowed:false, reason:"R2_KEY_STILL_REFERENCED", references:refs } : { allowed:true, reason:"UNREFERENCED_OWNED_BYTES" };
}

export async function deleteFastPushCandidatesBatch(input: { project_id?:unknown; candidate_ids?:unknown; confirmar?:unknown; apagar_materializacao?:unknown; apagar_bytes?:unknown; permitir_promovidas?:unknown; motivo?:unknown }) {
  const projectId = clean(input.project_id);
  const ids = uniqueCleanArray(input.candidate_ids);
  if (!projectId) throw new Error("PROJECT_ID_REQUIRED");
  if (!ids.length) throw new Error("CANDIDATE_IDS_REQUIRED");
  if (input.confirmar !== true) throw new Error("CONFIRMACAO_EXCLUSAO_PERMANENTE_REQUIRED");
  const deleteMaterialization = input.apagar_materializacao === true;
  const deleteBytes = input.apagar_bytes === true;
  const allowPromoted = input.permitir_promovidas === true;
  const db = getDb();
  const rows = await db.select().from(fastPushCandidates).where(inArray(fastPushCandidates.id, ids));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const results:Array<Record<string, unknown>> = [];

  for (const candidateId of ids) {
    const candidate = byId.get(candidateId);
    if (!candidate) { results.push({ candidate_id:candidateId, status:"NOT_FOUND" }); continue; }
    if (candidate.projectId !== projectId) { results.push({ candidate_id:candidateId, status:"PROJECT_MISMATCH", actual_project_id:candidate.projectId }); continue; }
    if (candidate.status === "PROMOTED_TO_ASSET" && !allowPromoted) { results.push({ candidate_id:candidateId, status:"PROMOTED_PROTECTED", asset_id:candidate.assetId || null }); continue; }

    if (candidate.supervisorCandidateId && candidate.status !== "PROMOTED_TO_ASSET") {
      await syncCanonicalDecision(candidate, "REJECTED", "MANUAL", clean(input.motivo) || "Hard delete FAST PUSH").catch(() => undefined);
    }
    if (candidate.supervisorCandidateId) {
      await db.delete(supervisorDecisionQueue).where(eq(supervisorDecisionQueue.candidateId, candidate.supervisorCandidateId));
      await db.delete(supervisorProjectCandidates).where(eq(supervisorProjectCandidates.id, candidate.supervisorCandidateId));
    }

    let materializationDeleted = false;
    if (deleteMaterialization && candidate.materializationItemId) {
      const files = await db.select().from(materializationFiles).where(eq(materializationFiles.itemDbId, candidate.materializationItemId));
      const materializationCandidateIds = [...new Set(files.map((file) => file.candidateId).filter(Boolean))];
      await db.delete(materializationFiles).where(eq(materializationFiles.itemDbId, candidate.materializationItemId));
      if (materializationCandidateIds.length) await db.delete(materializationCandidates).where(inArray(materializationCandidates.id, materializationCandidateIds));
      await db.delete(materializationItems).where(eq(materializationItems.id, candidate.materializationItemId));
      if (candidate.materializationBatchId) {
        const [remaining] = await db.select({ n:sql<number>`count(*)` }).from(materializationItems).where(eq(materializationItems.batchId, candidate.materializationBatchId));
        if (!Number(remaining?.n || 0)) await db.delete(materializationBatches).where(eq(materializationBatches.id, candidate.materializationBatchId));
      }
      materializationDeleted = true;
    }

    let bytesStatus = deleteBytes ? "NOT_DELETED" : "PRESERVED";
    if (deleteBytes) {
      const safety = await canDeleteCandidateBytes(candidate);
      if (safety.allowed && candidate.r2Key) { await env.BUCKET.delete(candidate.r2Key); bytesStatus = "DELETED"; }
      else bytesStatus = String(safety.reason || "NOT_SAFE");
    }
    await db.delete(fastPushCandidates).where(eq(fastPushCandidates.id, candidate.id));
    results.push({ candidate_id:candidate.id, status:"DELETED", materialization_deleted:materializationDeleted, bytes_status:bytesStatus, asset_preserved:Boolean(candidate.assetId) });
  }
  const summary = results.reduce<Record<string, number>>((acc,row) => { const key=String(row.status || "UNKNOWN"); acc[key]=(acc[key]||0)+1; return acc; },{});
  return { requested:ids.length, project_id:projectId, hard_delete:true, delete_materialization:deleteMaterialization, delete_bytes:deleteBytes, summary, results };
}
