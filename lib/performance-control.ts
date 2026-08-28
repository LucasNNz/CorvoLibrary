import { and, asc, desc, eq, gte, inArray, like, or, sql } from "drizzle-orm";
import { getDb } from "../db";
import {
  automaticProjectItems,
  automaticProjects,
  mcpAudit,
  operationResults,
  sourceRouteMetrics,
  supervisorDecisionQueue,
  supervisorProjectCandidates,
  workerCapacityLimits,
  workerEvents,
  workerSessions,
  workerWorkItems,
  materializationHostHealth,
} from "../db/schema";

const RESOLVED = new Set(["APPROVED", "FROZEN", "LINKED_FROM_LIBRARY", "LINKED_FROM_FAMILY"]);
const COLLECTING = new Set(["QUEUED","PARSING","SEARCHING_EXTERNALLY","SEARCHING_LIBRARY","COLLECTING","WAITING_LIBRARY","WAITING_EXTERNAL_SEARCH","DISCOVERED"]);
const MATERIALIZING = new Set(["READY_FOR_MATERIALIZATION","MATERIALIZATION_PENDING","MATERIALIZING"]);
const WAITING_QA = new Set(["QA_READY","READY_FOR_VISUAL_QA","WAITING_VISUAL_QA"]);
const TECHNICAL = new Set(["TECHNICAL_CORRECTION_REQUIRED","CORRECAO_TECNICA_PERMITIDA"]);
const FAILED = new Set(["FAILED","FAILED_SEMANTIC","FAILED_INFRASTRUCTURE","REJECTED","CANCELLED","CANCELED","ERROR_REAL"]);

const now = () => new Date();
const makeId = (prefix: string) => `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0,8).toUpperCase()}`;

export type ProjectCounts = {
  total: number; approved: number; frozen: number; collecting: number; materializing: number; waitingQa: number;
  relink: number; technical: number; waitingSeed: number; failed: number; pending: number; resolved: number;
};

export function countsFromStatuses(statuses: string[]): ProjectCounts {
  const count = (set: Set<string>) => statuses.filter((status) => set.has(status)).length;
  const approved = statuses.filter((status) => status === "APPROVED" || status === "LINKED_FROM_LIBRARY" || status === "LINKED_FROM_FAMILY").length;
  const frozen = statuses.filter((status) => status === "FROZEN").length;
  const resolved = statuses.filter((status) => RESOLVED.has(status)).length;
  const waitingSeed = statuses.filter((status) => status === "WAITING_FAMILY_SEED" || status === "WAITING_DEPENDENCY").length;
  return {
    total: statuses.length,
    approved,
    frozen,
    collecting: count(COLLECTING),
    materializing: count(MATERIALIZING),
    waitingQa: count(WAITING_QA),
    relink: statuses.filter((status) => status === "RELINK_REQUIRED").length,
    technical: count(TECHNICAL),
    waitingSeed,
    failed: count(FAILED),
    pending: Math.max(0, statuses.length - resolved),
    resolved,
  };
}


const ANIME_DOMAIN_HINTS = [
  "NARUTO", "BORUTO", "MY HERO ACADEMIA", "BOKU NO HERO", "ONE PIECE", "DEMON SLAYER", "KIMETSU",
  "JUJUTSU KAISEN", "CHAINSAW MAN", "DRAGON BALL", "DANDADAN", "SAKAMOTO DAYS", "JOJO", "BLEACH",
  "HUNTER X HUNTER", "ATTACK ON TITAN", "SHINGEKI", "ONE-PUNCH MAN", "ONE PUNCH MAN", "POKEMON", "POKÉMON"
];

function inferLegacyDomain(projectName: string, universes: string[]) {
  const corpus = `${projectName} ${universes.join(" ")}`.toUpperCase();
  if (ANIME_DOMAIN_HINTS.some((hint) => corpus.includes(hint))) return "ANIME";
  return "GENERAL";
}

function pipelineFromCounts(counts: ProjectCounts) {
  if (counts.total > 0 && counts.pending === 0) return { pipelineStatus: "AGUARDANDO", nextAction: "GERAR_ZIP" };
  if (counts.waitingQa > 0) return { pipelineStatus: "AGUARDANDO_QA", nextAction: "QA_VISUAL" };
  if (counts.relink > 0) return { pipelineStatus: "AGUARDANDO_RELINK", nextAction: "RELINK" };
  if (counts.materializing > 0) return { pipelineStatus: "AGUARDANDO_MATERIALIZACAO", nextAction: "MATERIALIZAR" };
  if (counts.technical > 0) return { pipelineStatus: "EM_PROCESSAMENTO", nextAction: "CORRECAO_TECNICA" };
  if (counts.pending > 0) return { pipelineStatus: "EM_PROCESSAMENTO", nextAction: "COLETAR" };
  return { pipelineStatus: "AGUARDANDO", nextAction: null as string | null };
}

export async function backfillLegacyProjects(projectId?: string) {
  const db = getDb();
  const projects = projectId
    ? await db.select().from(automaticProjects).where(eq(automaticProjects.id, projectId)).limit(1)
    : await db.select().from(automaticProjects).orderBy(asc(automaticProjects.createdAt)).limit(2000);
  const results: Array<Record<string, unknown>> = [];
  for (const project of projects) {
    const allItems = await db.select({ id: automaticProjectItems.id, version: automaticProjectItems.version, status: automaticProjectItems.status, universe: automaticProjectItems.universe, itemDomain: automaticProjectItems.itemDomain })
      .from(automaticProjectItems).where(eq(automaticProjectItems.projectId, project.id));
    if (!allItems.length) {
      results.push({ project_id: project.id, changed: false, reason: "NO_ITEMS" });
      continue;
    }
    const versions = [...new Set(allItems.map((row) => row.version))].sort((a,b)=>b-a);
    const activeHasItems = allItems.some((row) => row.version === project.activeVersion);
    const effectiveVersion = activeHasItems ? project.activeVersion : versions[0];
    const activeItems = allItems.filter((row) => row.version === effectiveVersion);
    const counts = countsFromStatuses(activeItems.map((row) => row.status));
    const inferred = project.projectDomain === "GENERAL" || !project.projectDomain
      ? inferLegacyDomain(project.name, activeItems.map((row) => row.universe || "").filter(Boolean))
      : project.projectDomain;
    const domain = inferred || "GENERAL";
    const pipeline = pipelineFromCounts(counts);
    const domainChanged = domain !== project.projectDomain;
    const versionChanged = effectiveVersion !== project.activeVersion;
    const countersStale = project.totalItems !== counts.total || project.approvedCount !== counts.approved || project.frozenCount !== counts.frozen || project.pendingCount !== counts.pending || project.waitingQaCount !== counts.waitingQa || project.relinkCount !== counts.relink || project.materializingCount !== counts.materializing || project.collectingCount !== counts.collecting || project.technicalCount !== counts.technical || project.waitingSeedCount !== counts.waitingSeed || project.failedCount !== counts.failed;
    const changed = domainChanged || versionChanged || countersStale || project.stateVersion <= 1;
    if (changed) {
      const at = now();
      await db.update(automaticProjects).set({
        activeVersion: effectiveVersion,
        projectDomain: domain,
        stateVersion: Math.max(2, project.stateVersion + 1),
        totalItems: counts.total,
        approvedCount: counts.approved,
        frozenCount: counts.frozen,
        collectingCount: counts.collecting,
        materializingCount: counts.materializing,
        waitingQaCount: counts.waitingQa,
        relinkCount: counts.relink,
        technicalCount: counts.technical,
        waitingSeedCount: counts.waitingSeed,
        failedCount: counts.failed,
        pendingCount: counts.pending,
        pipelineStatus: project.pipelineStatus === "CONCLUIDO" || project.pipelineStatus === "CANCELADO" ? project.pipelineStatus : pipeline.pipelineStatus,
        nextAction: project.pipelineStatus === "CONCLUIDO" || project.pipelineStatus === "CANCELADO" ? project.nextAction : pipeline.nextAction,
        readyAt: project.readyAt || project.createdAt,
        originalReadyAt: project.originalReadyAt || project.createdAt,
        lastAction: "LEGACY_BACKFILL_V58",
        updatedAt: at,
      }).where(eq(automaticProjects.id, project.id));
      if (domainChanged) {
        await db.update(automaticProjectItems).set({ itemDomain: domain }).where(and(eq(automaticProjectItems.projectId, project.id), eq(automaticProjectItems.version, effectiveVersion), or(eq(automaticProjectItems.itemDomain, "GENERAL"), sql`${automaticProjectItems.itemDomain} IS NULL`, eq(automaticProjectItems.itemDomain, ""))));
      }
    }
    results.push({ project_id: project.id, changed, previous_active_version: project.activeVersion, active_version: effectiveVersion, previous_domain: project.projectDomain, domain, counts, state_version: changed ? Math.max(2, project.stateVersion + 1) : project.stateVersion });
  }
  return { projects_scanned: projects.length, projects_changed: results.filter((row) => row.changed === true).length, results };
}

export async function refreshProjectSummary(projectId: string, options: { bumpVersion?: boolean; lastAction?: string; lastFrozenAt?: Date | null } = {}) {
  const db = getDb();
  const [project] = await db.select({ id: automaticProjects.id, activeVersion: automaticProjects.activeVersion, stateVersion: automaticProjects.stateVersion, productionRevision: automaticProjects.productionRevision }).from(automaticProjects).where(eq(automaticProjects.id, projectId)).limit(1);
  if (!project) throw new Error("PROJECT_NOT_FOUND");
  const rows = await db.select({ status: automaticProjectItems.status }).from(automaticProjectItems).where(and(eq(automaticProjectItems.projectId, projectId), eq(automaticProjectItems.version, project.activeVersion)));
  const counts = countsFromStatuses(rows.map((row) => row.status));
  const nextVersion = project.stateVersion + (options.bumpVersion === false ? 0 : 1);
  await db.update(automaticProjects).set({
    stateVersion: nextVersion,
    ...(options.bumpVersion === false ? {} : { productionRevision: sql`${automaticProjects.productionRevision} + 1` }),
    totalItems: counts.total,
    approvedCount: counts.approved,
    frozenCount: counts.frozen,
    collectingCount: counts.collecting,
    materializingCount: counts.materializing,
    waitingQaCount: counts.waitingQa,
    relinkCount: counts.relink,
    technicalCount: counts.technical,
    waitingSeedCount: counts.waitingSeed,
    failedCount: counts.failed,
    pendingCount: counts.pending,
    ...(options.lastAction ? { lastAction: options.lastAction } : {}),
    ...(options.lastFrozenAt !== undefined ? { lastFrozenAt: options.lastFrozenAt } : {}),
    updatedAt: now(),
  }).where(eq(automaticProjects.id, projectId));
  return { project_id: projectId, project_version: nextVersion, counts };
}

export async function bumpProjectVersion(projectId: string, lastAction?: string) {
  const db = getDb();
  await db.update(automaticProjects).set({ stateVersion: sql`${automaticProjects.stateVersion} + 1`, productionRevision: sql`${automaticProjects.productionRevision} + 1`, ...(lastAction ? { lastAction } : {}), updatedAt: now() }).where(eq(automaticProjects.id, projectId));
  const [row] = await db.select({ stateVersion: automaticProjects.stateVersion }).from(automaticProjects).where(eq(automaticProjects.id, projectId)).limit(1);
  return row?.stateVersion || 0;
}

export async function getOperationalSnapshot(projectId: string, sinceVersion = 0, packetLimit = 20) {
  const db = getDb();
  const [project] = await db.select().from(automaticProjects).where(eq(automaticProjects.id, projectId)).limit(1);
  if (!project) throw new Error("PROJECT_NOT_FOUND");
  const version = project.stateVersion || 1;
  if (sinceVersion > 0 && sinceVersion >= version) return { changed:false, project_id:projectId, version };
  const limit = Math.max(1, Math.min(20, Number(packetLimit) || 20));
  // V59: control plane mínimo. Nada de perfis completos, breakers históricos,
  // métricas históricas ou capacity planning nesta rota quente; esses dados vivem no painel operacional.
  const [decisionsRaw, qaRaw, relinksRaw, technicalRaw] = await Promise.all([
    db.select({ id:supervisorDecisionQueue.id,itemId:supervisorDecisionQueue.itemId,candidateId:supervisorDecisionQueue.candidateId,type:supervisorDecisionQueue.type,priority:supervisorDecisionQueue.priority,evidence:supervisorDecisionQueue.evidence,allowedActions:supervisorDecisionQueue.allowedActions,createdAt:supervisorDecisionQueue.createdAt }).from(supervisorDecisionQueue).where(and(eq(supervisorDecisionQueue.projectId,projectId),eq(supervisorDecisionQueue.state,"PENDENTE"))).orderBy(desc(supervisorDecisionQueue.priority),asc(supervisorDecisionQueue.createdAt)).limit(limit).catch(()=>[]),
    db.select({ id:supervisorProjectCandidates.id,itemId:supervisorProjectCandidates.itemId,materializationFileId:supervisorProjectCandidates.materializationFileId,source:supervisorProjectCandidates.source,originalUrl:supervisorProjectCandidates.originalUrl,host:supervisorProjectCandidates.host,mimeType:supervisorProjectCandidates.mimeType,width:supervisorProjectCandidates.width,height:supervisorProjectCandidates.height,status:supervisorProjectCandidates.status,createdAt:supervisorProjectCandidates.createdAt }).from(supervisorProjectCandidates).where(and(eq(supervisorProjectCandidates.projectId,projectId),eq(supervisorProjectCandidates.status,"PARA_QA_VISUAL"))).orderBy(asc(supervisorProjectCandidates.createdAt)).limit(limit).catch(()=>[]),
    db.select({ id:automaticProjectItems.id,itemKey:automaticProjectItems.itemKey,targetFile:automaticProjectItems.targetFile,term:automaticProjectItems.term,semanticReference:automaticProjectItems.semanticReference,universe:automaticProjectItems.universe,failureReason:automaticProjectItems.failureReason,attempts:automaticProjectItems.attempts,updatedAt:automaticProjectItems.updatedAt }).from(automaticProjectItems).where(and(eq(automaticProjectItems.projectId,projectId),eq(automaticProjectItems.version,project.activeVersion),eq(automaticProjectItems.status,"RELINK_REQUIRED"))).orderBy(asc(automaticProjectItems.stageReadyAt),asc(automaticProjectItems.priority)).limit(limit).catch(()=>[]),
    db.select({ id:automaticProjectItems.id,itemKey:automaticProjectItems.itemKey,targetFile:automaticProjectItems.targetFile,term:automaticProjectItems.term,status:automaticProjectItems.status,failureReason:automaticProjectItems.failureReason,updatedAt:automaticProjectItems.updatedAt }).from(automaticProjectItems).where(and(eq(automaticProjectItems.projectId,projectId),eq(automaticProjectItems.version,project.activeVersion),or(eq(automaticProjectItems.status,"TECHNICAL_CORRECTION_REQUIRED"),eq(automaticProjectItems.status,"CORRECAO_TECNICA_PERMITIDA")))).orderBy(asc(automaticProjectItems.stageReadyAt),asc(automaticProjectItems.priority)).limit(limit).catch(()=>[]),
  ]);
  const decisions=Array.isArray(decisionsRaw)?decisionsRaw:[], qa=Array.isArray(qaRaw)?qaRaw:[], relinks=Array.isArray(relinksRaw)?relinksRaw:[], technical=Array.isArray(technicalRaw)?technicalRaw:[];
  const counts={ total:project.totalItems||0, approved:project.approvedCount||0, frozen:project.frozenCount||0, collecting:project.collectingCount||0, materializing:project.materializingCount||0, waiting_qa:project.waitingQaCount||0, relink:project.relinkCount||0, technical:project.technicalCount||0, waiting_seed:project.waitingSeedCount||0, failed:project.failedCount||0, pending:project.pendingCount||0 };
  const nextActions=[counts.collecting?"COLETAR":null,counts.materializing?"MATERIALIZAR":null,counts.waiting_qa?"QA_VISUAL":null,counts.relink?"RELINK":null,counts.technical?"CORRECAO_TECNICA":null,counts.pending===0&&counts.total>0?"GERAR_ZIP":null].filter(Boolean);
  return {
    changed:true, project_id:projectId, version, status:project.status, pipeline_status:project.pipelineStatus, domain:project.projectDomain, counts,
    lease:{ execution_id:project.supervisorExecutionId||null,status:project.supervisorStatus||null,expires_at:project.supervisorLeaseExpiresAt||null },
    next_actions:nextActions,
    work_packet:{ qa, relink:relinks, technical, source_decisions:decisions.filter((decision)=>!["SOURCE_FAILURE","MATERIALIZATION_FAILURE"].includes(decision.type)) },
    updated_at:project.updatedAt,
  };
}

export async function beginOperation(operationId: string, tool: string, projectId?: string | null) {
  const db = getDb();
  const [existing] = await db.select().from(operationResults).where(eq(operationResults.operationId, operationId)).limit(1);
  if (existing) return existing;
  const date = now();
  await db.insert(operationResults).values({ operationId, tool, projectId: projectId || null, status: "RUNNING", createdAt: date, updatedAt: date }).onConflictDoNothing();
  return null;
}

export async function completeOperation(operationId: string, result: unknown) {
  await getDb().update(operationResults).set({ status: "COMPLETED", resultJson: JSON.stringify(result), error: null, updatedAt: now() }).where(eq(operationResults.operationId, operationId));
}

export async function failOperation(operationId: string, error: unknown) {
  await getDb().update(operationResults).set({ status: "FAILED", error: error instanceof Error ? error.message : String(error), updatedAt: now() }).where(eq(operationResults.operationId, operationId));
}

export async function getOperationResult(operationId: string) {
  const [row] = await getDb().select().from(operationResults).where(eq(operationResults.operationId, operationId)).limit(1);
  if (!row) return { found: false, operation_id: operationId };
  let result: unknown = null;
  try { result = row.resultJson ? JSON.parse(row.resultJson) : null; } catch { result = row.resultJson; }
  return { found: true, operation_id: row.operationId, tool: row.tool, project_id: row.projectId, status: row.status, result, error: row.error, created_at: row.createdAt, updated_at: row.updatedAt };
}

export async function getLatestOperationResult(projectId: string, tool: string) {
  const [row] = await getDb().select().from(operationResults).where(and(eq(operationResults.projectId, projectId), eq(operationResults.tool, tool))).orderBy(desc(operationResults.updatedAt)).limit(1);
  if (!row) return { found:false, project_id:projectId, tool };
  return getOperationResult(row.operationId);
}

async function updateRouteMetric(input: { universe?: string | null; compositionClass?: string | null; sourceId?: string | null; sourceName: string; host?: string | null; attempts?: number; materialized?: number; approved?: number; rejected?: number; technicalFailures?: number; semanticFailures?: number; durationMs?: number }) {
  const universe = (input.universe || "*").trim().toUpperCase() || "*";
  const composition = (input.compositionClass || "*").trim().toUpperCase() || "*";
  const sourceName = input.sourceName.trim() || "UNKNOWN";
  const host = (input.host || "*").trim().toLowerCase() || "*";
  const id = `${universe}::${composition}::${sourceName.toLowerCase()}::${host}`.slice(0,190);
  const db = getDb();
  const [current] = await db.select().from(sourceRouteMetrics).where(eq(sourceRouteMetrics.id, id)).limit(1);
  const base = current || { attempts:0, materialized:0, approved:0, rejected:0, technicalFailures:0, semanticFailures:0, totalDurationMs:0 };
  const next = {
    attempts: base.attempts + Math.max(0,input.attempts||0),
    materialized: base.materialized + Math.max(0,input.materialized||0),
    approved: base.approved + Math.max(0,input.approved||0),
    rejected: base.rejected + Math.max(0,input.rejected||0),
    technicalFailures: base.technicalFailures + Math.max(0,input.technicalFailures||0),
    semanticFailures: base.semanticFailures + Math.max(0,input.semanticFailures||0),
    totalDurationMs: base.totalDurationMs + Math.max(0,input.durationMs||0),
  };
  const approval = next.materialized ? next.approved / next.materialized : 0;
  const technical = next.attempts ? Math.min(1,next.materialized / next.attempts) : 0;
  const avgMs = next.attempts ? next.totalDurationMs / next.attempts : 0;
  const speed = Math.max(0.2, Math.min(1, 5000 / Math.max(500, avgMs || 500)));
  const failurePenalty = next.attempts ? (next.technicalFailures + next.semanticFailures) / next.attempts : (next.technicalFailures + next.semanticFailures ? 1 : 0);
  const score = Math.round(1000 * (0.5*approval + 0.35*technical + 0.15*speed - 0.25*Math.min(1,failurePenalty)));
  await db.insert(sourceRouteMetrics).values({ id, universe, compositionClass: composition, sourceId: input.sourceId || null, sourceName, host, ...next, score, updatedAt: now() }).onConflictDoUpdate({ target: sourceRouteMetrics.id, set: { sourceId: input.sourceId || current?.sourceId || null, ...next, score, updatedAt: now() } });
  routeRankingCache.clear();
  return { id, score, ...next };
}

export async function recordRouteMetric(input: { universe?: string | null; compositionClass?: string | null; sourceId?: string | null; sourceName: string; host?: string | null; outcome: "attempt"|"materialized"|"approved"|"rejected"|"technical_failure"|"semantic_failure"; durationMs?: number }) {
  return updateRouteMetric({
    ...input,
    attempts: input.outcome === "attempt" ? 1 : 0,
    materialized: input.outcome === "materialized" ? 1 : 0,
    approved: input.outcome === "approved" ? 1 : 0,
    rejected: input.outcome === "rejected" ? 1 : 0,
    technicalFailures: input.outcome === "technical_failure" ? 1 : 0,
    semanticFailures: input.outcome === "semantic_failure" ? 1 : 0,
  });
}

export async function recordRouteRun(input: { universe?: string | null; compositionClass?: string | null; sourceId?: string | null; sourceName: string; host?: string | null; attempts: number; materialized: number; technicalFailures?: number; durationMs?: number }) {
  return updateRouteMetric({ ...input, technicalFailures: input.technicalFailures || 0 });
}

const routeRankingCache = new Map<string,{ at:number; rows:Array<typeof sourceRouteMetrics.$inferSelect> }>();

export async function getRouteRanking(universe?: string, compositionClass?: string, limit = 50) {
  const max = Math.max(1, Math.min(200, limit));
  const key = `${(universe||"*").toUpperCase()}::${(compositionClass||"*").toUpperCase()}::${max}`;
  const cached = routeRankingCache.get(key);
  if (cached && Date.now()-cached.at < 30_000) return cached.rows;
  const conditions = [];
  if (universe) conditions.push(eq(sourceRouteMetrics.universe, universe.toUpperCase()));
  if (compositionClass) conditions.push(eq(sourceRouteMetrics.compositionClass, compositionClass.toUpperCase()));
  const rows = await getDb().select().from(sourceRouteMetrics).where(conditions.length ? and(...conditions) : undefined).orderBy(desc(sourceRouteMetrics.score), desc(sourceRouteMetrics.updatedAt)).limit(max);
  routeRankingCache.set(key,{at:Date.now(),rows});
  return rows;
}

export async function getMcpPerformanceSummary(hours = 24) {
  const since = new Date(Date.now() - Math.max(1, Math.min(720, hours))*60*60_000);
  const rows = await getDb().select().from(mcpAudit).where(gte(mcpAudit.createdAt, since)).orderBy(desc(mcpAudit.createdAt)).limit(5000);
  const durations = rows.map((row)=>row.durationMs || 0).filter((value)=>value>=0).sort((a,b)=>a-b);
  const percentile = (p:number) => durations.length ? durations[Math.min(durations.length-1, Math.floor((durations.length-1)*p))] : 0;
  const byTool = new Map<string,{calls:number,total:number,max:number,bytes:number}>();
  for (const row of rows) { const x=byTool.get(row.tool)||{calls:0,total:0,max:0,bytes:0}; x.calls+=1; x.total+=row.durationMs||0; x.max=Math.max(x.max,row.durationMs||0); x.bytes+=row.responseBytes||0; byTool.set(row.tool,x); }
  const tools=[...byTool.entries()].map(([tool,v])=>({tool,calls:v.calls,avg_ms:Math.round(v.total/Math.max(1,v.calls)),max_ms:v.max,avg_response_bytes:Math.round(v.bytes/Math.max(1,v.calls))})).sort((a,b)=>b.avg_ms-a.avg_ms);
  const critical = rows.filter((row)=>(row.durationMs||0)>3000).length;
  const slow = rows.filter((row)=>(row.durationMs||0)>1000).length;
  const warnings = rows.filter((row)=>(row.durationMs||0)>300).length;
  return { period_hours:hours,calls:rows.length,p50_ms:percentile(.5),p95_ms:percentile(.95),p99_ms:percentile(.99),slow_over_1s:slow,critical_over_3s:critical,warn_over_300ms:warnings,top_slowest_tools:tools.slice(0,20),top_called_tools:[...tools].sort((a,b)=>b.calls-a.calls).slice(0,20),top_payloads:[...tools].sort((a,b)=>b.avg_response_bytes-a.avg_response_bytes).slice(0,20) };
}
