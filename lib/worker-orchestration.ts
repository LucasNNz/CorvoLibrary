import { env } from "./platform/runtime";
import { and, asc, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import { getDb } from "../db";
import {
  automaticProjectFiles,
  automaticProjectItems,
  automaticProjects,
  exportJobs,
  projectRuns,
  queueSnapshots,
  settings,
  stageMetrics,
  supervisorPlans,
  planBranches,
  workerCapacityLimits,
  workerEvents,
  workerSessions,
  workerWorkItems,
} from "../db/schema";

const DEFAULT_TTL_MINUTES = 10;
const DEFAULT_WATCHDOG_MINUTES = 2;
const TERMINAL_PROJECTS = new Set(["CONCLUIDO_MANUAL", "COMPLETED", "COMPLETED_WITH_WARNINGS", "FORCED_CLOSED", "CANCELLED", "GROUPED_ARCHIVED"]);
const COMPLETED_PROJECTS = new Set(["CONCLUIDO_MANUAL", "COMPLETED", "COMPLETED_WITH_WARNINGS", "FORCED_CLOSED"]);
const RESOLVED_ITEMS = new Set(["APPROVED", "FROZEN", "LINKED_FROM_LIBRARY", "LINKED_FROM_FAMILY"]);
const PAUSED_ITEMS = new Set(["PAUSED_BY_SUPERVISOR", "CANCELLED", "CANCELED", "WAITING_FAMILY_SEED", "WAITING_DEPENDENCY"]);

const STAGE_BY_ITEM_STATUS: Array<[Set<string>, string]> = [
  [new Set(["QUEUED", "PARSING", "SEARCHING_EXTERNALLY", "SEARCHING_LIBRARY", "COLLECTING", "WAITING_LIBRARY", "WAITING_EXTERNAL_SEARCH"]), "COLETA"],
  [new Set(["READY_FOR_MATERIALIZATION", "MATERIALIZATION_PENDING", "MATERIALIZING"]), "MATERIALIZACAO"],
  [new Set(["QA_READY", "READY_FOR_VISUAL_QA"]), "QA"],
  [new Set(["RELINK_REQUIRED"]), "RELINK"],
  [new Set(["TECHNICAL_CORRECTION_REQUIRED", "CORRECAO_TECNICA_PERMITIDA"]), "CORRECAO_TECNICA"],
];

const WORKER_STAGES: Record<string, string[]> = {
  SCRIPT: ["SCRIPT"],
  COLLECTOR: ["COLETA"],
  MATERIALIZER: ["MATERIALIZACAO"],
  ANALYST: ["QA"],
  QA: ["QA"],
  RELINK: ["RELINK"],
  TECHNICAL_FIX: ["CORRECAO_TECNICA"],
  ORGANIZER: ["ORGANIZACAO"],
  EXPORTER: ["EXPORTACAO"],
  ZIP: ["EXPORTACAO"],
  SUPERVISOR: ["SCRIPT", "COLETA", "MATERIALIZACAO", "QA", "RELINK", "CORRECAO_TECNICA", "ORGANIZACAO", "EXPORTACAO"],
};

const DEFAULT_WORKER_FOR_STAGE: Record<string, string> = {
  SCRIPT: "SCRIPT",
  COLETA: "COLLECTOR",
  MATERIALIZACAO: "MATERIALIZER",
  QA: "ANALYST",
  RELINK: "RELINK",
  CORRECAO_TECNICA: "TECHNICAL_FIX",
  ORGANIZACAO: "ORGANIZER",
  EXPORTACAO: "EXPORTER",
};

const now = () => new Date();
const makeId = (prefix: string) => `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
const upper = (value: unknown, fallback = "") => String(value ?? fallback).trim().toUpperCase();
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
const parseJson = <T>(value: string | null | undefined, fallback: T): T => { try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; } };

function stageForItemStatus(status: string) {
  if (RESOLVED_ITEMS.has(status) || PAUSED_ITEMS.has(status)) return null;
  for (const [statuses, stage] of STAGE_BY_ITEM_STATUS) if (statuses.has(status)) return stage;
  if (status === "FAILED" || status === "ERROR_REAL") return null;
  return "COLETA";
}

function domainAllowed(workerDomain: string, projectDomain: string, allowedDomains: string[], globalFallback = false) {
  if (workerDomain === "MULTI") return true;
  if (workerDomain === projectDomain) return true;
  if (allowedDomains.includes(projectDomain)) return true;
  return globalFallback;
}

function actionAllowedForStage(stage: string, action: string) {
  const value = upper(action);
  if (!value) return true;
  if (value.includes("MATERIALIZ")) return stage === "MATERIALIZACAO" || stage === "CORRECAO_TECNICA";
  if (value.includes("QA") || value.includes("APROVAR") || value.includes("REJEITAR") || value.includes("CONGELAR")) return stage === "QA";
  if (value.includes("RELINK")) return stage === "RELINK" || stage === "COLETA";
  if (value.includes("CORRECAO")) return stage === "CORRECAO_TECNICA";
  if (value.includes("ZIP") || value.includes("EXPORT")) return stage === "EXPORTACAO";
  if (value.includes("COLETA") || value.includes("QUERY") || value.includes("FONTE") || value.includes("REFERENCIA")) return stage === "COLETA" || stage === "RELINK";
  return true;
}

async function settingValue(key: string, fallback: string) {
  const [row] = await getDb().select().from(settings).where(eq(settings.key, key)).limit(1);
  return row?.value ?? fallback;
}

export async function getWorkerConfig() {
  return {
    ttlMinutes: clamp(Number(await settingValue("worker_lease_ttl_minutes", String(DEFAULT_TTL_MINUTES))), 5, 15),
    watchdogMinutes: clamp(Number(await settingValue("worker_watchdog_interval_minutes", String(DEFAULT_WATCHDOG_MINUTES))), 1, 15),
    fifoEnabled: (await settingValue("fifo_enabled", "true")) === "true",
    skipLocked: (await settingValue("skip_locked", "true")) === "true",
    granularLeases: (await settingValue("lease_granular", "true")) === "true",
    requeueExpired: (await settingValue("requeue_expired_lease", "true")) === "true",
    preserveOriginalAge: (await settingValue("preserve_original_queue_age", "true")) === "true",
    fallbackBetweenDomains: (await settingValue("fallback_between_domains", "false")) === "true",
  };
}

async function recordWorkerEvent(input: {
  workerId?: string | null; workerType?: string | null; workerDomain?: string | null; executionId?: string | null;
  projectId?: string | null; workItemId?: string | null; stage?: string | null; eventType: string; status?: string | null;
  durationMs?: number | null; metadata?: Record<string, unknown>;
}) {
  await getDb().insert(workerEvents).values({
    id: makeId("WEVT"), workerId: input.workerId || null, workerType: input.workerType || null, workerDomain: input.workerDomain || null,
    executionId: input.executionId || null, projectId: input.projectId || null, workItemId: input.workItemId || null,
    stage: input.stage || null, eventType: input.eventType, status: input.status || null, durationMs: input.durationMs ?? null,
    metadataJson: JSON.stringify(input.metadata || {}), createdAt: now(),
  });
}

async function ensureProjectRun(project: typeof automaticProjects.$inferSelect) {
  const db = getDb();
  const [active] = await db.select().from(projectRuns).where(and(eq(projectRuns.projectId, project.id), eq(projectRuns.status, "ATIVO"))).limit(1);
  if (active) return active;
  const row = { id: makeId("RUN"), projectId: project.id, projectDomain: project.projectDomain || "GENERAL", status: "ATIVO", startedAt: project.startedAt || project.createdAt || now(), createdAt: now(), updatedAt: now() };
  await db.insert(projectRuns).values(row);
  return row;
}

async function ensureWorkItem(input: {
  scopeType: string; scopeId: string; projectId: string; projectDomain: string; itemId?: string | null; stage: string; priority: number;
  readyAt: Date; originalReadyAt: Date; payload: Record<string, unknown>;
}) {
  const db = getDb();
  const [existing] = await db.select().from(workerWorkItems).where(and(eq(workerWorkItems.scopeType, input.scopeType), eq(workerWorkItems.scopeId, input.scopeId), eq(workerWorkItems.stage, input.stage))).limit(1);
  if (existing) {
    if (existing.status === "CANCELLED") return existing;
    const canonicalChangedAfterCompletion = Boolean(existing.completedAt && input.readyAt.getTime() > existing.completedAt.getTime());
    const mayReopen = ["COMPLETED", "SUPERSEDED"].includes(existing.status) && canonicalChangedAfterCompletion;
    if (["COMPLETED", "SUPERSEDED"].includes(existing.status) && !mayReopen) return existing;
    const nextReady = mayReopen ? input.readyAt : (existing.readyAt || input.readyAt);
    const original = existing.originalReadyAt || input.originalReadyAt;
    const patch = {
      projectDomain: input.projectDomain, priority: input.priority, readyAt: nextReady, originalReadyAt: original, payloadJson: JSON.stringify(input.payload),
      ...(mayReopen ? { status: "READY", completedAt: null, leaseOwnerWorkerId: null, leaseExecutionId: null, leaseStartedAt: null, leaseLastSeenAt: null, leaseExpiresAt: null, lastAction: "REOPENED_BY_CANONICAL_STAGE" } : {}),
      updatedAt: now(),
    };
    await db.update(workerWorkItems).set(patch).where(eq(workerWorkItems.id, existing.id));
    return { ...existing, ...patch };
  }
  const row = {
    id: makeId("WORK"), scopeType: input.scopeType, scopeId: input.scopeId, projectId: input.projectId, projectDomain: input.projectDomain,
    itemId: input.itemId || null, stage: input.stage, workerType: DEFAULT_WORKER_FOR_STAGE[input.stage] || "SUPERVISOR",
    priority: input.priority, resumePriority: 0, status: "READY", readyAt: input.readyAt, originalReadyAt: input.originalReadyAt,
    attempts: 0, payloadJson: JSON.stringify(input.payload), createdAt: now(), updatedAt: now(),
  };
  await db.insert(workerWorkItems).values(row).onConflictDoNothing();
  return row;
}

export async function syncWorkerQueue(projectId?: string) {
  const db = getDb();
  const projects = projectId
    ? await db.select().from(automaticProjects).where(eq(automaticProjects.id, projectId)).limit(1)
    : await db.select().from(automaticProjects).orderBy(asc(automaticProjects.createdAt)).limit(1000);
  let createdOrTouched = 0;
  for (const project of projects) {
    if (TERMINAL_PROJECTS.has(project.status) || project.pipelineStatus === "CONCLUIDO" || project.pipelineStatus === "CANCELADO") {
      const activeRuns = await db.select().from(projectRuns).where(and(eq(projectRuns.projectId, project.id), eq(projectRuns.status, "ATIVO")));
      for (const run of activeRuns) {
        const completedAt = project.completedAt || project.updatedAt || now();
        await db.update(projectRuns).set({ status: project.pipelineStatus === "CANCELADO" || project.status === "CANCELLED" ? "CANCELADO" : "CONCLUIDO", completedAt, totalDurationMs: Math.max(0, completedAt.getTime() - run.startedAt.getTime()), updatedAt: now() }).where(eq(projectRuns.id, run.id));
      }
      continue;
    }
    const domain = upper(project.projectDomain || "GENERAL", "GENERAL");
    await ensureProjectRun(project);
    const files = await db.select().from(automaticProjectFiles).where(eq(automaticProjectFiles.projectId, project.id));
    const roles = new Set(files.map((file) => file.role));
    const filesComplete = roles.has("SCRIPT") && roles.has("REQUIREMENTS");
    if (filesComplete) {
      const staleScript = await db.select().from(workerWorkItems).where(and(eq(workerWorkItems.scopeType, "PROJECT"), eq(workerWorkItems.scopeId, project.id), eq(workerWorkItems.stage, "SCRIPT")));
      for (const work of staleScript) if (["READY", "WAITING_DEPENDENCY"].includes(work.status)) await db.update(workerWorkItems).set({ status: "SUPERSEDED", completedAt: now(), lastAction: "FILES_COMPLETE", updatedAt: now() }).where(eq(workerWorkItems.id, work.id));
    }
    if (project.status === "WAITING_FILES" || !filesComplete) {
      await ensureWorkItem({ scopeType: "PROJECT", scopeId: project.id, projectId: project.id, projectDomain: domain, stage: "SCRIPT", priority: project.queuePriority || 1, readyAt: project.readyAt || project.createdAt, originalReadyAt: project.originalReadyAt || project.createdAt, payload: { project_name: project.name, missing_files: [!roles.has("SCRIPT") ? "SCRIPT" : null, !roles.has("REQUIREMENTS") ? "REQUIREMENTS" : null].filter(Boolean) } });
      createdOrTouched += 1;
      continue;
    }
    const items = await db.select().from(automaticProjectItems).where(and(eq(automaticProjectItems.projectId, project.id), eq(automaticProjectItems.version, project.activeVersion)));
    let unresolved = 0;
    for (const item of items) {
      const stage = stageForItemStatus(item.status);
      if (!stage) {
        const stale = await db.select().from(workerWorkItems).where(and(eq(workerWorkItems.scopeType, "ITEM"), eq(workerWorkItems.scopeId, item.id)));
        for (const old of stale) if (["READY", "WAITING_DEPENDENCY"].includes(old.status)) await db.update(workerWorkItems).set({ status: "SUPERSEDED", completedAt: now(), lastAction: `CANONICAL_STATUS:${item.status}`, updatedAt: now() }).where(eq(workerWorkItems.id, old.id));
        continue;
      }
      unresolved += 1;
      const itemDomain = upper(item.itemDomain || domain, domain);
      const stageReadyAt = item.stage !== stage ? (item.updatedAt || item.createdAt) : (item.stageReadyAt || item.updatedAt || item.createdAt);
      const originalReadyAt = item.originalReadyAt || item.createdAt;
      if (item.itemDomain !== itemDomain || item.stage !== stage || !item.stageReadyAt || !item.originalReadyAt) {
        await db.update(automaticProjectItems).set({ itemDomain, stage, stageReadyAt, originalReadyAt, updatedAt: item.updatedAt }).where(eq(automaticProjectItems.id, item.id));
      }
      await ensureWorkItem({ scopeType: "ITEM", scopeId: item.id, projectId: project.id, projectDomain: itemDomain, itemId: item.id, stage, priority: Math.max(project.queuePriority || 1, item.priority || 1), readyAt: stageReadyAt, originalReadyAt, payload: { item_key: item.itemKey, target_file: item.targetFile, term: item.term, universe: item.universe, context: item.context, item_status: item.status } });
      createdOrTouched += 1;
      const stale = await db.select().from(workerWorkItems).where(and(eq(workerWorkItems.scopeType, "ITEM"), eq(workerWorkItems.scopeId, item.id)));
      for (const old of stale) if (old.stage !== stage && ["READY", "WAITING_DEPENDENCY"].includes(old.status)) await db.update(workerWorkItems).set({ status: "SUPERSEDED", completedAt: now(), lastAction: `STAGE_CHANGED:${stage}`, updatedAt: now() }).where(eq(workerWorkItems.id, old.id));
    }
    if (items.length && unresolved === 0) {
      const org = await db.select().from(workerWorkItems).where(and(eq(workerWorkItems.scopeType, "PROJECT"), eq(workerWorkItems.scopeId, project.id), eq(workerWorkItems.stage, "ORGANIZACAO"))).limit(1);
      const orgDone = org[0]?.status === "COMPLETED";
      if (!orgDone) {
        await ensureWorkItem({ scopeType: "PROJECT", scopeId: project.id, projectId: project.id, projectDomain: domain, stage: "ORGANIZACAO", priority: project.queuePriority || 1, readyAt: project.updatedAt, originalReadyAt: project.originalReadyAt || project.createdAt, payload: { project_name: project.name, total_items: items.length, next: "EXPORTACAO" } });
        createdOrTouched += 1;
      } else if (project.automaticZip && !project.zipR2Key) {
        let [job] = await db.select().from(exportJobs).where(and(eq(exportJobs.projectId, project.id), inArray(exportJobs.status, ["READY", "PROCESSING"]))).orderBy(asc(exportJobs.createdAt)).limit(1);
        if (!job) {
          const jobId = makeId("EXPJOB"), createdAt = now();
          await db.insert(exportJobs).values({ id: jobId, projectId: project.id, projectDomain: domain, status: "READY", createdAt, updatedAt: createdAt });
          [job] = await db.select().from(exportJobs).where(eq(exportJobs.id, jobId)).limit(1);
        }
        if (job) await ensureWorkItem({ scopeType: "EXPORT_JOB", scopeId: job.id, projectId: project.id, projectDomain: domain, stage: "EXPORTACAO", priority: project.queuePriority || 1, readyAt: job.createdAt, originalReadyAt: job.createdAt, payload: { export_job_id: job.id, project_name: project.name, total_items: items.length, automatic_zip: true } });
        createdOrTouched += 1;
      } else if (project.zipR2Key) {
        const jobs = await db.select().from(exportJobs).where(eq(exportJobs.projectId, project.id));
        for (const job of jobs) if (["READY", "PROCESSING"].includes(job.status)) await db.update(exportJobs).set({ status: "COMPLETED", r2Key: project.zipR2Key, fileName: project.zipFileName, sizeBytes: project.zipSizeBytes, completedAt: project.updatedAt, updatedAt: project.updatedAt }).where(eq(exportJobs.id, job.id));
        const exportWork = await db.select().from(workerWorkItems).where(and(eq(workerWorkItems.projectId, project.id), eq(workerWorkItems.stage, "EXPORTACAO")));
        for (const work of exportWork) if (["READY", "WAITING_DEPENDENCY"].includes(work.status)) await db.update(workerWorkItems).set({ status: "SUPERSEDED", completedAt: project.updatedAt, lastAction: "ZIP_ALREADY_EXISTS", updatedAt: project.updatedAt }).where(eq(workerWorkItems.id, work.id));
      }
    }
  }
  return { projects_scanned: projects.length, work_units_touched: createdOrTouched };
}


export async function syncWorkerItemsQueue(projectId: string, itemIds: string[]) {
  const db = getDb();
  const keys = [...new Set(itemIds.map((value)=>String(value||"").trim()).filter(Boolean))].slice(0,50);
  if (!keys.length) return { project_id:projectId, items_scanned:0, work_units_touched:0 };
  const [project] = await db.select().from(automaticProjects).where(eq(automaticProjects.id, projectId)).limit(1);
  if (!project) throw new Error("PROJECT_NOT_FOUND");
  const items = await db.select().from(automaticProjectItems).where(and(eq(automaticProjectItems.projectId,projectId),eq(automaticProjectItems.version,project.activeVersion),or(inArray(automaticProjectItems.id,keys),inArray(automaticProjectItems.itemKey,keys))));
  let touched=0;
  for (const item of items) {
    const stage=stageForItemStatus(item.status);
    const stale=await db.select().from(workerWorkItems).where(and(eq(workerWorkItems.scopeType,"ITEM"),eq(workerWorkItems.scopeId,item.id)));
    if (!stage) {
      for (const old of stale) if (["READY","WAITING_DEPENDENCY"].includes(old.status)) await db.update(workerWorkItems).set({status:"SUPERSEDED",completedAt:now(),lastAction:`CANONICAL_STATUS:${item.status}`,updatedAt:now()}).where(eq(workerWorkItems.id,old.id));
      continue;
    }
    const domain=upper(item.itemDomain||project.projectDomain||"GENERAL","GENERAL");
    const stageReadyAt=item.stage!==stage ? now() : (item.stageReadyAt||item.updatedAt||item.createdAt);
    const originalReadyAt=item.originalReadyAt||item.createdAt;
    if (item.itemDomain!==domain||item.stage!==stage||!item.stageReadyAt||!item.originalReadyAt) await db.update(automaticProjectItems).set({itemDomain:domain,stage,stageReadyAt,originalReadyAt,updatedAt:item.updatedAt}).where(eq(automaticProjectItems.id,item.id));
    await ensureWorkItem({scopeType:"ITEM",scopeId:item.id,projectId,projectDomain:domain,itemId:item.id,stage,priority:Math.max(project.queuePriority||1,item.priority||1),readyAt:stageReadyAt,originalReadyAt,payload:{item_key:item.itemKey,target_file:item.targetFile,term:item.term,universe:item.universe,context:item.context,item_status:item.status}});
    for (const old of stale) if (old.stage!==stage&&["READY","WAITING_DEPENDENCY"].includes(old.status)) await db.update(workerWorkItems).set({status:"SUPERSEDED",completedAt:now(),lastAction:`STAGE_CHANGED:${stage}`,updatedAt:now()}).where(eq(workerWorkItems.id,old.id));
    touched+=1;
  }
  return { project_id:projectId, items_scanned:items.length, work_units_touched:touched };
}

export async function runWorkerWatchdog(options: { projectId?: string; source?: string } = {}) {
  const config = await getWorkerConfig();
  const db = getDb();
  const at = Date.now();
  const rows = options.projectId
    ? await db.select().from(workerWorkItems).where(and(eq(workerWorkItems.projectId, options.projectId), eq(workerWorkItems.status, "LEASED")))
    : await db.select().from(workerWorkItems).where(eq(workerWorkItems.status, "LEASED"));
  const expired = rows.filter((row) => row.leaseExpiresAt && row.leaseExpiresAt.getTime() < at);
  for (const row of expired) {
    const session = row.leaseExecutionId ? (await db.select().from(workerSessions).where(eq(workerSessions.executionId, row.leaseExecutionId)).limit(1))[0] : null;
    await db.update(workerWorkItems).set({ status: config.requeueExpired ? "READY" : "WAITING_DEPENDENCY", resumePriority: 1, leaseOwnerWorkerId: null, leaseExecutionId: null, leaseStartedAt: null, leaseLastSeenAt: null, leaseExpiresAt: null, lastAction: "ABANDONED_BY_LEASE", updatedAt: now() }).where(eq(workerWorkItems.id, row.id));
    if (session) await db.update(workerSessions).set({ status: "ABANDONADA", currentWorkItemId: null, lastAction: "LEASE_EXPIRED", stoppedAt: now(), updatedAt: now() }).where(eq(workerSessions.id, session.id));
    await recordWorkerEvent({ workerId: row.leaseOwnerWorkerId, workerType: session?.workerType, workerDomain: session?.workerDomain, executionId: row.leaseExecutionId, projectId: row.projectId, workItemId: row.id, stage: row.stage, eventType: "LEASE_EXPIRED", status: "ABANDONED_BY_LEASE", metadata: { source: options.source || "WATCHDOG", original_ready_at: row.originalReadyAt.toISOString() } });
    await recordWorkerEvent({ projectId: row.projectId, workItemId: row.id, stage: row.stage, eventType: "WORK_ITEM_REQUEUED", status: "READY", metadata: { preserve_original_queue_age: true } });
  }
  return { expired: expired.length, requeued: config.requeueExpired ? expired.length : 0, config };
}

async function capacityFor(workerType: string, workerDomain: string) {
  const db = getDb();
  const rows = await db.select().from(workerCapacityLimits).where(eq(workerCapacityLimits.workerType, workerType));
  return rows.find((row) => row.workerDomain === workerDomain && row.enabled) || rows.find((row) => row.workerDomain === "*" && row.enabled) || { maxWorkers: 3, maxPerProject: 3, workerDomain: "*" };
}

async function activeSessionCounts(workerType: string, workerDomain: string, configDomain: string) {
  const sessions = await getDb().select().from(workerSessions).where(and(eq(workerSessions.status, "ATIVO"), eq(workerSessions.workerType, workerType)));
  const filtered = configDomain === "*" ? sessions : sessions.filter((row) => row.workerDomain === workerDomain);
  return filtered;
}

export async function acquireNextWorkerWork(input: Record<string, unknown>) {
  const workerType = upper(input.worker_type);
  const workerId = String(input.worker_id || "").trim();
  const workerDomain = upper(input.worker_domain, "GENERAL");
  const executionId = String(input.execution_id || "").trim() || `EXEC-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
  const allowedDomains = Array.isArray(input.allowed_domains) ? (input.allowed_domains as unknown[]).map((value) => upper(value)).filter(Boolean) : [];
  const requestedProjectId = String(input.project_id || "").trim();
  if (!WORKER_STAGES[workerType]) throw new Error("WORKER_TYPE_INVALID");
  if (!workerId) throw new Error("WORKER_ID_REQUIRED");
  if (!workerDomain) throw new Error("WORKER_DOMAIN_REQUIRED");

  await runWorkerWatchdog({ projectId: requestedProjectId || undefined, source: "ASSUME_NEXT" });
  await syncWorkerQueue(requestedProjectId || undefined);
  const db = getDb();
  const existingSession = (await db.select().from(workerSessions).where(eq(workerSessions.executionId, executionId)).limit(1))[0];
  if (existingSession) {
    if (existingSession.workerId !== workerId || existingSession.workerType !== workerType) throw new Error("EXECUTION_ID_ALREADY_BOUND_TO_OTHER_WORKER");
    if (existingSession.currentWorkItemId) {
      const active = (await db.select().from(workerWorkItems).where(eq(workerWorkItems.id, existingSession.currentWorkItemId)).limit(1))[0];
      if (active && active.status === "LEASED" && active.leaseExecutionId === executionId && active.leaseExpiresAt && active.leaseExpiresAt.getTime() > Date.now()) {
        await renewWorkerLeaseByActivity(executionId, active.projectId, "ASSUME_IDEMPOTENT_REUSE");
        return workResponse(active, existingSession, true);
      }
    }
  }

  const capacity = await capacityFor(workerType, workerDomain);
  const activeSessions = await activeSessionCounts(workerType, workerDomain, String(capacity.workerDomain));
  if (activeSessions.length >= Number(capacity.maxWorkers || 3)) return { work_item_id: null, motivo: "WORKER_CAPACITY_REACHED", worker_type: workerType, worker_domain: workerDomain, active_workers: activeSessions.length, max_workers: capacity.maxWorkers };

  const stages = WORKER_STAGES[workerType];
  const config = await getWorkerConfig();
  let candidates = await db.select().from(workerWorkItems).where(and(eq(workerWorkItems.status, "READY"), inArray(workerWorkItems.stage, stages))).orderBy(desc(workerWorkItems.priority), desc(workerWorkItems.resumePriority), asc(workerWorkItems.originalReadyAt), asc(workerWorkItems.attempts), asc(workerWorkItems.id)).limit(500);
  if (requestedProjectId) candidates = candidates.filter((row) => row.projectId === requestedProjectId);
  candidates = candidates.filter((row) => domainAllowed(workerDomain, row.projectDomain, allowedDomains, config.fallbackBetweenDomains));
  if (!candidates.length) return { work_item_id: null, motivo: "NENHUM_TRABALHO_ELEGIVEL", worker_type: workerType, worker_domain: workerDomain, fallback_between_domains: config.fallbackBetweenDomains };
  const ttlMs = config.ttlMinutes * 60_000;
  for (const candidate of candidates) {
    const perProject = activeSessions.filter((session) => session.projectId === candidate.projectId).length;
    if (perProject >= Number(capacity.maxPerProject || 3)) continue; // fairness + limite por projeto
    const at = Date.now(), expires = at + ttlMs;
    const update = await env.DB.prepare(`UPDATE worker_work_items SET status='LEASED', lease_owner_worker_id=?, lease_execution_id=?, lease_started_at=?, lease_last_seen_at=?, lease_expires_at=?, attempts=attempts+1, last_action='WORK_ITEM_ASSIGNED', updated_at=? WHERE id=? AND status='READY' AND (lease_expires_at IS NULL OR lease_expires_at<?)`)
      .bind(workerId, executionId, at, at, expires, at, candidate.id, at).run();
    const changes = Number((update.meta as { changes?: number } | undefined)?.changes || 0);
    if (!changes) continue; // SKIP LOCKED / race perdida: procurar o próximo
    const sessionId = existingSession?.id || makeId("WSES");
    await env.DB.prepare(`INSERT INTO worker_sessions (id,worker_id,worker_type,worker_domain,allowed_domains,execution_id,status,current_work_item_id,project_id,stage,last_action,started_at,last_seen_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(execution_id) DO UPDATE SET worker_id=excluded.worker_id,worker_type=excluded.worker_type,worker_domain=excluded.worker_domain,allowed_domains=excluded.allowed_domains,status='ATIVO',current_work_item_id=excluded.current_work_item_id,project_id=excluded.project_id,stage=excluded.stage,last_action=excluded.last_action,last_seen_at=excluded.last_seen_at,stopped_at=NULL,updated_at=excluded.updated_at`)
      .bind(sessionId, workerId, workerType, workerDomain, JSON.stringify(allowedDomains), executionId, "ATIVO", candidate.id, candidate.projectId, candidate.stage, "WORK_ITEM_ASSIGNED", at, at, at).run();
    await getDb().update(automaticProjects).set({ lastAction: `${workerId} assumiu ${candidate.stage}`, updatedAt: now() }).where(eq(automaticProjects.id, candidate.projectId));
    if (candidate.scopeType === "EXPORT_JOB") await db.update(exportJobs).set({ status: "PROCESSING", updatedAt: new Date(at) }).where(eq(exportJobs.id, candidate.scopeId));
    if (candidate.resumePriority > 0) await db.update(projectRuns).set({ resumes: sql`${projectRuns.resumes} + 1`, updatedAt: new Date(at) }).where(and(eq(projectRuns.projectId, candidate.projectId), eq(projectRuns.status, "ATIVO")));
    await recordWorkerEvent({ workerId, workerType, workerDomain, executionId, projectId: candidate.projectId, workItemId: candidate.id, stage: candidate.stage, eventType: "WORK_ITEM_ASSIGNED", status: "LEASED", metadata: { lease_expires_at: new Date(expires).toISOString(), fifo: true, skip_locked: true, resumed: candidate.resumePriority > 0 } });
    await recordWorkerEvent({ workerId, workerType, workerDomain, executionId, projectId: candidate.projectId, workItemId: candidate.id, stage: candidate.stage, eventType: "LEASE_ACQUIRED", status: "ATIVO", metadata: { ttl_minutes: config.ttlMinutes } });
    const leased = (await db.select().from(workerWorkItems).where(eq(workerWorkItems.id, candidate.id)).limit(1))[0];
    const session = (await db.select().from(workerSessions).where(eq(workerSessions.executionId, executionId)).limit(1))[0];
    return workResponse(leased, session, false);
  }
  return { work_item_id: null, motivo: "NENHUM_TRABALHO_ELEGIVEL_APOS_SKIP_LOCKED_OU_LIMITES", worker_type: workerType, worker_domain: workerDomain };
}

function workResponse(work: typeof workerWorkItems.$inferSelect, session: typeof workerSessions.$inferSelect, reused: boolean) {
  return {
    work_item_id: work.id, project_id: work.projectId, project_domain: work.projectDomain, item_id: work.itemId,
    stage: work.stage, worker_id: session.workerId, worker_type: session.workerType, worker_domain: session.workerDomain,
    execution_id: session.executionId, lease_expires_at: work.leaseExpiresAt?.toISOString() || null,
    original_ready_at: work.originalReadyAt.toISOString(), ready_at: work.readyAt.toISOString(), attempts: work.attempts,
    payload: parseJson<Record<string, unknown>>(work.payloadJson, {}), next_action: work.stage, idempotent_reuse: reused,
  };
}

export async function renewWorkerLeaseByActivity(executionId: string, projectId?: string, action = "MCP_ACTIVITY") {
  if (!executionId) return { matched: false, renewed: false, reason: "NO_EXECUTION_ID" };
  const config = await getWorkerConfig();
  const db = getDb();
  const session = (await db.select().from(workerSessions).where(eq(workerSessions.executionId, executionId)).limit(1))[0];
  if (!session || session.status !== "ATIVO" || !session.currentWorkItemId) return { matched: false, renewed: false, reason: "NO_ACTIVE_WORKER_SESSION" };
  const work = (await db.select().from(workerWorkItems).where(eq(workerWorkItems.id, session.currentWorkItemId)).limit(1))[0];
  if (!work || work.status !== "LEASED" || work.leaseExecutionId !== executionId) return { matched: true, renewed: false, reason: "WORK_ITEM_REASSIGNED" };
  if (projectId && work.projectId !== projectId) return { matched: true, renewed: false, reason: "WORK_ITEM_PROJECT_MISMATCH" };
  if (!actionAllowedForStage(work.stage, action)) throw new Error(`WORKER_STAGE_NOT_ALLOWED:${work.stage}:${action}`);
  const at = Date.now();
  if (!work.leaseExpiresAt || work.leaseExpiresAt.getTime() < at) {
    await runWorkerWatchdog({ projectId: work.projectId, source: "ACTIVITY_RENEWAL" });
    throw new Error("WORK_ITEM_REASSIGNED");
  }
  const expires = at + config.ttlMinutes * 60_000;
  const result = await env.DB.prepare(`UPDATE worker_work_items SET lease_last_seen_at=?,lease_expires_at=?,last_action=?,updated_at=? WHERE id=? AND lease_execution_id=? AND status='LEASED' AND lease_expires_at>=?`).bind(at, expires, action, at, work.id, executionId, at).run();
  const changes = Number((result.meta as { changes?: number } | undefined)?.changes || 0);
  if (!changes) throw new Error("WORK_ITEM_REASSIGNED");
  await db.update(workerSessions).set({ lastSeenAt: new Date(at), lastAction: action, updatedAt: new Date(at) }).where(eq(workerSessions.id, session.id));
  await db.update(automaticProjects).set({ lastAction: `${session.workerId}: ${action}`, updatedAt: new Date(at) }).where(eq(automaticProjects.id, work.projectId));
  await recordWorkerEvent({ workerId: session.workerId, workerType: session.workerType, workerDomain: session.workerDomain, executionId, projectId: work.projectId, workItemId: work.id, stage: work.stage, eventType: "LEASE_RENEWED", status: "ATIVO", metadata: { action, lease_expires_at: new Date(expires).toISOString() } });
  return { matched: true, renewed: true, work_item_id: work.id, project_id: work.projectId, lease_expires_at: new Date(expires).toISOString() };
}

export async function requireWorkerLeaseForWrite(projectId: string, executionId: string | undefined, action: string) {
  if (!executionId) return { matched: false, renewed: false, reason: "NO_EXECUTION_ID" };
  const result = await renewWorkerLeaseByActivity(executionId, projectId, action);
  if (!result.matched) return result;
  if (!result.renewed) throw new Error(String(result.reason || "LEASE_NOT_OWNED"));
  return result;
}

export async function completeWorkerWork(input: Record<string, unknown>) {
  const workItemId = String(input.work_item_id || "").trim();
  const workerId = String(input.worker_id || "").trim();
  const executionId = String(input.execution_id || "").trim();
  const resultText = upper(input.resultado || input.result || "CONCLUIDO", "CONCLUIDO");
  if (!workItemId || !workerId || !executionId) throw new Error("WORKER_ID_EXECUTION_ID_WORK_ITEM_REQUIRED");
  const db = getDb();
  const work = (await db.select().from(workerWorkItems).where(eq(workerWorkItems.id, workItemId)).limit(1))[0];
  if (!work) throw new Error("WORK_ITEM_NOT_FOUND");
  if (work.status === "COMPLETED") return { work_item_id: work.id, status: "COMPLETED", idempotent_reuse: true };
  if (work.leaseOwnerWorkerId !== workerId || work.leaseExecutionId !== executionId) throw new Error("WORK_ITEM_REASSIGNED");
  const completedAt = now();
  const durationMs = work.leaseStartedAt ? Math.max(0, completedAt.getTime() - work.leaseStartedAt.getTime()) : 0;
  const queueWaitMs = work.leaseStartedAt ? Math.max(0, work.leaseStartedAt.getTime() - work.readyAt.getTime()) : 0;
  const sessionBeforeComplete = (await db.select().from(workerSessions).where(eq(workerSessions.executionId, executionId)).limit(1))[0];
  const completeWork = db.update(workerWorkItems).set({ status: "COMPLETED", completedAt, resumePriority: 0, leaseOwnerWorkerId: null, leaseExecutionId: null, leaseStartedAt: null, leaseLastSeenAt: null, leaseExpiresAt: null, lastAction: `COMPLETED:${resultText}`, updatedAt: completedAt }).where(eq(workerWorkItems.id, work.id));
  const releaseSession = db.update(workerSessions).set({ status: "LIVRE", currentWorkItemId: null, projectId: null, stage: null, lastAction: `COMPLETED:${resultText}`, lastSeenAt: completedAt, updatedAt: completedAt }).where(eq(workerSessions.executionId, executionId));
  const insertMetric = db.insert(stageMetrics).values({ id: makeId("SMET"), projectId: work.projectId, projectDomain: work.projectDomain, workerId, workerType: sessionBeforeComplete?.workerType || work.workerType, workItemId: work.id, stage: work.stage, result: resultText, durationMs, queueWaitMs, attempts: work.attempts, startedAt: work.leaseStartedAt, completedAt, createdAt: completedAt });
  if (work.scopeType === "EXPORT_JOB") {
    const completeExport = db.update(exportJobs).set({ status: "COMPLETED", completedAt, updatedAt: completedAt }).where(eq(exportJobs.id, work.scopeId));
    await db.batch([completeWork, releaseSession, insertMetric, completeExport]);
  } else {
    await db.batch([completeWork, releaseSession, insertMetric]);
  }
  await recordWorkerEvent({ workerId, executionId, projectId: work.projectId, workItemId: work.id, stage: work.stage, eventType: "WORK_ITEM_COMPLETED", status: resultText, durationMs, metadata: { result_payload: input.resultado_detalhado || null } });
  await db.update(automaticProjects).set({ lastAction: `${workerId} concluiu ${work.stage}`, updatedAt: completedAt }).where(eq(automaticProjects.id, work.projectId));
  await syncWorkerQueue(work.projectId);
  return { work_item_id: work.id, project_id: work.projectId, stage: work.stage, status: "COMPLETED", resultado: resultText, duration_ms: durationMs, next_queue_synced: true };
}

export async function failWorkerWork(input: Record<string, unknown>) {
  const workItemId = String(input.work_item_id || "").trim();
  const workerId = String(input.worker_id || "").trim();
  const executionId = String(input.execution_id || "").trim();
  const failure = upper(input.tipo_falha || input.failure_type || "RETRYABLE", "RETRYABLE");
  const reason = String(input.motivo || "").trim();
  if (!workItemId || !workerId || !executionId) throw new Error("WORKER_ID_EXECUTION_ID_WORK_ITEM_REQUIRED");
  if (!["ERRO_REAL", "RETRYABLE", "RELINK_REQUIRED", "WAITING_DEPENDENCY", "ABANDONED_BY_LEASE"].includes(failure)) throw new Error("WORKER_FAILURE_TYPE_INVALID");
  const db = getDb();
  const work = (await db.select().from(workerWorkItems).where(eq(workerWorkItems.id, workItemId)).limit(1))[0];
  if (!work) throw new Error("WORK_ITEM_NOT_FOUND");
  if (work.leaseOwnerWorkerId !== workerId || work.leaseExecutionId !== executionId) throw new Error("WORK_ITEM_REASSIGNED");
  const nextStatus = failure === "ERRO_REAL" ? "ERROR_REAL" : failure === "WAITING_DEPENDENCY" ? "WAITING_DEPENDENCY" : "READY";
  const resumePriority = failure === "ABANDONED_BY_LEASE" || failure === "RETRYABLE" ? 1 : work.resumePriority;
  await db.update(workerWorkItems).set({ status: nextStatus, resumePriority, leaseOwnerWorkerId: null, leaseExecutionId: null, leaseStartedAt: null, leaseLastSeenAt: null, leaseExpiresAt: null, lastAction: `${failure}:${reason}`, updatedAt: now() }).where(eq(workerWorkItems.id, work.id));
  await db.update(workerSessions).set({ status: failure === "ERRO_REAL" ? "ERRO" : "LIVRE", currentWorkItemId: null, projectId: null, stage: null, lastAction: failure, lastSeenAt: now(), updatedAt: now() }).where(eq(workerSessions.executionId, executionId));
  if (work.itemId && failure === "RELINK_REQUIRED") await db.update(automaticProjectItems).set({ status: "RELINK_REQUIRED", failureReason: reason || "WORKER_RELINK_REQUIRED", stage: "RELINK", stageReadyAt: now(), updatedAt: now() }).where(eq(automaticProjectItems.id, work.itemId));
  if (work.itemId && failure === "ERRO_REAL") await db.update(automaticProjectItems).set({ status: "FAILED", failureReason: reason || "WORKER_ERROR_REAL", updatedAt: now() }).where(eq(automaticProjectItems.id, work.itemId));
  if (work.scopeType === "EXPORT_JOB") await db.update(exportJobs).set({ status: failure === "ERRO_REAL" ? "FAILED" : failure === "WAITING_DEPENDENCY" ? "WAITING_DEPENDENCY" : "READY", updatedAt: now() }).where(eq(exportJobs.id, work.scopeId));
  if (failure === "RETRYABLE" || failure === "ABANDONED_BY_LEASE") await db.update(projectRuns).set({ retries: sql`${projectRuns.retries} + 1`, updatedAt: now() }).where(and(eq(projectRuns.projectId, work.projectId), eq(projectRuns.status, "ATIVO")));
  if (failure === "RELINK_REQUIRED") await db.update(projectRuns).set({ relinks: sql`${projectRuns.relinks} + 1`, updatedAt: now() }).where(and(eq(projectRuns.projectId, work.projectId), eq(projectRuns.status, "ATIVO")));
  await recordWorkerEvent({ workerId, executionId, projectId: work.projectId, workItemId: work.id, stage: work.stage, eventType: "WORK_ITEM_FAILED", status: failure, metadata: { reason, requeued: nextStatus === "READY", original_ready_at: work.originalReadyAt.toISOString() } });
  return { work_item_id: work.id, project_id: work.projectId, failure_type: failure, queue_status: nextStatus, preserved_original_ready_at: true };
}

export async function configureWorkerCapacity(input: Record<string, unknown>) {
  const workerType = upper(input.worker_type);
  const workerDomain = upper(input.worker_domain || "*", "*");
  if (!WORKER_STAGES[workerType]) throw new Error("WORKER_TYPE_INVALID");
  const maxWorkers = clamp(Number(input.max_workers) || 3, 1, 100);
  const maxPerProject = clamp(Number(input.max_per_project) || maxWorkers, 1, 100);
  const id = `LIMIT-${workerType}-${workerDomain}`;
  const date = now();
  await getDb().insert(workerCapacityLimits).values({ id, workerType, workerDomain, maxWorkers, maxPerProject, enabled: input.enabled !== false, updatedAt: date }).onConflictDoUpdate({ target: workerCapacityLimits.id, set: { maxWorkers, maxPerProject, enabled: input.enabled !== false, updatedAt: date } });
  return { id, worker_type: workerType, worker_domain: workerDomain, max_workers: maxWorkers, max_per_project: maxPerProject, enabled: input.enabled !== false };
}

export async function setProjectDomain(input: Record<string, unknown>) {
  const projectId = String(input.projeto_id || input.project_id || "").trim();
  const domain = upper(input.project_domain || input.dominio || "GENERAL", "GENERAL");
  if (!projectId) throw new Error("PROJECT_ID_REQUIRED");
  const db = getDb();
  const [project] = await db.select().from(automaticProjects).where(eq(automaticProjects.id, projectId)).limit(1);
  if (!project) throw new Error("PROJECT_NOT_FOUND");
  await db.update(automaticProjects).set({ projectDomain: domain, lastAction: `DOMAIN:${domain}`, updatedAt: now() }).where(eq(automaticProjects.id, projectId));
  await db.update(automaticProjectItems).set({ itemDomain: domain, updatedAt: now() }).where(and(eq(automaticProjectItems.projectId, projectId), sql`${automaticProjectItems.itemDomain} IS NULL OR ${automaticProjectItems.itemDomain} = '' OR ${automaticProjectItems.itemDomain} = ${project.projectDomain}`));
  await db.update(workerWorkItems).set({ projectDomain: domain, updatedAt: now() }).where(eq(workerWorkItems.projectId, projectId));
  await recordWorkerEvent({ projectId, eventType: "PROJECT_DOMAIN_CHANGED", status: domain, metadata: { previous_domain: project.projectDomain } });
  return { projeto_id: projectId, project_domain: domain };
}

function percentile(values: number[], p: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a,b)=>a-b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] || 0;
}

export async function getOperationalDashboard(options: { snapshot?: boolean } = {}) {
  // V56: dashboard é READ puro. Watchdog/sync possuem ferramentas/jobs próprios e nunca rodam escondidos aqui.
  const db = getDb(), at = Date.now();
  const [sessions, ready, leasedRows, waiting, projects, limits, activePlans, activeBranches] = await Promise.all([
    db.select().from(workerSessions).where(eq(workerSessions.status, "ATIVO")).orderBy(desc(workerSessions.updatedAt)).limit(500),
    db.select().from(workerWorkItems).where(eq(workerWorkItems.status, "READY")).orderBy(asc(workerWorkItems.originalReadyAt)).limit(3000),
    db.select().from(workerWorkItems).where(eq(workerWorkItems.status, "LEASED")).orderBy(asc(workerWorkItems.leaseExpiresAt)).limit(1000),
    db.select().from(workerWorkItems).where(eq(workerWorkItems.status, "WAITING_DEPENDENCY")).orderBy(asc(workerWorkItems.originalReadyAt)).limit(1000),
    db.select().from(automaticProjects).orderBy(desc(automaticProjects.updatedAt)).limit(500),
    db.select().from(workerCapacityLimits),
    db.select().from(supervisorPlans).where(inArray(supervisorPlans.status,["ACCEPTED","DISPATCHING","RUNNING","WAITING_SUPERVISOR","PAUSED"])).orderBy(desc(supervisorPlans.updatedAt)).limit(200),
    db.select().from(planBranches).where(inArray(planBranches.status,["READY","RUNNING","WAITING_SUPERVISOR","WAITING_DEPENDENCY","PAUSED"])).orderBy(desc(planBranches.priority),asc(planBranches.originalReadyAt)).limit(3000),
  ]);
  let recentEvents: Array<{ eventType: string }> = [];
  const telemetryWarnings: string[] = [];
  try {
    recentEvents = await db.select({ eventType: workerEvents.eventType })
      .from(workerEvents)
      .where(gte(workerEvents.createdAt, new Date(at-60*60_000)))
      .orderBy(desc(workerEvents.createdAt))
      .limit(2000);
  } catch {
    // Telemetria histórica nunca deve derrubar a sala de controle. Filas/workers continuam sendo fonte operacional.
    telemetryWarnings.push("WORKER_EVENTS_UNAVAILABLE");
  }
  const leased = leasedRows.filter((w)=>w.leaseExpiresAt && w.leaseExpiresAt.getTime()>at);
  const active = sessions.filter((s)=>s.currentWorkItemId);
  const group = (rows: Array<{ [key: string]: unknown }>, key: string) => rows.reduce<Record<string, number>>((acc, row) => { const value = String(row[key] || "SEM_VALOR"); acc[value] = (acc[value] || 0) + 1; return acc; }, {});
  const queuesByStage = group(ready as unknown as Array<{[key:string]:unknown}>, "stage");
  const queuesByDomain = group(ready as unknown as Array<{[key:string]:unknown}>, "projectDomain");
  const activeByType = group(active as unknown as Array<{[key:string]:unknown}>, "workerType");
  const activeByDomain = group(active as unknown as Array<{[key:string]:unknown}>, "workerDomain");
  const workById = new Map([...ready,...leased,...waiting].map((work)=>[work.id,work]));
  const projectById = new Map(projects.map((project)=>[project.id,project]));
  const workers = active.map((session) => {
    const work = session.currentWorkItemId ? workById.get(session.currentWorkItemId) : undefined;
    const project = session.projectId ? projectById.get(session.projectId) : undefined;
    return { worker_id: session.workerId, worker_type: session.workerType, worker_domain: session.workerDomain, execution_id: session.executionId, project_id: session.projectId, project_name: project?.name || null, stage: session.stage, work_item_id: session.currentWorkItemId, item_id: work?.itemId || null, last_action: session.lastAction, last_heartbeat: session.lastSeenAt, time_in_stage_ms: work?.leaseStartedAt ? Math.max(0, at-work.leaseStartedAt.getTime()) : 0, lease_remaining_ms: work?.leaseExpiresAt ? Math.max(0, work.leaseExpiresAt.getTime()-at) : 0, status: session.status };
  });
  const projectsView = projects.filter((p)=>!TERMINAL_PROJECTS.has(p.status)).map((project)=>{
    const projectReady = ready.filter((w)=>w.projectId===project.id);
    const projectWorkers = workers.filter((w)=>w.project_id===project.id);
    return { project_id:project.id,name:project.name,domain:project.projectDomain,status:project.pipelineStatus||project.status,state_version:project.stateVersion,next_action:project.nextAction,last_action:project.lastAction,workers_active:projectWorkers.length,workers_by_stage:projectWorkers.reduce<Record<string,number>>((a,w)=>{const k=String(w.stage||"SEM_ETAPA");a[k]=(a[k]||0)+1;return a;},{}),queue_by_stage:projectReady.reduce<Record<string,number>>((a,w)=>{a[w.stage]=(a[w.stage]||0)+1;return a;},{}),progress:{completed:Math.max(0,project.totalItems-project.pendingCount),total:project.totalItems},counts:{collecting:project.collectingCount,materializing:project.materializingCount,waiting_qa:project.waitingQaCount,relink:project.relinkCount,technical:project.technicalCount,waiting_seed:project.waitingSeedCount,failed:project.failedCount},total_time_ms:Math.max(0,at-project.createdAt.getTime()),last_activity:project.updatedAt };
  });
  const domains=[...new Set(projects.map((p)=>p.projectDomain||"GENERAL"))].map((domain)=>({domain,active_projects:projectsView.filter((p)=>p.domain===domain).length,active_workers:workers.filter((w)=>w.worker_domain===domain).length,queue:Object.fromEntries(Object.keys(queuesByStage).map((stage)=>[stage,ready.filter((w)=>w.projectDomain===domain&&w.stage===stage).length]))}));
  const completedHour=recentEvents.filter((e)=>e.eventType==="WORK_ITEM_COMPLETED").length;
  const utilization=limits.map((limit)=>{const count=active.filter((s)=>s.workerType===limit.workerType&&(limit.workerDomain==="*"||s.workerDomain===limit.workerDomain)).length;return {worker_type:limit.workerType,domain:limit.workerDomain,active:count,max:limit.maxWorkers,utilization_pct:Math.round(count/Math.max(1,limit.maxWorkers)*100)};});
  const bottlenecks=Object.entries(queuesByStage).map(([stage,count])=>({stage,count,active:workers.filter((w)=>w.stage===stage).length})).sort((a,b)=>b.count-a.count).slice(0,5);
  const planViews=activePlans.map((plan)=>{const branches=activeBranches.filter((branch)=>branch.planId===plan.id);const byStatus=branches.reduce<Record<string,number>>((acc,row)=>{acc[row.status]=(acc[row.status]||0)+1;return acc;},{});return{plan_id:plan.id,project_id:plan.projectId,intent:plan.intent,status:plan.status,max_parallelism:plan.maxParallelism,branches_active:branches.length,branches_by_status:byStatus,accepted_at:plan.acceptedAt,updated_at:plan.updatedAt};});
  const executableReady=ready.filter((row)=>row.scopeType==="ITEM"&&Boolean(row.itemId)&&["COLETA","MATERIALIZACAO","RELINK"].includes(row.stage));
  const internalActive=active.filter((row)=>String(row.workerId||"").startsWith("INTERNAL-")).length;
  const dispatcherState=executableReady.length>0&&internalActive===0?"STARVED_READY_WITHOUT_CONSUMER":internalActive>0?"RUNNING":"IDLE";
  return {generated_at:new Date(at).toISOString(),read_only_snapshot:true,telemetry_warnings:telemetryWarnings,dispatcher:{state:dispatcherState,executable_ready:executableReady.length,internal_workers_active:internalActive,self_healing:true,wake_on_mcp_mutation:true,wake_on_cron:false,wake_on_mcp_scheduler:true},totals:{workers_active:active.length,queue_ready:ready.length,queue_leased:leased.length,queue_waiting_dependency:waiting.length,projects_in_progress:projectsView.length,projects_ready_resume:projects.filter((p)=>p.pipelineStatus==="PRONTO_PARA_RETOMADA").length,projects_completed:projects.filter((p)=>COMPLETED_PROJECTS.has(p.status)).length,throughput_last_hour:completedHour,plans_active:activePlans.length,plan_branches_active:activeBranches.length,plan_branches_waiting_supervisor:activeBranches.filter((b)=>b.status==="WAITING_SUPERVISOR").length},workers_active_by_type:activeByType,workers_active_by_domain:activeByDomain,queues_by_stage:queuesByStage,queues_by_domain:queuesByDomain,bottlenecks,utilization,workers,projects:projectsView,domains,plans:planViews};
}

export async function getManagementDashboard(days = 30) {
  const periodDays = clamp(days, 1, 365);
  const db = getDb();
  const since = Date.now() - periodDays*24*60*60_000;
  const [projects, metrics, events, snapshots] = await Promise.all([
    db.select().from(automaticProjects).orderBy(desc(automaticProjects.createdAt)).limit(5000),
    db.select().from(stageMetrics).orderBy(desc(stageMetrics.completedAt)).limit(10000),
    db.select({ workerId: workerEvents.workerId, workerDomain: workerEvents.workerDomain, eventType: workerEvents.eventType, status: workerEvents.status, durationMs: workerEvents.durationMs, createdAt: workerEvents.createdAt }).from(workerEvents).orderBy(desc(workerEvents.createdAt)).limit(10000),
    db.select().from(queueSnapshots).orderBy(desc(queueSnapshots.capturedAt)).limit(5000),
  ]);
  const recentProjects = projects.filter((p)=>p.createdAt.getTime()>=since);
  const recentMetrics = metrics.filter((m)=>m.completedAt.getTime()>=since);
  const recentEvents = events.filter((e)=>e.createdAt.getTime()>=since);
  const stages = [...new Set(recentMetrics.map((m)=>m.stage))];
  const stageStats = stages.map((stage)=>{
    const rows=recentMetrics.filter((m)=>m.stage===stage), durations=rows.map((m)=>m.durationMs), waits=rows.map((m)=>m.queueWaitMs);
    return { stage, count:rows.length, avg_ms:durations.length?Math.round(durations.reduce((a,b)=>a+b,0)/durations.length):0, p50_ms:percentile(durations,.5), p95_ms:percentile(durations,.95), p99_ms:percentile(durations,.99), min_ms:durations.length?Math.min(...durations):0, max_ms:durations.length?Math.max(...durations):0, avg_queue_wait_ms:waits.length?Math.round(waits.reduce((a,b)=>a+b,0)/waits.length):0 };
  });
  const domains=[...new Set(recentProjects.map((p)=>p.projectDomain||"GENERAL"))].map((domain)=>({ domain, projects_created:recentProjects.filter((p)=>(p.projectDomain||"GENERAL")===domain).length, projects_completed:recentProjects.filter((p)=>(p.projectDomain||"GENERAL")===domain&&COMPLETED_PROJECTS.has(p.status)).length, work_completed:recentMetrics.filter((m)=>m.projectDomain===domain).length, relinks:recentEvents.filter((e)=>e.workerDomain===domain&&e.status==="RELINK_REQUIRED").length, abandons:recentEvents.filter((e)=>e.workerDomain===domain&&e.eventType==="LEASE_EXPIRED").length }));
  const workers=[...new Set(recentEvents.map((e)=>e.workerId).filter(Boolean))].map((workerId)=>{const rows=recentEvents.filter((e)=>e.workerId===workerId); const completed=rows.filter((e)=>e.eventType==="WORK_ITEM_COMPLETED"); return {worker_id:workerId, completed:completed.length, failures:rows.filter((e)=>e.eventType==="WORK_ITEM_FAILED").length, abandons:rows.filter((e)=>e.eventType==="LEASE_EXPIRED").length, avg_duration_ms:completed.length?Math.round(completed.reduce((a,e)=>a+(e.durationMs||0),0)/completed.length):0};}).sort((a,b)=>b.completed-a.completed);
  const dayBuckets:Record<string,{completed:number,failed:number}>={};
  for(const e of recentEvents){const day=e.createdAt.toISOString().slice(0,10); dayBuckets[day] ||= {completed:0,failed:0}; if(e.eventType==="WORK_ITEM_COMPLETED")dayBuckets[day].completed++; if(e.eventType==="WORK_ITEM_FAILED")dayBuckets[day].failed++;}
  return { generated_at:new Date().toISOString(), period_days:periodDays, totals:{ projects_created:recentProjects.length, projects_completed:recentProjects.filter((p)=>COMPLETED_PROJECTS.has(p.status)).length, projects_in_progress:recentProjects.filter((p)=>!TERMINAL_PROJECTS.has(p.status)).length, work_completed:recentMetrics.length, relinks:recentEvents.filter((e)=>e.status==="RELINK_REQUIRED").length, lease_abandons:recentEvents.filter((e)=>e.eventType==="LEASE_EXPIRED").length, resumes:recentEvents.filter((e)=>e.eventType==="WORK_ITEM_REQUEUED").length }, stage_metrics:stageStats, domains, workers:workers.slice(0,50), throughput_by_day:Object.entries(dayBuckets).sort(([a],[b])=>a.localeCompare(b)).map(([day,value])=>({day,...value})), queue_history:snapshots.filter((s)=>s.capturedAt.getTime()>=since).slice(0,1000) };
}

export async function exportOperationsText(view: "operational" | "management" = "operational") {
  const data = view === "management" ? await getManagementDashboard(30) : await getOperationalDashboard({ snapshot:false });
  return { view, generated_at:new Date().toISOString(), conteudo_txt:JSON.stringify(data,null,2) };
}
