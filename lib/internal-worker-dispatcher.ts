import { env } from "./platform/runtime";
import { and, asc, desc, eq, inArray, like, or } from "drizzle-orm";
import { getDb } from "../db";
import {
  automaticProjectItems,
  automaticProjects,
  collectionTerms,
  planBranches,
  settings,
  stageMetrics,
  supervisorPlans,
  workerCapacityLimits,
  workerEvents,
  workerSessions,
  workerWorkItems,
} from "../db/schema";
import { processAutomaticProject } from "./automatic-projects";
import { getWorkerConfig, runWorkerWatchdog, syncWorkerQueue } from "./worker-orchestration";

const now = () => new Date();
const makeId = (prefix: string) => `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
const upper = (value: unknown, fallback = "") => String(value ?? fallback).trim().toUpperCase();
const clamp = (value: unknown, fallback: number, min: number, max: number) => Math.max(min, Math.min(max, Number.isFinite(Number(value)) ? Number(value) : fallback));
const parse = <T,>(value: string | null | undefined, fallback: T): T => { try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; } };

const RESOLVED = new Set(["APPROVED", "FROZEN", "LINKED_FROM_LIBRARY", "LINKED_FROM_FAMILY"]);
const WAITING = new Set(["WAITING_FAMILY_SEED", "WAITING_DEPENDENCY", "PAUSED_BY_SUPERVISOR", "CANCELLED", "CANCELED"]);
const INTERNAL_STAGES = new Set(["COLETA", "MATERIALIZACAO", "RELINK"]);

function stageForStatus(status: string) {
  if (RESOLVED.has(status) || WAITING.has(status) || status === "FAILED" || status === "ERROR_REAL") return null;
  if (["QUEUED", "PARSING", "SEARCHING_EXTERNALLY", "SEARCHING_LIBRARY", "COLLECTING", "WAITING_LIBRARY", "WAITING_EXTERNAL_SEARCH", "DISCOVERED", "PENDING"].includes(status)) return "COLETA";
  if (["READY_FOR_MATERIALIZATION", "MATERIALIZATION_PENDING", "MATERIALIZING"].includes(status)) return "MATERIALIZACAO";
  if (["QA_READY", "READY_FOR_VISUAL_QA", "WAITING_VISUAL_QA"].includes(status)) return "QA";
  if (status === "RELINK_REQUIRED") return "RELINK";
  if (["TECHNICAL_CORRECTION_REQUIRED", "CORRECAO_TECNICA_PERMITIDA"].includes(status)) return "CORRECAO_TECNICA";
  return "COLETA";
}

async function settingNumber(key: string, fallback: number, min: number, max: number) {
  const [row] = await getDb().select().from(settings).where(eq(settings.key, key)).limit(1);
  return clamp(row?.value, fallback, min, max);
}

async function settingBoolean(key: string, fallback: boolean) {
  const [row] = await getDb().select().from(settings).where(eq(settings.key, key)).limit(1);
  if (!row) return fallback;
  return String(row.value).trim().toLowerCase() !== "false";
}

async function recordEvent(input: {
  workerId?: string | null; workerType?: string | null; workerDomain?: string | null; executionId?: string | null;
  projectId?: string | null; workItemId?: string | null; stage?: string | null; eventType: string; status?: string | null;
  durationMs?: number | null; metadata?: Record<string, unknown>;
}) {
  await getDb().insert(workerEvents).values({
    id: makeId("WEVT"), workerId: input.workerId || null, workerType: input.workerType || null, workerDomain: input.workerDomain || null,
    executionId: input.executionId || null, projectId: input.projectId || null, workItemId: input.workItemId || null, stage: input.stage || null,
    eventType: input.eventType, status: input.status || null, durationMs: input.durationMs ?? null,
    metadataJson: JSON.stringify(input.metadata || {}), createdAt: now(),
  });
}

type Claim = {
  work: typeof workerWorkItems.$inferSelect;
  workerId: string;
  executionId: string;
  sessionId: string;
  branchId: string | null;
  claimedAt: Date;
};

async function branchForWork(work: typeof workerWorkItems.$inferSelect) {
  if (!work.itemId) return null;
  const rows = await getDb().select().from(planBranches)
    .where(and(eq(planBranches.projectId, work.projectId), eq(planBranches.itemId, work.itemId), inArray(planBranches.status, ["READY", "RUNNING", "WAITING_SUPERVISOR"])))
    .orderBy(desc(planBranches.priority), desc(planBranches.updatedAt)).limit(5);
  return rows.find((row) => row.stage === work.stage) || rows[0] || null;
}

async function relinkCanRun(work: typeof workerWorkItems.$inferSelect) {
  if (work.stage !== "RELINK" || !work.itemId) return true;
  const branch = await branchForWork(work);
  if (branch?.status === "WAITING_SUPERVISOR") return false;
  const [item] = await getDb().select().from(automaticProjectItems).where(eq(automaticProjectItems.id, work.itemId)).limit(1);
  if (!item) return false;
  const state = parse<Record<string, unknown>>(item.strategyState, {});
  const current = state.current_strategy && typeof state.current_strategy === "object" ? state.current_strategy as Record<string, unknown> : {};
  const queries = Array.isArray(current.queries) ? current.queries.map(String).map((value) => value.trim()).filter(Boolean) : [];
  const preferred = Array.isArray(current.preferred_sources) ? current.preferred_sources.map(String).filter(Boolean) : [];
  return Boolean(branch?.status === "READY" || branch?.status === "RUNNING" || queries.length || preferred.length);
}

async function activeInternalCounts() {
  const rows = await getDb().select().from(workerSessions).where(and(eq(workerSessions.status, "ATIVO"), like(workerSessions.workerId, "INTERNAL-%")));
  const byType = new Map<string, number>();
  const byProject = new Map<string, number>();
  const totalByProject = new Map<string, number>();
  for (const row of rows) {
    byType.set(row.workerType, (byType.get(row.workerType) || 0) + 1);
    if (row.projectId) {
      byProject.set(`${row.workerType}:${row.projectId}`, (byProject.get(`${row.workerType}:${row.projectId}`) || 0) + 1);
      totalByProject.set(row.projectId, (totalByProject.get(row.projectId) || 0) + 1);
    }
  }
  return { rows, byType, byProject, totalByProject };
}

async function capacityMap() {
  const rows = await getDb().select().from(workerCapacityLimits).where(eq(workerCapacityLimits.enabled, true));
  return rows;
}

function limitFor(rows: Array<typeof workerCapacityLimits.$inferSelect>, workerType: string, domain: string) {
  return rows.find((row) => row.workerType === workerType && row.workerDomain === domain)
    || rows.find((row) => row.workerType === workerType && row.workerDomain === "*")
    || { maxWorkers: 3, maxPerProject: 3 };
}

async function activePlanParallelism(projectId: string) {
  const [plan] = await getDb().select({ maxParallelism: supervisorPlans.maxParallelism }).from(supervisorPlans)
    .where(and(eq(supervisorPlans.projectId, projectId), inArray(supervisorPlans.status, ["ACCEPTED", "DISPATCHING", "RUNNING"])))
    .orderBy(desc(supervisorPlans.updatedAt)).limit(1);
  return Math.max(1, Number(plan?.maxParallelism || 8));
}

async function claimInternalWork(work: typeof workerWorkItems.$inferSelect, workerOrdinal: number): Promise<Claim | null> {
  const config = await getWorkerConfig();
  const at = Date.now();
  const expires = at + config.ttlMinutes * 60_000;
  const workerId = `INTERNAL-${work.workerType}-${String(workerOrdinal).padStart(2, "0")}`;
  const executionId = `IEXEC-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
  const sessionId = makeId("WSES");
  const update = await env.DB.prepare(`UPDATE worker_work_items SET status='LEASED', lease_owner_worker_id=?, lease_execution_id=?, lease_started_at=?, lease_last_seen_at=?, lease_expires_at=?, attempts=attempts+1, last_action='INTERNAL_DISPATCH_CLAIM', updated_at=? WHERE id=? AND status='READY' AND (lease_expires_at IS NULL OR lease_expires_at<?)`)
    .bind(workerId, executionId, at, at, expires, at, work.id, at).run();
  const changes = Number((update.meta as { changes?: number } | undefined)?.changes || 0);
  if (!changes) return null;
  await env.DB.prepare(`INSERT INTO worker_sessions (id,worker_id,worker_type,worker_domain,allowed_domains,execution_id,status,current_work_item_id,project_id,stage,last_action,started_at,last_seen_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(sessionId, workerId, work.workerType, work.projectDomain, "[]", executionId, "ATIVO", work.id, work.projectId, work.stage, "INTERNAL_DISPATCH_CLAIM", at, at, at).run();

  let branchId: string | null = null;
  const branch = await branchForWork(work);
  if (branch && branch.status === "READY") {
    branchId = branch.id;
    await getDb().update(planBranches).set({ status: "RUNNING", leaseOwner: workerId, leaseExecutionId: executionId, leaseExpiresAt: new Date(expires), attempt: branch.attempt + 1, startedAt: branch.startedAt || new Date(at), updatedAt: new Date(at) }).where(and(eq(planBranches.id, branch.id), eq(planBranches.status, "READY")));
  }
  await recordEvent({ workerId, workerType: work.workerType, workerDomain: work.projectDomain, executionId, projectId: work.projectId, workItemId: work.id, stage: work.stage, eventType: "INTERNAL_WORK_ASSIGNED", status: "LEASED", metadata: { branch_id: branchId, ttl_minutes: config.ttlMinutes } });
  return { work: { ...work, status: "LEASED", leaseOwnerWorkerId: workerId, leaseExecutionId: executionId, leaseStartedAt: new Date(at), leaseExpiresAt: new Date(expires) }, workerId, executionId, sessionId, branchId, claimedAt: new Date(at) };
}

async function activateRelink(claim: Claim) {
  if (claim.work.stage !== "RELINK" || !claim.work.itemId) return { handled: false, reason: "NOT_RELINK" };
  const db = getDb();
  const [item] = await db.select().from(automaticProjectItems).where(eq(automaticProjectItems.id, claim.work.itemId)).limit(1);
  if (!item) return { handled: false, reason: "ITEM_NOT_FOUND" };
  const state = parse<Record<string, unknown>>(item.strategyState, {});
  const current = state.current_strategy && typeof state.current_strategy === "object" ? state.current_strategy as Record<string, unknown> : {};
  const history = Array.isArray(state.query_history) ? state.query_history.map(String) : [];
  const queries = Array.isArray(current.queries) ? current.queries.map(String).map((value) => value.trim()).filter(Boolean) : [];
  const query = queries.find((candidate) => !history.includes(candidate)) || queries[0] || item.semanticReference || item.term;
  if (!query) return { handled: false, reason: "NO_AUTHORIZED_RELINK_ROUTE" };
  const date = now();
  if (item.collectionTermId) {
    await db.update(collectionTerms).set({ term: query, status: "PENDENTE", sourceCursor: 0, rounds: 0, attempts: 0, failureReason: null, sourcePlan: item.searchPlan || JSON.stringify(current), startedAt: null, updatedAt: date }).where(eq(collectionTerms.id, item.collectionTermId));
  }
  state.query_history = [...new Set([...history, query])].slice(-100);
  await db.update(automaticProjectItems).set({ status: "SEARCHING_EXTERNALLY", stage: "COLETA", stageReadyAt: date, strategyState: JSON.stringify(state), failureReason: null, updatedAt: date }).where(eq(automaticProjectItems.id, item.id));
  return { handled: true, query };
}

async function finalizeClaim(claim: Claim, outcome: { error?: string; relink?: Record<string, unknown> } = {}) {
  const db = getDb();
  const completedAt = now();
  const [item] = claim.work.itemId ? await db.select().from(automaticProjectItems).where(eq(automaticProjectItems.id, claim.work.itemId)).limit(1) : [null];
  const nextStage = item ? stageForStatus(item.status) : null;
  const stageChanged = Boolean(item && nextStage !== claim.work.stage);
  const resolved = Boolean(item && RESOLVED.has(item.status));
  const waitingSupervisor = Boolean(item && ["QA", "CORRECAO_TECNICA"].includes(nextStage || "")) || Boolean(item && item.status === "RELINK_REQUIRED" && !(await relinkCanRun(claim.work)));
  const error = outcome.error || "";
  const durationMs = Math.max(0, completedAt.getTime() - claim.claimedAt.getTime());
  const queueWaitMs = Math.max(0, claim.claimedAt.getTime() - claim.work.readyAt.getTime());

  let queueStatus = "READY";
  let branchStatus = "READY";
  let eventType = "INTERNAL_WORK_YIELDED";
  let result = "YIELDED_FOR_CONTINUATION";
  if (error) {
    result = `RETRYABLE:${error}`;
  } else if (resolved || stageChanged || !item) {
    queueStatus = "COMPLETED";
    branchStatus = waitingSupervisor ? "WAITING_SUPERVISOR" : resolved ? "COMPLETED" : nextStage === "QA" || nextStage === "CORRECAO_TECNICA" ? "WAITING_SUPERVISOR" : "COMPLETED";
    eventType = "WORK_ITEM_COMPLETED";
    result = resolved ? "RESOLVED" : `STAGE_ADVANCED:${nextStage || "DONE"}`;
  } else if (waitingSupervisor) {
    queueStatus = "COMPLETED";
    branchStatus = "WAITING_SUPERVISOR";
    eventType = "WORK_ITEM_COMPLETED";
    result = "WAITING_SUPERVISOR";
  }

  await db.update(workerWorkItems).set({
    status: queueStatus,
    completedAt: queueStatus === "COMPLETED" ? completedAt : null,
    leaseOwnerWorkerId: null, leaseExecutionId: null, leaseStartedAt: null, leaseLastSeenAt: null, leaseExpiresAt: null,
    lastAction: result, updatedAt: completedAt,
  }).where(eq(workerWorkItems.id, claim.work.id));
  await db.update(workerSessions).set({ status: error ? "LIVRE" : "LIVRE", currentWorkItemId: null, projectId: null, stage: null, lastAction: result, lastSeenAt: completedAt, stoppedAt: completedAt, updatedAt: completedAt }).where(eq(workerSessions.executionId, claim.executionId));
  if (claim.branchId) {
    await db.update(planBranches).set({ status: branchStatus, leaseOwner: null, leaseExecutionId: null, leaseExpiresAt: null, resultJson: JSON.stringify({ result, item_status: item?.status || null, next_stage: nextStage, error: error || null, relink: outcome.relink || null }), finishedAt: ["COMPLETED", "WAITING_SUPERVISOR", "FAILED"].includes(branchStatus) ? completedAt : null, updatedAt: completedAt }).where(eq(planBranches.id, claim.branchId));
  }
  if (queueStatus === "COMPLETED") {
    await db.insert(stageMetrics).values({ id: makeId("SMET"), projectId: claim.work.projectId, projectDomain: claim.work.projectDomain, workerId: claim.workerId, workerType: claim.work.workerType, workItemId: claim.work.id, stage: claim.work.stage, result, durationMs, queueWaitMs, attempts: claim.work.attempts + 1, startedAt: claim.claimedAt, completedAt, createdAt: completedAt });
  }
  await recordEvent({ workerId: claim.workerId, workerType: claim.work.workerType, workerDomain: claim.work.projectDomain, executionId: claim.executionId, projectId: claim.work.projectId, workItemId: claim.work.id, stage: claim.work.stage, eventType, status: result, durationMs, metadata: { branch_id: claim.branchId, next_stage: nextStage, item_status: item?.status || null } });
  return { work_item_id: claim.work.id, item_id: claim.work.itemId, from_stage: claim.work.stage, item_status: item?.status || null, next_stage: nextStage, queue_status: queueStatus, branch_status: branchStatus, result };
}

async function chooseClaims(options: { projectId?: string; maxWorkers: number }) {
  const db = getDb();
  const active = await activeInternalCounts();
  const capacities = await capacityMap();
  let rows = await db.select().from(workerWorkItems).where(eq(workerWorkItems.status, "READY"))
    .orderBy(desc(workerWorkItems.priority), desc(workerWorkItems.resumePriority), asc(workerWorkItems.originalReadyAt), asc(workerWorkItems.attempts), asc(workerWorkItems.id)).limit(500);
  if (options.projectId) rows = rows.filter((row) => row.projectId === options.projectId);
  rows = rows.filter((row) => row.scopeType === "ITEM" && Boolean(row.itemId) && INTERNAL_STAGES.has(row.stage));
  const selected: Array<typeof workerWorkItems.$inferSelect> = [];
  const localType = new Map<string, number>();
  const localProject = new Map<string, number>();
  const localProjectTotal = new Map<string, number>();
  const planMaxCache = new Map<string, number>();
  for (const row of rows) {
    if (selected.length >= options.maxWorkers) break;
    if (row.stage === "RELINK" && !(await relinkCanRun(row))) continue;
    const limit = limitFor(capacities, row.workerType, row.projectDomain);
    const typeCount = (active.byType.get(row.workerType) || 0) + (localType.get(row.workerType) || 0);
    if (typeCount >= Number(limit.maxWorkers || 3)) continue;
    const projectKey = `${row.workerType}:${row.projectId}`;
    const projectCount = (active.byProject.get(projectKey) || 0) + (localProject.get(projectKey) || 0);
    let planMax = planMaxCache.get(row.projectId);
    if (!planMax) { planMax = await activePlanParallelism(row.projectId); planMaxCache.set(row.projectId, planMax); }
    const projectTotal = (active.totalByProject.get(row.projectId) || 0) + (localProjectTotal.get(row.projectId) || 0);
    if (projectTotal >= planMax) continue;
    if (projectCount >= Number(limit.maxPerProject || 3)) continue;
    selected.push(row);
    localType.set(row.workerType, (localType.get(row.workerType) || 0) + 1);
    localProject.set(projectKey, (localProject.get(projectKey) || 0) + 1);
    localProjectTotal.set(row.projectId, (localProjectTotal.get(row.projectId) || 0) + 1);
  }
  return selected;
}

async function executeClaims(claims: Claim[], source: string) {
  const byProject = new Map<string, Claim[]>();
  for (const claim of claims) {
    const bucket = byProject.get(claim.work.projectId) || [];
    bucket.push(claim); byProject.set(claim.work.projectId, bucket);
  }
  const results: Array<Record<string, unknown>> = [];
  // Projetos distintos rodam em paralelo; dentro do mesmo projeto, um ciclo canônico avança
  // várias unidades/termos em paralelo no collector sem criar mutações concorrentes do mesmo projeto.
  await Promise.all([...byProject.entries()].map(async ([projectId, projectClaims]) => {
    const relinkResults = new Map<string, Record<string, unknown>>();
    for (const claim of projectClaims.filter((row) => row.work.stage === "RELINK")) {
      try { relinkResults.set(claim.work.id, await activateRelink(claim)); }
      catch (error) { relinkResults.set(claim.work.id, { handled: false, error: error instanceof Error ? error.message : String(error) }); }
    }
    let cycleError = "";
    try {
      const shouldRunCycle = projectClaims.some((claim) => ["COLETA", "MATERIALIZACAO", "RELINK"].includes(claim.work.stage));
      if (shouldRunCycle) await processAutomaticProject({ projeto_id: projectId, max_etapas: 1, max_qa_backlog: 40, dispatcher_source: source });
    } catch (error) {
      cycleError = error instanceof Error ? error.message : String(error);
    }
    for (const claim of projectClaims) {
      const relink = relinkResults.get(claim.work.id);
      const relinkError = relink && relink.error ? String(relink.error) : "";
      results.push(await finalizeClaim(claim, { error: cycleError || relinkError || undefined, relink }));
    }
    await syncWorkerQueue(projectId).catch(() => undefined);
    await getDb().update(automaticProjects).set({ lastAction: `INTERNAL_DISPATCH_CYCLE:${source}`, updatedAt: now() }).where(eq(automaticProjects.id, projectId)).catch(() => undefined);
  }));
  return results;
}

export async function getInternalDispatcherHealth(projectId?: string) {
  const db = getDb();
  let ready = await db.select({ id: workerWorkItems.id, projectId: workerWorkItems.projectId, itemId: workerWorkItems.itemId, scopeType: workerWorkItems.scopeType, stage: workerWorkItems.stage }).from(workerWorkItems).where(eq(workerWorkItems.status, "READY")).limit(3000);
  let active = await db.select({ id: workerSessions.id, projectId: workerSessions.projectId, workerType: workerSessions.workerType }).from(workerSessions).where(and(eq(workerSessions.status, "ATIVO"), like(workerSessions.workerId, "INTERNAL-%"))).limit(500);
  if (projectId) { ready = ready.filter((row) => row.projectId === projectId); active = active.filter((row) => row.projectId === projectId); }
  const executableReady = ready.filter((row) => row.scopeType === "ITEM" && Boolean(row.itemId) && INTERNAL_STAGES.has(row.stage));
  return {
    project_id: projectId || null,
    dispatcher_enabled: await settingBoolean("internal_dispatcher_enabled", true),
    queue_ready: ready.length,
    executable_ready: executableReady.length,
    internal_workers_active: active.length,
    state: executableReady.length > 0 && active.length === 0 ? "STARVED_READY_WITHOUT_CONSUMER" : active.length > 0 ? "RUNNING" : "IDLE",
    stages: executableReady.reduce<Record<string, number>>((acc, row) => { acc[row.stage] = (acc[row.stage] || 0) + 1; return acc; }, {}),
  };
}

export async function runInternalWorkerDispatcher(options: { projectId?: string; maxWorkers?: number; maxCycles?: number; source?: string } = {}) {
  const enabled = await settingBoolean("internal_dispatcher_enabled", true);
  if (!enabled) return { enabled: false, source: options.source || "DISPATCHER", cycles: 0, claimed: 0, completed: 0, health: await getInternalDispatcherHealth(options.projectId) };
  const maxWorkers = clamp(options.maxWorkers, await settingNumber("internal_dispatcher_max_workers", 8, 1, 50), 1, 50);
  const maxCycles = clamp(options.maxCycles, await settingNumber("internal_dispatcher_max_cycles", 3, 1, 10), 1, 10);
  const source = options.source || "INTERNAL_DISPATCHER";
  await runWorkerWatchdog({ projectId: options.projectId, source: `${source}:WATCHDOG` }).catch(() => undefined);
  await syncWorkerQueue(options.projectId).catch(() => undefined);
  const cycles: Array<Record<string, unknown>> = [];
  let totalClaimed = 0;
  for (let cycle = 0; cycle < maxCycles; cycle += 1) {
    const selected = await chooseClaims({ projectId: options.projectId, maxWorkers });
    if (!selected.length) break;
    const claims: Claim[] = [];
    let ordinal = 1;
    for (const work of selected) {
      const claim = await claimInternalWork(work, ordinal++);
      if (claim) claims.push(claim);
    }
    if (!claims.length) continue;
    totalClaimed += claims.length;
    const results = await executeClaims(claims, `${source}:CYCLE_${cycle + 1}`);
    cycles.push({ cycle: cycle + 1, claimed: claims.length, results });
    await syncWorkerQueue(options.projectId).catch(() => undefined);
  }
  const health = await getInternalDispatcherHealth(options.projectId);
  return { enabled: true, source, cycles: cycles.length, claimed: totalClaimed, completed: cycles.reduce((sum, row) => sum + ((row.results as Array<Record<string, unknown>> | undefined)?.filter((result) => result.queue_status === "COMPLETED").length || 0), 0), needs_reschedule: health.executable_ready > 0, health, details: cycles };
}
