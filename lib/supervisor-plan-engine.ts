import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { getDb } from "../db";
import { automaticProjectItems, automaticProjects, collectionTerms, planBranches, settings, supervisorPlans } from "../db/schema";
import { qaAutomaticProject } from "./automatic-projects";
import { alterItemsStrategiesBatch } from "./supervisor-control";
import { acquireNextSupervisorWork, requireSupervisorLeaseForWrite } from "./supervisor-lease";
import { beginOperation, completeOperation, failOperation, getOperationalSnapshot, getOperationResult, refreshProjectSummary } from "./performance-control";
import { syncWorkerQueue } from "./worker-orchestration";
import { recordPolicyApplications, resolveOperationalPolicies } from "./operational-policy-workspace";
import { runInternalWorkerDispatcher } from "./internal-worker-dispatcher";

const now = () => new Date();
const clean = (value: unknown) => typeof value === "string" ? value.trim() : "";
const upper = (value: unknown, fallback = "") => clean(value || fallback).toUpperCase();
const clamp = (value: unknown, fallback: number, min: number, max: number) => Math.max(min, Math.min(max, Number.isFinite(Number(value)) ? Number(value) : fallback));
const encode = (value: unknown) => JSON.stringify(value ?? null);
const parse = <T,>(value: string | null | undefined, fallback: T): T => { try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; } };
const makeId = (prefix: string) => `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0,8).toUpperCase()}`;
const chunk = <T,>(values: T[], size = 20) => Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, index * size + size));

const RESOLVED = new Set(["APPROVED","FROZEN","LINKED_FROM_LIBRARY","LINKED_FROM_FAMILY"]);
const WAITING_QA = new Set(["QA_READY","READY_FOR_VISUAL_QA","WAITING_VISUAL_QA"]);
const RELINK = new Set(["RELINK_REQUIRED"]);
const TECHNICAL = new Set(["TECHNICAL_CORRECTION_REQUIRED","CORRECAO_TECNICA_PERMITIDA"]);
const WAITING_DEP = new Set(["WAITING_FAMILY_SEED","WAITING_DEPENDENCY","PAUSED_BY_SUPERVISOR"]);
const MATERIAL = new Set(["READY_FOR_MATERIALIZATION","MATERIALIZATION_PENDING","MATERIALIZING"]);
const COLLECT = new Set(["QUEUED","PARSING","SEARCHING_EXTERNALLY","SEARCHING_LIBRARY","COLLECTING","WAITING_LIBRARY","WAITING_EXTERNAL_SEARCH","DISCOVERED","PENDING"]);

const STAGE_WORKER: Record<string,string> = {
  DISCOVERY:"COLLECTOR", MATERIALIZATION:"MATERIALIZER", PRECHECK:"ANALYST", RELINK:"RELINK", TECHNICAL_FIX:"TECHNICAL_FIX", FREEZE:"ANALYST", ORGANIZE:"ORGANIZER", EXPORT:"EXPORTER",
};

async function settingNumber(key: string, fallback: number, min: number, max: number) {
  const [row] = await getDb().select().from(settings).where(eq(settings.key,key)).limit(1);
  return clamp(row?.value, fallback, min, max);
}

function branchForItem(status: string, technicalPolicy: Record<string,unknown>) {
  if (RESOLVED.has(status) || WAITING_DEP.has(status)) return null;
  if (WAITING_QA.has(status)) return { branchType:"QA_PREP", stage:"QA", status:"WAITING_SUPERVISOR" };
  if (RELINK.has(status)) return { branchType:"RELINK", stage:"RELINK", status: technicalPolicy.auto_relink === true ? "READY" : "WAITING_SUPERVISOR" };
  if (TECHNICAL.has(status)) return { branchType:"TECHNICAL_FIX", stage:"CORRECAO_TECNICA", status: technicalPolicy.auto_technical === true ? "READY" : "WAITING_SUPERVISOR" };
  if (MATERIAL.has(status)) return { branchType:"MATERIALIZATION", stage:"MATERIALIZACAO", status:"READY" };
  if (COLLECT.has(status)) return { branchType:"DISCOVERY", stage:"COLETA", status:"READY" };
  if (status.startsWith("FAILED") || status === "ERROR_REAL" || status === "CANCELLED") return { branchType:"EXCEPTION", stage:"EXCEPTION", status:"WAITING_SUPERVISOR" };
  return { branchType:"DISCOVERY", stage:"COLETA", status:"READY" };
}

async function createBranchesForPlan(planId: string, projectId: string, options: { itemIds?: string[]; maxBranches?: number; technicalPolicy?: Record<string,unknown> } = {}) {
  const db = getDb();
  const [project] = await db.select().from(automaticProjects).where(eq(automaticProjects.id,projectId)).limit(1);
  if (!project) throw new Error("PROJECT_NOT_FOUND");
  const keys = [...new Set((options.itemIds || []).map(clean).filter(Boolean))];
  let items = await db.select().from(automaticProjectItems).where(and(eq(automaticProjectItems.projectId,projectId),eq(automaticProjectItems.version,project.activeVersion))).orderBy(desc(automaticProjectItems.priority),asc(automaticProjectItems.originalReadyAt),asc(automaticProjectItems.createdAt));
  if (keys.length) items = items.filter((item)=>keys.includes(item.id)||keys.includes(item.itemKey)||keys.includes(item.targetFile||""));
  const maxBranches = clamp(options.maxBranches, 80, 1, 500);
  const selected = items.filter((item)=>!RESOLVED.has(item.status)).slice(0,maxBranches);
  const date = now();
  const existing = await db.select({idempotencyKey:planBranches.idempotencyKey}).from(planBranches).where(eq(planBranches.planId,planId));
  const existingKeys = new Set(existing.map((row)=>row.idempotencyKey));
  const rows: Array<typeof planBranches.$inferInsert> = [];
  let waitingSupervisor = 0, ready = 0;
  const touchedIds: string[] = [];
  for (const item of selected) {
    const spec = branchForItem(item.status, options.technicalPolicy || {});
    if (!spec) continue;
    // Se o próprio Supervisor acabou de fornecer query/fonte de relink, a divergência já foi
    // resolvida e o branch deve entrar READY, não voltar a pedir a mesma decisão.
    if (spec.branchType === "RELINK" && spec.status === "WAITING_SUPERVISOR") {
      const state = parse<Record<string,unknown>>(item.strategyState,{});
      const current = state.current_strategy && typeof state.current_strategy === "object" ? state.current_strategy as Record<string,unknown> : {};
      const hasAuthorizedRoute = (Array.isArray(current.queries) && current.queries.length > 0) || (Array.isArray(current.preferred_sources) && current.preferred_sources.length > 0) || current.auto_relink === true;
      if (hasAuthorizedRoute) spec.status = "READY";
    }
    const idempotencyKey = `${planId}:${item.id}:${spec.branchType}:${item.updatedAt.getTime()}`;
    if (existingKeys.has(idempotencyKey)) continue;
    rows.push({
      id:makeId("BRANCH"), planId, projectId, itemId:item.id, stage:spec.stage, branchType:spec.branchType, priority:item.priority||1,
      status:spec.status, readyAt:item.stageReadyAt||item.updatedAt||date, originalReadyAt:item.originalReadyAt||item.createdAt||date,
      workerType:STAGE_WORKER[spec.branchType] || null, workerDomain:item.itemDomain||project.projectDomain||"GENERAL", attempt:0,maxAttempts:3,
      idempotencyKey,payloadJson:encode({item_key:item.itemKey,target_file:item.targetFile,term:item.term,universe:item.universe,composition_class:item.compositionClass,canonical_reference:item.semanticReference,item_status:item.status}),resultJson:"{}",createdAt:date,updatedAt:date,
    });
    touchedIds.push(item.id);
    if (spec.status === "WAITING_SUPERVISOR") waitingSupervisor += 1; else ready += 1;
  }
  // V61: fan-out grande nunca vira um INSERT D1 monolítico. Uma chamada externa pode
  // criar centenas de branches, mas a persistência é quebrada em chunks internos seguros.
  const chunkSize = await settingNumber("supervisor_plan_branch_insert_chunk_size", 20, 5, 50);
  let persisted = 0;
  let chunksPersisted = 0;
  try {
    for (const group of chunk(rows, chunkSize)) {
      if (!group.length) continue;
      await db.insert(planBranches).values(group).onConflictDoNothing();
      persisted += group.length;
      chunksPersisted += 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`PLAN_BRANCH_INSERT_FAILED|persisted=${persisted}|chunks=${chunksPersisted}|${message}`);
  }
  // A fila derivada e o dispatcher são acionados fora do ACK hot path.
  return { created:persisted, ready, waiting_supervisor:waitingSupervisor, touched_item_ids:touchedIds, insert_chunk_size:chunkSize, insert_chunks:chunksPersisted };
}

async function ensureCandidateBuffer(projectId:string,itemIds:string[],target:number){
  if(target<=1)return{terms_updated:0,target};
  const db=getDb();
  let items=await db.select({id:automaticProjectItems.id,collectionTermId:automaticProjectItems.collectionTermId}).from(automaticProjectItems).where(eq(automaticProjectItems.projectId,projectId));
  if(itemIds.length){const wanted=new Set(itemIds);items=items.filter((row)=>wanted.has(row.id));}
  const termIds=[...new Set(items.map((row)=>row.collectionTermId).filter((v):v is string=>Boolean(v)))];
  if(!termIds.length)return{terms_updated:0,target};
  const result=await db.update(collectionTerms).set({targetQuantity:sql`CASE WHEN ${collectionTerms.targetQuantity} < ${target} THEN ${target} ELSE ${collectionTerms.targetQuantity} END`,updatedAt:now()}).where(inArray(collectionTerms.id,termIds));
  return{terms_updated:Number((result as {meta?:{changes?:number}})?.meta?.changes||termIds.length),target};
}

async function applySupervisorCommands(projectId: string, commands: Array<Record<string,unknown>>) {
  const strategyRows: Array<Record<string,unknown>> = [];
  const qaRows: Array<Record<string,unknown>> = [];
  for (const command of commands.slice(0,50)) {
    const action = upper(command.action || command.acao || command.status);
    const itemId = clean(command.item_id);
    if (!itemId) continue;
    if (["APPROVE","APPROVE_AND_FREEZE","APROVADO"].includes(action)) qaRows.push({item_id:itemId,status:"APROVADO",observacao:clean(command.observacao)||clean(command.reason)});
    else if (["REJECT","REJECT_NEXT_CANDIDATE","REJECT_AND_BRANCH_SEARCH","REJEITADO"].includes(action)) qaRows.push({item_id:itemId,status:"REJEITADO",observacao:clean(command.observacao)||clean(command.reason)});
    else if (["TECH_FIX_AND_RECHECK","CORRECAO_TECNICA_PERMITIDA"].includes(action)) qaRows.push({item_id:itemId,status:"CORRECAO_TECNICA_PERMITIDA",observacao:clean(command.observacao)||clean(command.reason)});
    else if (["RELINK_WITH_ALTERNATIVES","RELINK_CANONICAL","RELINK_REQUIRED","RELINK"].includes(action)) {
      const queries = Array.isArray(command.queries) ? command.queries.map(String).filter(Boolean) : [];
      const preferred = Array.isArray(command.preferred_sources) ? command.preferred_sources.map(String).filter(Boolean) : [];
      strategyRows.push({item_id:itemId,referencia:clean(command.referencia)||clean(command.canonical_reference),query:queries[0]||clean(command.query),queries,fonte:preferred[0]||clean(command.fonte),preferred_sources:preferred,blocked_sources:Array.isArray(command.blocked_sources)?command.blocked_sources:[],timeout_ms:command.timeout_ms,motivo:clean(command.observacao)||clean(command.reason)||"V61_SUPERVISOR_PLAN"});
    }
  }
  const results: Record<string,unknown> = { qa:[], relink:[] };
  if (qaRows.length) {
    const applied: unknown[] = [];
    for (let i=0;i<qaRows.length;i+=20) applied.push(await qaAutomaticProject({projeto_id:projectId,decisoes:qaRows.slice(i,i+20),processar_apos:false}));
    results.qa = applied;
  }
  if (strategyRows.length) {
    const applied: unknown[] = [];
    for (let i=0;i<strategyRows.length;i+=20) applied.push(await alterItemsStrategiesBatch(projectId,strategyRows.slice(i,i+20)));
    results.relink = applied;
  }
  return results;
}

async function createPlan(input: { projectId:string; executionId:string; operationId:string; intent?:string; scope?:Record<string,unknown>; policies?:Record<string,unknown>; priority?:number; maxParallelism?:number }) {
  const db = getDb();
  const [project] = await db.select().from(automaticProjects).where(eq(automaticProjects.id,input.projectId)).limit(1);
  if (!project) throw new Error("PROJECT_NOT_FOUND");
  const existing = await db.select().from(supervisorPlans).where(eq(supervisorPlans.operationId,input.operationId)).limit(1);
  if (existing[0]) return existing[0];
  const policies = input.policies || {};
  const planId = makeId("PLAN"); const date=now();
  const maxParallelism = clamp(input.maxParallelism, await settingNumber("supervisor_plan_max_parallelism",8,1,50),1,50);
  const row = {
    id:planId,projectId:input.projectId,executionId:input.executionId,operationId:input.operationId,idempotencyKey:input.operationId,status:"ACCEPTED",priority:clamp(input.priority,1,1,100),intent:upper(input.intent,"EXECUTE_UNTIL_DIVERGENCE")||"EXECUTE_UNTIL_DIVERGENCE",
    scopeJson:encode(input.scope||{}),maxParallelism,stopConditionsJson:encode((policies.stop_conditions as unknown[])||["DECISION_BOUNDARY","PACKET_READY","PROJECT_COMPLETED","REAL_ERROR"]),successConditionsJson:encode((policies.success_conditions as unknown[])||[]),
    fallbackPolicyJson:encode((policies.fallback_policy as Record<string,unknown>)||{}),sourcePolicyJson:encode((policies.source_policy as Record<string,unknown>)||{}),qaPolicyJson:encode((policies.qa_policy as Record<string,unknown>)||{}),relinkPolicyJson:encode((policies.relink_policy as Record<string,unknown>)||{}),technicalPolicyJson:encode((policies.technical_policy as Record<string,unknown>)||{}),metadataJson:encode({source:"SUPERVISOR_MCP",v60:true,v61_dispatcher:true}),resultSummaryJson:"{}",projectVersionAtCreation:project.stateVersion||1,policyVersion:"V61",acceptedAt:date,createdAt:date,updatedAt:date,
  };
  await db.insert(supervisorPlans).values(row);
  await db.update(automaticProjects).set({activePlanId:planId,lastAction:`PLAN_ACCEPTED:${planId}`,updatedAt:date}).where(eq(automaticProjects.id,input.projectId));
  return row;
}

export async function supervisorExchange(input: Record<string,unknown>) {
  let projectId=clean(input.projeto_id||input.project_id), executionId=clean(input.execution_id);
  if (!projectId || !executionId) {
    const lease = await acquireNextSupervisorWork({projectId:projectId||undefined,executionId:executionId||undefined,ttlMinutes:clamp(input.ttl_minutos,10,5,15)});
    projectId = clean(lease.projeto_id); executionId=clean(lease.execution_id);
    if (!projectId || !executionId) return {accepted:false,...lease};
  } else await requireSupervisorLeaseForWrite(projectId,executionId,"SUPERVISOR_EXCHANGE_V61");

  const operationId=clean(input.operation_id)||`V61-${projectId}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0,6)}`;
  const existing=await beginOperation(operationId,"supervisor_exchange",projectId);
  if (existing) return getOperationResult(operationId);
  let persisted=false;
  let coreAck: Record<string,unknown> | null=null;
  let activePlanId = "";
  try {
    const decisions=(Array.isArray(input.decisions)?input.decisions:Array.isArray(input.decisoes)?input.decisoes:[]).filter((row):row is Record<string,unknown>=>Boolean(row&&typeof row==="object"&&!Array.isArray(row))).slice(0,50);
    const commands=(Array.isArray(input.commands)?input.commands:Array.isArray(input.comandos)?input.comandos:[]).filter((row):row is Record<string,unknown>=>Boolean(row&&typeof row==="object"&&!Array.isArray(row))).slice(0,50);
    const applied=await applySupervisorCommands(projectId,[...decisions,...commands]);
    const inputPolicies=(input.policies&&typeof input.policies==="object"&&!Array.isArray(input.policies)?input.policies:{} ) as Record<string,unknown>;
    const [policyProject]=await getDb().select({domain:automaticProjects.projectDomain,totalItems:automaticProjects.totalItems}).from(automaticProjects).where(eq(automaticProjects.id,projectId)).limit(1);
    const learnedPolicy=await resolveOperationalPolicies({domain:policyProject?.domain,project_id:projectId,tool:"supervisor_exchange",project_items:policyProject?.totalItems||0});
    const policies:Record<string,unknown>={...inputPolicies};
    if(learnedPolicy.qa_batch_size&&!policies.packet_threshold) policies.packet_threshold=learnedPolicy.qa_batch_size;
    if(learnedPolicy.relink_batch_size&&!policies.relink_batch_size) policies.relink_batch_size=learnedPolicy.relink_batch_size;
    if(learnedPolicy.skip_waiting!==null&&policies.skip_waiting===undefined) policies.skip_waiting=learnedPolicy.skip_waiting;
    if(learnedPolicy.delta_snapshot!==null&&policies.delta_snapshot===undefined) policies.delta_snapshot=learnedPolicy.delta_snapshot;
    await recordPolicyApplications(learnedPolicy,{domain:policyProject?.domain,project_id:projectId,tool:"supervisor_exchange",project_items:policyProject?.totalItems||0},"SUPERVISOR_PLAN").catch(()=>undefined);
    const scope=(input.scope&&typeof input.scope==="object"&&!Array.isArray(input.scope)?input.scope:{} ) as Record<string,unknown>;
    const plan=await createPlan({projectId,executionId,operationId,intent:clean(input.intent)||"EXECUTE_UNTIL_DIVERGENCE",scope,policies,priority:Number(input.priority)||1,maxParallelism:Number(input.max_parallelism)||learnedPolicy.parallelism||undefined});
    activePlanId = plan.id;
    const scopeItems=Array.isArray(scope.item_ids)?scope.item_ids.map(String):[];
    const nestedTechnical=((policies.technical_policy&&typeof policies.technical_policy==="object")?policies.technical_policy:{}) as Record<string,unknown>;
    const technicalPolicy={...nestedTechnical,auto_relink:policies.auto_relink===true||nestedTechnical.auto_relink===true,auto_technical:policies.auto_technical===true||nestedTechnical.auto_technical===true};
    const configuredMaxWip=await settingNumber("supervisor_plan_max_wip",200,10,500);
    const scopedMaxItems=clamp(scope.max_items,configuredMaxWip,1,500);
    const maxWip=scope.max_items===undefined?configuredMaxWip:Math.min(configuredMaxWip,scopedMaxItems);
    const candidateTarget=clamp(policies.candidate_buffer_target,await settingNumber("supervisor_plan_candidate_buffer_target",3,1,5),1,5);
    const branches=await createBranchesForPlan(plan.id,projectId,{itemIds:scopeItems,maxBranches:maxWip,technicalPolicy});
    const buffer=await ensureCandidateBuffer(projectId,branches.touched_item_ids,candidateTarget);
    // Primeiro persistimos um ACK mínimo recuperável. Se o cliente cair depois daqui,
    // operation_id já confirma que o comando foi aceito e o fan-out foi criado.
    coreAck={accepted:true,operation_id:operationId,plan_id:plan.id,project_id:projectId,execution_id:executionId,plan_status:"DISPATCHING",branches_created:branches.created,branches_ready:branches.ready,branches_waiting_supervisor:branches.waiting_supervisor,branches_queued:branches.ready,branch_insert_chunks:branches.insert_chunks,branch_insert_chunk_size:branches.insert_chunk_size,workers_dispatched:0,dispatch_pending:branches.ready>0,dispatcher_kick_scheduled:branches.ready>0,project_version:plan.projectVersionAtCreation,counts:{},next_work_packet:{qa:[],relink:[],technical:[],source_decisions:[]},next_supervisor_action:branches.waiting_supervisor>0?"DECIDE_WORK_PACKET":"NONE",decisions_applied:applied,candidate_buffer:buffer,ack_immediate:true,background_execution:true};
    await getDb().update(supervisorPlans).set({status:"DISPATCHING",startedAt:now(),resultSummaryJson:encode(coreAck),updatedAt:now()}).where(eq(supervisorPlans.id,plan.id));
    await completeOperation(operationId,coreAck); persisted=true;

    // Enriquecimento D1-only. Nunca espera rede externa, materialização ou ciclo de coleta.
    const summary=await refreshProjectSummary(projectId,{lastAction:`PLAN_DISPATCHED:${plan.id}`}).catch(()=>null);
    const packetLimit=clamp(input.packet_limit||input.limite_pacote||policies.packet_threshold||learnedPolicy.qa_batch_size,await settingNumber("supervisor_plan_packet_size",20,1,50),1,50);
    const snapshot=await getOperationalSnapshot(projectId,0,packetLimit).catch(()=>null);
    const ack={...coreAck,project_version:summary?.project_version||snapshot?.version||plan.projectVersionAtCreation,counts:summary?.counts||snapshot?.counts||{},next_work_packet:snapshot?.work_packet||coreAck.next_work_packet,lease:snapshot?.lease||null};
    await getDb().update(supervisorPlans).set({resultSummaryJson:encode(ack),updatedAt:now()}).where(eq(supervisorPlans.id,plan.id));
    await completeOperation(operationId,ack);
    return ack;
  } catch(error){
    if(persisted&&coreAck)return coreAck;
    const message=error instanceof Error?error.message:String(error);
    if(activePlanId){
      const date=now();
      // Se o fan-out falhar, o plano nunca fica fantasma em ACCEPTED/DISPATCHING.
      // Branches parcialmente criados são cancelados; retry idempotente pode criar novo plano.
      await getDb().update(planBranches).set({status:"CANCELLED",finishedAt:date,resultJson:encode({error:message,reason:"PLAN_CREATION_ABORTED"}),updatedAt:date}).where(and(eq(planBranches.planId,activePlanId),inArray(planBranches.status,["READY","RUNNING","WAITING_DEPENDENCY"]))).catch(()=>undefined);
      await getDb().update(supervisorPlans).set({status:"FAILED",resultSummaryJson:encode({error:message,failure_stage:"BRANCH_CREATION_OR_ACK",operation_id:operationId,retryable:true}),completedAt:date,updatedAt:date}).where(eq(supervisorPlans.id,activePlanId)).catch(()=>undefined);
      await getDb().update(automaticProjects).set({activePlanId:null,lastAction:`PLAN_FAILED:${activePlanId}`,updatedAt:date}).where(and(eq(automaticProjects.id,projectId),eq(automaticProjects.activePlanId,activePlanId))).catch(()=>undefined);
    }
    await failOperation(operationId,error);throw error;
  }
}

export async function executeUntilDivergence(input: Record<string,unknown>) {
  return supervisorExchange({...input,intent:"EXECUTE_UNTIL_DIVERGENCE",decisions:[],commands:[]});
}

async function refreshPlanBranches(planId:string,projectId:string) {
  const db=getDb();
  const branches=await db.select().from(planBranches).where(eq(planBranches.planId,planId));
  const itemIds=[...new Set(branches.map((b)=>b.itemId).filter((v):v is string=>Boolean(v)))];
  const items=itemIds.length?await db.select().from(automaticProjectItems).where(inArray(automaticProjectItems.id,itemIds)):[];
  const itemMap=new Map<string, typeof automaticProjectItems.$inferSelect>(items.map((item)=>[item.id,item]));
  const canonicalStage=(status:string)=>{
    if(RESOLVED.has(status)||WAITING_DEP.has(status))return null;
    if(WAITING_QA.has(status))return "QA";
    if(RELINK.has(status))return "RELINK";
    if(TECHNICAL.has(status))return "CORRECAO_TECNICA";
    if(MATERIAL.has(status))return "MATERIALIZACAO";
    if(COLLECT.has(status))return "COLETA";
    if(status.startsWith("FAILED")||status==="ERROR_REAL"||status==="CANCELLED")return "EXCEPTION";
    return "COLETA";
  };
  let completed=0,waiting=0,running=0,ready=0,failed=0;
  for(const branch of branches){
    const item=branch.itemId?itemMap.get(branch.itemId):null;
    let status=branch.status;
    const itemStage=item?canonicalStage(item.status):null;
    const leaseActive=Boolean(branch.leaseExpiresAt&&branch.leaseExpiresAt.getTime()>Date.now()&&branch.leaseExecutionId);
    if(item){
      if(RESOLVED.has(item.status)) status="COMPLETED";
      else if(WAITING_QA.has(item.status)||TECHNICAL.has(item.status)||item.status.startsWith("FAILED")) status="WAITING_SUPERVISOR";
      else if(WAITING_DEP.has(item.status)) status="WAITING_DEPENDENCY";
      else if(itemStage!==branch.stage && itemStage!=="EXCEPTION") status="COMPLETED";
      else if(leaseActive) status="RUNNING";
      else if(branch.status==="RUNNING") status="READY"; // lease terminou/worker sumiu: devolve ao dispatcher.
      else if(["READY","WAITING_SUPERVISOR","WAITING_DEPENDENCY","PAUSED"].includes(branch.status)) status=branch.status;
    }
    if(status!==branch.status) await db.update(planBranches).set({status,leaseOwner:status==="RUNNING"?branch.leaseOwner:null,leaseExecutionId:status==="RUNNING"?branch.leaseExecutionId:null,leaseExpiresAt:status==="RUNNING"?branch.leaseExpiresAt:null,resultJson:encode(item?{item_status:item.status,item_stage:itemStage}:{}),finishedAt:["COMPLETED","FAILED"].includes(status)?now():null,updatedAt:now()}).where(eq(planBranches.id,branch.id));
    if(status==="COMPLETED")completed++; else if(status==="WAITING_SUPERVISOR")waiting++; else if(status==="RUNNING")running++; else if(status==="READY")ready++; else if(status==="FAILED")failed++;
  }
  return {total:branches.length,completed,waiting_supervisor:waiting,running,ready,failed};
}

export async function runSupervisorPlansTick(options:{planId?:string;projectId?:string;maxPlans?:number;maxSteps?:number;source?:string}={}) {
  const db=getDb();
  let plans=options.planId?await db.select().from(supervisorPlans).where(eq(supervisorPlans.id,options.planId)).limit(1):await db.select().from(supervisorPlans).where(inArray(supervisorPlans.status,["ACCEPTED","DISPATCHING","RUNNING"])).orderBy(desc(supervisorPlans.priority),asc(supervisorPlans.createdAt)).limit(clamp(options.maxPlans,5,1,20));
  if(options.projectId) plans=plans.filter((plan)=>plan.projectId===options.projectId);
  // Um único dispatcher global por tick. Ele respeita capacidade, domínio, FIFO e max_parallelism
  // dos planos, evitando N loops concorrentes para N planos.
  const dispatch=await runInternalWorkerDispatcher({projectId:options.projectId,maxWorkers:50,maxCycles:clamp(options.maxSteps,2,1,5),source:options.source||"PLAN_TICK"});
  const results=[];
  for(const plan of plans){
    const started=now();
    await db.update(supervisorPlans).set({status:"RUNNING",startedAt:plan.startedAt||started,updatedAt:started}).where(eq(supervisorPlans.id,plan.id));
    try{
      // O Data Plane já rodou acima; aqui fazemos apenas fan-in/status do plano.
      await syncWorkerQueue(plan.projectId).catch(()=>undefined);
      const branchState=await refreshPlanBranches(plan.id,plan.projectId);
      const snapshot=await getOperationalSnapshot(plan.projectId,0,20);
      const packet=snapshot.work_packet||{qa:[],relink:[],technical:[],source_decisions:[]};
      const packetCount=(packet.qa?.length||0)+(packet.relink?.length||0)+(packet.technical?.length||0)+(packet.source_decisions?.length||0);
      const pending=Number(snapshot.counts?.pending||0);
      const nextStatus=pending===0&&Number(snapshot.counts?.total||0)>0?"COMPLETED":packetCount>0&&branchState.running===0?"WAITING_SUPERVISOR":"RUNNING";
      const summary={plan_id:plan.id,status:nextStatus,branch_state:branchState,project_version:snapshot.version,counts:snapshot.counts,packet_ready:packetCount,dispatch_claimed:dispatch.claimed,source:options.source||"PLAN_TICK"};
      await db.update(supervisorPlans).set({status:nextStatus,resultSummaryJson:encode(summary),completedAt:nextStatus==="COMPLETED"?now():null,updatedAt:now()}).where(eq(supervisorPlans.id,plan.id));
      if(nextStatus==="COMPLETED") await db.update(automaticProjects).set({activePlanId:null,lastAction:`PLAN_COMPLETED:${plan.id}`,updatedAt:now()}).where(and(eq(automaticProjects.id,plan.projectId),eq(automaticProjects.activePlanId,plan.id)));
      results.push(summary);
    }catch(error){
      const message=error instanceof Error?error.message:String(error);
      await db.update(supervisorPlans).set({status:"FAILED",resultSummaryJson:encode({error:message,source:options.source||"PLAN_TICK"}),completedAt:now(),updatedAt:now()}).where(eq(supervisorPlans.id,plan.id));
      results.push({plan_id:plan.id,status:"FAILED",error:message});
    }
  }
  return {plans_scanned:plans.length,dispatch,results};
}

export async function getWorkPacket(projectId:string,limit=20,sinceVersion=0){
  const snapshot=await getOperationalSnapshot(projectId,sinceVersion,clamp(limit,20,1,50));
  const activePlan=await getDb().select().from(supervisorPlans).where(and(eq(supervisorPlans.projectId,projectId),inArray(supervisorPlans.status,["ACCEPTED","DISPATCHING","RUNNING","WAITING_SUPERVISOR"]))).orderBy(desc(supervisorPlans.updatedAt)).limit(1);
  return {...snapshot,active_plan:activePlan[0]?{plan_id:activePlan[0].id,status:activePlan[0].status,intent:activePlan[0].intent,updated_at:activePlan[0].updatedAt}:null};
}

export async function getPlanStatus(planId:string){
  const db=getDb(); const [plan]=await db.select().from(supervisorPlans).where(eq(supervisorPlans.id,planId)).limit(1); if(!plan)return{found:false,plan_id:planId};
  const branches=await db.select().from(planBranches).where(eq(planBranches.planId,planId));
  const counts=branches.reduce<Record<string,number>>((acc,row)=>{acc[row.status]=(acc[row.status]||0)+1;return acc;},{});
  return{found:true,plan:{...plan,scope:parse(plan.scopeJson,{}),stop_conditions:parse(plan.stopConditionsJson,[]),result_summary:parse(plan.resultSummaryJson,{})},branches:{total:branches.length,by_status:counts}};
}

export async function getPlanDetails(planId:string,limit=100){
  const status=await getPlanStatus(planId); if(!status.found)return status;
  const branches=await getDb().select().from(planBranches).where(eq(planBranches.planId,planId)).orderBy(desc(planBranches.priority),asc(planBranches.originalReadyAt)).limit(clamp(limit,100,1,500));
  return{...status,branch_list:branches.map((row)=>({...row,payload:parse(row.payloadJson,{}),result:parse(row.resultJson,{})}))};
}

export async function getPlanExceptions(planId:string,limit=50){
  const rows=await getDb().select().from(planBranches).where(and(eq(planBranches.planId,planId),or(eq(planBranches.status,"WAITING_SUPERVISOR"),eq(planBranches.status,"FAILED"),eq(planBranches.status,"WAITING_DEPENDENCY")))).orderBy(desc(planBranches.priority),asc(planBranches.originalReadyAt)).limit(clamp(limit,50,1,200));
  return{plan_id:planId,total:rows.length,exceptions:rows.map((row)=>({...row,payload:parse(row.payloadJson,{}),result:parse(row.resultJson,{})}))};
}

export async function controlPlan(planId:string,action:"pause"|"resume"|"cancel"){
  const db=getDb(); const [plan]=await db.select().from(supervisorPlans).where(eq(supervisorPlans.id,planId)).limit(1); if(!plan)throw new Error("PLAN_NOT_FOUND");
  const status=action==="pause"?"PAUSED":action==="resume"?"RUNNING":"CANCELLED"; const date=now();
  await db.update(supervisorPlans).set({status,completedAt:action==="cancel"?date:null,updatedAt:date}).where(eq(supervisorPlans.id,planId));
  if(action==="cancel") await db.update(planBranches).set({status:"CANCELLED",finishedAt:date,updatedAt:date}).where(and(eq(planBranches.planId,planId),inArray(planBranches.status,["READY","RUNNING","WAITING_DEPENDENCY"])));
  if(action==="resume") await db.update(planBranches).set({status:"READY",updatedAt:date}).where(and(eq(planBranches.planId,planId),eq(planBranches.status,"PAUSED")));
  if(action==="pause") await db.update(planBranches).set({status:"PAUSED",updatedAt:date}).where(and(eq(planBranches.planId,planId),eq(planBranches.status,"READY")));
  if(action==="cancel") await db.update(automaticProjects).set({activePlanId:null,lastAction:`PLAN_CANCELLED:${planId}`,updatedAt:date}).where(and(eq(automaticProjects.id,plan.projectId),eq(automaticProjects.activePlanId,planId)));
  return{plan_id:planId,project_id:plan.projectId,status};
}
