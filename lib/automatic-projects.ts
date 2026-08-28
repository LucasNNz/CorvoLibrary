import { env } from "./platform/runtime";
import { toArrayBuffer } from "./web-crypto";
import { and, asc, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import { getDb } from "../db";
import {
  assetUsage,
  assets,
  automaticProjectEvents,
  automaticProjectFiles,
  automaticProjectItems,
  automaticProjects,
  collectionBatches,
  collectionCandidates,
  collectionSourceRuns,
  collectionSources,
  collectionTerms,
  materializationBatches,
  materializationFiles,
  materializationItems,
  requests,
  supervisorDecisionQueue,
  supervisorDecisionJobs,
  supervisorExecutions,
  supervisorProjectCandidates,
  workerSessions,
  workerWorkItems,
  workerEvents,
  stageMetrics,
  projectRuns,
  exportJobs,
  planBranches,
  sourceRoutingPlans,
  supervisorPlans,
  operationalGaps,
  operationalPolicies,
  operationalPolicyEvents,
  projectProductionAssets,
  projectTitleCandidates,
} from "../db/schema";
import { createCollectionBatch, executeCollection } from "./auto-collector";
import { addCandidates, applyTechnicalCorrection, materializeBatch, probeMaterializationUrl, registerQaBatch } from "./materializer";
import { classifyComposition, classifySemantic, type SupervisorInput, type SupervisorOutput } from "./ai-supervisor";
import { getSupervisorMode, recordQaMetrics, sourcePolicyForItem, syncDecisionQueue } from "./supervisor-control";
import { bridgeMaterializationToSupervisor, reconcileSupervisorMaterializations, resolveBridgedCandidate } from "./supervisor-materialization-bridge";
import { getHostRanking } from "./inventory-intelligence";
import { completeSupervisorExecution, deriveProjectPipelineState } from "./supervisor-lease";
import { recordRouteMetric, refreshProjectSummary } from "./performance-control";
import { getProjectProductionPackage } from "./project-production-package";

type ParsedProjectItem = { itemKey: string; term: string; context?: string; kind: string; universe?: string; notes?: string; priority: number };
type StrategyState = {
  reference_history?: string[];
  query_history?: string[];
  source_history?: string[];
  host_history?: string[];
  candidate_history?: unknown[];
  materialization_history?: unknown[];
  qa_history?: unknown[];
  failure_history?: unknown[];
  attempt_budget?: { reference_changes?: number; query_rounds?: number; candidate_tries?: number; technical_tries?: number };
  current_strategy?: Record<string, unknown>;
};

const RESOLVED_STATUSES = new Set(["APPROVED", "LINKED_FROM_LIBRARY", "LINKED_FROM_FAMILY", "FROZEN"]);
const MANUALLY_COMPLETED_STATUSES = new Set(["CONCLUIDO_MANUAL", "COMPLETED", "COMPLETED_WITH_WARNINGS", "FORCED_CLOSED"]);
const AUTOMATION_STOPPED_STATUSES = new Set([...MANUALLY_COMPLETED_STATUSES, "MOTOR_LIBRARY_RODADO", "PAUSED_BY_SUPERVISOR", "CANCELLED", "GROUPED_ARCHIVED"]);
const makeId = (prefix: string) => `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
const clean = (value: unknown) => typeof value === "string" ? value.trim() : "";
const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR").replace(/[^a-z0-9]+/g, " ").trim();
const projectVideoKey = (value: string) => normalize(value)
  .replace(/^(?:corvo ?quiz|projeto)\s+/, "")
  .replace(/\s+(?:reels?|shorts?|video)$/, "")
  .replace(/\s+(?:v|versao)\s*\d+$/, "")
  .replace(/\s+/g, " ")
  .trim();
const now = () => new Date();
const chunk = <T,>(values: T[], size = 40) => Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, index * size + size));

async function projectNameGroup(name: string) {
  const key = projectVideoKey(name);
  const rows = await getDb().select().from(automaticProjects).orderBy(desc(automaticProjects.updatedAt));
  return rows.filter((row) => projectVideoKey(row.name) === key);
}

async function projectCompletionGuard(project: typeof automaticProjects.$inferSelect) {
  const key = projectVideoKey(project.name);
  const [projectRows, requestRows] = await Promise.all([
    projectNameGroup(project.name),
    getDb().select().from(requests),
  ]);
  const completedProject = projectRows.find((row) => MANUALLY_COMPLETED_STATUSES.has(row.status));
  const completedRequest = requestRows.find((row) => projectVideoKey(row.project) === key && normalize(row.status).includes("conclu"));
  return {
    allowed: !completedProject && !completedRequest && !AUTOMATION_STOPPED_STATUSES.has(project.status),
    reason: completedProject || completedRequest ? "PROJECT_GROUP_CONCLUIDO_MANUALMENTE" : project.status === "MOTOR_LIBRARY_RODADO" ? "MOTOR_LIBRARY_JA_RODADO" : project.status === "GROUPED_ARCHIVED" ? "PROJECT_EXECUTION_GROUPED_ARCHIVED" : null,
    groupCount: projectRows.length,
  };
}

async function assertProjectAutomationAllowed(project: typeof automaticProjects.$inferSelect) {
  const guard = await projectCompletionGuard(project);
  if (!guard.allowed) throw new Error(`${guard.reason}: desconclua o projeto manualmente antes de liberar nova execução`);
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)));
  return btoa(binary);
}

async function sha256Hex(bytes: Uint8Array) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes)));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function stableProjectItemId(projectId: string, version: number, itemKey: string) {
  const hash = await sha256Hex(new TextEncoder().encode(`${projectId}\n${version}\n${itemKey}`));
  return `PITEM-${hash.slice(0, 24).toUpperCase()}`;
}

function targetFileName(value: string, fallbackExtension = "jpg") {
  let name = clean(value).replace(/[\\/]/g, "-").replace(/[^a-zA-Z0-9À-ÿ._ -]/g, "-").replace(/\s+/g, " ").trim();
  if (!name) name = `asset.${fallbackExtension}`;
  if (!/\.[a-z0-9]{2,8}$/i.test(name)) name += `.${fallbackExtension}`;
  return name.slice(0, 180);
}

function familyKey(item: ParsedProjectItem) {
  const composition = classifyComposition(item.kind, item.notes, item.term);
  const targetExt = item.itemKey.match(/\.([a-z0-9]{2,8})$/i)?.[1]?.toLowerCase() || "";
  const contextualConstraint = composition === "CONTEXTUAL" ? normalize(item.context || item.notes || "") : targetExt;
  return [normalize(item.term), normalize(item.universe || ""), normalize(item.kind), composition, contextualConstraint].join("::");
}

function parseScriptAssetContext(scriptText: string) {
  const byTarget = new Map<string, { preset: string; slot: string; scene: string; question?: string }>();
  const blocks = scriptText.replace(/\r/g, "").split(/(?=^\[[^\]]+\]\s*$)/m).map((value) => value.trim()).filter(Boolean);
  for (const block of blocks) {
    const scene = block.match(/^\[([^\]]+)\]/m)?.[1];
    if (!scene) continue;
    const fields: Record<string, string> = {};
    for (const line of block.split("\n")) {
      const separator = line.indexOf(":");
      if (separator > 0) fields[normalize(line.slice(0, separator)).replaceAll(" ", "_").toUpperCase()] = line.slice(separator + 1).trim();
    }
    const preset = fields.TIPO || "";
    const question = fields.PERGUNTA || "";
    for (const [key, value] of Object.entries(fields)) {
      if (!key.startsWith("IMAGEM") || !value) continue;
      byTarget.set(targetFileName(value).toLocaleLowerCase("pt-BR"), { preset, slot: key, scene, question });
    }
  }
  return byTarget;
}

function enrichRequirementsWithScript(items: ParsedProjectItem[], scriptText: string) {
  const scriptAssets = parseScriptAssetContext(scriptText);
  return items.map((item) => {
    const target = targetFileName(item.itemKey).toLocaleLowerCase("pt-BR");
    const script = scriptAssets.get(target);
    if (!script) return item;
    const context = item.context || [`CENA ${script.scene}`, script.question, script.slot].filter(Boolean).join(" — ");
    const metadata = [`PRESET=${script.preset}`, `SLOT=${script.slot}`, `CENA=${script.scene}`].filter((value) => !value.endsWith("=")).join(" | ");
    return { ...item, context, notes: [item.notes, metadata].filter(Boolean).join(" | ") };
  });
}

function supervisorItemContext(item: typeof automaticProjectItems.$inferSelect) {
  const metadata = [item.notes, item.context].filter(Boolean).join(" | ");
  const preset = metadata.match(/(?:PRESET|TIPO)\s*[=:]\s*([A-Z0-9_À-Ÿ-]+)/i)?.[1] || null;
  const slot = metadata.match(/(?:SLOT)\s*[=:]\s*([A-Z0-9_À-Ÿ-]+)/i)?.[1] || item.context?.match(/\b(IMAGEM(?:_PRINCIPAL|_[A-Z0-9]+)?)\b/i)?.[1] || null;
  return { preset, slot };
}

async function projectEvent(projectId: string, event: string, status?: string | null, detail?: unknown, itemId?: string | null, durationMs?: number | null) {
  await getDb().insert(automaticProjectEvents).values({ id: makeId("PEVT"), projectId, itemId: itemId || null, event, status: status || null, detail: detail === undefined ? null : JSON.stringify(detail).slice(0, 8000), durationMs: durationMs ?? null, createdAt: now() });
}

function parseBlockItems(text: string) {
  const blocks = text.replace(/\r/g, "").split(/(?=^\[[^\]]+\]\s*$)/m).map((value) => value.trim()).filter(Boolean);
  return blocks.flatMap((block, index) => {
    const heading = block.match(/^\[([^\]]+)\]/m)?.[1];
    if (!heading) return [];
    const fields: Record<string, string> = {};
    for (const line of block.split("\n")) {
      const separator = line.indexOf(":");
      if (separator > 0) fields[normalize(line.slice(0, separator)).replaceAll(" ", "_").toUpperCase()] = line.slice(separator + 1).trim();
    }
    const term = fields.TERMO || fields.NOME_SEMANTICO || fields.PERSONAGEM || fields.REFERENCIA_VISUAL || heading;
    return [{ itemKey: fields.ID || heading, term, context: fields.CONTEXTO || fields.REFERENCIA_ROTEIRO, kind: fields.TIPO || fields.CATEGORIA || "contextual", universe: fields.UNIVERSO, notes: fields.OBSERVACAO, priority: Number(fields.PRIORIDADE) || index + 1 } satisfies ParsedProjectItem];
  });
}

export function parseProjectRequirements(text: string) {
  const cleanText = text.replace(/^\uFEFF/, "").replace(/\r/g, "");
  const blockItems = parseBlockItems(cleanText);
  if (blockItems.length) return blockItems;
  const items: ParsedProjectItem[] = [];
  for (const rawLine of cleanText.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("//") || line.startsWith(";")) continue;
    const parts = line.split("|").map((part) => part.trim());
    const header = parts.map((part) => normalize(part));
    if (["id", "item id", "termo"].includes(header[0]) && header.some((part) => ["termo", "quantidade", "contexto"].includes(part))) continue;
    if (Number.isInteger(Number(parts[1])) && Number(parts[1]) > 0) {
      const quantity = Math.min(100, Number(parts[1]));
      for (let index = 0; index < quantity; index += 1) items.push({ itemKey: `${String(items.length + 1).padStart(3, "0")}`, term: parts[0], kind: parts[2] || "contextual", universe: parts[3] || undefined, priority: items.length + 1 });
      continue;
    }
    const itemKey = parts.length > 1 ? parts[0] : String(items.length + 1).padStart(3, "0");
    const term = parts.length > 1 ? parts[1] : parts[0];
    if (!term) continue;
    items.push({ itemKey, term, kind: parts[2] || "contextual", universe: parts[3] || undefined, context: parts[4] || undefined, notes: parts.slice(5).join(" | ") || undefined, priority: items.length + 1 });
  }
  if (!items.length) throw new Error("TXT_SEM_ITENS_VALIDOS");
  if (items.length > 2000) throw new Error("LIMITE_2000_ITENS");
  return items;
}

export async function createAutomaticProject(input: Record<string, unknown>) {
  const name = clean(input.nome);
  if (!name) throw new Error("NOME_REQUIRED");
  const date = now(), id = clean(input.projeto_id) || makeId("PROJ");
  const [existing] = await getDb().select().from(automaticProjects).where(eq(automaticProjects.id, id)).limit(1);
  if (existing) return getAutomaticProject(id);
  const [sameName] = await projectNameGroup(name);
  if (sameName) {
    await projectEvent(sameName.id, "duplicate_project_reused", sameName.status, { requestedName: name, existingProjectId: sameName.id });
    return getAutomaticProject(sameName.id);
  }
  const completedRequest = (await getDb().select().from(requests)).find((row) => normalize(row.project) === normalize(name) && normalize(row.status).includes("conclu"));
  if (completedRequest) throw new Error("PROJECT_GROUP_CONCLUIDO_MANUALMENTE: desconclua o projeto antes de criar uma nova execução");
  const projectDomain = clean(input.project_domain || input.dominio).toUpperCase() || "GENERAL";
  const row = {
    id, name, status: "WAITING_FILES", projectDomain, queuePriority: Math.max(1, Number(input.prioridade_fila) || 1), readyAt: date, originalReadyAt: date, lastAction: "PROJECT_CREATED", automatic: input.automatico !== false,
    libraryFirst: input.biblioteca_primeiro !== false, externalSearch: input.busca_externa !== false,
    parallelMaterialization: input.materializacao_paralela !== false, automaticTechnicalQa: input.qa_tecnico !== false,
    automaticZip: input.zip_automatico !== false, deleteZipOnComplete: input.excluir_zip_ao_concluir !== false,
    circuitBreaker: input.circuit_breaker !== false, createdAt: date, updatedAt: date,
  };
  await getDb().insert(automaticProjects).values(row);
  await projectEvent(id, "project_created", "WAITING_FILES", { automatic: row.automatic });
  return getAutomaticProject(id);
}

export async function updateAutomaticProject(input: Record<string, unknown>) {
  const projectId = clean(input.projeto_id);
  const [project] = await getDb().select().from(automaticProjects).where(eq(automaticProjects.id, projectId)).limit(1);
  if (!project) throw new Error("PROJECT_NOT_FOUND");
  const values = {
    name: clean(input.nome) || project.name,
    projectDomain: clean(input.project_domain || input.dominio).toUpperCase() || project.projectDomain || "GENERAL",
    queuePriority: input.prioridade_fila === undefined ? project.queuePriority : Math.max(1, Number(input.prioridade_fila) || 1),
    automatic: input.automatico === undefined ? project.automatic : input.automatico === true,
    libraryFirst: input.biblioteca_primeiro === undefined ? project.libraryFirst : input.biblioteca_primeiro === true,
    externalSearch: input.busca_externa === undefined ? project.externalSearch : input.busca_externa === true,
    parallelMaterialization: input.materializacao_paralela === undefined ? project.parallelMaterialization : input.materializacao_paralela === true,
    automaticTechnicalQa: input.qa_tecnico === undefined ? project.automaticTechnicalQa : input.qa_tecnico === true,
    automaticZip: input.zip_automatico === undefined ? project.automaticZip : input.zip_automatico === true,
    deleteZipOnComplete: input.excluir_zip_ao_concluir === undefined ? project.deleteZipOnComplete : input.excluir_zip_ao_concluir === true,
    circuitBreaker: input.circuit_breaker === undefined ? project.circuitBreaker : input.circuit_breaker === true,
    updatedAt: now(),
  };
  await getDb().update(automaticProjects).set(values).where(eq(automaticProjects.id, projectId));
  await projectEvent(projectId, "project_settings_updated", project.status, values);
  return getAutomaticProject(projectId);
}

export async function attachAutomaticProjectFile(projectId: string, roleInput: string, fileName: string, mimeType: string, bytes: Uint8Array) {
  const role = roleInput.toUpperCase() === "SCRIPT" ? "SCRIPT" : roleInput.toUpperCase() === "REQUIREMENTS" ? "REQUIREMENTS" : "";
  if (!role) throw new Error("ROLE_INVALID");
  if (!bytes.byteLength || bytes.byteLength > 10 * 1024 * 1024) throw new Error("TXT_LIMIT_10_MB");
  const db = getDb();
  const [project] = await db.select().from(automaticProjects).where(eq(automaticProjects.id, projectId)).limit(1);
  if (!project) throw new Error("PROJECT_NOT_FOUND");
  await assertProjectAutomationAllowed(project);
  const contentHash = await sha256Hex(bytes);
  const [same] = await db.select().from(automaticProjectFiles).where(and(eq(automaticProjectFiles.projectId, projectId), eq(automaticProjectFiles.role, role), eq(automaticProjectFiles.contentHash, contentHash))).orderBy(desc(automaticProjectFiles.version)).limit(1);
  if (same) {
    await projectEvent(projectId, "project_file_idempotent_reuse", project.status, { role, version: same.version, fileName: same.fileName, contentHash });
    if (project.automatic) await startAutomaticProject(projectId);
    return getAutomaticProject(projectId);
  }
  const active = ["READY", "PROCESSING", "QA_IN_PROGRESS", "PARTIAL_READY", "READY_TO_COMPLETE"].includes(project.status);
  const [latest] = await db.select().from(automaticProjectFiles).where(and(eq(automaticProjectFiles.projectId, projectId), eq(automaticProjectFiles.role, role))).orderBy(desc(automaticProjectFiles.version)).limit(1);
  const version = Math.max((latest?.version || 0) + 1, active ? project.activeVersion + 1 : 1);
  const id = makeId("PFILE"), safeName = (fileName || `${role.toLowerCase()}.txt`).replace(/[^a-zA-Z0-9À-ÿ._-]/g, "-");
  const r2Key = `projects/${projectId}/files/${role.toLowerCase()}/v${version}-${id}-${safeName}`;
  await env.BUCKET.put(r2Key, bytes, { httpMetadata: { contentType: mimeType || "text/plain" }, customMetadata: { projectId, role, version: String(version), originalName: fileName, contentHash } });
  const inserted = await db.insert(automaticProjectFiles).values({ id, projectId, role, version, fileName, r2Key, mimeType: mimeType || "text/plain", sizeBytes: bytes.byteLength, contentHash, createdAt: now() }).onConflictDoNothing().returning({ id: automaticProjectFiles.id });
  if (!inserted.length) {
    const [winner] = await db.select().from(automaticProjectFiles).where(and(eq(automaticProjectFiles.projectId, projectId), eq(automaticProjectFiles.role, role), eq(automaticProjectFiles.contentHash, contentHash))).orderBy(desc(automaticProjectFiles.version)).limit(1);
    if (winner?.r2Key !== r2Key) await env.BUCKET.delete(r2Key).catch(() => undefined);
    await projectEvent(projectId, "project_file_idempotent_race_reuse", project.status, { role, version: winner?.version || version, contentHash });
    if (project.automatic) await startAutomaticProject(projectId);
    return getAutomaticProject(projectId);
  }
  await db.update(automaticProjects).set({ productionRevision: sql`${automaticProjects.productionRevision} + 1`, updatedAt: now() }).where(eq(automaticProjects.id, projectId));
  await projectEvent(projectId, "project_file_received", project.status, { role, version, fileName, bytes: bytes.byteLength, contentHash });
  if (active) {
    await projectEvent(projectId, "new_version_staged", project.status, { role, version, reason: "CURRENT_BATCH_PRESERVED" });
    return getAutomaticProject(projectId);
  }
  if (project.automatic) await startAutomaticProject(projectId);
  return getAutomaticProject(projectId);
}

async function latestProjectFiles(projectId: string) {
  const rows = await getDb().select().from(automaticProjectFiles).where(eq(automaticProjectFiles.projectId, projectId)).orderBy(desc(automaticProjectFiles.version));
  return { rows, script: rows.find((row) => row.role === "SCRIPT") || null, requirements: rows.find((row) => row.role === "REQUIREMENTS") || null };
}

async function readTextFile(row: typeof automaticProjectFiles.$inferSelect) {
  const object = await env.BUCKET.get(row.r2Key);
  if (!object) throw new Error("PROJECT_FILE_MISSING_R2");
  return new TextDecoder().decode(await object.arrayBuffer());
}

export async function getAutomaticProjectFile(input: Record<string, unknown>, includeContent = true) {
  const projectId = clean(input.projeto_id);
  const fileId = clean(input.arquivo_id);
  const requestedRole = clean(input.tipo).toUpperCase();
  const requestedVersion = Number(input.versao);
  if (!projectId) throw new Error("PROJECT_ID_REQUIRED");
  if (requestedRole && !["SCRIPT", "REQUIREMENTS"].includes(requestedRole)) throw new Error("ROLE_INVALID");

  const db = getDb();
  const [project] = await db.select().from(automaticProjects).where(eq(automaticProjects.id, projectId)).limit(1);
  if (!project) throw new Error("PROJECT_NOT_FOUND");
  const rows = await db.select().from(automaticProjectFiles).where(eq(automaticProjectFiles.projectId, projectId)).orderBy(desc(automaticProjectFiles.version), desc(automaticProjectFiles.createdAt));
  const file = rows.find((row) => {
    if (fileId && row.id !== fileId) return false;
    if (requestedRole && row.role !== requestedRole) return false;
    if (Number.isFinite(requestedVersion) && requestedVersion > 0 && row.version !== requestedVersion) return false;
    return true;
  });
  if (!file) throw new Error("PROJECT_FILE_NOT_FOUND");

  const object = await env.BUCKET.get(file.r2Key);
  if (!object) throw new Error("PROJECT_FILE_MISSING_R2");
  const metadata = {
    projeto_id: projectId,
    projeto_nome: project.name,
    arquivo_id: file.id,
    tipo: file.role,
    versao: file.version,
    nome_arquivo: file.fileName,
    mime_type: file.mimeType,
    tamanho_bytes: file.sizeBytes,
    hash_sha256: file.contentHash,
    criado_em: file.createdAt,
  };
  if (!includeContent) return metadata;
  if (!file.mimeType.toLowerCase().includes("text") && !file.fileName.toLowerCase().endsWith(".txt")) throw new Error("PROJECT_FILE_NOT_TEXT");

  const textContent = new TextDecoder().decode(await object.arrayBuffer());
  const start = Math.max(0, Math.floor(Number(input.inicio_caractere) || 0));
  const requestedLimit = Math.floor(Number(input.limite_caracteres) || 200_000);
  const limit = Math.max(1, Math.min(500_000, requestedLimit));
  const end = Math.min(textContent.length, start + limit);
  const content = textContent.slice(start, end);
  return {
    ...metadata,
    conteudo_txt: content,
    inicio_caractere: start,
    caracteres_retornados: content.length,
    caracteres_total: textContent.length,
    completo: end >= textContent.length,
    proximo_inicio: end < textContent.length ? end : null,
  };
}

async function prepareVersionItems(projectId: string, version: number, parsed: ParsedProjectItem[], requirementsHash: string | null) {
  const db = getDb(), date = now();
  const [project] = await db.select().from(automaticProjects).where(eq(automaticProjects.id, projectId)).limit(1);
  const projectDomain = project?.projectDomain || "GENERAL";
  let existing = await db.select().from(automaticProjectItems).where(and(eq(automaticProjectItems.projectId, projectId), eq(automaticProjectItems.version, version)));
  const duplicateGroups = new Map<string, typeof existing>();
  for (const row of existing) duplicateGroups.set(row.itemKey, [...(duplicateGroups.get(row.itemKey) || []), row]);
  let removedDuplicates = 0;
  for (const [itemKey, rows] of duplicateGroups) {
    if (rows.length < 2) continue;
    const score = (row: typeof rows[number]) => (RESOLVED_STATUSES.has(row.status) ? 1000 : 0) + (row.linkedAssetId ? 500 : 0) + (row.materializationFileId ? 100 : 0) + row.updatedAt.getTime() / 1e15;
    const keeper = [...rows].sort((a, b) => score(b) - score(a))[0];
    const duplicates = rows.filter((row) => row.id !== keeper.id);
    const duplicateIds = duplicates.map((row) => row.id);
    if (duplicateIds.length) {
      await db.update(automaticProjectEvents).set({ itemId: keeper.id }).where(inArray(automaticProjectEvents.itemId, duplicateIds));
      await db.update(automaticProjectItems).set({ familySeedItemId: keeper.id }).where(inArray(automaticProjectItems.familySeedItemId, duplicateIds));
      await db.delete(automaticProjectItems).where(inArray(automaticProjectItems.id, duplicateIds));
      removedDuplicates += duplicateIds.length;
      await projectEvent(projectId, "idempotent_duplicate_collapsed", "IDEMPOTENT_REUSE", { version, itemKey, keeper: keeper.id, removed: duplicateIds });
    }
  }
  if (removedDuplicates) existing = await db.select().from(automaticProjectItems).where(and(eq(automaticProjectItems.projectId, projectId), eq(automaticProjectItems.version, version)));
  const existingByKey = new Map(existing.map((row) => [row.itemKey, row]));
  const firstByFamily = new Map<string, string>();
  for (const item of parsed) if (!firstByFamily.has(familyKey(item))) firstByFamily.set(familyKey(item), item.itemKey);
  const idByKey = new Map<string, string>();
  for (const item of parsed) idByKey.set(item.itemKey, existingByKey.get(item.itemKey)?.id || await stableProjectItemId(projectId, version, item.itemKey));

  for (const item of parsed) {
    const familyId = familyKey(item), seedKey = firstByFamily.get(familyId) || item.itemKey, seedId = idByKey.get(seedKey) || null;
    const compositionClass = classifyComposition(item.kind, item.notes, item.term);
    const semanticClass = classifySemantic(item.term, item.kind, item.universe, compositionClass);
    const current = existingByKey.get(item.itemKey);
    const values = {
      targetFile: targetFileName(item.itemKey), term: item.term, context: item.context || null, kind: item.kind,
      universe: item.universe || null, itemDomain: current?.itemDomain || projectDomain, notes: item.notes || null, priority: item.priority, compositionClass, semanticClass,
      familyId, familySeedItemId: seedId, requirementsHash, originalReadyAt: current?.originalReadyAt || date, updatedAt: date,
    };
    if (current) {
      await db.update(automaticProjectItems).set(values).where(eq(automaticProjectItems.id, current.id));
      continue;
    }
    await db.insert(automaticProjectItems).values({
      id: idByKey.get(item.itemKey)!, projectId, version, itemKey: item.itemKey, ...values,
      status: item.itemKey === seedKey ? "SEARCHING_LIBRARY" : "WAITING_FAMILY_SEED", stage: item.itemKey === seedKey ? "COLETA" : null, stageReadyAt: item.itemKey === seedKey ? date : null, createdAt: date,
    }).onConflictDoNothing();
  }
  return { createdOrReused: parsed.length, families: firstByFamily.size };
}

export async function backfillAutomaticProjectItemsFromFiles(projectId: string) {
  const db = getDb();
  const [project] = await db.select().from(automaticProjects).where(eq(automaticProjects.id, projectId)).limit(1);
  if (!project) throw new Error("PROJECT_NOT_FOUND");
  const existing = await db.select({ id: automaticProjectItems.id, version: automaticProjectItems.version }).from(automaticProjectItems).where(eq(automaticProjectItems.projectId, projectId));
  const files = await latestProjectFiles(projectId);
  if (!files.requirements) return { project_id: projectId, changed: false, reason: "REQUIREMENTS_NOT_FOUND", items_before: existing.length, items_after: existing.length };
  const version = Math.max(files.requirements.version, files.script?.version || 0, project.activeVersion || 1);
  const hasCanonical = existing.some((row) => row.version === version);
  if (hasCanonical) return { project_id: projectId, changed: false, reason: "CANONICAL_ITEMS_ALREADY_EXIST", active_version: version, items_before: existing.length, items_after: existing.length };
  const [requirementsText, scriptText] = await Promise.all([readTextFile(files.requirements), files.script ? readTextFile(files.script) : Promise.resolve("")]);
  const parsed = enrichRequirementsWithScript(parseProjectRequirements(requirementsText), scriptText);
  if (!parsed.length) return { project_id: projectId, changed: false, reason: "REQUIREMENTS_PARSED_ZERO_ITEMS", active_version: version, items_before: existing.length, items_after: existing.length };
  const prepared = await prepareVersionItems(projectId, version, parsed, files.requirements.contentHash || null);
  await db.update(automaticProjects).set({ activeVersion: version, lastAction: "LEGACY_ITEMS_BACKFILLED_V58", updatedAt: now() }).where(eq(automaticProjects.id, projectId));
  await projectEvent(projectId, "legacy_items_backfilled_v58", "READY", { version, items: parsed.length, families: prepared.families, requirements_hash: files.requirements.contentHash || null });
  return { project_id: projectId, changed: true, active_version: version, items_before: existing.length, items_after: parsed.length, families: prepared.families };
}

export async function startAutomaticProject(projectId: string) {
  const db = getDb();
  const [project] = await db.select().from(automaticProjects).where(eq(automaticProjects.id, projectId)).limit(1);
  if (!project) throw new Error("PROJECT_NOT_FOUND");
  await assertProjectAutomationAllowed(project);
  const files = await latestProjectFiles(projectId);
  if (!files.script || !files.requirements) {
    await db.update(automaticProjects).set({ status: "WAITING_FILES", updatedAt: now() }).where(eq(automaticProjects.id, projectId));
    return getAutomaticProject(projectId);
  }
  if (["PROCESSING", "QA_IN_PROGRESS"].includes(project.status)) return getAutomaticProject(projectId);
  const version = Math.max(files.script.version, files.requirements.version, project.activeVersion);
  const [requirementsText, scriptText] = await Promise.all([readTextFile(files.requirements), readTextFile(files.script)]);
  const parsed = enrichRequirementsWithScript(parseProjectRequirements(requirementsText), scriptText);
  const date = now();
  await db.update(automaticProjects).set({ status: "READY", activeVersion: version, startedAt: project.startedAt || date, completedAt: null, collectionBatchId: null, updatedAt: date }).where(eq(automaticProjects.id, projectId));
  const prepared = await prepareVersionItems(projectId, version, parsed, files.requirements.contentHash || null);
  await projectEvent(projectId, "requirements_parsed_idempotent", "READY", { version, items: parsed.length, families: prepared.families, requirementsHash: files.requirements.contentHash || null });
  await reconcileAutomaticProject(projectId, false);
  await resolveProjectFromLibrary(projectId, version);
  return getAutomaticProject(projectId);
}

async function registerUsage(project: typeof automaticProjects.$inferSelect, item: typeof automaticProjectItems.$inferSelect, assetId: string, note: string) {
  const db = getDb();
  const usageId = `USE-${project.id}-${item.version}-${item.itemKey}`.slice(0, 190);
  const inserted = await db.insert(assetUsage).values({ id: usageId, assetId, project: project.name, role: item.kind, scriptReference: item.context, note, usedAt: now() }).onConflictDoNothing().returning({ id: assetUsage.id });
  if (inserted.length) await db.update(assets).set({ useCount: sql`${assets.useCount} + 1`, lastUsedAt: now(), updatedAt: now() }).where(eq(assets.id, assetId));
}

async function fanOutFamily(projectId: string, version: number, familyId: string | null, seedItemId: string, assetId: string) {
  if (!familyId) return 0;
  const db = getDb();
  const [project] = await db.select().from(automaticProjects).where(eq(automaticProjects.id, projectId)).limit(1);
  if (!project) return 0;
  const members = await db.select().from(automaticProjectItems).where(and(eq(automaticProjectItems.projectId, projectId), eq(automaticProjectItems.version, version), eq(automaticProjectItems.familyId, familyId))).orderBy(asc(automaticProjectItems.priority));
  let linked = 0;
  for (const member of members) {
    if (member.id === seedItemId || RESOLVED_STATUSES.has(member.status)) continue;
    await registerUsage(project, member, assetId, "Fan-out intra-projeto a partir de seed aprovada");
    await db.update(automaticProjectItems).set({ status: "LINKED_FROM_FAMILY", sourceType: "FAMILY", linkedAssetId: assetId, failureReason: null, updatedAt: now() }).where(eq(automaticProjectItems.id, member.id));
    linked += 1;
    await projectEvent(projectId, "item_linked_from_family", "LINKED_FROM_FAMILY", { familyId, seedItemId, assetId }, member.id);
  }
  return linked;
}

async function fanOutResolvedSeeds(projectId: string, version: number) {
  const items = await getDb().select().from(automaticProjectItems).where(and(eq(automaticProjectItems.projectId, projectId), eq(automaticProjectItems.version, version))).orderBy(asc(automaticProjectItems.priority));
  for (const seed of items) if (seed.linkedAssetId && seed.familySeedItemId === seed.id) await fanOutFamily(projectId, version, seed.familyId, seed.id, seed.linkedAssetId);
}

function strategyFromItem(item: typeof automaticProjectItems.$inferSelect): StrategyState {
  return parseJson<StrategyState>(item.strategyState, {});
}

function withPlan(state: StrategyState, plan: SupervisorOutput) {
  const references = plan.reference ? [plan.reference] : [];
  return {
    ...state,
    reference_history: [...new Set([...(state.reference_history || []), ...references])],
    // query_history registra somente consultas efetivamente executadas. Alternativas planejadas ficam em current_strategy.
    query_history: state.query_history || [],
    current_strategy: plan as unknown as Record<string, unknown>,
  } satisfies StrategyState;
}

async function recordAttemptedQuery(itemId: string, query: string) {
  const value = clean(query);
  if (!value) return;
  const db = getDb();
  const [latest] = await db.select().from(automaticProjectItems).where(eq(automaticProjectItems.id, itemId)).limit(1);
  if (!latest) return;
  const state = strategyFromItem(latest);
  state.query_history = [...new Set([...(state.query_history || []), value])].slice(-100);
  await db.update(automaticProjectItems).set({ strategyState: JSON.stringify(state), updatedAt: now() }).where(eq(automaticProjectItems.id, itemId));
}


function collectionPolicy(plan: SupervisorOutput) {
  return JSON.stringify({
    preferred_sources: plan.preferred_sources || [], negative_terms: plan.negative_terms || [],
    preferred_hosts: plan.preferred_hosts || [], avoid_hosts: plan.avoid_hosts || [],
    avoid_sources: ((plan as unknown as Record<string, unknown>).avoid_sources as string[] | undefined) || [],
    strict_preferred_sources: Boolean((plan as unknown as Record<string, unknown>).strict_preferred_sources),
    queries: plan.queries || [], max_rounds: plan.max_rounds || 3, max_urls_per_term: (plan as unknown as Record<string, unknown>).max_urls_per_term || undefined, max_sources_per_term: (plan as unknown as Record<string, unknown>).max_sources_per_term || undefined, timeout_ms: (plan as unknown as Record<string, unknown>).timeout_ms || undefined,
  });
}

let telemetryCache: { at: number; value: Record<string, unknown> } | null = null;
async function supervisorTelemetry() {
  if (telemetryCache && Date.now() - telemetryCache.at < 10_000) return telemetryCache.value;
  const db = getDb();
  const [ranking, sources] = await Promise.all([
    getHostRanking(),
    db.select().from(collectionSources).where(eq(collectionSources.active, true)).orderBy(asc(collectionSources.priority)).limit(100),
  ]);
  const hosts = ranking.hosts || [];
  const preferredHosts = hosts.filter((row) => row.classification === "PREFERENCIAL" || row.classification === "ESTAVEL").slice(0, 20).map((row) => row.host);
  const badHosts = hosts.filter((row) => row.classification === "EVITAR" || row.classification === "BLOQUEADO").slice(0, 30).map((row) => row.host);
  const value = {
    preferred_hosts: preferredHosts,
    stable_hosts: hosts.filter((row) => row.classification === "ESTAVEL").slice(0, 30).map((row) => row.host),
    bad_hosts: badHosts,
    circuit_breaker_open: hosts.filter((row) => row.circuitState === "OPEN").map((row) => row.host),
    host_health: hosts.slice(0, 100).map((row) => ({
      host: row.host, score: row.score, classification: row.classification, circuit_state: row.circuitState,
      technical_rate: row.technicalRate, visual_rate: row.visualRate, avg_latency_ms: row.avgLatencyMs,
      p95_latency_ms: row.p95LatencyMs, successes: row.successes, failures: row.failures, approved: row.approved, rejected: row.rejected,
    })),
    sources: sources.map((row) => ({ id: row.id, name: row.name, priority: row.priority, api_key_configured: row.apiKeyEnv ? Boolean((env as unknown as Record<string, unknown>)[row.apiKeyEnv]) : true, queries: row.queryCount, found: row.foundCount, materialized: row.materializedCount, failures: row.failureCount, avg_latency_ms: row.queryCount ? Math.round(row.totalDurationMs / row.queryCount) : null })),
    global_concurrency: 8, per_host_concurrency: 2, fetch_timeout_ms: 12_000,
    supervisor: await getSupervisorMode(),
  };
  telemetryCache = { at: Date.now(), value };
  return value;
}

function libraryCandidateSummary(rows: Array<typeof assets.$inferSelect>) {
  return rows.slice(0, 20).map((asset) => ({ id: asset.id, name: asset.name, universe: asset.universe, kind: asset.kind, subject: asset.subject, semantic_family: asset.semanticFamily, tags: asset.tags, use_count: asset.useCount, qa_status: asset.qaStatus }));
}

async function approvedLibraryMatches(item: typeof automaticProjectItems.$inferSelect) {
  const approved = await getDb().select().from(assets).where(eq(assets.status, "Aprovado"));
  const needle = normalize(item.term), universe = normalize(item.universe || "");
  return approved.filter((asset) => {
    const haystack = normalize([asset.semanticFamily, asset.subject, asset.name, asset.tags].filter(Boolean).join(" "));
    return haystack.includes(needle) && (!universe || normalize(asset.universe || "").includes(universe));
  });
}

async function planItem(
  project: typeof automaticProjects.$inferSelect,
  item: typeof automaticProjectItems.$inferSelect,
  event: "ITEM_START" | "SEARCH_EXHAUSTED" | "RELINK_REQUIRED",
  extras: { libraryState?: SupervisorInput["library_state"]; candidates?: SupervisorInput["candidates"] } = {},
) {
  const state = strategyFromItem(item);
  const profilePolicy = await sourcePolicyForItem({ term: item.semanticReference || item.term, compositionClass: item.compositionClass, semanticClass: item.semanticClass, universe: item.universe, kind: item.kind, domain: item.itemDomain || project.projectDomain });
  const semanticClass = (item.semanticClass || classifySemantic(item.term, item.kind, item.universe, item.compositionClass === "ISOLATED" ? "ISOLATED" : "CONTEXTUAL")) as SupervisorOutput["semantic_class"];
  const plan = {
    action: event === "RELINK_REQUIRED" || event === "SEARCH_EXHAUSTED" ? "RELINK_ITEM" : "START_EXTERNAL_SEARCH",
    reason: event === "ITEM_START" ? "Planejamento determinístico: usar referência existente e perfil persistente; nenhuma IA interna foi chamada." : "Limite determinístico atingido; decisão adaptativa deve ser feita pelo Supervisor ChatGPT via MCP.",
    reference: item.semanticReference || item.term,
    universe_reference: item.universe || null,
    semantic_class: semanticClass,
    composition_class: item.compositionClass === "ISOLATED" ? "ISOLATED" : "CONTEXTUAL",
    queries: [profilePolicy.query],
    negative_terms: profilePolicy.negative_terms,
    preferred_sources: profilePolicy.preferred_sources,
    preferred_hosts: profilePolicy.preferred_hosts,
    avoid_hosts: profilePolicy.avoid_hosts,
    max_rounds: profilePolicy.max_rounds,
    notes: profilePolicy.profile_id ? `SOURCE_PROFILE=${profilePolicy.profile_id}` : "Sem perfil específico; usando configuração determinística padrão.",
  } satisfies SupervisorOutput;
  (plan as unknown as Record<string, unknown>).timeout_ms = profilePolicy.timeout_ms;
  (plan as unknown as Record<string, unknown>).max_urls_per_term = profilePolicy.max_urls_per_term;
  (plan as unknown as Record<string, unknown>).max_sources_per_term = profilePolicy.max_sources_per_term;
  (plan as unknown as Record<string, unknown>).source_profile_id = profilePolicy.profile_id;
  (plan as unknown as Record<string, unknown>).avoid_sources = profilePolicy.avoid_sources;
  (plan as unknown as Record<string, unknown>).strict_preferred_sources = profilePolicy.strict_preferred_sources;
  const next = withPlan(state, plan);
  await getDb().update(automaticProjectItems).set({
    semanticReference: plan.reference || item.semanticReference || item.term,
    semanticClass: plan.semantic_class || item.semanticClass,
    compositionClass: plan.composition_class || item.compositionClass,
    searchPlan: JSON.stringify(plan), strategyState: JSON.stringify(next), updatedAt: now(),
  }).where(eq(automaticProjectItems.id, item.id));
  await projectEvent(project.id, "deterministic_plan", plan.action, { event, plan, supervisor_internal_ai: false }, item.id);
  return { plan, state: next };
}

async function executeSupervisorPlanningAction(project: typeof automaticProjects.$inferSelect, item: typeof automaticProjectItems.$inferSelect, output: SupervisorOutput) {
  const db = getDb();
  if (output.action === "USE_LIBRARY_ASSET" && output.selected_asset_id) {
    const matureMatches = await approvedLibraryMatches(item);
    const selected = matureMatches.length >= 5 ? matureMatches.find((asset) => asset.id === output.selected_asset_id) : null;
    if (selected) {
      await registerUsage(project, item, selected.id, "Selecionado diretamente pelo Supervisor IA após validar maturidade >= 5");
      await db.update(automaticProjectItems).set({ status: "LINKED_FROM_LIBRARY", sourceType: "LIBRARY", linkedAssetId: selected.id, failureReason: null, updatedAt: now() }).where(eq(automaticProjectItems.id, item.id));
      await fanOutFamily(project.id, item.version, item.familyId, item.id, selected.id);
      await projectEvent(project.id, "supervisor_library_asset_selected", "LINKED_FROM_LIBRARY", { assetId: selected.id }, item.id);
      return { handled: true, search: false };
    }
  }
  if (output.action === "CANCEL_ITEM") {
    await db.update(automaticProjectItems).set({ status: "CANCELLED", failureReason: output.reason, updatedAt: now() }).where(eq(automaticProjectItems.id, item.id));
    await persistSupervisorHistory(item, "failure", { action: output.action, reason: output.reason });
    await projectEvent(project.id, "supervisor_item_cancelled", "CANCELLED", { reason: output.reason }, item.id);
    return { handled: true, search: false };
  }
  if (output.action === "MATERIALIZE_URL" && output.selected_url) {
    const handled = await materializeSupervisorUrl(project, item, output);
    return { handled, search: !handled };
  }
  if (output.action === "PROBE_URL" && output.selected_url) {
    const probe = await probeMaterializationUrl({ url: output.selected_url });
    await projectEvent(project.id, "supervisor_probe", probe.success ? "SUCCESS" : "FAILED", probe, item.id);
    if (probe.success) {
      const handled = await materializeSupervisorUrl(project, item, { ...output, action: "MATERIALIZE_URL" });
      return { handled, search: !handled };
    }
    await persistSupervisorHistory(item, "failure", { action: "PROBE_URL", reason: probe.detail || "PROBE_FAILED", url: output.selected_url });
    return { handled: false, search: true };
  }
  return { handled: false, search: true };
}

async function resolveProjectFromLibrary(projectId: string, version: number) {
  const db = getDb();
  const [project] = await db.select().from(automaticProjects).where(eq(automaticProjects.id, projectId)).limit(1);
  if (!project) throw new Error("PROJECT_NOT_FOUND");
  await fanOutResolvedSeeds(projectId, version);
  const items = await db.select().from(automaticProjectItems).where(and(eq(automaticProjectItems.projectId, projectId), eq(automaticProjectItems.version, version))).orderBy(asc(automaticProjectItems.priority));
  const approved = await db.select().from(assets).where(eq(assets.status, "Aprovado"));
  const unresolvedSeeds: typeof items = [];
  const preplanned = new Map<string, SupervisorOutput>();
  for (const item of items) {
    if (item.familySeedItemId && item.familySeedItemId !== item.id) continue;
    if (item.linkedAssetId || item.collectionTermId) continue;
    const needle = normalize(item.term), universe = normalize(item.universe || "");
    const matches = approved.filter((asset) => {
      const haystack = normalize([asset.semanticFamily, asset.subject, asset.name, asset.tags].filter(Boolean).join(" "));
      return haystack.includes(needle) && (!universe || normalize(asset.universe).includes(universe));
    });
    if (project.libraryFirst && matches.length >= 5) {
      // Reuso determinístico de repertório já aprovado: não é uma nova aprovação semântica.
      // Entre correspondências exatas maduras, prioriza o asset menos usado para preservar giro.
      const selected = [...matches].sort((a, b) => a.useCount - b.useCount || a.name.localeCompare(b.name))[0];
      if (selected) {
        await registerUsage(project, item, selected.id, "Reuso determinístico de Biblioteca madura (>=5 variações previamente aprovadas)");
        await db.update(automaticProjectItems).set({ status: "LINKED_FROM_LIBRARY", sourceType: "LIBRARY", linkedAssetId: selected.id, failureReason: null, updatedAt: now() }).where(eq(automaticProjectItems.id, item.id));
        await projectEvent(projectId, "item_linked_from_library", "LINKED_FROM_LIBRARY", { assetId: selected.id, variations: matches.length, supervisor: false, deterministic_reuse: true }, item.id);
        await fanOutFamily(projectId, version, item.familyId, item.id, selected.id);
      } else unresolvedSeeds.push(item);
    } else unresolvedSeeds.push(item);
  }
  if (!unresolvedSeeds.length) {
    await db.update(automaticProjects).set({ status: "READY_TO_COMPLETE", updatedAt: now() }).where(eq(automaticProjects.id, projectId));
    if (project.automaticZip) await regenerateProjectZip(projectId);
    return;
  }
  if (!project.externalSearch) {
    for (const item of unresolvedSeeds) await db.update(automaticProjectItems).set({ status: "RELINK_REQUIRED", failureReason: "EXTERNAL_SEARCH_DISABLED", updatedAt: now() }).where(eq(automaticProjectItems.id, item.id));
    await db.update(automaticProjects).set({ status: "PARTIAL_READY", updatedAt: now() }).where(eq(automaticProjects.id, projectId));
    return;
  }
  const planned: Array<{ item: typeof unresolvedSeeds[number]; query: string; preferredSources: string[]; plan: SupervisorOutput }> = [];
  for (const item of unresolvedSeeds) {
    const plan = preplanned.get(item.id) || (await planItem(project, item, "ITEM_START")).plan;
    const execution = await executeSupervisorPlanningAction(project, item, plan);
    if (execution.handled) continue;
    planned.push({ item, query: plan.queries?.[0] || plan.reference || item.term, preferredSources: plan.preferred_sources || [], plan });
  }
  if (!planned.length) {
    await reconcileAutomaticProject(projectId);
    return;
  }
  const termsText = planned.map(({ item, query }) => `${query} | 3 | ${item.compositionClass === "ISOLATED" ? "transparente" : "contextual"} | ${item.universe || ""}`).join("\n");
  const collection = await createCollectionBatch({ nome: `${project.name} · v${version}`, termos_texto: termsText, max_urls_por_termo: 60, max_fontes_por_termo: 20, max_rodadas_por_termo: 5, max_minutos_por_termo: 20, max_minutos_total: 480 });
  const terms = collection.termos as Array<{ id: string }>;
  for (let index = 0; index < planned.length; index += 1) {
    const termId = terms[index]?.id || null;
    await db.update(automaticProjectItems).set({ status: "SEARCHING_EXTERNALLY", collectionTermId: termId, updatedAt: now() }).where(eq(automaticProjectItems.id, planned[index].item.id));
    if (termId) await db.update(collectionTerms).set({ sourcePlan: collectionPolicy(planned[index].plan), updatedAt: now() }).where(eq(collectionTerms.id, termId));
    await recordAttemptedQuery(planned[index].item.id, planned[index].query);
  }
  await db.update(automaticProjects).set({ status: "PROCESSING", collectionBatchId: collection.lote.id, updatedAt: now() }).where(eq(automaticProjects.id, projectId));
  await projectEvent(projectId, "external_collection_queued", "PROCESSING", { batchId: collection.lote.id, seedItems: planned.length, familySlots: items.length });
}

async function queueSearchTerm(project: typeof automaticProjects.$inferSelect, item: typeof automaticProjectItems.$inferSelect, plan: SupervisorOutput, batchId?: string | null) {
  const db = getDb(), query = plan.queries?.[0] || plan.reference || item.term;
  let activeBatchId = batchId || project.collectionBatchId || null;
  let termId: string | null = null;
  if (!activeBatchId) {
    const collection = await createCollectionBatch({ nome: `${project.name} · v${item.version} · retomada`, termos_texto: `${query} | 3 | ${item.compositionClass === "ISOLATED" ? "transparente" : "contextual"} | ${item.universe || ""}`, max_urls_por_termo: 60, max_fontes_por_termo: 20, max_rodadas_por_termo: plan.max_rounds || 3, max_minutos_por_termo: 20, max_minutos_total: 480 });
    activeBatchId = collection.lote.id;
    termId = (collection.termos as Array<{ id: string }>)[0]?.id || null;
    await db.update(automaticProjects).set({ collectionBatchId: activeBatchId, status: "PROCESSING", updatedAt: now() }).where(eq(automaticProjects.id, project.id));
  } else {
    const digest = await sha256Hex(new TextEncoder().encode(`${activeBatchId}\n${item.id}\n${Date.now()}`));
    termId = `COLTERM-${digest.slice(0, 24).toUpperCase()}`;
    await db.insert(collectionTerms).values({ id: termId, batchId: activeBatchId, term: query, targetQuantity: 3, kind: item.compositionClass === "ISOLATED" ? "transparente" : "contextual", universe: item.universe || null, sourcePlan: collectionPolicy(plan), updatedAt: now() });
    await db.update(collectionBatches).set({ status: "EXECUTANDO", totalTerms: sql`${collectionBatches.totalTerms} + 1`, totalTarget: sql`${collectionBatches.totalTarget} + 3`, completedAt: null, updatedAt: now() }).where(eq(collectionBatches.id, activeBatchId));
  }
  if (!activeBatchId || !termId) throw new Error("COLLECTION_TERM_CREATE_FAILED");
  await db.update(collectionTerms).set({ sourcePlan: collectionPolicy(plan), updatedAt: now() }).where(eq(collectionTerms.id, termId));
  await db.update(automaticProjectItems).set({ status: "SEARCHING_EXTERNALLY", collectionTermId: termId, failureReason: null, updatedAt: now() }).where(eq(automaticProjectItems.id, item.id));
  await recordAttemptedQuery(item.id, query);
  await projectEvent(project.id, "external_search_requeued", "SEARCHING_EXTERNALLY", { batchId: activeBatchId, termId, query, planAction: plan.action }, item.id);
  return activeBatchId;
}

async function ensureUnqueuedExternalSearch(projectId: string) {
  const db = getDb();
  const [project] = await db.select().from(automaticProjects).where(eq(automaticProjects.id, projectId)).limit(1);
  if (!project || !project.externalSearch) return 0;
  const items = await db.select().from(automaticProjectItems).where(and(eq(automaticProjectItems.projectId, projectId), eq(automaticProjectItems.version, project.activeVersion), eq(automaticProjectItems.status, "SEARCHING_EXTERNALLY"))).orderBy(asc(automaticProjectItems.priority));
  const orphans = items.filter((item) => !item.collectionTermId && !item.linkedAssetId);
  let batchId = project.collectionBatchId, queued = 0;
  for (const item of orphans) {
    const { plan } = await planItem(project, item, item.failureReason === "BAD_REFERENCE" ? "RELINK_REQUIRED" : "SEARCH_EXHAUSTED");
    const direct = await executeSupervisorPlanningAction(project, item, plan);
    if (direct.handled) { queued += 1; continue; }
    batchId = await queueSearchTerm(project, item, plan, batchId);
    queued += 1;
  }
  return queued;
}

async function fetchTermsChunked(termIds: string[]) {
  const rows: Array<typeof collectionTerms.$inferSelect> = [];
  for (const ids of chunk([...new Set(termIds)], 40)) if (ids.length) rows.push(...await getDb().select().from(collectionTerms).where(inArray(collectionTerms.id, ids)));
  return rows;
}

async function replanFailedItem(project: typeof automaticProjects.$inferSelect, item: typeof automaticProjectItems.$inferSelect, term: typeof collectionTerms.$inferSelect) {
  const state = strategyFromItem(item), budget = state.attempt_budget || {};
  const queryRounds = budget.query_rounds || 0;
  const maxRounds = Math.max(1, Math.min(10, Number((state.current_strategy as Record<string, unknown> | undefined)?.max_rounds) || 3));
  if (queryRounds >= maxRounds) return false;
  const recentRuns = await getDb().select().from(collectionSourceRuns).where(eq(collectionSourceRuns.termId, term.id)).orderBy(desc(collectionSourceRuns.createdAt)).limit(30);
  const sourceIds = [...new Set(recentRuns.map((run) => run.sourceId))];
  const sourceRows = sourceIds.length ? await getDb().select().from(collectionSources).where(inArray(collectionSources.id, sourceIds)) : [];
  const sourceMap = new Map(sourceRows.map((row) => [row.id, row.name]));
  state.source_history = [...new Set([...(state.source_history || []), ...recentRuns.map((run) => sourceMap.get(run.sourceId) || run.sourceId)])].slice(-100);
  const priorFailures = Array.isArray(state.failure_history) ? state.failure_history : [];
  state.failure_history = [...priorFailures, ...recentRuns.filter((run) => run.status !== "CONCLUIDA").map((run) => ({ at: run.createdAt.toISOString(), source: sourceMap.get(run.sourceId) || run.sourceId, reason: run.detail || run.status, found: run.foundCount, materialized: run.materializedCount }))].slice(-100);
  const planningItem = { ...item, strategyState: JSON.stringify(state) };
  const { plan, state: plannedState } = await planItem(project, planningItem, term.failureReason === "BAD_REFERENCE" ? "RELINK_REQUIRED" : "SEARCH_EXHAUSTED");
  const execution = await executeSupervisorPlanningAction(project, item, plan);
  if (execution.handled) return true;
  const history = state.query_history || [];
  let query = term.term;
  const unused = (plan.queries || []).find((candidate) => !history.includes(candidate));
  if (["TRY_NEXT_QUERY", "RELINK_ITEM", "START_EXTERNAL_SEARCH"].includes(plan.action)) {
    query = unused || "";
    if (!query && plan.reference && !history.includes(plan.reference)) query = plan.reference;
  } else if (plan.action === "TRY_NEXT_SOURCE") query = term.term;
  else query = unused || "";
  // Nunca reexecuta silenciosamente uma query já registrada como tentada.
  if (!query || (plan.action !== "TRY_NEXT_SOURCE" && history.includes(query))) return false;
  plannedState.query_history = [...new Set([...(plannedState.query_history || []), query])].slice(-100);
  const nextQueryRounds = queryRounds + (plan.action === "TRY_NEXT_SOURCE" ? 0 : 1);
  plannedState.attempt_budget = { ...budget, query_rounds: nextQueryRounds, reference_changes: (budget.reference_changes || 0) + (plan.action === "RELINK_ITEM" ? 1 : 0) };
  const failures = Array.isArray(plannedState.failure_history) ? plannedState.failure_history : [];
  plannedState.failure_history = [...failures, { at: new Date().toISOString(), term: term.term, status: term.status, reason: term.failureReason || "SEARCH_EXHAUSTED", supervisor_action: plan.action }].slice(-100);
  await getDb().update(automaticProjectItems).set({ status: "SEARCHING_EXTERNALLY", failureReason: null, strategyState: JSON.stringify(plannedState), updatedAt: now() }).where(eq(automaticProjectItems.id, item.id));
  await getDb().update(collectionTerms).set({ term: query, status: "PENDENTE", sourceCursor: 0, rounds: 0, attempts: 0, sourcePlan: collectionPolicy(plan), failureReason: null, startedAt: null, updatedAt: now() }).where(eq(collectionTerms.id, term.id));
  await projectEvent(project.id, "supervisor_search_replanned", "SEARCHING_EXTERNALLY", { oldTerm: term.term, newQuery: query, planAction: plan.action, queryRound: nextQueryRounds }, item.id);
  return true;
}

async function syncProjectFromCollection(projectId: string) {
  const db = getDb();
  const [project] = await db.select().from(automaticProjects).where(eq(automaticProjects.id, projectId)).limit(1);
  if (!project?.collectionBatchId) return;
  const items = await db.select().from(automaticProjectItems).where(and(eq(automaticProjectItems.projectId, projectId), eq(automaticProjectItems.version, project.activeVersion)));
  const termIds = items.map((item) => item.collectionTermId).filter((value): value is string => Boolean(value));
  const terms = await fetchTermsChunked(termIds);
  const termMap = new Map(terms.map((row) => [row.id, row]));
  const runs: Array<typeof collectionSourceRuns.$inferSelect> = [];
  for (const ids of chunk(termIds, 40)) if (ids.length) runs.push(...await db.select().from(collectionSourceRuns).where(inArray(collectionSourceRuns.termId, ids)));
  const sourceIds = [...new Set(runs.map((row) => row.sourceId))];
  const sourceRows: Array<typeof collectionSources.$inferSelect> = [];
  for (const ids of chunk(sourceIds, 40)) if (ids.length) sourceRows.push(...await db.select().from(collectionSources).where(inArray(collectionSources.id, ids)));
  const sourceMap = new Map(sourceRows.map((row) => [row.id, row.name]));
  for (const item of items) {
    if (!item.collectionTermId || RESOLVED_STATUSES.has(item.status)) continue;
    const candidates = await db.select().from(collectionCandidates).where(and(eq(collectionCandidates.termId, item.collectionTermId), eq(collectionCandidates.status, "PARA_ANALISE"))).orderBy(desc(collectionCandidates.createdAt)).limit(1);
    const candidate = candidates[0], term = termMap.get(item.collectionTermId);
    if (candidate) {
      const state = strategyFromItem(item);
      const history = Array.isArray(state.candidate_history) ? state.candidate_history : [];
      const host = (() => { try { return new URL(candidate.url).hostname.toLowerCase(); } catch { return ""; } })();
      state.candidate_history = [...history, { candidate_id: candidate.id, url: candidate.url, source_id: candidate.sourceId, source: sourceMap.get(candidate.sourceId) || candidate.sourceId, host, at: new Date().toISOString() }].slice(-100);
      state.source_history = [...new Set([...(state.source_history || []), ...runs.filter((run) => run.termId === item.collectionTermId).map((run) => sourceMap.get(run.sourceId) || run.sourceId)])].slice(-100);
      state.host_history = [...new Set([...(state.host_history || []), ...(host ? [host] : [])])].slice(-100);
      const materialHistory = Array.isArray(state.materialization_history) ? state.materialization_history : [];
      state.materialization_history = [...materialHistory, { batch_id: candidate.materializationBatchId, item_id: candidate.materializationItemId, file_id: candidate.materializationFileId, at: new Date().toISOString() }].slice(-100);
      const budget = state.attempt_budget || {}; state.attempt_budget = { ...budget, candidate_tries: (budget.candidate_tries || 0) + 1 };
      const bridged = candidate.materializationItemId ? await bridgeMaterializationToSupervisor(candidate.materializationItemId, { projectId, itemId: item.id, collectionCandidateId: candidate.id }) : { linked: false, reason: "MATERIALIZATION_ITEM_ID_MISSING" };
      // A ponte decide qual candidata fica ativa em PARA_QA_VISUAL. Nunca sobrescrever uma candidata já ativa com outra que ficou apenas em PARA_ANALISE.
      await db.update(automaticProjectItems).set({ sourceType: "EXTERNAL", strategyState: JSON.stringify(state), failureReason: null, attempts: sql`${automaticProjectItems.attempts} + 1`, updatedAt: now() }).where(eq(automaticProjectItems.id, item.id));
      if (!bridged.linked) {
        // Compatibilidade defensiva: mantém o comportamento anterior caso a materialização exista mas ainda não possa ser reconciliada.
        await db.update(automaticProjectItems).set({ status: "QA_READY", collectionCandidateId: candidate.id, materializationBatchId: candidate.materializationBatchId, materializationItemId: candidate.materializationItemId, materializationFileId: candidate.materializationFileId, updatedAt: now() }).where(eq(automaticProjectItems.id, item.id));
      }
    } else if (term && ["INSUFICIENTE", "FALHA_TECNICA", "CANCELADO"].includes(term.status)) {
      const replanned = term.status !== "CANCELADO" ? await replanFailedItem(project, item, term) : false;
      if (!replanned) await db.update(automaticProjectItems).set({
        status: term.status === "FALHA_TECNICA" ? "FAILED_INFRASTRUCTURE" : term.status === "CANCELADO" ? "CANCELLED" : "RELINK_REQUIRED",
        failureReason: term.failureReason || (term.status === "INSUFICIENTE" ? "SEMANTIC_BUDGET_EXHAUSTED_SUPERVISOR_REQUIRED" : term.status), updatedAt: now(),
      }).where(eq(automaticProjectItems.id, item.id));
    } else {
      const status = term?.status === "MATERIALIZANDO" ? "MATERIALIZING" : term?.status === "BUSCANDO" ? "SEARCHING_EXTERNALLY" : "QUEUED";
      await db.update(automaticProjectItems).set({ status, updatedAt: now() }).where(eq(automaticProjectItems.id, item.id));
    }
  }
}


async function persistSupervisorHistory(item: typeof automaticProjectItems.$inferSelect, kind: "qa" | "failure" | "materialization", entry: Record<string, unknown>) {
  const db = getDb();
  const [latest] = await db.select().from(automaticProjectItems).where(eq(automaticProjectItems.id, item.id)).limit(1);
  const state = strategyFromItem(latest || item), key = kind === "qa" ? "qa_history" : kind === "failure" ? "failure_history" : "materialization_history";
  const current = Array.isArray(state[key]) ? state[key] as unknown[] : [];
  state[key] = [...current, { ...entry, at: new Date().toISOString() }].slice(-100);
  await db.update(automaticProjectItems).set({ strategyState: JSON.stringify(state), updatedAt: now() }).where(eq(automaticProjectItems.id, item.id));
  return state;
}

async function materializeSupervisorUrl(project: typeof automaticProjects.$inferSelect, item: typeof automaticProjectItems.$inferSelect, output: SupervisorOutput) {
  const url = clean(output.selected_url);
  if (!url) return false;
  const db = getDb();
  const [latestProjectItem] = await db.select().from(automaticProjectItems).where(eq(automaticProjectItems.id, item.id)).limit(1);
  const memory = strategyFromItem(latestProjectItem || item);
  const seenUrls = new Set<string>();
  for (const entry of Array.isArray(memory.candidate_history) ? memory.candidate_history : []) if (entry && typeof entry === "object" && clean((entry as Record<string, unknown>).url)) seenUrls.add(clean((entry as Record<string, unknown>).url));
  for (const entry of Array.isArray(memory.materialization_history) ? memory.materialization_history : []) if (entry && typeof entry === "object" && clean((entry as Record<string, unknown>).url)) seenUrls.add(clean((entry as Record<string, unknown>).url));
  if (seenUrls.has(url)) {
    await persistSupervisorHistory(latestProjectItem || item, "failure", { action: "MATERIALIZE_URL", reason: "DUPLICATE_CANDIDATE", url });
    await projectEvent(project.id, "supervisor_duplicate_url_blocked", "DUPLICATE_CANDIDATE", { url }, item.id);
    return false;
  }
  if (item.materializationBatchId && item.materializationItemId) {
    const [materialized] = await db.select().from(materializationItems).where(eq(materializationItems.id, item.materializationItemId)).limit(1);
    if (materialized) {
      await addCandidates({ batch_id: item.materializationBatchId, item_id: materialized.itemId, candidatas: [{ url, fonte: `SUPERVISOR_IA:${output.provider_mode || "AI"}` }] });
      const [updated] = await db.select().from(materializationItems).where(eq(materializationItems.id, materialized.id)).limit(1);
      await db.update(automaticProjectItems).set({ status: updated?.status === "READY_FOR_VISUAL_QA" ? "QA_READY" : "MATERIALIZING", materializationFileId: updated?.selectedFileId || item.materializationFileId, failureReason: null, updatedAt: now() }).where(eq(automaticProjectItems.id, item.id));
      await persistSupervisorHistory(item, "materialization", { action: "MATERIALIZE_URL", url, batch_id: item.materializationBatchId, materialization_item_id: materialized.id, file_id: updated?.selectedFileId || null });
      return true;
    }
  }
  const batchId = `SUP-${project.id}-${item.version}-${item.id}`.slice(0, 190);
  await materializeBatch({
    batch_id: batchId, projeto: project.name,
    itens: [{ item_id: item.id, arquivo_alvo: item.targetFile || item.itemKey, conceito: item.term, referencia_visual: output.reference || item.semanticReference || item.term, universo: item.universe, tipo: item.kind, referencia_roteiro: item.context, usado_para: item.notes, transparencia_necessaria: item.compositionClass === "ISOLATED" && /\.png$/i.test(item.targetFile || ""), composition_class: item.compositionClass === "ISOLATED" ? "ISOLATED" : "CONTEXTUAL", candidatas: [{ prioridade: 1, url, fonte: `SUPERVISOR_IA:${output.provider_mode || "AI"}` }] }],
  });
  const [created] = await db.select().from(materializationItems).where(and(eq(materializationItems.batchId, batchId), eq(materializationItems.itemId, item.id))).limit(1);
  if (!created) return false;
  await db.update(automaticProjectItems).set({ status: created.status === "READY_FOR_VISUAL_QA" ? "QA_READY" : "MATERIALIZING", sourceType: "EXTERNAL", materializationBatchId: batchId, materializationItemId: created.id, materializationFileId: created.selectedFileId, failureReason: created.failureReason, updatedAt: now() }).where(eq(automaticProjectItems.id, item.id));
  await persistSupervisorHistory(item, "materialization", { action: "MATERIALIZE_URL", url, batch_id: batchId, materialization_item_id: created.id, file_id: created.selectedFileId });
  return true;
}

async function executeSupervisorQaAction(project: typeof automaticProjects.$inferSelect, item: typeof automaticProjectItems.$inferSelect, output: SupervisorOutput) {
  const db = getDb();
  await persistSupervisorHistory(item, "qa", { action: output.action, reason: output.reason, notes: output.notes || null, labels: output.qa_labels || null, provider: output.provider_mode || null, model: output.provider_model || null });
  if (output.action === "APPROVE_AND_FREEZE") {
    await applyProjectQaDecisions(project.id, [{ item_id: item.id, status: "APROVADO", observacao: output.notes || output.reason }]); return true;
  }
  if (output.action === "REJECT_AND_NEXT_CANDIDATE" || output.action === "TRY_NEXT_CANDIDATE" || output.action === "TRY_NEXT_SOURCE") {
    await applyProjectQaDecisions(project.id, [{ item_id: item.id, status: "REJEITADO", observacao: output.notes || output.reason }]); return true;
  }
  if (output.action === "TRY_NEXT_QUERY" || output.action === "START_EXTERNAL_SEARCH") {
    await applyProjectQaDecisions(project.id, [{ item_id: item.id, status: "REJEITADO", observacao: output.notes || output.reason }]);
    if (item.collectionTermId) await db.update(collectionTerms).set({ status: "INSUFICIENTE", failureReason: "BAD_QUERY", updatedAt: now() }).where(eq(collectionTerms.id, item.collectionTermId));
    return true;
  }
  if (output.action === "USE_LIBRARY_ASSET" && output.selected_asset_id) {
    const selected = await executeSupervisorPlanningAction(project, item, output);
    if (selected.handled) return true;
    await persistSupervisorHistory(item, "failure", { action: "USE_LIBRARY_ASSET", reason: "LIBRARY_ASSET_REJECTED_BY_MATURITY_OR_STATUS", asset_id: output.selected_asset_id });
    await applyProjectQaDecisions(project.id, [{ item_id: item.id, status: "REJEITADO", observacao: "Biblioteca não atingiu maturidade >= 5 ou asset selecionado não estava aprovado; seguir coleta externa." }]);
    return true;
  }
  if (output.action === "RELINK_ITEM") {
    await applyProjectQaDecisions(project.id, [{ item_id: item.id, status: "RELINK_REQUIRED", observacao: output.notes || output.reason }]); return true;
  }
  if (output.action === "CANCEL_ITEM") {
    await db.update(automaticProjectItems).set({ status: "CANCELLED", failureReason: output.reason, updatedAt: now() }).where(eq(automaticProjectItems.id, item.id));
    await persistSupervisorHistory(item, "failure", { reason: output.reason, action: output.action }); return true;
  }
  if (output.action === "MATERIALIZE_URL") return materializeSupervisorUrl(project, item, output);
  if (output.action === "PROBE_URL" && output.selected_url) {
    const probe = await probeMaterializationUrl({ url: output.selected_url });
    await projectEvent(project.id, "supervisor_probe", probe.success ? "SUCCESS" : "FAILED", probe, item.id);
    if (probe.success) return materializeSupervisorUrl(project, item, { ...output, action: "MATERIALIZE_URL" });
    await persistSupervisorHistory(item, "failure", { reason: probe.detail || "PROBE_FAILED", url: output.selected_url, action: "PROBE_URL" });
    await applyProjectQaDecisions(project.id, [{ item_id: item.id, status: "REJEITADO", observacao: probe.detail || "PROBE_FAILED" }]);
    return true;
  }
  if (output.action === "WAIT_FOR_VISUAL_QA") return false;
  if (output.action === "APPLY_TECHNICAL_FIX") {
    const [latestItem] = await db.select().from(automaticProjectItems).where(eq(automaticProjectItems.id, item.id)).limit(1);
    const technicalState = strategyFromItem(latestItem || item), technicalBudget = technicalState.attempt_budget || {};
    if ((technicalBudget.technical_tries || 0) >= 2) {
      await persistSupervisorHistory(item, "failure", { action: "APPLY_TECHNICAL_FIX", reason: "TECHNICAL_ATTEMPT_BUDGET_EXHAUSTED", attempts: technicalBudget.technical_tries || 0 });
      await applyProjectQaDecisions(project.id, [{ item_id: item.id, status: "RELINK_REQUIRED", observacao: "Duas correções técnicas sem resolução; relink obrigatório." }]);
      return true;
    }
    if (item.compositionClass !== "ISOLATED" || !item.materializationBatchId || !item.materializationItemId) {
      await applyProjectQaDecisions(project.id, [{ item_id: item.id, status: "RELINK_REQUIRED", observacao: "Correção técnica solicitada para item sem materialização isolada válida." }]); return true;
    }
    const [materialized] = await db.select().from(materializationItems).where(eq(materializationItems.id, item.materializationItemId)).limit(1);
    if (!materialized) return false;
    await registerQaBatch({ batch_id: item.materializationBatchId, decisoes: [{ item_id: materialized.itemId, status: "CORRECAO_TECNICA_PERMITIDA", observacao: output.notes || output.reason }] });
    const correction = await applyTechnicalCorrection({ batch_id: item.materializationBatchId, item_id: materialized.itemId, technical_fixes: output.technical_fixes || [], technical_parameters: output.technical_parameters || {} });
    const [updated] = await db.select().from(materializationItems).where(eq(materializationItems.id, materialized.id)).limit(1);
    technicalState.attempt_budget = { ...technicalBudget, technical_tries: (technicalBudget.technical_tries || 0) + 1 };
    await db.update(automaticProjectItems).set({ status: updated?.status === "READY_FOR_VISUAL_QA" ? "QA_READY" : "MATERIALIZING", materializationFileId: updated?.selectedFileId || item.materializationFileId, strategyState: JSON.stringify(technicalState), failureReason: updated?.failureReason || null, updatedAt: now() }).where(eq(automaticProjectItems.id, item.id));
    await persistSupervisorHistory(item, "materialization", { action: "APPLY_TECHNICAL_FIX", fixes: output.technical_fixes || [], parameters: output.technical_parameters || {}, technical_try: (technicalBudget.technical_tries || 0) + 1, result: correction });
    return true;
  }
  return false;
}

async function applyProjectQaDecisions(projectId: string, decisions: Array<Record<string, unknown>>) {
  const db = getDb(), results: Array<Record<string, unknown>> = [];
  const requested = decisions.slice(0,20).map((decision) => ({ raw:decision, itemId:clean(decision.item_id), status:clean(decision.status).toUpperCase(), observation:clean(decision.observacao) || null }));
  const keys = [...new Set(requested.map((entry)=>entry.itemId).filter(Boolean))];
  if (!keys.length) return results;
  // V56: batch prefetch. Uma chamada de QA de 20 itens não faz SELECT item + SELECT materialização 20 vezes.
  const projectItems = await db.select().from(automaticProjectItems).where(and(eq(automaticProjectItems.projectId,projectId),or(inArray(automaticProjectItems.id,keys),inArray(automaticProjectItems.itemKey,keys))));
  const itemMap = new Map<string,typeof automaticProjectItems.$inferSelect>();
  for (const item of projectItems) { itemMap.set(item.id,item); itemMap.set(item.itemKey,item); }
  const materializationIds = [...new Set(projectItems.map((item)=>item.materializationItemId).filter((value):value is string=>Boolean(value)))];
  const materializedBefore = materializationIds.length ? await db.select().from(materializationItems).where(inArray(materializationItems.id,materializationIds)) : [];
  const materializedMapBefore = new Map(materializedBefore.map((row)=>[row.id,row]));
  const grouped = new Map<string,Array<{ item_id:string; status:string; observacao:string|null }>>();
  const valid: Array<{ item:typeof automaticProjectItems.$inferSelect; status:string; observation:string|null }> = [];
  for (const entry of requested) {
    const item = itemMap.get(entry.itemId);
    const materialized = item?.materializationItemId ? materializedMapBefore.get(item.materializationItemId) : null;
    if (!item || !item.materializationBatchId || !materialized) { results.push({item_id:entry.itemId,erro:!item?"ITEM_NOT_READY_FOR_QA":"MATERIALIZATION_ITEM_NOT_FOUND"}); continue; }
    const decisionStatus = entry.status === "APROVADO" ? "APROVADO" : entry.status === "RELINK_REQUIRED" ? "RELINK_REQUIRED" : entry.status === "CORRECAO_TECNICA_PERMITIDA" ? "CORRECAO_TECNICA_PERMITIDA" : "REJEITADO";
    const bucket = grouped.get(item.materializationBatchId) || [];
    bucket.push({item_id:materialized.itemId,status:decisionStatus,observacao:entry.observation});
    grouped.set(item.materializationBatchId,bucket);
    valid.push({item,status:entry.status,observation:entry.observation});
  }
  for (const [batchId,batchDecisions] of grouped) await registerQaBatch({batch_id:batchId,decisoes:batchDecisions});
  const materializedAfter = materializationIds.length ? await db.select().from(materializationItems).where(inArray(materializationItems.id,materializationIds)) : [];
  const materializedMap = new Map(materializedAfter.map((row)=>[row.id,row]));

  for (const {item,status,observation} of valid) {
    const updatedMaterialized = item.materializationItemId ? materializedMap.get(item.materializationItemId) : null;
    const qa = { batch_id:item.materializationBatchId, item_id:updatedMaterialized?.itemId || item.materializationItemId, status };
    const bridgeDecision = await resolveBridgedCandidate(projectId,item.id,status,observation);
    const state = strategyFromItem(item), qaHistory = Array.isArray(state.qa_history) ? state.qa_history : [];
    state.qa_history = [...qaHistory,{status,observation,materialization_item_id:item.materializationItemId,at:new Date().toISOString()}].slice(-100);
    if (status === "CORRECAO_TECNICA_PERMITIDA") {
      await db.update(automaticProjectItems).set({status:"TECHNICAL_CORRECTION_REQUIRED",strategyState:JSON.stringify(state),failureReason:observation,updatedAt:now()}).where(eq(automaticProjectItems.id,item.id));
      results.push({item_id:item.itemKey,status:"TECHNICAL_CORRECTION_REQUIRED"});
      await projectEvent(projectId,"project_qa_decision",status,{observation,qa},item.id);
      continue;
    }
    if (status === "APROVADO" && updatedMaterialized?.frozenAssetId) {
      await db.update(automaticProjectItems).set({status:"APPROVED",linkedAssetId:updatedMaterialized.frozenAssetId,strategyState:JSON.stringify(state),failureReason:null,updatedAt:now()}).where(eq(automaticProjectItems.id,item.id));
      const fanout = await fanOutFamily(projectId,item.version,item.familyId,item.id,updatedMaterialized.frozenAssetId);
      results.push({item_id:item.itemKey,status:"APPROVED",asset_id:updatedMaterialized.frozenAssetId,fanout});
    } else {
      const failures = Array.isArray(state.failure_history) ? state.failure_history : [];
      state.failure_history = [...failures,{status,reason:observation||status,candidate_id:bridgeDecision.current?.id||item.collectionCandidateId,at:new Date().toISOString()}].slice(-100);
      if (item.collectionCandidateId) await db.update(collectionCandidates).set({status:"DESCARTADO",failureReason:observation||status,updatedAt:now()}).where(eq(collectionCandidates.id,item.collectionCandidateId));
      let remainingCandidate = null as typeof collectionCandidates.$inferSelect | null;
      if (item.collectionTermId) {
        [remainingCandidate] = await db.select().from(collectionCandidates).where(and(eq(collectionCandidates.termId,item.collectionTermId),eq(collectionCandidates.status,"PARA_ANALISE"))).orderBy(desc(collectionCandidates.createdAt)).limit(1);
      }
      // V59: rejeições sem alternativa pronta não ficam pingando indefinidamente na mesma rota.
      // Duas rejeições semânticas sem próxima candidata promovível elevam o item para RELINK,
      // enquanto os demais workers/projeto seguem independentes.
      const semanticRejectCount = (Array.isArray(state.failure_history) ? state.failure_history : []).filter((failure:any)=>failure?.status === "REJEITADO").length;
      const autoRelink = status === "REJEITADO" && !bridgeDecision.promoted && !remainingCandidate && semanticRejectCount >= 2;
      const relinkNow = status === "RELINK_REQUIRED" || autoRelink;
      if (item.collectionTermId) {
        await db.update(collectionTerms).set({status:relinkNow ? "INSUFICIENTE" : (bridgeDecision.promoted||remainingCandidate) ? "PARA_ANALISE" : "PENDENTE",collectedCount:sql`max(0, ${collectionTerms.collectedCount} - 1)`,failureReason:observation||(relinkNow?"BAD_REFERENCE":"QA_REJECTED_NEW_CANDIDATE_REQUIRED"),updatedAt:now()}).where(eq(collectionTerms.id,item.collectionTermId));
      }
      if (!relinkNow && bridgeDecision.promoted) {
        await db.update(automaticProjectItems).set({status:"QA_READY",strategyState:JSON.stringify(state),failureReason:null,updatedAt:now()}).where(eq(automaticProjectItems.id,item.id));
        results.push({item_id:item.itemKey,status:"QA_READY",candidata_descartada:true,proxima_candidata:bridgeDecision.promoted.id,next_state:"NEXT_CANDIDATE"});
      } else {
        await db.update(automaticProjectItems).set({status:relinkNow?"RELINK_REQUIRED":"SEARCHING_EXTERNALLY",collectionCandidateId:null,materializationBatchId:null,materializationItemId:null,materializationFileId:null,failureReason:observation||(relinkNow?"BAD_REFERENCE":"QA_REJECTED_NEW_CANDIDATE_REQUIRED"),strategyState:JSON.stringify(state),updatedAt:now()}).where(eq(automaticProjectItems.id,item.id));
        results.push({item_id:item.itemKey,status:relinkNow?"RELINK_REQUIRED":"SEARCHING_EXTERNALLY",candidata_descartada:true,next_state:relinkNow?"RELINK_QUEUE":"NEXT_CANDIDATE",auto_relink:autoRelink});
      }
    }
    if (bridgeDecision.current?.source) await recordRouteMetric({universe:item.universe,compositionClass:item.compositionClass,sourceName:bridgeDecision.current.source,host:bridgeDecision.current.host,outcome:status === "APROVADO"?"approved":"rejected"}).catch(()=>undefined);
    await recordQaMetrics(projectId,item.id,status);
    await projectEvent(projectId,"project_qa_decision",status,{observation,qa,source:"SUPERVISOR_MCP"},item.id);
  }
  return results;
}

async function runAutomaticVisualQa(projectId: string) {
  // V45: QA semântico/visual nunca é fingido pelo app. Apenas publica decisões pendentes para o ChatGPT via MCP.
  await syncDecisionQueue(projectId);
  return 0;
}

export async function reconcileAutomaticProject(projectId: string, updateProjectStatus = true) {
  const db = getDb();
  const [project] = await db.select().from(automaticProjects).where(eq(automaticProjects.id, projectId)).limit(1);
  if (!project) throw new Error("PROJECT_NOT_FOUND");
  // V47: primeiro reconcilia toda materialização real pronta para QA, inclusive lotes laterais/manuais.
  await reconcileSupervisorMaterializations(projectId);
  const items = await db.select().from(automaticProjectItems).where(and(eq(automaticProjectItems.projectId, projectId), eq(automaticProjectItems.version, project.activeVersion))).orderBy(asc(automaticProjectItems.priority));
  const materializationIds = [...new Set(items.map((item) => item.materializationItemId).filter((value): value is string => Boolean(value)))];
  const materializedRows: Array<typeof materializationItems.$inferSelect> = [];
  for (const ids of chunk(materializationIds, 40)) if (ids.length) materializedRows.push(...await db.select().from(materializationItems).where(inArray(materializationItems.id, ids)));
  // Recupera também lotes manuais/alternativos identificáveis pelo projeto e pelo target file.
  const projectBatches = await db.select({ id: materializationBatches.id }).from(materializationBatches).where(eq(materializationBatches.project, project.name)).orderBy(desc(materializationBatches.updatedAt)).limit(200);
  for (const ids of chunk(projectBatches.map((row) => row.id), 40)) if (ids.length) {
    const rows = await db.select().from(materializationItems).where(inArray(materializationItems.batchId, ids));
    for (const row of rows) if (row.frozenAssetId && !materializedRows.some((current) => current.id === row.id)) materializedRows.push(row);
  }
  const matMap = new Map(materializedRows.map((row) => [row.id, row]));
  const frozenByTarget = new Map<string, typeof materializationItems.$inferSelect>();
  for (const row of [...materializedRows].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())) {
    const key = targetFileName(row.targetName).toLocaleLowerCase("pt-BR");
    if (row.frozenAssetId && !frozenByTarget.has(key)) frozenByTarget.set(key, row);
  }
  let reconciled = 0;
  for (const item of items) {
    const direct = item.materializationItemId ? matMap.get(item.materializationItemId) : null;
    const mat = direct?.frozenAssetId ? direct : frozenByTarget.get(targetFileName(item.targetFile || item.itemKey).toLocaleLowerCase("pt-BR")) || direct;
    const assetId = mat?.frozenAssetId || item.linkedAssetId;
    if (assetId && (!RESOLVED_STATUSES.has(item.status) || item.linkedAssetId !== assetId)) {
      await db.update(automaticProjectItems).set({
        status: item.sourceType === "LIBRARY" ? "LINKED_FROM_LIBRARY" : item.sourceType === "FAMILY" ? "LINKED_FROM_FAMILY" : "APPROVED",
        sourceType: item.sourceType || (mat ? "MATERIALIZATION_RECONCILED" : null), linkedAssetId: assetId,
        materializationBatchId: item.materializationBatchId || mat?.batchId || null, materializationItemId: item.materializationItemId || mat?.id || null,
        materializationFileId: item.materializationFileId || mat?.selectedFileId || null, failureReason: null, updatedAt: now(),
      }).where(eq(automaticProjectItems.id, item.id));
      reconciled += 1;
    }
  }
  await fanOutResolvedSeeds(projectId, project.activeVersion);
  const detail = await getAutomaticProject(projectId, false);
  const status = deriveProjectStatus(detail.itens, detail.projeto.status);
  if (updateProjectStatus && ![...AUTOMATION_STOPPED_STATUSES, "FAILED"].includes(project.status)) await db.update(automaticProjects).set({ status, updatedAt: now() }).where(eq(automaticProjects.id, projectId));
  const summary = await refreshProjectSummary(projectId, { bumpVersion: updateProjectStatus, lastAction: "PROJECT_RECONCILED" }).catch(() => null);
  await projectEvent(projectId, "project_reconciled", status, { reconciled, total: detail.itens.length, resolved: detail.metricas.resolvidos, project_version: summary?.project_version });
  return { projeto_id: projectId, reconciliados: reconciled, status, metricas: detail.metricas, project_version: summary?.project_version, counts: summary?.counts };
}

function deriveProjectStatus(items: Array<typeof automaticProjectItems.$inferSelect>, fallback: string) {
  const active = items.filter((item) => ["SEARCHING_LIBRARY", "SEARCHING_EXTERNALLY", "DISCOVERED", "QUEUED", "MATERIALIZING"].includes(item.status)).length;
  const qa = items.filter((item) => ["QA_READY", "TECHNICAL_CORRECTION_REQUIRED"].includes(item.status)).length;
  const gaps = items.filter((item) => ["RELINK_REQUIRED", "FAILED", "FAILED_SEMANTIC", "FAILED_INFRASTRUCTURE", "REJECTED", "CANCELLED"].includes(item.status)).length;
  const resolved = items.filter((item) => RESOLVED_STATUSES.has(item.status)).length;
  if (active) return "PROCESSING";
  if (qa) return "QA_IN_PROGRESS";
  if (gaps) return "PARTIAL_READY";
  if (items.length && resolved === items.length) return "READY_TO_COMPLETE";
  return fallback;
}

export async function processAutomaticProject(input: Record<string, unknown>) {
  const projectId = clean(input.projeto_id), maxSteps = Math.max(1, Math.min(20, Number(input.max_etapas) || 5)), maxQaBacklog = Math.max(1, Math.min(500, Number(input.max_qa_backlog) || 500));
  let detail = await getAutomaticProject(projectId);
  await assertProjectAutomationAllowed(detail.projeto);
  if (detail.projeto.status === "WAITING_FILES" || detail.projeto.status === "READY") detail = await startAutomaticProject(projectId);
  let steps = 0, lastSignature = "", visualHandled = 0;
  for (; steps < maxSteps; steps += 1) {
    const [project] = await getDb().select().from(automaticProjects).where(eq(automaticProjects.id, projectId)).limit(1);
    if (!project) throw new Error("PROJECT_NOT_FOUND");
    if ([...AUTOMATION_STOPPED_STATUSES, "FAILED"].includes(project.status)) break;
    await ensureUnqueuedExternalSearch(projectId);
    const before = await getAutomaticProject(projectId);
    const beforeSignature = JSON.stringify({ counts: before.contagem_status, resolved: before.metricas.resolvidos, status: before.projeto.status });
    // V60 backpressure: um backlog de QA grande não deve receber materialização ilimitada.
    // O pipeline continua nas outras filas, mas desacelera discovery/coleta até o QA baixar.
    if (project.collectionBatchId && !["READY_TO_COMPLETE"].includes(project.status) && Number(project.waitingQaCount || 0) < maxQaBacklog) {
      await executeCollection({ lote_id: project.collectionBatchId, max_rodadas: 1 });
      await syncProjectFromCollection(projectId);
    }
    visualHandled += await runAutomaticVisualQa(projectId);
    await reconcileAutomaticProject(projectId);
    detail = await getAutomaticProject(projectId);
    const status = deriveProjectStatus(detail.itens, detail.projeto.status);
    await getDb().update(automaticProjects).set({ status, updatedAt: now() }).where(eq(automaticProjects.id, projectId));
    if (status === "READY_TO_COMPLETE") {
      if (project.automaticZip) {
        await regenerateProjectZip(projectId);
        await getProjectConsistencyGate(projectId, true);
      }
      await getDb().update(automaticProjects).set({ status: "MOTOR_LIBRARY_RODADO", updatedAt: now() }).where(eq(automaticProjects.id, projectId));
      await projectEvent(projectId, "library_engine_finished", "MOTOR_LIBRARY_RODADO", { resolved: detail.metricas.resolvidos, total: detail.metricas.total });
      break;
    }
    const afterSignature = JSON.stringify({ counts: detail.contagem_status, resolved: detail.metricas.resolvidos, status });
    // V56: SKIP WAITING. QA/relink/correção bloqueiam somente o item, nunca o projeto.
    const productive = detail.itens.some((item) => ["SEARCHING_LIBRARY", "SEARCHING_EXTERNALLY", "DISCOVERED", "QUEUED", "COLLECTING", "MATERIALIZING", "READY_FOR_MATERIALIZATION", "MATERIALIZATION_PENDING"].includes(item.status));
    const waitingOnly = detail.itens.some((item) => ["QA_READY", "READY_FOR_VISUAL_QA", "TECHNICAL_CORRECTION_REQUIRED", "RELINK_REQUIRED", "WAITING_FAMILY_SEED", "WAITING_DEPENDENCY"].includes(item.status));
    if (!productive && waitingOnly) break;
    if (!productive && !waitingOnly) break;
    if (afterSignature === beforeSignature && afterSignature === lastSignature) break;
    lastSignature = afterSignature;
  }
  detail = await getAutomaticProject(projectId);
  const status = detail.projeto.status === "MOTOR_LIBRARY_RODADO" ? "MOTOR_LIBRARY_RODADO" : deriveProjectStatus(detail.itens, detail.projeto.status);
  if (detail.projeto.status !== "MOTOR_LIBRARY_RODADO") await getDb().update(automaticProjects).set({ status, updatedAt: now() }).where(eq(automaticProjects.id, projectId));
  await refreshProjectSummary(projectId, { lastAction: "AUTOMATIC_CYCLE_FINISHED" }).catch(() => undefined);
  const supervisor = await getSupervisorMode();
  await syncDecisionQueue(projectId);
  await projectEvent(projectId, "automatic_cycle_finished", status, { resolved: detail.metricas.resolvidos, total: detail.metricas.total, steps: steps + 1, supervisorVisualQa: false, visualActionsHandled: visualHandled, supervisor, internalAiCalled: false });
  return getAutomaticProject(projectId);
}

export async function qaAutomaticProject(input: Record<string, unknown>) {
  const projectId = clean(input.projeto_id), decisions = Array.isArray(input.decisoes) ? (input.decisoes as Array<Record<string, unknown>>).slice(0, 20) : [];
  if (!decisions.length) throw new Error("DECISOES_REQUIRED");
  const [project] = await getDb().select().from(automaticProjects).where(eq(automaticProjects.id, projectId)).limit(1);
  if (!project) throw new Error("PROJECT_NOT_FOUND");
  await assertProjectAutomationAllowed(project);
  const results = await applyProjectQaDecisions(projectId, decisions);
  const summary = await refreshProjectSummary(projectId, { lastAction: "QA_BATCH_APPLIED", lastFrozenAt: decisions.some((decision) => clean(decision.status).toUpperCase() === "APROVADO") ? now() : undefined }).catch(() => null);
  // V56: mutação pode retornar o novo estado sem disparar um ciclo pesado escondido.
  if (input.processar_apos === false) return { resultados: results, project_version: summary?.project_version, project_counts: summary?.counts };
  const detail = await processAutomaticProject({ projeto_id: projectId, max_etapas: 1 });
  return { resultados: results, projeto: detail, project_version: summary?.project_version, project_counts: summary?.counts };
}

async function loadAssetsChunked(assetIds: string[]) {
  const rows: Array<typeof assets.$inferSelect> = [];
  for (const ids of chunk([...new Set(assetIds)], 40)) if (ids.length) rows.push(...await getDb().select().from(assets).where(inArray(assets.id, ids)));
  return rows;
}

export async function regenerateProjectZip(projectId: string, requestedTargetFiles?: string[]) {
  const db = getDb();
  await reconcileAutomaticProject(projectId, false);
  const [project] = await db.select().from(automaticProjects).where(eq(automaticProjects.id, projectId)).limit(1);
  if (!project) throw new Error("PROJECT_NOT_FOUND");
  const allItems = await db.select().from(automaticProjectItems).where(and(eq(automaticProjectItems.projectId, projectId), eq(automaticProjectItems.version, project.activeVersion))).orderBy(asc(automaticProjectItems.priority));
  const requested = requestedTargetFiles?.length ? new Set(requestedTargetFiles.map((value) => targetFileName(value).toLocaleLowerCase("pt-BR"))) : null;
  const items = requested ? allItems.filter((item) => requested.has(targetFileName(item.targetFile || item.itemKey).toLocaleLowerCase("pt-BR"))) : allItems;
  const extras = requested ? [...requested].filter((name) => !allItems.some((item) => targetFileName(item.targetFile || item.itemKey).toLocaleLowerCase("pt-BR") === name)) : [];
  if (extras.length) throw new Error(`PROJECT_ZIP_UNKNOWN_TARGET_FILES:${extras.join(",")}`);
  const resolved = items.filter((item) => item.linkedAssetId && RESOLVED_STATUSES.has(item.status));
  const assetIds = resolved.map((item) => item.linkedAssetId).filter((value): value is string => Boolean(value));
  const assetRows = await loadAssetsChunked(assetIds), assetMap = new Map(assetRows.map((asset) => [asset.id, asset]));
  const files: Record<string, Uint8Array> = {}, bytesCache = new Map<string, Uint8Array>();
  const manifest = ["PROJETO: " + project.name, "PROJECT_ID: " + project.id, "VERSAO: " + project.activeVersion, "GERADO_UTC: " + new Date().toISOString(), "", "STATUS_QA: APROVADO", ""];
  let total = 0;
  const usedNames = new Set<string>();
  const missing: string[] = [];
  for (const item of items) {
    const asset = item.linkedAssetId ? assetMap.get(item.linkedAssetId) : null;
    const target = targetFileName(item.targetFile || item.itemKey, asset?.originalName.split(".").pop() || "jpg");
    if (!asset || !RESOLVED_STATUSES.has(item.status)) { missing.push(target); continue; }
    const lower = target.toLocaleLowerCase("pt-BR");
    if (usedNames.has(lower)) throw new Error(`DUPLICATE_TARGET_FILE:${target}`);
    usedNames.add(lower);
    let bytes = bytesCache.get(asset.id);
    if (!bytes) {
      const object = await env.BUCKET.get(asset.r2Key);
      if (!object) { missing.push(target); continue; }
      bytes = new Uint8Array(await object.arrayBuffer());
      bytesCache.set(asset.id, bytes);
    }
    total += bytes.byteLength;
    if (total > 100 * 1024 * 1024) throw new Error("PROJECT_ZIP_LIMIT_100_MB");
    files[target] = bytes;
    manifest.push(`[${target}]`, `ITEM_ID: ${item.itemKey}`, `TERMO: ${item.term}`, `ASSET_ID: ${asset.id}`, `ORIGEM: ${item.sourceType || "LIBRARY"}`, `UNIVERSO: ${asset.universe}`, `TIPO: ${asset.kind}`, `COMPOSITION_CLASS: ${item.compositionClass}`, `FAMILY_ID: ${item.familyId || ""}`, `STATUS: ${item.status}`, "");
  }
  const expected = items.map((item) => targetFileName(item.targetFile || item.itemKey));
  const actual = Object.keys(files);
  manifest.unshift(`TARGET_FILES_ESPERADOS: ${expected.length}`, `TARGET_FILES_RESOLVIDOS: ${actual.length}`, `TARGET_FILES_FALTANTES: ${missing.length}`, "");
  files["IMPORTACAO.txt"] = strToU8(manifest.join("\n"));
  files["PROJETO.txt"] = strToU8(manifest.join("\n"));
  const zip = zipSync(files, { level: 0 });
  const partial = Boolean(requested);
  const base = project.name.replace(/[^a-zA-Z0-9À-ÿ._-]/g, "-");
  const fileName = `${base}-v${project.activeVersion}${partial ? "-parcial" : ""}.zip`, r2Key = `projects/${projectId}/working/${partial ? makeId("PARTIAL") + "-" : ""}${fileName}`;
  if (!partial && project.zipR2Key && project.zipR2Key !== r2Key) await env.BUCKET.delete(project.zipR2Key).catch(() => undefined);
  await env.BUCKET.put(r2Key, zip, { httpMetadata: { contentType: "application/zip" }, customMetadata: { projectId, temporary: "true", version: String(project.activeVersion), fileName, targetFiles: String(actual.length), missing: String(missing.length), importacaoTxt: "true" } });
  if (!partial) await db.update(automaticProjects).set({ zipR2Key: r2Key, zipFileName: fileName, zipSizeBytes: zip.byteLength, updatedAt: now() }).where(eq(automaticProjects.id, projectId));
  await projectEvent(projectId, partial ? "partial_zip_generated" : "temporary_zip_regenerated", project.status, { expected: expected.length, resolved: actual.length, missing, bytes: zip.byteLength });
  return { projeto_id: projectId, arquivo: fileName, r2_key: r2Key, tamanho_bytes: zip.byteLength, target_files_esperados: expected.length, target_files_resolvidos: actual.length, faltantes: missing, temporario: true, parcial: partial };
}

export async function getProjectConsistencyGate(projectId: string, checkZip = true) {
  await reconcileAutomaticProject(projectId, false);
  const db = getDb();
  const [project] = await db.select().from(automaticProjects).where(eq(automaticProjects.id, projectId)).limit(1);
  if (!project) throw new Error("PROJECT_NOT_FOUND");
  const items = await db.select().from(automaticProjectItems).where(and(eq(automaticProjectItems.projectId, projectId), eq(automaticProjectItems.version, project.activeVersion))).orderBy(asc(automaticProjectItems.priority));
  const expectedTargets = items.map((item) => targetFileName(item.targetFile || item.itemKey));
  const duplicateTargets = expectedTargets.filter((target, index) => expectedTargets.findIndex((candidate) => candidate.toLocaleLowerCase("pt-BR") === target.toLocaleLowerCase("pt-BR")) !== index);
  const pending = items.filter((item) => !RESOLVED_STATUSES.has(item.status));
  const assetIds = items.map((item) => item.linkedAssetId).filter((value): value is string => Boolean(value));
  const assetRows = await loadAssetsChunked(assetIds), assetMap = new Map(assetRows.map((row) => [row.id, row]));
  const missingAssets: string[] = [], missingObjects: string[] = [];
  const validTargets = new Set<string>();
  for (const item of items) {
    if (!RESOLVED_STATUSES.has(item.status) || !item.linkedAssetId) continue;
    const asset = assetMap.get(item.linkedAssetId);
    if (!asset) { missingAssets.push(item.itemKey); continue; }
    const object = await env.BUCKET.head(asset.r2Key);
    if (!object) { missingObjects.push(item.itemKey); continue; }
    validTargets.add(targetFileName(item.targetFile || item.itemKey).toLocaleLowerCase("pt-BR"));
  }
  let zipValidated = !project.automaticZip || !checkZip, zipReason: string | null = checkZip && project.automaticZip ? "ZIP_NOT_CHECKED" : null;
  if (checkZip && project.automaticZip) {
    if (!project.zipR2Key) zipReason = "ZIP_MISSING";
    else {
      const zipHead = await env.BUCKET.head(project.zipR2Key);
      if (!zipHead) zipReason = "ZIP_R2_MISSING";
      else {
        const metadata = zipHead.customMetadata || {};
        const targetCount = Number(metadata.targetFiles || -1), missingCount = Number(metadata.missing || -1);
        const importacao = metadata.importacaoTxt === "true";
        zipValidated = targetCount === expectedTargets.length && missingCount === 0 && importacao;
        zipReason = zipValidated ? null : `ZIP_METADATA_MISMATCH:targets=${targetCount}:missing=${missingCount}:importacao=${importacao}`;
      }
    }
  }
  const critical = [
    ...pending.map((item) => `PENDING:${item.itemKey}:${item.status}`),
    ...missingAssets.map((item) => `ASSET_MISSING:${item}`),
    ...missingObjects.map((item) => `R2_MISSING:${item}`),
    ...duplicateTargets.map((item) => `DUPLICATE_TARGET:${item}`),
    ...(checkZip && project.automaticZip && !zipValidated ? [`ZIP_INVALID:${zipReason}`] : []),
  ];
  const gate = {
    projeto_id: projectId,
    versao: project.activeVersion,
    expected_target_files: expectedTargets.length,
    resolved_target_files: validTargets.size,
    pending_items: pending.map((item) => ({ item_id: item.itemKey, status: item.status, failure_reason: item.failureReason })),
    missing_assets: missingAssets,
    missing_r2_objects: missingObjects,
    duplicate_target_files: duplicateTargets,
    zip_validated: zipValidated,
    zip_reason: zipReason,
    importacao_txt_present: !project.automaticZip || !checkZip ? null : zipValidated,
    progresso_reconciliado: items.length ? Math.round(validTargets.size / items.length * 100) : 0,
    pass: critical.length === 0,
    critical,
    warnings: [] as string[],
  };
  await projectEvent(projectId, "project_consistency_gate", gate.pass ? "PASS" : "FAIL", gate);
  return gate;
}

function reopenSelectorMatches(item: typeof automaticProjectItems.$inferSelect, selectors: Set<string>) {
  if (!selectors.size) return true;
  const values = [item.id, item.itemKey, item.targetFile || ""].map((value) => normalize(value));
  return values.some((value) => selectors.has(value));
}

function reopenedItemStatus(status: string) {
  if (["PAUSED_BY_SUPERVISOR", "CANCELLED", "REJECTED", "FAILED", "FAILED_SEMANTIC", "FAILED_INFRASTRUCTURE"].includes(status)) return "RELINK_REQUIRED";
  return status;
}

export async function reopenAutomaticProject(input: Record<string, unknown>) {
  if (input.confirmar_reabertura !== true && input.confirmar !== true) throw new Error("REOPEN_EXPLICIT_CONFIRMATION_REQUIRED");
  const requestedId = clean(input.projeto_id), reason = clean(input.motivo) || "Reabertura explícita autorizada";
  if (!requestedId) throw new Error("PROJECT_ID_REQUIRED");
  const db = getDb();
  const [requested] = await db.select().from(automaticProjects).where(eq(automaticProjects.id, requestedId)).limit(1);
  if (!requested) throw new Error("PROJECT_NOT_FOUND");
  const logicalGroups = await logicalProjectGroups();
  const logical = logicalGroups.find((entry) => entry.executionIds.includes(requestedId));
  const group = logical?.rows || await projectNameGroup(requested.name);
  const groupItemsByProject = new Map<string, Array<typeof automaticProjectItems.$inferSelect>>();
  for (const row of group) {
    const rowItems = await db.select().from(automaticProjectItems).where(and(eq(automaticProjectItems.projectId, row.id), eq(automaticProjectItems.version, row.activeVersion))).orderBy(asc(automaticProjectItems.priority));
    groupItemsByProject.set(row.id, rowItems);
  }
  const targetProject = [...group].sort((a, b) => {
    const ai = groupItemsByProject.get(a.id) || [], bi = groupItemsByProject.get(b.id) || [];
    const ar = ai.filter((item) => RESOLVED_STATUSES.has(item.status) && item.linkedAssetId).length, br = bi.filter((item) => RESOLVED_STATUSES.has(item.status) && item.linkedAssetId).length;
    return br - ar || bi.length - ai.length || b.activeVersion - a.activeVersion || b.updatedAt.getTime() - a.updatedAt.getTime();
  })[0] || requested;
  const wasCompleted = group.some((row) => MANUALLY_COMPLETED_STATUSES.has(row.status));
  const requestRows = await db.select().from(requests);
  const keys = new Set(group.map((row) => projectVideoKey(row.name)));
  const hadCompletedRequest = requestRows.some((row) => keys.has(projectVideoKey(row.project)) && normalize(row.status).includes("conclu"));
  if (!wasCompleted && !hadCompletedRequest && targetProject.status !== "GROUPED_ARCHIVED") throw new Error("PROJECT_NOT_COMPLETED");

  const rawSelectors = Array.isArray(input.gaps) ? input.gaps : Array.isArray(input.itens_gap) ? input.itens_gap : Array.isArray(input.arquivos_gap) ? input.arquivos_gap : [];
  const selectors = new Set(rawSelectors.map(clean).filter(Boolean).map(normalize));
  let items = groupItemsByProject.get(targetProject.id) || await db.select().from(automaticProjectItems).where(and(eq(automaticProjectItems.projectId, targetProject.id), eq(automaticProjectItems.version, targetProject.activeVersion))).orderBy(asc(automaticProjectItems.priority));
  const resolvedDonors = new Map<string, typeof automaticProjectItems.$inferSelect>();
  const allGroupItems: Array<typeof automaticProjectItems.$inferSelect> = [];
  for (const ids of chunk(group.map((row) => row.id), 40)) if (ids.length) allGroupItems.push(...await db.select().from(automaticProjectItems).where(inArray(automaticProjectItems.projectId, ids)));
  for (const donor of allGroupItems) {
    if (!RESOLVED_STATUSES.has(donor.status) || !donor.linkedAssetId) continue;
    const key = normalize(donor.targetFile || donor.itemKey);
    const current = resolvedDonors.get(key);
    if (!current || donor.updatedAt.getTime() > current.updatedAt.getTime()) resolvedDonors.set(key, donor);
  }
  let importedFrozen = 0;
  for (const item of items) {
    if (RESOLVED_STATUSES.has(item.status) && item.linkedAssetId) continue;
    const donor = resolvedDonors.get(normalize(item.targetFile || item.itemKey));
    if (!donor?.linkedAssetId) continue;
    await db.update(automaticProjectItems).set({
      status: donor.status === "FROZEN" ? "FROZEN" : donor.status, sourceType: donor.sourceType || "GROUP_RECONCILED", linkedAssetId: donor.linkedAssetId,
      collectionTermId: donor.collectionTermId || item.collectionTermId, collectionCandidateId: donor.collectionCandidateId || item.collectionCandidateId,
      materializationBatchId: donor.materializationBatchId || item.materializationBatchId, materializationItemId: donor.materializationItemId || item.materializationItemId, materializationFileId: donor.materializationFileId || item.materializationFileId,
      failureReason: null, updatedAt: now(),
    }).where(eq(automaticProjectItems.id, item.id));
    importedFrozen += 1;
    await projectEvent(targetProject.id, "group_resolved_asset_reconciled", donor.status, { source_project_id: donor.projectId, source_item_id: donor.id, asset_id: donor.linkedAssetId, target_file: item.targetFile || item.itemKey }, item.id);
  }
  if (importedFrozen) items = await db.select().from(automaticProjectItems).where(and(eq(automaticProjectItems.projectId, targetProject.id), eq(automaticProjectItems.version, targetProject.activeVersion))).orderBy(asc(automaticProjectItems.priority));
  const unresolved = items.filter((item) => !RESOLVED_STATUSES.has(item.status));
  const selected = unresolved.filter((item) => reopenSelectorMatches(item, selectors));
  if (selectors.size && selected.length !== selectors.size) {
    const matched = new Set(selected.flatMap((item) => [normalize(item.id), normalize(item.itemKey), normalize(item.targetFile || "")]));
    const missing = [...selectors].filter((selector) => !matched.has(selector));
    if (missing.length) throw new Error(`REOPEN_GAPS_NOT_FOUND:${missing.join(",")}`);
  }

  const selectedIds = new Set(selected.map((item) => item.id));
  const date = now();
  for (const item of unresolved) {
    if (selectors.size && !selectedIds.has(item.id)) {
      if (item.status !== "PAUSED_BY_SUPERVISOR") {
        await db.update(automaticProjectItems).set({ status: "PAUSED_BY_SUPERVISOR", failureReason: item.failureReason || "OUTSIDE_EXPLICIT_REOPEN_SCOPE", updatedAt: date }).where(eq(automaticProjectItems.id, item.id));
        await projectEvent(targetProject.id, "item_kept_outside_reopen_scope", "PAUSED_BY_SUPERVISOR", { source: "SUPERVISOR_MCP", reason }, item.id);
      }
      await db.update(supervisorProjectCandidates).set({ status: "PARA_ANALISE", updatedAt: date }).where(and(eq(supervisorProjectCandidates.projectId, targetProject.id), eq(supervisorProjectCandidates.itemId, item.id), eq(supervisorProjectCandidates.status, "PARA_QA_VISUAL")));
      await db.update(supervisorDecisionQueue).set({ state: "RESOLVIDA", decision: "FORA_ESCOPO_REABERTURA", observation: reason, source: "SUPERVISOR_MCP", resolvedAt: date, updatedAt: date }).where(and(eq(supervisorDecisionQueue.projectId, targetProject.id), eq(supervisorDecisionQueue.itemId, item.id), eq(supervisorDecisionQueue.state, "PENDENTE")));
      continue;
    }
    const nextStatus = reopenedItemStatus(item.status);
    if (nextStatus !== item.status) {
      await db.update(automaticProjectItems).set({ status: nextStatus, failureReason: item.failureReason || "REOPENED_BY_SUPERVISOR", updatedAt: date }).where(eq(automaticProjectItems.id, item.id));
      await db.update(supervisorDecisionQueue).set({ state: "RESOLVIDA", decision: "REABERTO_COMO_GAP", observation: reason, source: "SUPERVISOR_MCP", resolvedAt: date, updatedAt: date }).where(and(eq(supervisorDecisionQueue.projectId, targetProject.id), eq(supervisorDecisionQueue.itemId, item.id), eq(supervisorDecisionQueue.state, "PENDENTE")));
    }
  }

  const refreshedItems = await db.select().from(automaticProjectItems).where(and(eq(automaticProjectItems.projectId, targetProject.id), eq(automaticProjectItems.version, targetProject.activeVersion))).orderBy(asc(automaticProjectItems.priority));
  let targetStatus = deriveProjectStatus(refreshedItems, selected.length || unresolved.length ? "PARTIAL_READY" : "READY_TO_COMPLETE");
  if (["READY", "CONCLUIDO_MANUAL", "COMPLETED", "COMPLETED_WITH_WARNINGS", "FORCED_CLOSED", "GROUPED_ARCHIVED"].includes(targetStatus)) targetStatus = selected.length || unresolved.length ? "PARTIAL_READY" : "READY_TO_COMPLETE";

  for (const row of group) {
    const nextStatus = row.id === targetProject.id ? targetStatus : "GROUPED_ARCHIVED";
    await db.update(automaticProjects).set({
      status: nextStatus,
      completedAt: null,
      pipelineStatus: row.id === targetProject.id ? "PRONTO_PARA_RETOMADA" : "CANCELADO",
      nextAction: row.id === targetProject.id ? "RECONCILIAR" : "FINALIZAR",
      previousExecutionId: row.supervisorExecutionId || row.previousExecutionId,
      supervisorExecutionId: null,
      supervisorStatus: row.id === targetProject.id ? "LIVRE" : "SUBSTITUIDA",
      supervisorLeaseStartedAt: null,
      supervisorLastSeenAt: null,
      supervisorLeaseExpiresAt: null,
      abandonedAt: null,
      resumeReason: row.id === targetProject.id ? "REABERTURA_EXPLICITA" : row.resumeReason,
      updatedAt: date,
    }).where(eq(automaticProjects.id, row.id));
    await projectEvent(row.id, row.id === targetProject.id ? "project_explicitly_reopened" : "project_group_execution_archived", nextStatus, {
      source: clean(input.origem) || "SUPERVISOR_MCP", reason, requested_project_id: requestedId, canonical_project_id: targetProject.id,
      preserved_resolved: refreshedItems.filter((item) => RESOLVED_STATUSES.has(item.status)).length, imported_resolved_from_group: importedFrozen, reopened_gaps: selected.map((item) => item.targetFile || item.itemKey), grouped_projects: group.map((entry) => entry.id),
    });
  }
  for (const row of requestRows.filter((item) => keys.has(projectVideoKey(item.project)))) await db.update(requests).set({ status: "Em andamento" }).where(eq(requests.id, row.id));

  await reconcileSupervisorMaterializations(targetProject.id).catch(() => undefined);
  const pipeline = await deriveProjectPipelineState(targetProject.id, false).catch(() => ({ nextAction: "RECONCILIAR" }));
  await db.update(automaticProjects).set({ pipelineStatus: "PRONTO_PARA_RETOMADA", nextAction: pipeline.nextAction || "RECONCILIAR", updatedAt: now() }).where(eq(automaticProjects.id, targetProject.id));
  const detail = await getAutomaticProject(targetProject.id, false);
  return {
    ...detail,
    reabertura: { autorizada: true, projeto_solicitado: requestedId, projeto_canonico: targetProject.id, status: targetStatus, congelados_preservados: detail.itens.filter((item) => RESOLVED_STATUSES.has(item.status)).length, congelados_importados_do_grupo: importedFrozen, gaps_abertos: detail.itens.filter((item) => !RESOLVED_STATUSES.has(item.status) && item.status !== "PAUSED_BY_SUPERVISOR").map((item) => ({ item_id: item.id, item_key: item.itemKey, arquivo: item.targetFile || item.itemKey, status: item.status })), fora_do_escopo: detail.itens.filter((item) => item.status === "PAUSED_BY_SUPERVISOR").map((item) => item.targetFile || item.itemKey), motivo: reason },
  };
}

export async function completeAutomaticProject(input: Record<string, unknown>) {
  const projectId = clean(input.projeto_id), completed = input.concluido !== false, db = getDb();
  if (!completed) return reopenAutomaticProject({ ...input, confirmar_reabertura: true, origem: clean(input.origem) || "OWNER_UI", motivo: clean(input.motivo) || "Desconclusão explícita pelo proprietário" });
  const [project] = await db.select().from(automaticProjects).where(eq(automaticProjects.id, projectId)).limit(1);
  if (!project) throw new Error("PROJECT_NOT_FOUND");
  const logicalGroups = await logicalProjectGroups();
  const logical = logicalGroups.find((entry) => entry.executionIds.includes(projectId));
  const group = logical?.rows || await projectNameGroup(project.name), groupIds = group.map((row) => row.id), date = now();
  const status = "CONCLUIDO_MANUAL";
  for (const ids of chunk(groupIds, 40)) await db.update(automaticProjects).set({ status, completedAt: date, pipelineStatus: "CONCLUIDO", nextAction: "FINALIZAR", supervisorStatus: "CONCLUIDA", supervisorLastSeenAt: date, supervisorLeaseExpiresAt: date, updatedAt: date }).where(inArray(automaticProjects.id, ids));
  const requestRows = await db.select().from(requests), keys = new Set(group.map((row) => projectVideoKey(row.name)));
  for (const row of requestRows.filter((item) => keys.has(projectVideoKey(item.project)))) {
    await db.update(requests).set({ status: "Concluído" }).where(eq(requests.id, row.id));
  }
  for (const row of group) {
    await projectEvent(row.id, "project_manually_completed", status, { ownerAction: true, groupedProjects: groupIds });
    if (row.supervisorExecutionId) await completeSupervisorExecution(row.id, row.supervisorExecutionId, "CONCLUIDA").catch(() => undefined);
  }
  return getAutomaticProject(projectId);
}

export async function getProjectAutomationAvailability(input: Record<string, unknown>) {
  const projectId = clean(input.projeto_id), name = clean(input.nome);
  const rows = projectId
    ? await getDb().select().from(automaticProjects).where(eq(automaticProjects.id, projectId)).limit(1)
    : name ? await projectNameGroup(name) : [];
  const project = rows[0];
  if (!project) return { encontrado: false, liberado_para_ia: true, motivo: null, projetos_agrupados: 0 };
  const guard = await projectCompletionGuard(project);
  return { encontrado: true, projeto_id: project.id, nome: project.name, status: project.status, liberado_para_ia: guard.allowed, motivo: guard.reason, projetos_agrupados: guard.groupCount };
}

export async function getAutomaticProjectSummary(projectId: string) {
  const db = getDb();
  const [project] = await db.select().from(automaticProjects).where(eq(automaticProjects.id, projectId)).limit(1);
  if (!project) throw new Error("PROJECT_NOT_FOUND");
  return {
    projeto: { id: project.id, name: project.name, status: project.status, pipelineStatus: project.pipelineStatus, projectDomain: project.projectDomain, activeVersion: project.activeVersion, stateVersion: project.stateVersion, nextAction: project.nextAction, lastAction: project.lastAction, automatic: project.automatic, createdAt: project.createdAt, updatedAt: project.updatedAt },
    metricas: { total: project.totalItems, aprovados: project.approvedCount, congelados: project.frozenCount, coleta: project.collectingCount, materializacao: project.materializingCount, qa: project.waitingQaCount, relink: project.relinkCount, correcao: project.technicalCount, waiting_seed: project.waitingSeedCount, falhas: project.failedCount, pendentes: project.pendingCount, resolvidos: Math.max(0, project.totalItems - project.pendingCount), progresso_percentual: project.totalItems ? Math.round((project.totalItems-project.pendingCount)/project.totalItems*100) : 0 },
  };
}

export async function listAutomaticProjectsFast(limit = 50, cursor?: string) {
  const db = getDb();
  const max = Math.max(1, Math.min(100, limit));
  let where = undefined as ReturnType<typeof or> | undefined;
  if (cursor) {
    const [timeRaw, idRaw] = cursor.split("|");
    const time = Number(timeRaw);
    if (Number.isFinite(time) && idRaw) {
      const cursorDate = new Date(time);
      where = or(
        lt(automaticProjects.updatedAt, cursorDate),
        and(eq(automaticProjects.updatedAt, cursorDate), lt(automaticProjects.id, idRaw)),
      );
    }
  }
  const rows = await db.select().from(automaticProjects).where(where).orderBy(desc(automaticProjects.updatedAt), desc(automaticProjects.id)).limit(max + 1);
  const page = rows.slice(0,max).map((project)=>({ id:project.id,name:project.name,status:project.status,pipeline_status:project.pipelineStatus,domain:project.projectDomain,version:project.activeVersion,state_version:project.stateVersion,counts:{total:project.totalItems,approved:project.approvedCount,frozen:project.frozenCount,collecting:project.collectingCount,materializing:project.materializingCount,waiting_qa:project.waitingQaCount,relink:project.relinkCount,technical:project.technicalCount,waiting_seed:project.waitingSeedCount,failed:project.failedCount,pending:project.pendingCount},last_action:project.lastAction,created_at:project.createdAt,updated_at:project.updatedAt}));
  const last = page[page.length-1];
  const nextCursor = rows.length > max && last ? `${new Date(last.updated_at).getTime()}|${last.id}` : null;
  return { projetos: page, total: page.length, next_cursor: nextCursor };
}

export async function getAutomaticProject(projectId: string, reconcile = false) {
  if (reconcile) await reconcileAutomaticProject(projectId, false);
  const db = getDb(), [project] = await db.select().from(automaticProjects).where(eq(automaticProjects.id, projectId)).limit(1);
  if (!project) throw new Error("PROJECT_NOT_FOUND");
  const [files, items, events, production] = await Promise.all([
    db.select().from(automaticProjectFiles).where(eq(automaticProjectFiles.projectId, projectId)).orderBy(desc(automaticProjectFiles.createdAt)),
    db.select().from(automaticProjectItems).where(and(eq(automaticProjectItems.projectId, projectId), eq(automaticProjectItems.version, project.activeVersion))).orderBy(asc(automaticProjectItems.priority)),
    db.select().from(automaticProjectEvents).where(eq(automaticProjectEvents.projectId, projectId)).orderBy(desc(automaticProjectEvents.createdAt)).limit(100),
    getProjectProductionPackage(projectId),
  ]);
  const counts = Object.fromEntries([...new Set(items.map((item) => item.status))].map((status) => [status, items.filter((item) => item.status === status).length]));
  const resolved = items.filter((item) => RESOLVED_STATUSES.has(item.status)).length;
  const started = project.startedAt?.getTime() || project.createdAt.getTime(), elapsed = (project.completedAt?.getTime() || Date.now()) - started;
  const guard = await projectCompletionGuard(project);
  const visibleProject = guard.reason === "PROJECT_GROUP_CONCLUIDO_MANUALMENTE" ? { ...project, status: "CONCLUIDO_MANUAL" } : project;
  return { projeto: visibleProject, arquivos: files, itens: items, eventos: events, producao: production, contagem_status: counts, metricas: { total: items.length, resolvidos: resolved, familias: new Set(items.map((item) => item.familyId).filter(Boolean)).size, biblioteca: items.filter((item) => item.sourceType === "LIBRARY").length, fanout: items.filter((item) => item.sourceType === "FAMILY").length, externos: items.filter((item) => item.sourceType === "EXTERNAL").length, qa: items.filter((item) => item.status === "QA_READY").length, relink: items.filter((item) => item.status === "RELINK_REQUIRED").length, falhas: items.filter((item) => item.status.startsWith("FAILED")).length, progresso_percentual: items.length ? Math.round(resolved / items.length * 100) : 0, tempo_total_ms: Math.max(0, elapsed), throughput_por_minuto: elapsed > 0 ? Math.round(resolved / (elapsed / 60_000) * 100) / 100 : 0 } };
}

type LogicalProjectGroup = {
  key: string;
  rows: Array<typeof automaticProjects.$inferSelect>;
  representative: typeof automaticProjects.$inferSelect;
  executionIds: string[];
  errorCount: number;
  fileCount: number;
};

async function logicalProjectGroups() : Promise<LogicalProjectGroup[]> {
  const db = getDb();
  const [rows, fileRows, itemRows] = await Promise.all([
    db.select().from(automaticProjects).orderBy(desc(automaticProjects.updatedAt)),
    db.select().from(automaticProjectFiles),
    db.select().from(automaticProjectItems),
  ]);
  const parent = new Map(rows.map((row) => [row.id, row.id]));
  const find = (id: string): string => { const current = parent.get(id) || id; if (current === id) return id; const root = find(current); parent.set(id, root); return root; };
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(rb, ra); };

  const byName = new Map<string, string>();
  for (const row of rows) {
    const key = projectVideoKey(row.name) || `id:${row.id}`;
    const existing = byName.get(key);
    if (existing) union(existing, row.id); else byName.set(key, row.id);
  }
  const byScriptHash = new Map<string, string>();
  for (const file of fileRows) {
    if (file.role !== "SCRIPT" || !file.contentHash) continue;
    const existing = byScriptHash.get(file.contentHash);
    if (existing) union(existing, file.projectId); else byScriptHash.set(file.contentHash, file.projectId);
  }

  const groupedRows = new Map<string, typeof rows>();
  for (const row of rows) { const root = find(row.id); groupedRows.set(root, [...(groupedRows.get(root) || []), row]); }
  const filesPerProject = new Map<string, number>();
  for (const file of fileRows) filesPerProject.set(file.projectId, (filesPerProject.get(file.projectId) || 0) + 1);
  const activeVersions = new Map(rows.map((row) => [row.id, row.activeVersion]));
  const currentItems = itemRows.filter((item) => activeVersions.get(item.projectId) === item.version);
  const itemsPerProject = new Map<string, number>(), errorsPerProject = new Map<string, number>();
  for (const item of currentItems) {
    itemsPerProject.set(item.projectId, (itemsPerProject.get(item.projectId) || 0) + 1);
    if (!RESOLVED_STATUSES.has(item.status) && (item.failureReason || item.status.startsWith("FAILED") || item.status === "RELINK_REQUIRED")) errorsPerProject.set(item.projectId, (errorsPerProject.get(item.projectId) || 0) + 1);
  }
  return [...groupedRows.entries()].map(([root, group]) => {
    const ranked = [...group].sort((a, b) => {
      const score = (row: typeof automaticProjects.$inferSelect) => (itemsPerProject.get(row.id) || 0) * 100 + (filesPerProject.get(row.id) || 0) * 10 + row.activeVersion;
      return score(b) - score(a) || b.updatedAt.getTime() - a.updatedAt.getTime();
    });
    return {
      key: projectVideoKey(ranked[0].name) || root,
      rows: group,
      representative: ranked[0],
      executionIds: group.map((row) => row.id),
      errorCount: group.reduce((sum, row) => sum + (errorsPerProject.get(row.id) || 0), 0),
      fileCount: group.reduce((sum, row) => sum + (filesPerProject.get(row.id) || 0), 0),
    };
  });
}

export async function listAutomaticProjects(limit = 50) {
  const [groups, requestRows] = await Promise.all([logicalProjectGroups(), getDb().select().from(requests)]);
  const completedRequestNames = new Set(requestRows.filter((row) => normalize(row.status).includes("conclu")).map((row) => projectVideoKey(row.project)));
  const grouped = groups.map((logical) => {
    const group = logical.rows, representative = logical.representative;
    const completed = group.some((row) => completedRequestNames.has(projectVideoKey(row.name)) || MANUALLY_COMPLETED_STATUSES.has(row.status));
    const createdAt = new Date(Math.min(...group.map((row) => row.createdAt.getTime())));
    const updatedAt = new Date(Math.max(...group.map((row) => row.updatedAt.getTime())));
    const projectErrorStatus = group.some((row) => ["ERROR", "FAILED"].includes(row.status));
    return {
      ...representative, createdAt, updatedAt,
      status: completed ? "CONCLUIDO_MANUAL" : representative.status,
      groupCount: group.length,
      executionIds: logical.executionIds,
      versions: [...new Set(group.map((row) => row.activeVersion))].sort((a, b) => b - a),
      errorCount: logical.errorCount,
      hasErrors: !completed && (logical.errorCount > 0 || projectErrorStatus),
      recent24h: createdAt.getTime() >= Date.now() - 24 * 60 * 60_000,
    };
  }).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()).slice(0, Math.max(1, Math.min(100, limit)));
  return { projetos: grouped, total: grouped.length, execucoes_totais: groups.reduce((sum, group) => sum + group.rows.length, 0) };
}

export async function completeAutomaticProjects(input: Record<string, unknown>) {
  const ids = Array.isArray(input.projeto_ids) ? input.projeto_ids.map(clean).filter(Boolean) : [clean(input.projeto_id)].filter(Boolean);
  if (!ids.length) throw new Error("PROJECT_IDS_REQUIRED");
  const groups = await logicalProjectGroups();
  const targetGroups = groups.filter((group) => group.executionIds.some((id) => ids.includes(id)));
  const representatives = targetGroups.map((group) => group.representative.id);
  const results = [];
  for (const id of representatives) results.push(await completeAutomaticProject({ projeto_id: id, concluido: input.concluido !== false }));
  return { atualizados: results.length, projeto_ids: representatives, concluido: input.concluido !== false };
}

export async function deleteAutomaticProjects(input: Record<string, unknown>) {
  if (input.confirmar !== true) throw new Error("CONFIRMACAO_REQUIRED");
  const ids = Array.isArray(input.projeto_ids) ? input.projeto_ids.map(clean).filter(Boolean) : [clean(input.projeto_id)].filter(Boolean);
  if (!ids.length) throw new Error("PROJECT_IDS_REQUIRED");
  const db = getDb(), groups = await logicalProjectGroups();
  const targetGroups = groups.filter((group) => group.executionIds.some((id) => ids.includes(id)));
  const projectIds = [...new Set(targetGroups.flatMap((group) => group.executionIds))];
  if (!projectIds.length) return { excluidos: 0, projeto_ids: [] };
  const [files, projects, productionAssets] = await Promise.all([
    db.select().from(automaticProjectFiles).where(inArray(automaticProjectFiles.projectId, projectIds)),
    db.select().from(automaticProjects).where(inArray(automaticProjects.id, projectIds)),
    db.select().from(projectProductionAssets).where(inArray(projectProductionAssets.projectId, projectIds)),
  ]);
  const ownedProductionKeys = productionAssets.filter((row) => row.r2Key.startsWith(`projects/${row.projectId}/production/`)).map((row) => row.r2Key);
  const r2Keys = [...new Set([
    ...files.map((file) => file.r2Key),
    ...projects.map((project) => project.zipR2Key).filter((value): value is string => Boolean(value)),
    ...projects.map((project) => project.productionZipR2Key).filter((value): value is string => Boolean(value)),
    ...ownedProductionKeys,
  ])];
  const requestRows = await db.select().from(requests);
  const keys = new Set(projects.map((project) => projectVideoKey(project.name)));
  const requestIds = requestRows.filter((row) => keys.has(projectVideoKey(row.project))).map((row) => row.id);

  // D1-native atomic deletion. Drizzle's generic transaction() emits BEGIN,
  // which is not supported by the Cloudflare D1 execution path used here.
  // batch() executes these statements atomically inside D1.
  if (requestIds.length) {
    await db.batch([
      db.delete(operationalPolicyEvents).where(inArray(operationalPolicyEvents.projectId, projectIds)),
      db.delete(operationalPolicies).where(inArray(operationalPolicies.projectId, projectIds)),
      db.delete(operationalGaps).where(inArray(operationalGaps.projectId, projectIds)),
      db.delete(planBranches).where(inArray(planBranches.projectId, projectIds)),
      db.delete(sourceRoutingPlans).where(inArray(sourceRoutingPlans.projectId, projectIds)),
      db.delete(supervisorPlans).where(inArray(supervisorPlans.projectId, projectIds)),
      db.delete(supervisorDecisionJobs).where(inArray(supervisorDecisionJobs.projectId, projectIds)),
      db.delete(supervisorDecisionQueue).where(inArray(supervisorDecisionQueue.projectId, projectIds)),
      db.delete(supervisorExecutions).where(inArray(supervisorExecutions.projectId, projectIds)),
      db.delete(supervisorProjectCandidates).where(inArray(supervisorProjectCandidates.projectId, projectIds)),
      db.delete(workerEvents).where(inArray(workerEvents.projectId, projectIds)),
      db.delete(stageMetrics).where(inArray(stageMetrics.projectId, projectIds)),
      db.delete(projectRuns).where(inArray(projectRuns.projectId, projectIds)),
      db.delete(exportJobs).where(inArray(exportJobs.projectId, projectIds)),
      db.delete(workerSessions).where(inArray(workerSessions.projectId, projectIds)),
      db.delete(workerWorkItems).where(inArray(workerWorkItems.projectId, projectIds)),
      db.delete(projectTitleCandidates).where(inArray(projectTitleCandidates.projectId, projectIds)),
      db.delete(projectProductionAssets).where(inArray(projectProductionAssets.projectId, projectIds)),
      db.delete(automaticProjectEvents).where(inArray(automaticProjectEvents.projectId, projectIds)),
      db.delete(automaticProjectItems).where(inArray(automaticProjectItems.projectId, projectIds)),
      db.delete(automaticProjectFiles).where(inArray(automaticProjectFiles.projectId, projectIds)),
      db.delete(automaticProjects).where(inArray(automaticProjects.id, projectIds)),
      db.delete(requests).where(inArray(requests.id, requestIds)),
    ]);
  } else {
    await db.batch([
      db.delete(operationalPolicyEvents).where(inArray(operationalPolicyEvents.projectId, projectIds)),
      db.delete(operationalPolicies).where(inArray(operationalPolicies.projectId, projectIds)),
      db.delete(operationalGaps).where(inArray(operationalGaps.projectId, projectIds)),
      db.delete(planBranches).where(inArray(planBranches.projectId, projectIds)),
      db.delete(sourceRoutingPlans).where(inArray(sourceRoutingPlans.projectId, projectIds)),
      db.delete(supervisorPlans).where(inArray(supervisorPlans.projectId, projectIds)),
      db.delete(supervisorDecisionJobs).where(inArray(supervisorDecisionJobs.projectId, projectIds)),
      db.delete(supervisorDecisionQueue).where(inArray(supervisorDecisionQueue.projectId, projectIds)),
      db.delete(supervisorExecutions).where(inArray(supervisorExecutions.projectId, projectIds)),
      db.delete(supervisorProjectCandidates).where(inArray(supervisorProjectCandidates.projectId, projectIds)),
      db.delete(workerEvents).where(inArray(workerEvents.projectId, projectIds)),
      db.delete(stageMetrics).where(inArray(stageMetrics.projectId, projectIds)),
      db.delete(projectRuns).where(inArray(projectRuns.projectId, projectIds)),
      db.delete(exportJobs).where(inArray(exportJobs.projectId, projectIds)),
      db.delete(workerSessions).where(inArray(workerSessions.projectId, projectIds)),
      db.delete(workerWorkItems).where(inArray(workerWorkItems.projectId, projectIds)),
      db.delete(projectTitleCandidates).where(inArray(projectTitleCandidates.projectId, projectIds)),
      db.delete(projectProductionAssets).where(inArray(projectProductionAssets.projectId, projectIds)),
      db.delete(automaticProjectEvents).where(inArray(automaticProjectEvents.projectId, projectIds)),
      db.delete(automaticProjectItems).where(inArray(automaticProjectItems.projectId, projectIds)),
      db.delete(automaticProjectFiles).where(inArray(automaticProjectFiles.projectId, projectIds)),
      db.delete(automaticProjects).where(inArray(automaticProjects.id, projectIds)),
    ]);
  }

  // Clean R2 only after D1 is committed. Missing R2 objects are harmless and
  // the cleanup is idempotent, so a previous failed deletion can be retried.
  const r2CleanupFailures: string[] = [];
  for (const key of r2Keys) {
    try { await env.BUCKET.delete(key); }
    catch { r2CleanupFailures.push(key); }
  }

  return {
    excluidos: projectIds.length,
    grupos_excluidos: targetGroups.length,
    projeto_ids: projectIds,
    arquivos_r2_removidos: r2Keys.length - r2CleanupFailures.length,
    r2_cleanup_failures: r2CleanupFailures,
  };
}

export async function getAutomaticProjectLog(projectId: string) {
  const detail = await getAutomaticProject(projectId);
  const lines = ["LOG DO PROJETO AUTOMÁTICO", `PROJETO: ${detail.projeto.name}`, `ID: ${projectId}`, `STATUS: ${detail.projeto.status}`, `VERSAO: ${detail.projeto.activeVersion}`, `GERADO_UTC: ${new Date().toISOString()}`, "", "MÉTRICAS", JSON.stringify(detail.metricas, null, 2), "", "ITENS"];
  for (const item of detail.itens) lines.push(`${item.itemKey} | target=${item.targetFile || item.itemKey} | ${item.term} | ${item.status} | family=${item.familyId || "—"} | composition=${item.compositionClass} | origem=${item.sourceType || "—"} | asset=${item.linkedAssetId || "—"} | erro=${item.failureReason || "—"} | tentativas=${item.attempts}`);
  lines.push("", "EVENTOS");
  for (const event of detail.eventos) lines.push(`${event.createdAt.toISOString()} | ${event.event} | ${event.status || "—"} | ${event.detail || ""}`);
  return { projeto_id: projectId, arquivo: `LOG-${projectId}.txt`, conteudo: lines.join("\n") };
}

export async function attachAutomaticProjectFileFromUrl(input: Record<string, unknown>) {
  const availability = await getProjectAutomationAvailability({ projeto_id: clean(input.projeto_id) });
  if (availability.encontrado && !availability.liberado_para_ia) throw new Error(`${availability.motivo}: projeto bloqueado para anexos da IA`);
  const file = input.arquivo && typeof input.arquivo === "object" ? input.arquivo as Record<string, unknown> : {};
  const inlineContent = clean(input.conteudo_txt) || clean(file.content) || clean(file.text);
  const fileName = clean(input.nome_arquivo) || clean(file.file_name) || `${clean(input.tipo).toLowerCase()}.txt`;
  if (inlineContent) {
    const bytes = new TextEncoder().encode(inlineContent);
    if (bytes.byteLength > 10 * 1024 * 1024) throw new Error("TXT_LIMIT_10_MB");
    return attachAutomaticProjectFile(clean(input.projeto_id), clean(input.tipo), fileName, clean(file.mime_type) || "text/plain;charset=utf-8", bytes);
  }
  const url = clean(file.download_url) || clean(file.downloadUrl) || clean(file.url) || clean(file.uri);
  if (!url) throw new Error("FILE_CONTENT_OR_DOWNLOAD_URL_REQUIRED: envie conteudo_txt ou um arquivo com download_url");
  if (!/^https:\/\//i.test(url)) throw new Error("FILE_DOWNLOAD_URL_MUST_BE_HTTPS");
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`FILE_DOWNLOAD_FAILED:${response.status}`);
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > 10 * 1024 * 1024) throw new Error("TXT_LIMIT_10_MB");
  const bytes = new Uint8Array(await response.arrayBuffer());
  return attachAutomaticProjectFile(clean(input.projeto_id), clean(input.tipo), fileName, clean(file.mime_type) || response.headers.get("content-type") || "text/plain", bytes);
}
