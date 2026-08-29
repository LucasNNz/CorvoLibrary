import { and, asc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { getDb } from "../db";
import { automaticProjectItems, automaticProjects, fastPushCandidates, operationResults, supervisorDecisionJobs, supervisorProjectCandidates } from "../db/schema";
import { qaAutomaticProject } from "./automatic-projects";
import { getOperationalSnapshot, refreshProjectSummary } from "./performance-control";
import { syncWorkerItemsQueue } from "./worker-orchestration";

const MAX_DECISIONS = 200;
const MAX_FAST_APPROVE_ITEMS = 100;
const DECISION_SLICE = 12;
const JOB_LEASE_MS = 45_000;
const MAX_ATTEMPTS = 5;

const now = () => new Date();
const clean = (value: unknown) => typeof value === "string" ? value.trim() : "";
const makeId = (prefix: string) => `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
const parse = <T,>(value: string | null | undefined, fallback: T): T => { try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; } };

export type SupervisorQueuedDecision = {
  item_id: string;
  status: string;
  observacao: string | null;
};

export type FastApproveProjectItem = {
  item_id: string;
  candidate_id: string;
  observacao: string | null;
};

export type FastCandidateDecision = {
  item_id: string | null;
  candidate_id: string | null;
  action: "APROVADO" | "REJEITADO" | "RELINK_REQUIRED";
  reason: string | null;
  reject_all?: boolean;
};

type JobPayload = {
  project_id: string;
  decisions?: SupervisorQueuedDecision[];
  approvals?: FastApproveProjectItem[];
  fast_decisions?: FastCandidateDecision[];
  execution_id?: string | null;
  source?: string | null;
};

type JobProgress = {
  cursor: number;
  results: Array<Record<string, unknown>>;
  started_at?: string;
  last_error?: string | null;
};

function normalizeApprovals(raw: unknown): FastApproveProjectItem[] {
  const rows = Array.isArray(raw) ? raw : [];
  const out: FastApproveProjectItem[] = [];
  const seen = new Set<string>();
  for (const entry of rows) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const itemId = clean(row.item_id) || clean(row.project_item_id) || clean(row.pitem) || clean(row.target_file);
    const candidateId = clean(row.candidate_id) || clean(row.supervisor_candidate_id) || clean(row.fast_push_candidate_id);
    if (!itemId || !candidateId) continue;
    const normalized = { item_id: itemId, candidate_id: candidateId, observacao: clean(row.observacao) || clean(row.note) || clean(row.motivo) || null };
    if (seen.has(itemId)) {
      const index = out.findIndex((current) => current.item_id === itemId);
      if (index >= 0) out[index] = normalized;
    } else {
      seen.add(itemId);
      out.push(normalized);
    }
    if (out.length >= MAX_FAST_APPROVE_ITEMS) break;
  }
  return out;
}

function normalizeFastCandidateDecisions(raw: unknown): FastCandidateDecision[] {
  const rows = Array.isArray(raw) ? raw : [];
  const out: FastCandidateDecision[] = [];
  const indexByKey = new Map<string, number>();
  for (const entry of rows) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const itemId = clean(row.item_id) || clean(row.project_item_id) || clean(row.pitem) || clean(row.target_file) || null;
    const candidateId = clean(row.candidate_id) || clean(row.supervisor_candidate_id) || clean(row.fast_push_candidate_id) || null;
    if (!itemId && !candidateId) continue;
    const rawAction = (clean(row.action) || clean(row.acao)).toUpperCase();
    const action = rawAction === "APPROVE" || rawAction === "APROVAR" || rawAction === "APROVADO" ? "APROVADO"
      : rawAction === "RELINK" || rawAction === "RELINKAR" || rawAction === "RELINK_REQUIRED" ? "RELINK_REQUIRED"
      : rawAction === "REJECT" || rawAction === "REJEITAR" || rawAction === "REJEITADO" ? "REJEITADO" : null;
    if (!action) continue;
    const normalized: FastCandidateDecision = { item_id:itemId, candidate_id:candidateId, action, reason:clean(row.reason) || clean(row.motivo) || clean(row.observacao) || null, reject_all:row.reject_all === true || row.rejeitar_todas === true };
    const key = candidateId ? `candidate:${candidateId}` : `item:${itemId}`;
    const existing = indexByKey.get(key);
    if (existing !== undefined) out[existing] = normalized;
    else { indexByKey.set(key,out.length); out.push(normalized); }
    if (out.length >= MAX_DECISIONS) break;
  }
  return out;
}

function fastDecideAckPayload(operationId: string, projectId: string, decisions: FastCandidateDecision[], phase = "QUEUED", completed = 0) {
  const requested = { approve:0, reject:0, relink:0 };
  for (const decision of decisions) {
    if (decision.action === "APROVADO") requested.approve += 1;
    else if (decision.action === "REJEITADO") requested.reject += 1;
    else requested.relink += 1;
  }
  return {
    success:true, accepted:true, fast_ack:true, compact_ack:true, tool:"fast_decidir_candidatas_lote",
    operation_id:operationId, project_id:projectId, status:phase, phase,
    accepted_count:decisions.length, completed_count:completed, pending_count:Math.max(0,decisions.length-completed),
    requested_approve:requested.approve, requested_reject:requested.reject, requested_relink:requested.relink,
    recovery:{tool:"obter_resultado_operacao",operation_id:operationId},
  };
}

function fastApproveAckPayload(operationId: string, projectId: string, total: number, phase = "QUEUED", completed = 0) {
  return {
    success: true,
    accepted: true,
    fast_ack: true,
    compact_ack: true,
    tool: "FAST_APPROVE_PROJECT_ITEMS",
    operation_id: operationId,
    project_id: projectId,
    status: phase,
    phase,
    queued_items: total,
    completed_items: completed,
    pending_items: Math.max(0, total - completed),
    recovery: { tool: "obter_resultado_operacao", operation_id: operationId },
  };
}

function ackForJob(job: typeof supervisorDecisionJobs.$inferSelect, total: number, phase = "QUEUED", completed = 0) {
  if (job.kind === "FAST_APPROVE_PROJECT_ITEMS") return fastApproveAckPayload(job.operationId, job.projectId, total, phase, completed);
  if (job.kind === "FAST_DECIDE_PROJECT_CANDIDATES") {
    const payload = parse<JobPayload>(job.payloadJson, { project_id:job.projectId, fast_decisions:[] });
    return fastDecideAckPayload(job.operationId, job.projectId, normalizeFastCandidateDecisions(payload.fast_decisions), phase, completed);
  }
  return ackPayload(job.operationId, job.projectId, total, phase, completed);
}

function normalizeDecisions(raw: unknown): SupervisorQueuedDecision[] {
  const rows = Array.isArray(raw) ? raw : [];
  const out: SupervisorQueuedDecision[] = [];
  const seen = new Set<string>();
  for (const entry of rows) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const itemId = clean(row.item_id);
    if (!itemId) continue;
    // The last decision for the same item wins inside one logical operation.
    const statusRaw = clean(row.status).toUpperCase();
    const status = statusRaw === "APROVADO" ? "APROVADO"
      : statusRaw === "RELINK_REQUIRED" ? "RELINK_REQUIRED"
      : statusRaw === "CORRECAO_TECNICA_PERMITIDA" ? "CORRECAO_TECNICA_PERMITIDA"
      : "REJEITADO";
    const normalized = { item_id: itemId, status, observacao: clean(row.observacao) || null };
    if (seen.has(itemId)) {
      const index = out.findIndex((current) => current.item_id === itemId);
      if (index >= 0) out[index] = normalized;
    } else {
      seen.add(itemId);
      out.push(normalized);
    }
    if (out.length >= MAX_DECISIONS) break;
  }
  return out;
}

function ackPayload(operationId: string, projectId: string, total: number, phase = "QUEUED", completed = 0) {
  return {
    success: true,
    accepted: true,
    fast_ack: true,
    operation_id: operationId,
    project_id: projectId,
    status: phase,
    phase,
    queued_decisions: total,
    completed_decisions: completed,
    pending_decisions: Math.max(0, total - completed),
    // Compatibility with the V59/V56 compact batch response. The authoritative
    // next packet is produced when finalization completes in the Data Plane.
    next_work_packet: { qa: [], relink: [], technical: [], source_decisions: [] },
    next_actions: [],
    recovery: { tool: "obter_resultado_operacao", operation_id: operationId },
  };
}

export async function enqueueSupervisorDecisionBatch(input: {
  operationId: string;
  projectId: string;
  decisions: unknown;
  executionId?: string | null;
  source?: string | null;
}) {
  const operationId = clean(input.operationId);
  const projectId = clean(input.projectId);
  if (!operationId) throw new Error("OPERATION_ID_REQUIRED");
  if (!projectId) throw new Error("PROJECT_ID_REQUIRED");
  const decisions = normalizeDecisions(input.decisions);
  if (!decisions.length) throw new Error("DECISOES_REQUIRED");

  const db = getDb();
  const [project] = await db.select({ id: automaticProjects.id }).from(automaticProjects).where(eq(automaticProjects.id, projectId)).limit(1);
  if (!project) throw new Error("PROJECT_NOT_FOUND");

  const [existingOperation] = await db.select().from(operationResults).where(eq(operationResults.operationId, operationId)).limit(1);
  if (existingOperation) {
    if (existingOperation.tool !== "aplicar_decisoes_supervisor_lote") throw new Error(`OPERATION_ID_ALREADY_USED_BY:${existingOperation.tool}`);
    const existingResult = parse<Record<string, unknown>>(existingOperation.resultJson, {});
    return { ...existingResult, operation_id: operationId, operation_status: existingOperation.status, idempotent_replay: true };
  }

  const date = now();
  const payload: JobPayload = { project_id: projectId, decisions, execution_id: clean(input.executionId) || null, source: clean(input.source) || "SUPERVISOR_MCP" };
  const ack = ackPayload(operationId, projectId, decisions.length);
  const jobId = makeId("QAJOB");
  // D1 batch is transactional: operation receipt and durable job become visible together.
  await db.batch([
    db.insert(operationResults).values({
      operationId, tool: "aplicar_decisoes_supervisor_lote", projectId, status: "RUNNING",
      resultJson: JSON.stringify(ack), error: null, createdAt: date, updatedAt: date,
    }).onConflictDoNothing(),
    db.insert(supervisorDecisionJobs).values({
      id: jobId, operationId, projectId, kind: "PROJECT_QA", status: "QUEUED",
      payloadJson: JSON.stringify(payload), progressJson: JSON.stringify({ cursor: 0, results: [] } satisfies JobProgress),
      attempts: 0, createdAt: date, updatedAt: date,
    }).onConflictDoNothing(),
  ]);

  const [job] = await db.select({ id: supervisorDecisionJobs.id, status: supervisorDecisionJobs.status }).from(supervisorDecisionJobs).where(eq(supervisorDecisionJobs.operationId, operationId)).limit(1);
  if (!job) throw new Error("FAST_DECISION_JOB_PERSISTENCE_FAILED");
  return { ...ack, job_id: job.id, job_status: job.status, idempotent_replay: false };
}

export async function enqueueFastApproveProjectItems(input: {
  operationId: string;
  projectId: string;
  items: unknown;
  executionId?: string | null;
  source?: string | null;
}) {
  const operationId = clean(input.operationId);
  const projectId = clean(input.projectId);
  if (!operationId) throw new Error("OPERATION_ID_REQUIRED");
  if (!projectId) throw new Error("PROJECT_ID_REQUIRED");
  const approvals = normalizeApprovals(input.items);
  if (!approvals.length) throw new Error("ITENS_REQUIRED");

  const db = getDb();
  const [project] = await db.select({ id: automaticProjects.id }).from(automaticProjects).where(eq(automaticProjects.id, projectId)).limit(1);
  if (!project) throw new Error("PROJECT_NOT_FOUND");

  const [existingOperation] = await db.select().from(operationResults).where(eq(operationResults.operationId, operationId)).limit(1);
  if (existingOperation) {
    if (existingOperation.tool !== "FAST_APPROVE_PROJECT_ITEMS") throw new Error(`OPERATION_ID_ALREADY_USED_BY:${existingOperation.tool}`);
    const existingResult = parse<Record<string, unknown>>(existingOperation.resultJson, {});
    return { ...existingResult, operation_id: operationId, operation_status: existingOperation.status, idempotent_replay: true };
  }

  const date = now();
  const payload: JobPayload = { project_id: projectId, approvals, execution_id: clean(input.executionId) || null, source: clean(input.source) || "SUPERVISOR_MCP" };
  const ack = fastApproveAckPayload(operationId, projectId, approvals.length);
  const jobId = makeId("QAJOB");
  await db.batch([
    db.insert(operationResults).values({
      operationId, tool: "FAST_APPROVE_PROJECT_ITEMS", projectId, status: "RUNNING",
      resultJson: JSON.stringify(ack), error: null, createdAt: date, updatedAt: date,
    }).onConflictDoNothing(),
    db.insert(supervisorDecisionJobs).values({
      id: jobId, operationId, projectId, kind: "FAST_APPROVE_PROJECT_ITEMS", status: "QUEUED",
      payloadJson: JSON.stringify(payload), progressJson: JSON.stringify({ cursor: 0, results: [] } satisfies JobProgress),
      attempts: 0, createdAt: date, updatedAt: date,
    }).onConflictDoNothing(),
  ]);

  const [job] = await db.select({ id: supervisorDecisionJobs.id, status: supervisorDecisionJobs.status }).from(supervisorDecisionJobs).where(eq(supervisorDecisionJobs.operationId, operationId)).limit(1);
  if (!job) throw new Error("FAST_APPROVE_JOB_PERSISTENCE_FAILED");
  return { ...ack, job_id: job.id, job_status: job.status, idempotent_replay: false };
}

export async function enqueueFastCandidateDecisionBatch(input: {
  operationId:string;
  projectId:string;
  decisions:unknown;
  executionId?:string|null;
  source?:string|null;
}) {
  const operationId=clean(input.operationId),projectId=clean(input.projectId);
  if(!operationId) throw new Error("OPERATION_ID_REQUIRED");
  if(!projectId) throw new Error("PROJECT_ID_REQUIRED");
  const decisions=normalizeFastCandidateDecisions(input.decisions);
  if(!decisions.length) throw new Error("DECISOES_REQUIRED");
  const db=getDb();
  const [project]=await db.select({id:automaticProjects.id}).from(automaticProjects).where(eq(automaticProjects.id,projectId)).limit(1);
  if(!project) throw new Error("PROJECT_NOT_FOUND");
  const [existing]=await db.select().from(operationResults).where(eq(operationResults.operationId,operationId)).limit(1);
  if(existing){if(existing.tool!=="fast_decidir_candidatas_lote") throw new Error(`OPERATION_ID_ALREADY_USED_BY:${existing.tool}`); const prior=parse<Record<string,unknown>>(existing.resultJson,{}); return {...prior,operation_id:operationId,operation_status:existing.status,idempotent_replay:true};}
  const date=now(),payload:JobPayload={project_id:projectId,fast_decisions:decisions,execution_id:clean(input.executionId)||null,source:clean(input.source)||"SUPERVISOR_MCP"},ack=fastDecideAckPayload(operationId,projectId,decisions),jobId=makeId("QAJOB");
  await db.batch([
    db.insert(operationResults).values({operationId,tool:"fast_decidir_candidatas_lote",projectId,status:"RUNNING",resultJson:JSON.stringify(ack),error:null,createdAt:date,updatedAt:date}).onConflictDoNothing(),
    db.insert(supervisorDecisionJobs).values({id:jobId,operationId,projectId,kind:"FAST_DECIDE_PROJECT_CANDIDATES",status:"QUEUED",payloadJson:JSON.stringify(payload),progressJson:JSON.stringify({cursor:0,results:[]} satisfies JobProgress),attempts:0,createdAt:date,updatedAt:date}).onConflictDoNothing(),
  ]);
  const [job]=await db.select({id:supervisorDecisionJobs.id,status:supervisorDecisionJobs.status}).from(supervisorDecisionJobs).where(eq(supervisorDecisionJobs.operationId,operationId)).limit(1);
  if(!job) throw new Error("FAST_DECIDE_JOB_PERSISTENCE_FAILED");
  return {...ack,job_id:job.id,job_status:job.status,idempotent_replay:false};
}

async function requeueStaleJobs() {
  const date = now();
  await getDb().update(supervisorDecisionJobs).set({
    status: "QUEUED", leaseOwner: null, leaseExpiresAt: null, updatedAt: date,
  }).where(and(
    eq(supervisorDecisionJobs.status, "RUNNING"),
    or(lt(supervisorDecisionJobs.leaseExpiresAt, date), sql`${supervisorDecisionJobs.leaseExpiresAt} IS NULL`),
  )).catch(() => undefined);
}

async function claimJob(source: string) {
  const db = getDb();
  const [candidate] = await db.select().from(supervisorDecisionJobs)
    .where(eq(supervisorDecisionJobs.status, "QUEUED"))
    .orderBy(asc(supervisorDecisionJobs.createdAt)).limit(1);
  if (!candidate) return null;
  const date = now(), leaseOwner = `${source}:${crypto.randomUUID().slice(0, 8)}`;
  const leaseExpiresAt = new Date(date.getTime() + JOB_LEASE_MS);
  const [claimed] = await db.update(supervisorDecisionJobs).set({
    status: "RUNNING", attempts: sql`${supervisorDecisionJobs.attempts} + 1`, leaseOwner, leaseExpiresAt,
    startedAt: candidate.startedAt || date, updatedAt: date,
  }).where(and(eq(supervisorDecisionJobs.id, candidate.id), eq(supervisorDecisionJobs.status, "QUEUED"))).returning();
  return claimed || null;
}

async function persistProgress(job: typeof supervisorDecisionJobs.$inferSelect, progress: JobProgress, total: number) {
  const db = getDb(), date = now();
  const ack = ackForJob(job, total, "PROCESSING", progress.cursor);
  await db.batch([
    db.update(supervisorDecisionJobs).set({
      status: "QUEUED", progressJson: JSON.stringify(progress), leaseOwner: null, leaseExpiresAt: null, updatedAt: date,
    }).where(eq(supervisorDecisionJobs.id, job.id)),
    db.update(operationResults).set({ status: "RUNNING", resultJson: JSON.stringify(ack), error: null, updatedAt: date }).where(eq(operationResults.operationId, job.operationId)),
  ]);
  return ack;
}

async function completeJob(job: typeof supervisorDecisionJobs.$inferSelect, progress: JobProgress, appliedRecord: Record<string, unknown>) {
  const db = getDb(), date = now();
  const changedItems = progress.results;
  const changedIds = [...new Set(changedItems.map((row) => clean(row.item_id)).filter(Boolean))];
  await syncWorkerItemsQueue(job.projectId, changedIds).catch(() => undefined);
  const snapshot = await getOperationalSnapshot(job.projectId, 0, 20).catch(() => null);
  const finalResult = job.kind === "FAST_DECIDE_PROJECT_CANDIDATES" ? (() => {
    const failed = changedItems.filter((row) => row.failed === true || ["FAILED","NO_ACTIVE_CANDIDATE","NO_ACTIVE_CANDIDATES","AMBIGUOUS_REQUIRES_CANDIDATE_ID","ITEM_FROZEN_LOCKED"].includes(clean(row.status).toUpperCase())).length;
    return {success:true,accepted:true,fast_ack:true,compact_ack:true,tool:"fast_decidir_candidatas_lote",operation_id:job.operationId,project_id:job.projectId,status:"COMPLETED",phase:"COMPLETED",accepted_count:changedItems.length,approved_count:changedItems.filter((row)=>row.action==="APPROVE"&&clean(row.status).toUpperCase()==="APPROVED").length,rejected_count:changedItems.filter((row)=>row.action==="REJECT"&&row.failed!==true).length,relink_count:changedItems.filter((row)=>row.action==="RELINK"&&clean(row.status).toUpperCase()==="RELINK_REQUIRED").length,failed_count:failed,project_version:Number(appliedRecord.project_version)||Number(snapshot?.version)||0,updated_counts:appliedRecord.project_counts&&typeof appliedRecord.project_counts==="object"?appliedRecord.project_counts:snapshot?.counts||{},lease:snapshot?.lease||null};
  })() : job.kind === "FAST_APPROVE_PROJECT_ITEMS" ? {
    success: true,
    accepted: true,
    fast_ack: true,
    compact_ack: true,
    tool: "FAST_APPROVE_PROJECT_ITEMS",
    operation_id: job.operationId,
    project_id: job.projectId,
    status: "COMPLETED",
    phase: "COMPLETED",
    queued_items: progress.results.length,
    completed_items: progress.results.length,
    pending_items: 0,
    approved_count: changedItems.filter((row) => clean(row.status).toUpperCase() === "APPROVED").length,
    project_version: Number(appliedRecord.project_version) || Number(snapshot?.version) || 0,
    project_counts: appliedRecord.project_counts && typeof appliedRecord.project_counts === "object" ? appliedRecord.project_counts : snapshot?.counts || {},
    lease: snapshot?.lease || null,
  } : {
    success: true,
    accepted: true,
    fast_ack: true,
    operation_id: job.operationId,
    project_id: job.projectId,
    status: "COMPLETED",
    phase: "COMPLETED",
    queued_decisions: progress.results.length,
    completed_decisions: progress.results.length,
    pending_decisions: 0,
    changed_items: changedItems,
    project_version: Number(appliedRecord.project_version) || Number(snapshot?.version) || 0,
    project_counts: appliedRecord.project_counts && typeof appliedRecord.project_counts === "object" ? appliedRecord.project_counts : snapshot?.counts || {},
    next_work_packet: snapshot?.work_packet || { qa: [], relink: [], technical: [], source_decisions: [] },
    next_actions: snapshot?.next_actions || [],
    lease: snapshot?.lease || null,
  };
  await db.batch([
    db.update(supervisorDecisionJobs).set({
      status: "COMPLETED", progressJson: JSON.stringify(progress), resultJson: JSON.stringify(finalResult),
      leaseOwner: null, leaseExpiresAt: null, completedAt: date, updatedAt: date,
    }).where(eq(supervisorDecisionJobs.id, job.id)),
    db.update(operationResults).set({ status: "COMPLETED", resultJson: JSON.stringify(finalResult), error: null, updatedAt: date }).where(eq(operationResults.operationId, job.operationId)),
  ]);
  return finalResult;
}

async function retryOrFailJob(job: typeof supervisorDecisionJobs.$inferSelect, progress: JobProgress, error: unknown, total: number) {
  const db = getDb(), date = now();
  const message = error instanceof Error ? error.message : String(error);
  const exhausted = job.attempts >= MAX_ATTEMPTS;
  progress.last_error = message;
  if (exhausted) {
    const result = { ...ackForJob(job, total, "FAILED", progress.cursor), success: false, error: message };
    await db.batch([
      db.update(supervisorDecisionJobs).set({ status: "FAILED", progressJson: JSON.stringify(progress), resultJson: JSON.stringify(result), leaseOwner: null, leaseExpiresAt: null, completedAt: date, updatedAt: date }).where(eq(supervisorDecisionJobs.id, job.id)),
      db.update(operationResults).set({ status: "FAILED", resultJson: JSON.stringify(result), error: message, updatedAt: date }).where(eq(operationResults.operationId, job.operationId)),
    ]);
    return result;
  }
  const result = { ...ackForJob(job, total, "RETRYING", progress.cursor), retry_attempt: job.attempts, last_error: message };
  await db.batch([
    db.update(supervisorDecisionJobs).set({ status: "QUEUED", progressJson: JSON.stringify(progress), leaseOwner: null, leaseExpiresAt: null, updatedAt: date }).where(eq(supervisorDecisionJobs.id, job.id)),
    db.update(operationResults).set({ status: "RUNNING", resultJson: JSON.stringify(result), error: null, updatedAt: date }).where(eq(operationResults.operationId, job.operationId)),
  ]);
  return result;
}

async function resolveProjectItemBySelector(projectId: string, selector: string) {
  const [item] = await getDb().select().from(automaticProjectItems).where(and(
    eq(automaticProjectItems.projectId, projectId),
    or(eq(automaticProjectItems.id, selector), eq(automaticProjectItems.itemKey, selector), eq(automaticProjectItems.targetFile, selector)),
  )).limit(1);
  if (!item) throw new Error(`PROJECT_ITEM_NOT_FOUND:${selector}`);
  return item;
}

async function resolveSupervisorCandidateForApproval(projectId: string, itemId: string, candidateId: string) {
  const db = getDb();
  let [bridge] = await db.select().from(supervisorProjectCandidates).where(eq(supervisorProjectCandidates.id, candidateId)).limit(1);
  if (!bridge) {
    const [fastCandidate] = await db.select().from(fastPushCandidates).where(eq(fastPushCandidates.id, candidateId)).limit(1);
    if (fastCandidate?.supervisorCandidateId) [bridge] = await db.select().from(supervisorProjectCandidates).where(eq(supervisorProjectCandidates.id, fastCandidate.supervisorCandidateId)).limit(1);
  }
  if (!bridge) throw new Error(`PROJECT_CANDIDATE_NOT_FOUND:${candidateId}`);
  if (bridge.projectId !== projectId) throw new Error(`CANDIDATE_PROJECT_MISMATCH:${candidateId}`);
  if (bridge.itemId !== itemId) throw new Error(`CANDIDATE_ITEM_MISMATCH:${candidateId}`);
  return bridge;
}

async function resolveSupervisorCandidateById(projectId:string,candidateId:string) {
  const db=getDb();
  let [bridge]=await db.select().from(supervisorProjectCandidates).where(eq(supervisorProjectCandidates.id,candidateId)).limit(1);
  if(!bridge){const [fastCandidate]=await db.select().from(fastPushCandidates).where(eq(fastPushCandidates.id,candidateId)).limit(1);if(fastCandidate?.supervisorCandidateId)[bridge]=await db.select().from(supervisorProjectCandidates).where(eq(supervisorProjectCandidates.id,fastCandidate.supervisorCandidateId)).limit(1);}
  if(!bridge) throw new Error(`PROJECT_CANDIDATE_NOT_FOUND:${candidateId}`);
  if(bridge.projectId!==projectId) throw new Error(`CANDIDATE_PROJECT_MISMATCH:${candidateId}`);
  return bridge;
}

async function activateDecisionCandidate(projectId:string,item:typeof automaticProjectItems.$inferSelect,bridge:typeof supervisorProjectCandidates.$inferSelect) {
  if(["APPROVED","FROZEN","LINKED_FROM_LIBRARY","LINKED_FROM_FAMILY"].includes(item.status)) throw new Error("ITEM_FROZEN_LOCKED");
  if(!["PARA_ANALISE","PARA_QA_VISUAL"].includes(clean(bridge.status).toUpperCase())) throw new Error(`CANDIDATE_NOT_ACTIVE:${bridge.status}`);
  const db=getDb(),date=now();
  await db.update(supervisorProjectCandidates).set({status:"PARA_ANALISE",updatedAt:date}).where(and(eq(supervisorProjectCandidates.projectId,projectId),eq(supervisorProjectCandidates.itemId,item.id),eq(supervisorProjectCandidates.status,"PARA_QA_VISUAL"),sql`${supervisorProjectCandidates.id} <> ${bridge.id}`));
  await db.update(supervisorProjectCandidates).set({status:"PARA_QA_VISUAL",updatedAt:date}).where(eq(supervisorProjectCandidates.id,bridge.id));
  await db.update(fastPushCandidates).set({projectLinkStatus:"LINKED_PARA_QA_VISUAL",supervisorCandidateId:bridge.id,linkedAt:date,updatedAt:date}).where(eq(fastPushCandidates.materializationItemId,bridge.materializationItemId)).catch(()=>undefined);
  await db.update(automaticProjectItems).set({status:"QA_READY",collectionCandidateId:bridge.collectionCandidateId||null,materializationBatchId:bridge.materializationBatchId,materializationItemId:bridge.materializationItemId,materializationFileId:bridge.materializationFileId,failureReason:null,updatedAt:date}).where(eq(automaticProjectItems.id,item.id));
  return bridge;
}

async function prepareFastApproveSelection(projectId: string, selection: FastApproveProjectItem) {
  const db = getDb();
  const item = await resolveProjectItemBySelector(projectId, selection.item_id);
  const bridge = await resolveSupervisorCandidateForApproval(projectId, item.id, selection.candidate_id);
  if (item.status === "APPROVED" && item.linkedAssetId) {
    return { item, bridge, alreadyApproved: true as const };
  }
  const bridgeStatus = clean(bridge.status).toUpperCase();
  if (!["PARA_ANALISE", "PARA_QA_VISUAL", "APROVADO"].includes(bridgeStatus)) throw new Error(`CANDIDATE_NOT_APPROVABLE:${bridgeStatus}`);
  const date = now();
  await db.update(supervisorProjectCandidates).set({ status: "PARA_ANALISE", updatedAt: date }).where(and(
    eq(supervisorProjectCandidates.projectId, projectId),
    eq(supervisorProjectCandidates.itemId, item.id),
    eq(supervisorProjectCandidates.status, "PARA_QA_VISUAL"),
    sql`${supervisorProjectCandidates.id} <> ${bridge.id}`
  ));
  await db.update(supervisorProjectCandidates).set({ status: "PARA_QA_VISUAL", updatedAt: date }).where(eq(supervisorProjectCandidates.id, bridge.id));
  await db.update(fastPushCandidates).set({ projectLinkStatus: "LINKED_PARA_ANALISE", updatedAt: date }).where(and(
    eq(fastPushCandidates.projectId, projectId),
    eq(fastPushCandidates.projectItemId, item.id),
    eq(fastPushCandidates.projectLinkStatus, "LINKED_PARA_QA_VISUAL"),
    sql`${fastPushCandidates.supervisorCandidateId} <> ${bridge.id}`
  )).catch(() => undefined);
  await db.update(fastPushCandidates).set({ projectLinkStatus: "LINKED_PARA_QA_VISUAL", supervisorCandidateId: bridge.id, linkedAt: date, updatedAt: date }).where(eq(fastPushCandidates.materializationItemId, bridge.materializationItemId)).catch(() => undefined);
  await db.update(automaticProjectItems).set({
    status: "QA_READY",
    collectionCandidateId: bridge.collectionCandidateId || null,
    materializationBatchId: bridge.materializationBatchId,
    materializationItemId: bridge.materializationItemId,
    materializationFileId: bridge.materializationFileId,
    failureReason: null,
    updatedAt: date,
  }).where(eq(automaticProjectItems.id, item.id));
  return { item, bridge, alreadyApproved: false as const };
}

async function processFastApproveClaim(job: typeof supervisorDecisionJobs.$inferSelect) {
  const payload = parse<JobPayload>(job.payloadJson, { project_id: job.projectId, approvals: [] });
  const approvals = normalizeApprovals(payload.approvals);
  const progress = parse<JobProgress>(job.progressJson, { cursor: 0, results: [] });
  if (!approvals.length) throw new Error("ITENS_REQUIRED");
  if (progress.cursor >= approvals.length) return completeJob(job, progress, {});
  if (!progress.started_at) progress.started_at = new Date().toISOString();

  const slice = approvals.slice(progress.cursor, progress.cursor + DECISION_SLICE);
  const decisions: SupervisorQueuedDecision[] = [];
  const passthrough: Array<Record<string, unknown>> = [];
  for (const selection of slice) {
    const prepared = await prepareFastApproveSelection(job.projectId, selection);
    if (prepared.alreadyApproved) {
      passthrough.push({ item_id: prepared.item.itemKey, status: "APPROVED", asset_id: prepared.item.linkedAssetId, candidate_id: prepared.bridge.id, idempotent: true });
      continue;
    }
    decisions.push({ item_id: prepared.item.id, status: "APROVADO", observacao: selection.observacao });
  }

  const changed: Array<Record<string, unknown>> = [...passthrough];
  let appliedRecord: Record<string, unknown> = {};
  if (decisions.length) {
    const applied = await qaAutomaticProject({ projeto_id: job.projectId, decisoes: decisions, processar_apos: false });
    appliedRecord = applied && typeof applied === "object" ? applied as Record<string, unknown> : {};
    const rows = Array.isArray(appliedRecord.resultados) ? appliedRecord.resultados as Array<Record<string, unknown>> : [];
    changed.push(...rows);
  }
  progress.results.push(...changed);
  progress.cursor += slice.length;
  progress.last_error = null;
  if (progress.cursor >= approvals.length) return completeJob(job, progress, appliedRecord);
  return persistProgress(job, progress, approvals.length);
}

async function processFastCandidateDecisionClaim(job: typeof supervisorDecisionJobs.$inferSelect) {
  const payload=parse<JobPayload>(job.payloadJson,{project_id:job.projectId,fast_decisions:[]}),all=normalizeFastCandidateDecisions(payload.fast_decisions),progress=parse<JobProgress>(job.progressJson,{cursor:0,results:[]});
  if(!all.length) throw new Error("DECISOES_REQUIRED");
  if(progress.cursor>=all.length) return completeJob(job,progress,{});
  if(!progress.started_at) progress.started_at=new Date().toISOString();
  const slice=all.slice(progress.cursor,progress.cursor+DECISION_SLICE),qaDecisions:SupervisorQueuedDecision[]=[],actionByItem=new Map<string,FastCandidateDecision["action"]>(),preResults:Array<Record<string,unknown>>=[];
  let directRelink=false;
  for(const decision of slice){
    try{
      let item:typeof automaticProjectItems.$inferSelect|undefined,bridge:typeof supervisorProjectCandidates.$inferSelect|undefined;
      if(decision.candidate_id){bridge=await resolveSupervisorCandidateById(job.projectId,decision.candidate_id); item=await resolveProjectItemBySelector(job.projectId,bridge.itemId); if(decision.item_id){const selected=await resolveProjectItemBySelector(job.projectId,decision.item_id);if(selected.id!==item.id) throw new Error(`CANDIDATE_ITEM_MISMATCH:${decision.candidate_id}`);}}
      else if(decision.item_id) item=await resolveProjectItemBySelector(job.projectId,decision.item_id);
      if(!item) throw new Error("PROJECT_ITEM_NOT_FOUND");
      if(decision.action==="APROVADO"&&item.status==="APPROVED"&&item.linkedAssetId){preResults.push({item_id:item.itemKey,action:"APPROVE",status:"APPROVED",asset_id:item.linkedAssetId,idempotent:true});continue;}
      if(!bridge){
        const active=await getDb().select().from(supervisorProjectCandidates).where(and(eq(supervisorProjectCandidates.projectId,job.projectId),eq(supervisorProjectCandidates.itemId,item.id),inArray(supervisorProjectCandidates.status,["PARA_QA_VISUAL","PARA_ANALISE"]))).orderBy(asc(supervisorProjectCandidates.createdAt));
        if(decision.action==="APROVADO"){
          if(active.length===0){preResults.push({item_id:item.itemKey,action:"APPROVE",status:"NO_ACTIVE_CANDIDATES",failed:true});continue;}
          if(active.length>1){preResults.push({item_id:item.itemKey,action:"APPROVE",status:"AMBIGUOUS_REQUIRES_CANDIDATE_ID",candidate_ids:active.map((row)=>row.id),failed:true});continue;}
          bridge=active[0];
        } else bridge=active.find((row)=>row.status==="PARA_QA_VISUAL")||undefined;
      }
      if(decision.action==="REJEITADO"&&decision.reject_all===true&&!decision.candidate_id){
        if(["APPROVED","FROZEN","LINKED_FROM_LIBRARY","LINKED_FROM_FAMILY"].includes(item.status)){preResults.push({item_id:item.itemKey,action:"REJECT",status:"ITEM_FROZEN_LOCKED",failed:true});continue;}
        let rejectedCandidates=0;
        for(let guard=0;guard<20;guard+=1){
          const [current]=await getDb().select().from(supervisorProjectCandidates).where(and(eq(supervisorProjectCandidates.projectId,job.projectId),eq(supervisorProjectCandidates.itemId,item.id),eq(supervisorProjectCandidates.status,"PARA_QA_VISUAL"))).orderBy(asc(supervisorProjectCandidates.createdAt)).limit(1);
          if(!current) break;
          await activateDecisionCandidate(job.projectId,item,current);
          await qaAutomaticProject({projeto_id:job.projectId,decisoes:[{item_id:item.id,status:"REJEITADO",observacao:decision.reason}],processar_apos:false});
          rejectedCandidates+=1;
        }
        // Reject-by-PITEM is intentionally terminal for the current candidate buffer:
        // after all active choices are closed, the slot must not silently restart heavy collection.
        await getDb().update(supervisorProjectCandidates).set({status:"DESCARTADO_RELINK",updatedAt:now()}).where(and(eq(supervisorProjectCandidates.projectId,job.projectId),eq(supervisorProjectCandidates.itemId,item.id),eq(supervisorProjectCandidates.status,"PARA_ANALISE")));
        await getDb().update(automaticProjectItems).set({status:"RELINK_REQUIRED",failureReason:decision.reason||"ALL_ACTIVE_CANDIDATES_REJECTED",updatedAt:now()}).where(eq(automaticProjectItems.id,item.id));
        preResults.push({item_id:item.itemKey,action:"REJECT",status:"REJECTED_ALL_ACTIVE",rejected_candidates:rejectedCandidates,next_state:"RELINK_REQUIRED"});
        directRelink=true;continue;
      }
      if(decision.action==="RELINK_REQUIRED"&&!bridge){
        if(["APPROVED","FROZEN","LINKED_FROM_LIBRARY","LINKED_FROM_FAMILY"].includes(item.status)){preResults.push({item_id:item.itemKey,action:"RELINK",status:"ITEM_FROZEN_LOCKED",failed:true});continue;}
        await getDb().update(automaticProjectItems).set({status:"RELINK_REQUIRED",failureReason:decision.reason||"RELINK_REQUIRED_BY_SUPERVISOR",updatedAt:now()}).where(eq(automaticProjectItems.id,item.id));
        preResults.push({item_id:item.itemKey,action:"RELINK",status:"RELINK_REQUIRED"});directRelink=true;continue;
      }
      if(!bridge){preResults.push({item_id:item.itemKey,action:decision.action==="REJEITADO"?"REJECT":"RELINK",status:"NO_ACTIVE_CANDIDATE",failed:true});continue;}
      await activateDecisionCandidate(job.projectId,item,bridge);
      qaDecisions.push({item_id:item.id,status:decision.action,observacao:decision.reason});
      actionByItem.set(item.id,decision.action); actionByItem.set(item.itemKey,decision.action);
    }catch(error){preResults.push({item_id:decision.item_id,candidate_id:decision.candidate_id,action:decision.action==="APROVADO"?"APPROVE":decision.action==="REJEITADO"?"REJECT":"RELINK",status:"FAILED",failed:true,error:error instanceof Error?error.message:String(error)});}
  }
  let appliedRecord:Record<string,unknown>={}; const changed:Array<Record<string,unknown>>=[...preResults];
  if(qaDecisions.length){const applied=await qaAutomaticProject({projeto_id:job.projectId,decisoes:qaDecisions,processar_apos:false});appliedRecord=applied&&typeof applied==="object"?applied as Record<string,unknown>:{};const rows=Array.isArray(appliedRecord.resultados)?appliedRecord.resultados as Array<Record<string,unknown>>:[];for(const row of rows){const action=actionByItem.get(clean(row.item_id));changed.push({...row,action:action==="APROVADO"?"APPROVE":action==="REJEITADO"?"REJECT":"RELINK"});}}
  else if(directRelink){const summary=await refreshProjectSummary(job.projectId,{lastAction:"FAST_RELINK_APPLIED"}).catch(()=>null);if(summary)appliedRecord={project_version:summary.project_version,project_counts:summary.counts};}
  progress.results.push(...changed);progress.cursor+=slice.length;progress.last_error=null;
  if(progress.cursor>=all.length)return completeJob(job,progress,appliedRecord);
  return persistProgress(job,progress,all.length);
}

async function processClaim(job: typeof supervisorDecisionJobs.$inferSelect) {
  if (job.kind === "FAST_DECIDE_PROJECT_CANDIDATES") return processFastCandidateDecisionClaim(job);
  if (job.kind === "FAST_APPROVE_PROJECT_ITEMS") return processFastApproveClaim(job);
  const payload = parse<JobPayload>(job.payloadJson, { project_id: job.projectId, decisions: [] });
  const decisions = normalizeDecisions(payload.decisions);
  const progress = parse<JobProgress>(job.progressJson, { cursor: 0, results: [] });
  if (!decisions.length) throw new Error("DECISOES_REQUIRED");
  if (progress.cursor >= decisions.length) return completeJob(job, progress, {});
  if (!progress.started_at) progress.started_at = new Date().toISOString();

  const slice = decisions.slice(progress.cursor, progress.cursor + DECISION_SLICE);
  const applied = await qaAutomaticProject({ projeto_id: job.projectId, decisoes: slice, processar_apos: false });
  const appliedRecord = applied && typeof applied === "object" ? applied as Record<string, unknown> : {};
  const changed = Array.isArray(appliedRecord.resultados) ? appliedRecord.resultados as Array<Record<string, unknown>> : [];
  progress.results.push(...changed);
  progress.cursor += slice.length;
  progress.last_error = null;
  if (progress.cursor >= decisions.length) return completeJob(job, progress, appliedRecord);
  return persistProgress(job, progress, decisions.length);
}

export async function processSupervisorDecisionJobs(options: { maxJobs?: number; maxWallMs?: number; source?: string } = {}) {
  const source = clean(options.source) || "FAST_SUPERVISOR_DECISION_WORKER";
  const maxJobs = Math.max(1, Math.min(10, Number(options.maxJobs) || 2));
  const maxWallMs = Math.max(1_000, Math.min(60_000, Number(options.maxWallMs) || 24_000));
  const startedAt = Date.now();
  await requeueStaleJobs();
  const processed: Array<Record<string, unknown>> = [];

  while (processed.length < maxJobs && Date.now() - startedAt < maxWallMs) {
    const job = await claimJob(source);
    if (!job) break;
    try {
      const result = await processClaim(job);
      processed.push({ operation_id: job.operationId, project_id: job.projectId, status: String((result as Record<string, unknown>).status || "PROCESSING") });
    } catch (error) {
      const payload = parse<JobPayload>(job.payloadJson, { project_id: job.projectId, decisions: [] });
      const progress = parse<JobProgress>(job.progressJson, { cursor: 0, results: [] });
      const total = job.kind === "FAST_APPROVE_PROJECT_ITEMS" ? normalizeApprovals(payload.approvals).length : job.kind === "FAST_DECIDE_PROJECT_CANDIDATES" ? normalizeFastCandidateDecisions(payload.fast_decisions).length : normalizeDecisions(payload.decisions).length;
      const result = await retryOrFailJob(job, progress, error, total);
      processed.push({ operation_id: job.operationId, project_id: job.projectId, status: String((result as Record<string, unknown>).status || "RETRYING"), error: error instanceof Error ? error.message : String(error) });
    }
  }

  const [queued] = await getDb().select({ n: sql<number>`count(*)` }).from(supervisorDecisionJobs).where(or(eq(supervisorDecisionJobs.status, "QUEUED"), eq(supervisorDecisionJobs.status, "RUNNING")));
  return {
    source,
    processed_jobs: processed.length,
    duration_ms: Date.now() - startedAt,
    pending_jobs: Number(queued?.n || 0),
    needs_reschedule: Number(queued?.n || 0) > 0,
    jobs: processed,
  };
}
