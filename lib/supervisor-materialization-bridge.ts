import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../db";
import {
  automaticProjectEvents,
  automaticProjectItems,
  automaticProjects,
  fastPushCandidates,
  materializationBatches,
  materializationCandidates,
  materializationFiles,
  materializationItems,
  supervisorDecisionQueue,
  supervisorProjectCandidates,
} from "../db/schema";

const now = () => new Date();
const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR").replace(/[^a-z0-9]+/g, " ").trim();
const lockedProjectStatuses = new Set(["CONCLUIDO_MANUAL", "COMPLETED", "COMPLETED_WITH_WARNINGS", "FORCED_CLOSED", "CANCELLED", "GROUPED_ARCHIVED"]);
const frozenItemStatuses = new Set(["APPROVED", "FROZEN", "LINKED_FROM_LIBRARY", "LINKED_FROM_FAMILY"]);
const bridgeBlockedItemStatuses = new Set([...frozenItemStatuses, "PAUSED_BY_SUPERVISOR"]);

async function stableId(prefix: string, value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `${prefix}-${Array.from(new Uint8Array(digest)).slice(0, 16).map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

function json(value: unknown) { return JSON.stringify(value ?? null); }

async function queueVisualDecision(projectId: string, projectItem: typeof automaticProjectItems.$inferSelect, bridgeId: string, evidence: Record<string, unknown>) {
  const db = getDb();
  const [pending] = await db.select().from(supervisorDecisionQueue).where(and(eq(supervisorDecisionQueue.projectId, projectId), eq(supervisorDecisionQueue.itemId, projectItem.id), eq(supervisorDecisionQueue.type, "QA_VISUAL"), eq(supervisorDecisionQueue.state, "PENDENTE"))).limit(1);
  if (pending) {
    await db.update(supervisorDecisionQueue).set({ candidateId: bridgeId, evidence: json(evidence), allowedActions: json(["APROVADO", "REJEITADO", "RELINK_REQUIRED", "CORRECAO_TECNICA_PERMITIDA"]), updatedAt: now() }).where(eq(supervisorDecisionQueue.id, pending.id));
    return pending.id;
  }
  const id = await stableId("SDEC", `${projectId}\n${projectItem.id}\n${bridgeId}\nQA_VISUAL`);
  await db.insert(supervisorDecisionQueue).values({
    id, projectId, itemId: projectItem.id, candidateId: bridgeId, type: "QA_VISUAL", priority: projectItem.priority,
    state: "PENDENTE", evidence: json(evidence), allowedActions: json(["APROVADO", "REJEITADO", "RELINK_REQUIRED", "CORRECAO_TECNICA_PERMITIDA"]),
    source: "AUTOMATICO", createdAt: now(), updatedAt: now(),
  }).onConflictDoUpdate({ target: supervisorDecisionQueue.id, set: { candidateId: bridgeId, state: "PENDENTE", evidence: json(evidence), allowedActions: json(["APROVADO", "REJEITADO", "RELINK_REQUIRED", "CORRECAO_TECNICA_PERMITIDA"]), decision: null, observation: null, resolvedAt: null, updatedAt: now() } });
  return id;
}

async function resolveProjectItem(materialized: typeof materializationItems.$inferSelect, batch: typeof materializationBatches.$inferSelect, hints?: { projectId?: string; itemId?: string }) {
  const db = getDb();
  let projects: Array<typeof automaticProjects.$inferSelect> = [];
  if (hints?.projectId) {
    projects = await db.select().from(automaticProjects).where(eq(automaticProjects.id, hints.projectId)).limit(1);
  } else if (batch.project) {
    // Caminho rápido: lotes do fluxo principal normalmente carregam ID ou nome exato do projeto.
    projects = await db.select().from(automaticProjects).where(eq(automaticProjects.id, batch.project)).limit(1);
    if (!projects.length) projects = await db.select().from(automaticProjects).where(eq(automaticProjects.name, batch.project)).orderBy(desc(automaticProjects.updatedAt)).limit(10);
  }
  if (!projects.length && !hints?.projectId) projects = await db.select().from(automaticProjects).orderBy(desc(automaticProjects.updatedAt)).limit(100);
  projects = projects.filter((project) => !lockedProjectStatuses.has(project.status));
  const scored: Array<{ project: typeof automaticProjects.$inferSelect; item: typeof automaticProjectItems.$inferSelect; score: number; reasons: string[] }> = [];
  const batchName = normalize(batch.project || "");
  const matItemKey = normalize(materialized.itemId || "");
  const matTarget = normalize(materialized.targetName || "");
  const matConcept = normalize(materialized.concept || "");
  const matReference = normalize(materialized.visualReference || "");
  const matUniverse = normalize(materialized.universe || "");

  for (const project of projects) {
    const projectName = normalize(project.name);
    let projectScore = 0;
    const projectReasons: string[] = [];
    if (batch.project === project.id) { projectScore += 100; projectReasons.push("batch_project_id"); }
    else if (batchName && projectName && batchName === projectName) { projectScore += 90; projectReasons.push("batch_project_name"); }
    else if (batchName && projectName && (batchName.startsWith(projectName + " ") || batchName.includes(projectName + " v"))) { projectScore += 65; projectReasons.push("batch_project_prefix"); }
    const items = await db.select().from(automaticProjectItems).where(and(eq(automaticProjectItems.projectId, project.id), eq(automaticProjectItems.version, project.activeVersion))).orderBy(asc(automaticProjectItems.priority));
    for (const item of items) {
      if (bridgeBlockedItemStatuses.has(item.status)) continue;
      if (hints?.itemId && hints.itemId !== item.id && hints.itemId !== item.itemKey) continue;
      let score = projectScore; const reasons = [...projectReasons];
      if (hints?.projectId === project.id) { score += 20; reasons.push("explicit_project_hint"); }
      if (hints?.itemId && (hints.itemId === item.id || hints.itemId === item.itemKey)) { score += 150; reasons.push("explicit_item_hint"); }
      if (materialized.itemId === item.id) { score += 100; reasons.push("materialization_item_is_project_item_id"); }
      else if (matItemKey && matItemKey === normalize(item.itemKey)) { score += 70; reasons.push("item_key"); }
      const target = normalize(item.targetFile || item.itemKey);
      if (matTarget && target && matTarget === target) { score += 90; reasons.push("target_file"); }
      const term = normalize(item.term || "");
      if (matConcept && term && matConcept === term) { score += 35; reasons.push("concept_term"); }
      const semantic = normalize(item.semanticReference || item.term || "");
      if (matReference && semantic && matReference === semantic) { score += 25; reasons.push("visual_reference"); }
      if (matUniverse && normalize(item.universe || "") === matUniverse) { score += 5; reasons.push("universe"); }
      scored.push({ project, item, score, reasons });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.item.priority - b.item.priority);
  const best = scored[0];
  if (!best || best.score < 100) return { match: null, reason: "NO_CONFIDENT_PROJECT_ITEM_MATCH", candidates: scored.slice(0, 5).map((row) => ({ project_id: row.project.id, item_id: row.item.id, score: row.score, reasons: row.reasons })) };
  if (scored[1] && scored[1].score === best.score && scored[1].item.id !== best.item.id) return { match: null, reason: "AMBIGUOUS_PROJECT_ITEM_MATCH", candidates: scored.slice(0, 5).map((row) => ({ project_id: row.project.id, item_id: row.item.id, score: row.score, reasons: row.reasons })) };
  return { match: best, reason: "MATCHED", candidates: [] };
}

export async function bridgeMaterializationToSupervisor(materializationItemDbId: string, hints?: { projectId?: string; itemId?: string; collectionCandidateId?: string | null }) {
  const db = getDb();
  const [materialized] = await db.select().from(materializationItems).where(eq(materializationItems.id, materializationItemDbId)).limit(1);
  if (!materialized) return { linked: false, reason: "MATERIALIZATION_ITEM_NOT_FOUND" };
  if (materialized.status !== "READY_FOR_VISUAL_QA" || !materialized.selectedFileId) return { linked: false, reason: "MATERIALIZATION_NOT_READY", status: materialized.status };
  const [batch] = await db.select().from(materializationBatches).where(eq(materializationBatches.id, materialized.batchId)).limit(1);
  const [file] = await db.select().from(materializationFiles).where(eq(materializationFiles.id, materialized.selectedFileId)).limit(1);
  const [candidate] = materialized.selectedCandidateId ? await db.select().from(materializationCandidates).where(eq(materializationCandidates.id, materialized.selectedCandidateId)).limit(1) : [null];
  if (!batch || !file) return { linked: false, reason: "MATERIALIZATION_EVIDENCE_INCOMPLETE" };
  // Idempotência barata: consultas do painel/QA podem reconciliar repetidamente o mesmo projeto.
  const [alreadyLinked] = hints?.projectId
    ? await db.select().from(supervisorProjectCandidates).where(and(eq(supervisorProjectCandidates.projectId, hints.projectId), eq(supervisorProjectCandidates.materializationFileId, file.id))).limit(1)
    : await db.select().from(supervisorProjectCandidates).where(eq(supervisorProjectCandidates.materializationFileId, file.id)).limit(1);
  if (alreadyLinked) {
    let matchesExplicitItem = true;
    if (hints?.itemId) {
      const [linkedItem] = await db.select().from(automaticProjectItems).where(eq(automaticProjectItems.id, alreadyLinked.itemId)).limit(1);
      matchesExplicitItem = Boolean(linkedItem && (linkedItem.id === hints.itemId || linkedItem.itemKey === hints.itemId));
    }
    if (matchesExplicitItem) return { linked: true, project_id: alreadyLinked.projectId, item_id: alreadyLinked.itemId, candidate_id: alreadyLinked.id, status: alreadyLinked.status, materialization_file_id: file.id, existing: true };
  }
  const resolution = await resolveProjectItem(materialized, batch, hints);
  if (!resolution.match) return { linked: false, reason: resolution.reason, candidates: resolution.candidates };
  const { project, item } = resolution.match;
  if (bridgeBlockedItemStatuses.has(item.status)) return { linked: false, reason: frozenItemStatuses.has(item.status) ? "PROJECT_ITEM_FROZEN" : "PROJECT_ITEM_PAUSED", project_id: project.id, item_id: item.id };

  const bridgeId = await stableId("SPCAND", `${project.id}\n${item.id}\n${file.id}`);
  const [existing] = await db.select().from(supervisorProjectCandidates).where(eq(supervisorProjectCandidates.id, bridgeId)).limit(1);
  if (existing && !["PARA_ANALISE", "PARA_QA_VISUAL"].includes(existing.status)) return { linked: false, reason: "CANDIDATE_ALREADY_RESOLVED", candidate_id: existing.id, status: existing.status };
  const [active] = await db.select().from(supervisorProjectCandidates).where(and(eq(supervisorProjectCandidates.projectId, project.id), eq(supervisorProjectCandidates.itemId, item.id), eq(supervisorProjectCandidates.status, "PARA_QA_VISUAL"))).orderBy(asc(supervisorProjectCandidates.createdAt)).limit(1);
  const status = !active || active.id === bridgeId ? "PARA_QA_VISUAL" : "PARA_ANALISE";
  const metadata = {
    target_filename: item.targetFile || item.itemKey,
    semantic_reference: item.semanticReference || item.term,
    visual_reference: materialized.visualReference || item.semanticReference || item.term,
    universe: item.universe,
    preset: materialized.preset,
    slot: materialized.slot,
    context: item.context,
    mime_type: file.mimeType,
    width: file.width,
    height: file.height,
    size_bytes: file.sizeBytes,
    sha256: file.sha256,
    technical_status: file.technicalStatus,
    materialization_status: materialized.status,
    match_score: resolution.match.score,
    match_reasons: resolution.match.reasons,
    collection_candidate_id: hints?.collectionCandidateId || null,
  };
  await db.insert(supervisorProjectCandidates).values({
    id: bridgeId, projectId: project.id, itemId: item.id, materializationBatchId: materialized.batchId, materializationItemId: materialized.id,
    materializationCandidateId: materialized.selectedCandidateId || null, materializationFileId: file.id, collectionCandidateId: hints?.collectionCandidateId || null,
    source: candidate?.source || null, originalUrl: candidate?.originalUrl || null, host: candidate?.host || null, status, metadata: json(metadata), createdAt: now(), updatedAt: now(),
  }).onConflictDoUpdate({ target: supervisorProjectCandidates.id, set: { status, source: candidate?.source || null, originalUrl: candidate?.originalUrl || null, host: candidate?.host || null, collectionCandidateId: hints?.collectionCandidateId || existing?.collectionCandidateId || null, metadata: json(metadata), updatedAt: now() } });

  if (status === "PARA_QA_VISUAL") {
    await db.update(automaticProjectItems).set({
      status: "QA_READY", sourceType: item.sourceType || "MATERIALIZATION_RECONCILED",
      collectionCandidateId: hints?.collectionCandidateId || item.collectionCandidateId,
      materializationBatchId: materialized.batchId, materializationItemId: materialized.id, materializationFileId: file.id,
      failureReason: null, updatedAt: now(),
    }).where(eq(automaticProjectItems.id, item.id));
    await queueVisualDecision(project.id, item, bridgeId, { ...metadata, supervisor_candidate_id: bridgeId, materialization_candidate_id: materialized.selectedCandidateId, source: candidate?.source || null, original_url: candidate?.originalUrl || null, host: candidate?.host || null });
  }
  await db.insert(automaticProjectEvents).values({ id: await stableId("PEVT", `${bridgeId}\n${status}`), projectId: project.id, itemId: item.id, event: "materialization_supervisor_bridge", status, detail: json({ bridge_id: bridgeId, materialization_item_id: materialized.id, materialization_file_id: file.id, source: candidate?.source || null, url: candidate?.originalUrl || null, match_score: resolution.match.score, match_reasons: resolution.match.reasons }), createdAt: now() }).onConflictDoNothing();
  return { linked: true, project_id: project.id, item_id: item.id, candidate_id: bridgeId, status, materialization_file_id: file.id };
}

export async function reconcileSupervisorMaterializations(projectId: string) {
  const db = getDb();
  const [project] = await db.select().from(automaticProjects).where(eq(automaticProjects.id, projectId)).limit(1);
  if (!project) throw new Error("PROJECT_NOT_FOUND");
  if (lockedProjectStatuses.has(project.status)) return { projeto_id: projectId, vinculadas: 0, ignoradas: 0, bloqueado: true };
  const projectItems = await db.select().from(automaticProjectItems).where(and(eq(automaticProjectItems.projectId, projectId), eq(automaticProjectItems.version, project.activeVersion)));
  const directIds = projectItems.map((item) => item.materializationItemId).filter((value): value is string => Boolean(value));
  const readyRows = await db.select().from(materializationItems).where(eq(materializationItems.status, "READY_FOR_VISUAL_QA")).orderBy(desc(materializationItems.updatedAt)).limit(500);
  const rows = [...readyRows];
  if (directIds.length) {
    const directRows = await db.select().from(materializationItems).where(inArray(materializationItems.id, directIds));
    for (const row of directRows) if (!rows.some((current) => current.id === row.id)) rows.push(row);
  }
  let linked = 0, ignored = 0;
  for (const row of rows) {
    const result = await bridgeMaterializationToSupervisor(row.id, { projectId });
    if (result.linked) linked += 1; else ignored += 1;
  }
  return { projeto_id: projectId, vinculadas: linked, ignoradas: ignored };
}

export async function resolveBridgedCandidate(projectId: string, itemId: string, decision: string, observation?: string | null) {
  const db = getDb();
  const [current] = await db.select().from(supervisorProjectCandidates).where(and(eq(supervisorProjectCandidates.projectId, projectId), eq(supervisorProjectCandidates.itemId, itemId), eq(supervisorProjectCandidates.status, "PARA_QA_VISUAL"))).orderBy(asc(supervisorProjectCandidates.createdAt)).limit(1);
  if (!current) return { current: null, promoted: null };
  const normalized = decision.toUpperCase();
  const status = normalized === "APROVADO" ? "APROVADO" : normalized === "RELINK_REQUIRED" ? "RELINK_REQUIRED" : normalized === "CORRECAO_TECNICA_PERMITIDA" ? "CORRECAO_TECNICA_PERMITIDA" : "REJEITADO";
  const metadata = (() => { try { return JSON.parse(current.metadata || "{}") as Record<string, unknown>; } catch { return {}; } })();
  await db.update(supervisorProjectCandidates).set({ status, metadata: json({ ...metadata, qa_decision: normalized, qa_observation: observation || null, qa_resolved_at: new Date().toISOString() }), updatedAt: now() }).where(eq(supervisorProjectCandidates.id, current.id));
  await db.update(fastPushCandidates).set({
    projectLinkStatus: normalized === "APROVADO" ? "RESOLVED_APPROVED" : normalized === "CORRECAO_TECNICA_PERMITIDA" ? "LINKED_TECHNICAL_CORRECTION" : normalized === "RELINK_REQUIRED" ? "RESOLVED_RELINK_REQUIRED" : "RESOLVED_REJECTED",
    updatedAt: now(),
  }).where(eq(fastPushCandidates.materializationItemId, current.materializationItemId));
  await db.update(supervisorDecisionQueue).set({ state: "RESOLVIDA", decision: normalized, observation: observation || null, source: "SUPERVISOR_MCP", resolvedAt: now(), updatedAt: now() }).where(and(eq(supervisorDecisionQueue.projectId, projectId), eq(supervisorDecisionQueue.itemId, itemId), eq(supervisorDecisionQueue.type, "QA_VISUAL"), eq(supervisorDecisionQueue.state, "PENDENTE")));
  if (normalized === "RELINK_REQUIRED") {
    await db.update(supervisorProjectCandidates).set({ status: "DESCARTADO_RELINK", updatedAt: now() }).where(and(eq(supervisorProjectCandidates.projectId, projectId), eq(supervisorProjectCandidates.itemId, itemId), eq(supervisorProjectCandidates.status, "PARA_ANALISE")));
    return { current: { ...current, status }, promoted: null };
  }
  if (normalized === "APROVADO" || normalized === "CORRECAO_TECNICA_PERMITIDA") return { current: { ...current, status }, promoted: null };
  const [next] = await db.select().from(supervisorProjectCandidates).where(and(eq(supervisorProjectCandidates.projectId, projectId), eq(supervisorProjectCandidates.itemId, itemId), eq(supervisorProjectCandidates.status, "PARA_ANALISE"))).orderBy(asc(supervisorProjectCandidates.createdAt)).limit(1);
  if (!next) return { current: { ...current, status }, promoted: null };
  await db.update(supervisorProjectCandidates).set({ status: "PARA_QA_VISUAL", updatedAt: now() }).where(eq(supervisorProjectCandidates.id, next.id));
  await db.update(fastPushCandidates).set({ projectLinkStatus: "LINKED_PARA_QA_VISUAL", supervisorCandidateId: next.id, updatedAt: now() }).where(eq(fastPushCandidates.materializationItemId, next.materializationItemId));
  const [projectItem] = await db.select().from(automaticProjectItems).where(eq(automaticProjectItems.id, itemId)).limit(1);
  if (projectItem) {
    await db.update(automaticProjectItems).set({ status: "QA_READY", collectionCandidateId: next.collectionCandidateId || null, materializationBatchId: next.materializationBatchId, materializationItemId: next.materializationItemId, materializationFileId: next.materializationFileId, failureReason: null, updatedAt: now() }).where(eq(automaticProjectItems.id, itemId));
    const nextMeta = (() => { try { return JSON.parse(next.metadata || "{}") as Record<string, unknown>; } catch { return {}; } })();
    await queueVisualDecision(projectId, projectItem, next.id, { ...nextMeta, supervisor_candidate_id: next.id, source: next.source, original_url: next.originalUrl, host: next.host });
  }
  return { current: { ...current, status }, promoted: { ...next, status: "PARA_QA_VISUAL" } };
}
