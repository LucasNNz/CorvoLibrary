import { env } from "./platform/runtime";
import { and, asc, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { getDb } from "../db";
import { automaticProjectEvents, automaticProjectItems, automaticProjects, settings, supervisorDecisionQueue, supervisorExecutions, supervisorProjectCandidates } from "../db/schema";
import { requireWorkerLeaseForWrite, renewWorkerLeaseByActivity, syncWorkerQueue } from "./worker-orchestration";

const DEFAULT_TTL_MINUTES = 10;
const DEFAULT_WATCHDOG_MINUTES = 2;
const COMPLETED_PROJECT_STATUSES = new Set(["CONCLUIDO_MANUAL", "COMPLETED", "COMPLETED_WITH_WARNINGS", "FORCED_CLOSED"]);
const TERMINAL_PROJECT_STATUSES = new Set([...COMPLETED_PROJECT_STATUSES, "CANCELLED", "GROUPED_ARCHIVED"]);
const RESOLVED_ITEM_STATUSES = new Set(["APPROVED", "FROZEN", "LINKED_FROM_LIBRARY", "LINKED_FROM_FAMILY"]);
const QA_ITEM_STATUSES = new Set(["QA_READY", "TECHNICAL_CORRECTION_REQUIRED"]);
const RELINK_ITEM_STATUSES = new Set(["RELINK_REQUIRED"]);
const MATERIALIZATION_ITEM_STATUSES = new Set(["MATERIALIZING", "MATERIALIZATION_PENDING", "READY_FOR_MATERIALIZATION", "READY_FOR_VISUAL_QA"]);
const COLLECTION_ITEM_STATUSES = new Set(["QUEUED", "PARSING", "SEARCHING_EXTERNALLY", "SEARCHING_LIBRARY", "COLLECTING", "WAITING_LIBRARY", "WAITING_EXTERNAL_SEARCH"]);

type LeaseConfig = {
  ttlMinutes: number;
  watchdogMinutes: number;
  renewOnActivity: boolean;
  autoMarkAbandoned: boolean;
  autoReadyForResume: boolean;
  reconcileBeforeResume: boolean;
  requireExecutionIdForWrites: boolean;
  allowOldExecutionWrites: boolean;
};

type LeaseRow = {
  id: string;
  status: string;
  pipeline_status: string | null;
  next_action: string | null;
  supervisor_execution_id: string | null;
  supervisor_status: string | null;
  supervisor_lease_started_at: number | null;
  supervisor_last_seen_at: number | null;
  supervisor_lease_expires_at: number | null;
  previous_execution_id: string | null;
  abandoned_at: number | null;
  resume_reason: string | null;
};

const now = () => new Date();
const makeEventId = () => `PEVT-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
const makeExecutionId = () => `EXEC-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
const bool = (value: string | undefined, fallback: boolean) => value === undefined ? fallback : value.toLowerCase() === "true";
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));

async function rawProject(projectId: string): Promise<LeaseRow | null> {
  const row = await env.DB.prepare(`SELECT id,status,pipeline_status,next_action,supervisor_execution_id,supervisor_status,supervisor_lease_started_at,supervisor_last_seen_at,supervisor_lease_expires_at,previous_execution_id,abandoned_at,resume_reason FROM automatic_projects WHERE id=? LIMIT 1`).bind(projectId).first<LeaseRow>();
  return row || null;
}

async function projectEvent(projectId: string, executionId: string | null, event: string, status: string, metadata: Record<string, unknown> = {}) {
  await getDb().insert(automaticProjectEvents).values({
    id: makeEventId(), projectId, event, status,
    detail: JSON.stringify({ execution_id: executionId, ...metadata }), createdAt: now(),
  });
}

export async function getSupervisorLeaseConfig(): Promise<LeaseConfig> {
  const rows = await getDb().select().from(settings).where(inArray(settings.key, [
    "supervisor_lease_ttl_minutes", "supervisor_watchdog_interval_minutes", "supervisor_renew_on_activity",
    "supervisor_auto_mark_abandoned", "supervisor_auto_ready_for_resume", "supervisor_reconcile_before_resume",
    "supervisor_require_execution_id_for_writes", "supervisor_allow_old_execution_writes",
  ]));
  const map = new Map(rows.map((row) => [row.key, row.value]));
  return {
    ttlMinutes: clamp(Number(map.get("supervisor_lease_ttl_minutes") || DEFAULT_TTL_MINUTES), 5, 15),
    watchdogMinutes: clamp(Number(map.get("supervisor_watchdog_interval_minutes") || DEFAULT_WATCHDOG_MINUTES), 1, 15),
    renewOnActivity: bool(map.get("supervisor_renew_on_activity"), true),
    autoMarkAbandoned: bool(map.get("supervisor_auto_mark_abandoned"), true),
    autoReadyForResume: bool(map.get("supervisor_auto_ready_for_resume"), true),
    reconcileBeforeResume: bool(map.get("supervisor_reconcile_before_resume"), true),
    requireExecutionIdForWrites: bool(map.get("supervisor_require_execution_id_for_writes"), true),
    allowOldExecutionWrites: bool(map.get("supervisor_allow_old_execution_writes"), false),
  };
}

export async function deriveProjectPipelineState(projectId: string, persist = true) {
  const db = getDb();
  const [project] = await db.select().from(automaticProjects).where(eq(automaticProjects.id, projectId)).limit(1);
  if (!project) throw new Error("PROJECT_NOT_FOUND");
  const items = await db.select().from(automaticProjectItems).where(and(eq(automaticProjectItems.projectId, projectId), eq(automaticProjectItems.version, project.activeVersion)));
  let pipelineStatus = project.pipelineStatus || "AGUARDANDO";
  let nextAction = project.nextAction || "RECONCILIAR";
  const unresolved = items.filter((item) => !RESOLVED_ITEM_STATUSES.has(item.status));
  if (COMPLETED_PROJECT_STATUSES.has(project.status)) { pipelineStatus = "CONCLUIDO"; nextAction = "FINALIZAR"; }
  else if (project.status === "CANCELLED" || project.status === "GROUPED_ARCHIVED") { pipelineStatus = "CANCELADO"; nextAction = "FINALIZAR"; }
  else if (project.status === "PAUSED_BY_SUPERVISOR") { pipelineStatus = "AGUARDANDO"; nextAction = project.nextAction || "RECONCILIAR"; }
  else if (project.supervisorStatus === "ABANDONADA" || project.pipelineStatus === "PRONTO_PARA_RETOMADA") { pipelineStatus = "PRONTO_PARA_RETOMADA"; nextAction = project.nextAction || "RECONCILIAR"; }
  else if (unresolved.some((item) => QA_ITEM_STATUSES.has(item.status))) { pipelineStatus = "AGUARDANDO_QA"; nextAction = "QA_VISUAL"; }
  else if (unresolved.some((item) => RELINK_ITEM_STATUSES.has(item.status))) { pipelineStatus = "AGUARDANDO_RELINK"; nextAction = "RELINK"; }
  else if (unresolved.some((item) => MATERIALIZATION_ITEM_STATUSES.has(item.status))) { pipelineStatus = "AGUARDANDO_MATERIALIZACAO"; nextAction = "MATERIALIZAR"; }
  else if (unresolved.some((item) => COLLECTION_ITEM_STATUSES.has(item.status))) { pipelineStatus = "EM_PROCESSAMENTO"; nextAction = "COLETAR"; }
  else if (unresolved.length) { pipelineStatus = "EM_PROCESSAMENTO"; nextAction = "RECONCILIAR"; }
  else if (items.length) { pipelineStatus = "EM_PROCESSAMENTO"; nextAction = project.zipR2Key ? "FINALIZAR" : "GERAR_ZIP"; }
  else { pipelineStatus = "AGUARDANDO"; nextAction = "RECONCILIAR"; }
  if (persist && (pipelineStatus !== project.pipelineStatus || nextAction !== project.nextAction)) {
    await db.update(automaticProjects).set({ pipelineStatus, nextAction, updatedAt: now() }).where(eq(automaticProjects.id, projectId));
  }
  return { pipelineStatus, nextAction, totalItems: items.length, pendingItems: unresolved.length };
}

export async function runSupervisorWatchdog(options: { projectId?: string; source?: string } = {}) {
  const config = await getSupervisorLeaseConfig();
  if (!config.autoMarkAbandoned) return { expirados: 0, projetos: [], config };
  const db = getDb(), at = Date.now();
  const expiredLease = or(isNull(automaticProjects.supervisorLeaseExpiresAt), lt(automaticProjects.supervisorLeaseExpiresAt, new Date(at)));
  const condition = options.projectId
    ? and(eq(automaticProjects.id, options.projectId), eq(automaticProjects.supervisorStatus, "ATIVO"), expiredLease)
    : and(eq(automaticProjects.supervisorStatus, "ATIVO"), expiredLease);
  const expired = await db.select().from(automaticProjects).where(condition).orderBy(asc(automaticProjects.supervisorLeaseExpiresAt)).limit(200);
  const results: Array<Record<string, unknown>> = [];
  for (const project of expired) {
    if (TERMINAL_PROJECT_STATUSES.has(project.status)) {
      const completed = COMPLETED_PROJECT_STATUSES.has(project.status);
      const executionStatus = completed ? "CONCLUIDA" : project.status === "CANCELLED" ? "CANCELADA" : "SUBSTITUIDA";
      await db.update(automaticProjects).set({ supervisorStatus: executionStatus, pipelineStatus: completed ? "CONCLUIDO" : "CANCELADO", updatedAt: now() }).where(eq(automaticProjects.id, project.id));
      if (project.supervisorExecutionId) await db.update(supervisorExecutions).set({ status: executionStatus, completedAt: completed ? now() : null, updatedAt: now() }).where(eq(supervisorExecutions.id, project.supervisorExecutionId));
      continue;
    }
    const executionId = project.supervisorExecutionId;
    const changed = await env.DB.prepare(`UPDATE automatic_projects SET supervisor_status='ABANDONADA', pipeline_status=?, resume_reason='LEASE_SUPERVISOR_EXPIRADO', abandoned_at=?, updated_at=? WHERE id=? AND supervisor_status='ATIVO' AND supervisor_execution_id IS ? AND supervisor_lease_expires_at < ?`)
      .bind(config.autoReadyForResume ? "PRONTO_PARA_RETOMADA" : project.pipelineStatus, at, at, project.id, executionId, at).run();
    const changes = Number((changed.meta as { changes?: number } | undefined)?.changes || 0);
    if (!changes) continue;
    if (executionId) await db.update(supervisorExecutions).set({ status: "ABANDONADA", abandonedAt: new Date(at), updatedAt: new Date(at) }).where(eq(supervisorExecutions.id, executionId));
    await projectEvent(project.id, executionId, "SUPERVISOR_LEASE_EXPIRED", "ABANDONADA", { source: options.source || "WATCHDOG", lease_expires_at: project.supervisorLeaseExpiresAt?.toISOString?.() || null });
    await projectEvent(project.id, executionId, "SUPERVISOR_MARKED_ABANDONED", "PRONTO_PARA_RETOMADA", { source: options.source || "WATCHDOG", reason: "LEASE_SUPERVISOR_EXPIRADO" });
    await projectEvent(project.id, executionId, "PROJECT_READY_FOR_RESUME", "PRONTO_PARA_RETOMADA", { source: options.source || "WATCHDOG" });
    results.push({ project_id: project.id, execution_id: executionId, pipeline_status: "PRONTO_PARA_RETOMADA" });
  }
  return { expirados: results.length, projetos: results, config };
}

export async function acquireSupervisorLease(input: { projectId: string; executionId?: string; ttlMinutes?: number; reason?: string; source?: string }) {
  // V59: aquisição não executa watchdog/reconciliação antes do CAS. O próprio CAS aceita
  // lease expirado; a execução anterior é classificada localmente depois da tomada.
  const at = Date.now();
  const config = await getSupervisorLeaseConfig(), project = await rawProject(input.projectId);
  if (!project) throw new Error("PROJECT_NOT_FOUND");
  if (TERMINAL_PROJECT_STATUSES.has(project.status) || project.pipeline_status === "CONCLUIDO" || project.pipeline_status === "CANCELADO") throw new Error("PROJECT_NOT_ELIGIBLE_FOR_LEASE");
  const executionId = input.executionId?.trim() || makeExecutionId();
  const ttlMinutes = clamp(Number(input.ttlMinutes || config.ttlMinutes), 5, 15), expires = at + ttlMinutes * 60_000;
  const previousExecutionId = project.supervisor_execution_id && project.supervisor_execution_id !== executionId ? project.supervisor_execution_id : project.previous_execution_id;
  const previousLeaseExpired = project.supervisor_status === "ATIVO" && Boolean(project.supervisor_lease_expires_at) && Number(project.supervisor_lease_expires_at) < at;
  const resumeReason = previousLeaseExpired || project.pipeline_status === "PRONTO_PARA_RETOMADA" || project.supervisor_status === "ABANDONADA"
    ? (project.resume_reason || "LEASE_SUPERVISOR_EXPIRADO") : (input.reason || null);
  const result = await env.DB.prepare(`UPDATE automatic_projects SET supervisor_execution_id=?, supervisor_status='ATIVO', supervisor_lease_started_at=CASE WHEN supervisor_execution_id=? THEN COALESCE(supervisor_lease_started_at,?) ELSE ? END, supervisor_last_seen_at=?, supervisor_lease_expires_at=?, previous_execution_id=?, abandoned_at=NULL, resume_reason=?, resumed_at=CASE WHEN ? IS NOT NULL THEN ? ELSE resumed_at END, pipeline_status='EM_PROCESSAMENTO', updated_at=? WHERE id=? AND status NOT IN ('CONCLUIDO_MANUAL','COMPLETED','COMPLETED_WITH_WARNINGS','FORCED_CLOSED','CANCELLED','GROUPED_ARCHIVED') AND (supervisor_status IS NULL OR supervisor_status!='ATIVO' OR supervisor_lease_expires_at IS NULL OR supervisor_lease_expires_at < ? OR supervisor_execution_id=?)`)
    .bind(executionId, executionId, at, at, at, expires, previousExecutionId, resumeReason, previousExecutionId, at, at, input.projectId, at, executionId).run();
  const changes = Number((result.meta as { changes?: number } | undefined)?.changes || 0);
  if (!changes) {
    const current = await rawProject(input.projectId);
    throw new Error(`LEASE_BUSY:${current?.supervisor_execution_id || "UNKNOWN"}:${current?.supervisor_lease_expires_at || "UNKNOWN"}`);
  }
  const db = getDb(), date = new Date(at), expiresDate = new Date(expires);
  await db.insert(supervisorExecutions).values({ id: executionId, projectId: input.projectId, previousExecutionId: previousExecutionId || null, status: "ATIVO", leaseStartedAt: date, lastSeenAt: date, leaseExpiresAt: expiresDate, resumeReason, createdAt: date, updatedAt: date }).onConflictDoUpdate({ target: supervisorExecutions.id, set: { status: "ATIVO", lastSeenAt: date, leaseExpiresAt: expiresDate, resumeReason, updatedAt: date } });
  if (previousLeaseExpired && previousExecutionId && previousExecutionId !== executionId) {
    await db.update(supervisorExecutions).set({ status:"ABANDONADA", abandonedAt:date, updatedAt:date }).where(eq(supervisorExecutions.id,previousExecutionId));
    await projectEvent(input.projectId, previousExecutionId, "SUPERVISOR_LEASE_EXPIRED", "ABANDONADA", { source:"FAST_ACQUIRE", replaced_by:executionId });
  }
  if (previousExecutionId && previousExecutionId !== executionId) {
    await db.update(supervisorExecutions).set({ status: "SUBSTITUIDA", updatedAt: date }).where(and(eq(supervisorExecutions.id, previousExecutionId), eq(supervisorExecutions.status, "ATIVO")));
    await projectEvent(input.projectId, executionId, "SUPERVISOR_REPLACED", "SUBSTITUIDA", { previous_execution_id: previousExecutionId, new_execution_id: executionId });
  }
  await projectEvent(input.projectId, executionId, "SUPERVISOR_LEASE_ACQUIRED", "ATIVO", { previous_execution_id: previousExecutionId, ttl_minutes: ttlMinutes, lease_expires_at: new Date(expires).toISOString(), source: input.source || "SUPERVISOR_MCP", resume_reason: resumeReason });
  if (previousExecutionId) await projectEvent(input.projectId, executionId, "PROJECT_RESUMED", "EM_PROCESSAMENTO", { previous_execution_id: previousExecutionId, resume_reason: resumeReason });
  return { projeto_id: input.projectId, execution_id: executionId, previous_execution_id: previousExecutionId, supervisor_status: "ATIVO", pipeline_status: "EM_PROCESSAMENTO", lease_started_at: new Date(at).toISOString(), lease_expires_at: new Date(expires).toISOString(), ttl_minutes: ttlMinutes, resume_reason: resumeReason };
}

export async function renewSupervisorLease(projectId: string, executionId: string, action = "MCP_ACTIVITY") {
  const config = await getSupervisorLeaseConfig();
  if (!config.renewOnActivity) return { projeto_id: projectId, execution_id: executionId, renovado: false, motivo: "RENEW_DISABLED" };
  if (!executionId?.trim()) throw new Error("EXECUTION_ID_REQUIRED");
  const at = Date.now(), expires = at + config.ttlMinutes * 60_000;
  const result = await env.DB.prepare(`UPDATE automatic_projects SET supervisor_last_seen_at=?, supervisor_lease_expires_at=?, updated_at=? WHERE id=? AND supervisor_execution_id=? AND supervisor_status='ATIVO' AND supervisor_lease_expires_at>=?`)
    .bind(at, expires, at, projectId, executionId, at).run();
  const changes = Number((result.meta as { changes?: number } | undefined)?.changes || 0);
  if (!changes) {
    const current = await rawProject(projectId);
    if (!current) throw new Error("PROJECT_NOT_FOUND");
    if (current.supervisor_execution_id !== executionId) throw new Error("SUPERVISOR_REPLACED");
    if (current.supervisor_status !== "ATIVO" || !current.supervisor_lease_expires_at || current.supervisor_lease_expires_at < at) {
      await runSupervisorWatchdog({ projectId, source: "LEASE_RENEWAL" });
      throw new Error("LEASE_NOT_OWNED");
    }
    throw new Error("LEASE_RENEW_FAILED");
  }
  const db = getDb();
  await db.update(supervisorExecutions).set({ lastSeenAt: new Date(at), leaseExpiresAt: new Date(expires), updatedAt: new Date(at) }).where(eq(supervisorExecutions.id, executionId));
  await projectEvent(projectId, executionId, "SUPERVISOR_HEARTBEAT_RENEWED", "ATIVO", { action, lease_expires_at: new Date(expires).toISOString() });
  return { projeto_id: projectId, execution_id: executionId, renovado: true, last_seen_at: new Date(at).toISOString(), lease_expires_at: new Date(expires).toISOString() };
}

export async function touchSupervisorLeaseForRead(projectId: string, executionId?: string, action = "MCP_READ") {
  if (!executionId?.trim()) return { renovado: false, motivo: "NO_EXECUTION_ID" };
  try { return await renewSupervisorLease(projectId, executionId, action); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (["SUPERVISOR_REPLACED", "LEASE_NOT_OWNED", "LEASE_RENEW_FAILED"].includes(message)) return { renovado: false, motivo: message };
    throw error;
  }
}

export async function requireSupervisorLeaseForWrite(projectId: string, executionId: string | undefined, action: string) {
  const config = await getSupervisorLeaseConfig();
  if (!config.requireExecutionIdForWrites) return { required: false, renovado: false };
  if (!executionId?.trim()) throw new Error("EXECUTION_ID_REQUIRED_USE_ASSUMIR_TRABALHO_SUPERVISOR");
  if (config.allowOldExecutionWrites) return { required: true, ...(await touchSupervisorLeaseForRead(projectId, executionId, action)) };
  return { required: true, ...(await renewSupervisorLease(projectId, executionId, action)) };
}

export async function withProjectLease<T>(projectId: string, input: Record<string, unknown>, action: string, work: () => Promise<T>): Promise<T> {
  const executionId = typeof input.execution_id === "string" ? input.execution_id.trim() : "";
  const workerLease = await requireWorkerLeaseForWrite(projectId, executionId || undefined, action);
  if (!workerLease.matched) await requireSupervisorLeaseForWrite(projectId, executionId || undefined, action);
  const result = await work();
  await deriveProjectPipelineState(projectId, true).catch(() => undefined);
  await syncWorkerQueue(projectId).catch(() => undefined);
  if (workerLease.matched) await renewWorkerLeaseByActivity(executionId, projectId, `${action}_COMPLETED`).catch(() => undefined);
  else await renewSupervisorLease(projectId, executionId, `${action}_COMPLETED`).catch(() => undefined);
  return result;
}

export async function completeSupervisorExecution(projectId: string, executionId?: string, status: "CONCLUIDA" | "CANCELADA" = "CONCLUIDA") {
  const project = await rawProject(projectId); if (!project) return { atualizado: false, motivo: "PROJECT_NOT_FOUND" };
  const owner = executionId?.trim() || project.supervisor_execution_id || "";
  if (!owner || project.supervisor_execution_id !== owner) return { atualizado: false, motivo: "LEASE_NOT_OWNED" };
  const at = now(), pipeline = status === "CONCLUIDA" ? "CONCLUIDO" : "CANCELADO";
  await getDb().update(automaticProjects).set({ supervisorStatus: status, pipelineStatus: pipeline, nextAction: "FINALIZAR", supervisorLastSeenAt: at, supervisorLeaseExpiresAt: at, completedAt: status === "CONCLUIDA" ? at : null, updatedAt: at }).where(eq(automaticProjects.id, projectId));
  await getDb().update(supervisorExecutions).set({ status, completedAt: at, updatedAt: at }).where(eq(supervisorExecutions.id, owner));
  await projectEvent(projectId, owner, status === "CONCLUIDA" ? "PROJECT_COMPLETED" : "SUPERVISOR_CANCELLED", status, { previous_execution_id: project.previous_execution_id || null });
  return { atualizado: true, projeto_id: projectId, execution_id: owner, supervisor_status: status, pipeline_status: pipeline };
}

export async function getSupervisorLeaseTelemetry(hours = 24) {
  const config = await getSupervisorLeaseConfig();
  const db = getDb(), since = new Date(Date.now() - clamp(hours, 1, 720) * 60 * 60_000);
  const [projects, executions, events] = await Promise.all([
    db.select().from(automaticProjects).orderBy(desc(automaticProjects.updatedAt)).limit(500),
    db.select().from(supervisorExecutions).where(lt(supervisorExecutions.createdAt, new Date(Date.now() + 1))).orderBy(desc(supervisorExecutions.updatedAt)).limit(1000),
    db.select().from(automaticProjectEvents).where(lt(automaticProjectEvents.createdAt, new Date(Date.now() + 1))).orderBy(desc(automaticProjectEvents.createdAt)).limit(2000),
  ]);
  const recentExecutions = executions.filter((row) => row.updatedAt >= since);
  const recentEvents = events.filter((row) => row.createdAt >= since);
  const resumed = recentEvents.filter((row) => row.event === "PROJECT_RESUMED");
  const resumeTimes = resumed.map((event) => {
    try { const detail = JSON.parse(event.detail || "{}"); const prior = executions.find((row) => row.id === detail.previous_execution_id); return prior?.abandonedAt ? Math.max(0, event.createdAt.getTime() - prior.abandonedAt.getTime()) : null; } catch { return null; }
  }).filter((value): value is number => typeof value === "number");
  return {
    periodo_horas: clamp(hours, 1, 720),
    configuracao: config,
    supervisores_ativos: projects.filter((p) => p.supervisorStatus === "ATIVO" && p.supervisorLeaseExpiresAt && p.supervisorLeaseExpiresAt.getTime() > Date.now()).length,
    leases_expirados_24h: recentEvents.filter((e) => e.event === "SUPERVISOR_LEASE_EXPIRED").length,
    projetos_prontos_retomada: projects.filter((p) => p.pipelineStatus === "PRONTO_PARA_RETOMADA").length,
    retomadas_24h: resumed.length,
    tempo_medio_para_retomada_ms: resumeTimes.length ? Math.round(resumeTimes.reduce((a,b)=>a+b,0)/resumeTimes.length) : 0,
    retomadas_com_sucesso: recentEvents.filter((e) => e.event === "PROJECT_COMPLETED" && e.detail?.includes?.("previous_execution_id")).length,
    colisoes_de_lease_impedidas: recentEvents.filter((e) => e.event === "SUPERVISOR_LEASE_COLLISION_BLOCKED").length,
    execucoes_abandonadas: recentExecutions.filter((e) => e.status === "ABANDONADA").length,
    projetos_concluidos_apos_retomada: projects.filter((p) => COMPLETED_PROJECT_STATUSES.has(p.status) && Boolean(p.previousExecutionId)).length,
  };
}

export async function recordSupervisorProjectReconciled(projectId: string, executionId: string, metadata: Record<string, unknown> = {}) {
  await projectEvent(projectId, executionId, "PROJECT_RECONCILED", "EM_PROCESSAMENTO", metadata);
}

export async function acquireNextSupervisorWork(input: { projectId?: string; executionId?: string; ttlMinutes?: number } = {}) {
  // V59 FAST LEASE: nenhuma varredura de watchdog, reconciliação ou contagem de itens
  // faz parte do caminho de aquisição. A seleção pula leases válidos no próprio SQL.
  const executionId = input.executionId?.trim() || undefined;
  const at = Date.now();
  let candidateIds: string[] = [];
  if (input.projectId) candidateIds = [input.projectId];
  else {
    const rows = await env.DB.prepare(`SELECT id FROM automatic_projects
      WHERE status NOT IN ('CONCLUIDO_MANUAL','COMPLETED','COMPLETED_WITH_WARNINGS','FORCED_CLOSED','CANCELLED','GROUPED_ARCHIVED')
        AND COALESCE(pipeline_status,'AGUARDANDO') NOT IN ('CONCLUIDO','CANCELADO')
        AND (supervisor_status IS NULL OR supervisor_status!='ATIVO' OR supervisor_lease_expires_at IS NULL OR supervisor_lease_expires_at < ? OR supervisor_execution_id=?)
      ORDER BY CASE COALESCE(pipeline_status,'AGUARDANDO')
        WHEN 'PRONTO_PARA_RETOMADA' THEN 0 WHEN 'AGUARDANDO_QA' THEN 1 WHEN 'AGUARDANDO_RELINK' THEN 2 WHEN 'AGUARDANDO_MATERIALIZACAO' THEN 3 ELSE 4 END ASC,
        COALESCE(original_ready_at,ready_at,created_at,updated_at) ASC, id ASC LIMIT 20`)
      .bind(at, executionId || "").all<{ id:string }>();
    candidateIds = (rows.results || []).map((row)=>String(row.id)).filter(Boolean);
  }
  for (const projectId of candidateIds) {
    try {
      return await acquireSupervisorLease({ projectId, executionId, ttlMinutes:input.ttlMinutes, reason:"TRABALHO_ELEGIVEL", source:"ASSUMIR_PROXIMO_TRABALHO_FAST" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("LEASE_BUSY") || message === "PROJECT_NOT_ELIGIBLE_FOR_LEASE") continue;
      throw error;
    }
  }
  return { projeto_id:null, execution_id:null, pipeline_status:null, next_action:null, pending_items:0, motivo:"NENHUM_TRABALHO_ELEGIVEL", lease_fast_path:true };
}
