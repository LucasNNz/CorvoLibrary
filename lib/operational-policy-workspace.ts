import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb } from "../db";
import { automaticProjectItems, automaticProjects, operationalGaps, operationalPolicies, operationalPolicyEvents, settings } from "../db/schema";

const now = () => new Date();
const clean = (value: unknown) => typeof value === "string" ? value.trim() : "";
const upper = (value: unknown, fallback = "") => clean(value || fallback).toUpperCase();
const norm = (value: unknown) => clean(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const encode = (value: unknown) => JSON.stringify(value ?? null);
const parseJson = <T,>(raw: string | null | undefined, fallback: T): T => { try { return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; } };
const makeId = (prefix: string) => `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0,8).toUpperCase()}`;
const clamp = (value: unknown, fallback: number, min: number, max: number) => Math.max(min, Math.min(max, Number.isFinite(Number(value)) ? Number(value) : fallback));

export type OperationalContext = {
  domain?: string | null;
  universe?: string | null;
  work_type?: string | null;
  composition_class?: string | null;
  semantic_class?: string | null;
  preset?: string | null;
  project_id?: string | null;
  item_id?: string | null;
  source?: string | null;
  host?: string | null;
  tool?: string | null;
  worker_type?: string | null;
  requires_api_key?: boolean | null;
  configured?: boolean | null;
  project_items?: number | null;
};

export type PolicyAction = Record<string, unknown> & { type?: string; reason?: string };
export type PolicyResolution = {
  matched_policies: Array<{ id:string; policy_key:string; version:number; scope_level:string; priority:number; action:PolicyAction }>;
  blocked_sources: string[];
  preferred_sources: string[];
  skip_source: boolean;
  block_source: boolean;
  block_reason: string | null;
  timeout_ms: number | null;
  retry_limit: number | null;
  fallback_order: string[];
  qa_batch_size: number | null;
  relink_batch_size: number | null;
  parallelism: number | null;
  skip_waiting: boolean | null;
  delta_snapshot: boolean | null;
};

type PolicyRow = typeof operationalPolicies.$inferSelect;

const CORE_RULES = Object.freeze([
  "NO_AI_IMAGE_GENERATION_WITHOUT_AUTHORIZATION",
  "NO_CONTEXTUAL_COMPOSITION",
  "NO_PREVIEW_APPROVAL",
  "NEVER_REOPEN_FROZEN",
  "DO_NOT_LOWER_QA_BAR",
  "DO_NOT_SAVE_SEMANTICALLY_WRONG_ASSET",
]);

const scopeRank: Record<string,number> = { GLOBAL:1, DOMAIN:2, UNIVERSE:3, WORK_TYPE:4, COMPOSITION_CLASS:5, SEMANTIC_CLASS:6, PRESET:7, PROJECT:8, ITEM:9 };
let policyCache: { expiresAt:number; rows:PolicyRow[] } | null = null;

function invalidatePolicyCache() { policyCache = null; }

async function policyCacheTtlMs() {
  const [row] = await getDb().select({value:settings.value}).from(settings).where(eq(settings.key,"operational_policy_cache_ttl_ms")).limit(1).catch(()=>[] as Array<{value:string}>);
  return clamp(row?.value,60000,5000,300000);
}

export async function loadActiveOperationalPolicies(force = false): Promise<PolicyRow[]> {
  const stamp = Date.now();
  if (!force && policyCache && policyCache.expiresAt > stamp) return policyCache.rows;
  const statuses = ["ACTIVE","PROMOTED","TESTING"];
  const rows = await getDb().select().from(operationalPolicies).where(inArray(operationalPolicies.status,statuses)).orderBy(desc(operationalPolicies.priority),desc(operationalPolicies.version));
  const latestByKey = new Map<string,PolicyRow>();
  for (const row of rows) if (!latestByKey.has(row.policyKey)) latestByKey.set(row.policyKey,row);
  const latest = [...latestByKey.values()];
  policyCache = { rows:latest, expiresAt:stamp + await policyCacheTtlMs() };
  return latest;
}

function sameText(a: unknown, b: unknown) { return norm(a) === norm(b); }
function includesText(a: unknown, b: unknown) { const A=norm(a),B=norm(b); return Boolean(A && B && (A.includes(B) || B.includes(A))); }

function baseScopeMatches(policy: PolicyRow, ctx: OperationalContext) {
  if (policy.domain && !sameText(policy.domain,ctx.domain)) return false;
  if (policy.universe && !includesText(policy.universe,ctx.universe)) return false;
  if (policy.workType && !sameText(policy.workType,ctx.work_type)) return false;
  if (policy.compositionClass && !sameText(policy.compositionClass,ctx.composition_class)) return false;
  if (policy.semanticClass && !sameText(policy.semanticClass,ctx.semantic_class)) return false;
  if (policy.preset && !sameText(policy.preset,ctx.preset)) return false;
  if (policy.projectId && policy.projectId !== ctx.project_id) return false;
  if (policy.itemId && policy.itemId !== ctx.item_id) return false;
  return true;
}

export function operationalConditionMatches(condition: Record<string,unknown>, ctx: OperationalContext) {
  for (const [key,value] of Object.entries(condition || {})) {
    if (value === null || value === undefined || value === "") continue;
    if (key === "domain" && !sameText(ctx.domain,value)) return false;
    if (key === "universe" && !includesText(ctx.universe,value)) return false;
    if (key === "universe_not" && includesText(ctx.universe,value)) return false;
    if (key === "source" && !sameText(ctx.source,value)) return false;
    if (key === "source_contains" && !norm(ctx.source).includes(norm(value))) return false;
    if (key === "source_not" && sameText(ctx.source,value)) return false;
    if (key === "host" && !includesText(ctx.host,value)) return false;
    if (key === "tool" && !sameText(ctx.tool,value)) return false;
    if (key === "worker_type" && !sameText(ctx.worker_type,value)) return false;
    if (key === "composition_class" && !sameText(ctx.composition_class,value)) return false;
    if (key === "semantic_class" && !sameText(ctx.semantic_class,value)) return false;
    if (key === "preset" && !sameText(ctx.preset,value)) return false;
    if (key === "project_id" && clean(ctx.project_id) !== clean(value)) return false;
    if (key === "item_id" && clean(ctx.item_id) !== clean(value)) return false;
    if (key === "requires_api_key" && Boolean(ctx.requires_api_key) !== Boolean(value)) return false;
    if (key === "configured" && Boolean(ctx.configured) !== Boolean(value)) return false;
    if (key === "project_items_gte" && Number(ctx.project_items || 0) < Number(value)) return false;
    if (key === "project_items_lte" && Number(ctx.project_items || 0) > Number(value)) return false;
  }
  return true;
}

export function evaluateOperationalPolicies(rows: PolicyRow[], ctx: OperationalContext): PolicyResolution {
  const matched = rows.filter((policy)=>baseScopeMatches(policy,ctx) && operationalConditionMatches(parseJson(policy.conditionJson,{}),ctx))
    .sort((a,b)=>(scopeRank[b.scopeLevel]||0)-(scopeRank[a.scopeLevel]||0) || b.priority-a.priority || b.version-a.version);
  const result: PolicyResolution = { matched_policies:[],blocked_sources:[],preferred_sources:[],skip_source:false,block_source:false,block_reason:null,timeout_ms:null,retry_limit:null,fallback_order:[],qa_batch_size:null,relink_batch_size:null,parallelism:null,skip_waiting:null,delta_snapshot:null };
  for (const policy of matched) {
    const action = parseJson<PolicyAction>(policy.actionJson,{});
    result.matched_policies.push({id:policy.id,policy_key:policy.policyKey,version:policy.version,scope_level:policy.scopeLevel,priority:policy.priority,action});
    const type = upper(action.type);
    if (type === "BLOCK_SOURCE") { result.block_source=true; result.block_reason=clean(action.reason)||"BLOCKED_BY_POLICY"; }
    if (type === "SKIP_SOURCE") { result.skip_source=true; result.block_reason=clean(action.reason)||"SKIPPED_BY_POLICY"; }
    if (type === "BOOST_SOURCE_SCORE" && clean(action.source)) result.preferred_sources.push(clean(action.source));
    if (Array.isArray(action.blocked_sources)) result.blocked_sources.push(...action.blocked_sources.map(String));
    if (Array.isArray(action.preferred_sources)) result.preferred_sources.push(...action.preferred_sources.map(String));
    if (Number.isFinite(Number(action.timeout_ms))) result.timeout_ms=Number(action.timeout_ms);
    if (Number.isFinite(Number(action.retry_limit))) result.retry_limit=Number(action.retry_limit);
    if (Array.isArray(action.fallback_order)) result.fallback_order=action.fallback_order.map(String);
    if (Number.isFinite(Number(action.qa_batch_size))) result.qa_batch_size=Number(action.qa_batch_size);
    if (Number.isFinite(Number(action.relink_batch_size))) result.relink_batch_size=Number(action.relink_batch_size);
    if (Number.isFinite(Number(action.parallelism))) result.parallelism=Number(action.parallelism);
    if (typeof action.skip_waiting === "boolean") result.skip_waiting=action.skip_waiting;
    if (typeof action.delta_snapshot === "boolean") result.delta_snapshot=action.delta_snapshot;
    // A política mais específica vem primeiro. BLOCK/SKIP não pode ser desfeito por escopo menos específico.
    if ((result.block_source || result.skip_source) && (scopeRank[policy.scopeLevel]||0) >= 7) break;
  }
  result.blocked_sources=[...new Set(result.blocked_sources)];
  result.preferred_sources=[...new Set(result.preferred_sources)];
  return result;
}

export async function resolveOperationalPolicies(ctx: OperationalContext) {
  return evaluateOperationalPolicies(await loadActiveOperationalPolicies(),ctx);
}

export function makeGapSignature(input: Record<string,unknown>) {
  const explicit=clean(input.signature); if(explicit) return upper(explicit).replace(/\s+/g,"_");
  const category=upper(input.category,"OTHER");
  const source=upper(input.source);
  const host=upper(input.host);
  const tool=upper(input.tool);
  const universe=upper(input.universe);
  const composition=upper(input.composition_class);
  const symptom=upper(input.symptom).replace(/[^A-Z0-9]+/g,"_").slice(0,80);
  return [category,source||host||tool||universe||"GENERIC",composition||symptom||"GAP"].filter(Boolean).join("|");
}

export async function detectOperationalGap(input: Record<string,unknown>) {
  const db=getDb(), date=now(), signature=makeGapSignature(input);
  const [existing]=await db.select().from(operationalGaps).where(eq(operationalGaps.signature,signature)).limit(1);
  if(existing){
    await db.update(operationalGaps).set({occurrenceCount:existing.occurrenceCount+1,lastSeenAt:date,status:existing.status==="RESOLVED"?"RECURRED":existing.status,evidenceJson:encode(input.evidence||parseJson(existing.evidenceJson,{})),rootCause:clean(input.root_cause)||existing.rootCause}).where(eq(operationalGaps.id,existing.id));
    return {created:false,gap_id:existing.id,signature,occurrence_count:existing.occurrenceCount+1,status:existing.status==="RESOLVED"?"RECURRED":existing.status};
  }
  const id=makeId("GAP");
  await db.insert(operationalGaps).values({id,signature,category:upper(input.category,"OTHER"),severity:upper(input.severity,"MEDIUM"),projectId:clean(input.project_id)||null,itemId:clean(input.item_id)||null,domain:upper(input.domain)||null,universe:clean(input.universe)||null,compositionClass:upper(input.composition_class)||null,semanticClass:upper(input.semantic_class)||null,preset:upper(input.preset)||null,source:clean(input.source)||null,host:clean(input.host)||null,tool:clean(input.tool)||null,workerType:upper(input.worker_type)||null,symptom:clean(input.symptom)||signature,rootCause:clean(input.root_cause)||null,evidenceJson:encode(input.evidence||{}),occurrenceCount:1,status:"OPEN",firstSeenAt:date,lastSeenAt:date});
  return {created:true,gap_id:id,signature,occurrence_count:1,status:"OPEN"};
}

export async function listOperationalGaps(input: Record<string,unknown>={}) {
  const limit=clamp(input.limit,100,1,500), rows=await getDb().select().from(operationalGaps).orderBy(desc(operationalGaps.occurrenceCount),desc(operationalGaps.lastSeenAt)).limit(500);
  const filtered=rows.filter(r=>(!clean(input.status)||sameText(r.status,input.status))&&(!clean(input.category)||sameText(r.category,input.category))&&(!clean(input.project_id)||r.projectId===clean(input.project_id)));
  return {gaps:filtered.slice(0,limit),total:filtered.length};
}

export async function getOperationalGap(id:string){ const [gap]=await getDb().select().from(operationalGaps).where(eq(operationalGaps.id,id)).limit(1); return gap?{found:true,gap}:{found:false,gap_id:id}; }

function policyInsert(input: Record<string,unknown>, overrides: Partial<typeof operationalPolicies.$inferInsert>={}) {
  const id=clean(overrides.id)||makeId("POL"), key=clean(overrides.policyKey)||clean(input.policy_key)||id, date=now();
  return {id,policyKey:key,name:clean(input.name)||clean(overrides.name)||key,description:clean(input.description)||null,category:upper(input.category,"OTHER"),status:upper(input.status,"DRAFT"),ruleType:upper(input.rule_type,"LEARNED_POLICY"),scopeLevel:upper(input.scope_level,"PROJECT"),propagationLevel:clamp(input.propagation_level,1,0,4),domain:upper(input.domain)||null,universe:clean(input.universe)||null,workType:upper(input.work_type)||null,compositionClass:upper(input.composition_class)||null,semanticClass:upper(input.semantic_class)||null,preset:upper(input.preset)||null,projectId:clean(input.project_id)||null,itemId:clean(input.item_id)||null,conditionJson:encode(input.condition||{}),actionJson:encode(input.action||{}),priority:clamp(input.priority,1,-1000,1000),confidence:clamp(input.confidence,50,0,100),sourceGapId:clean(input.source_gap_id)||null,createdBy:clean(input.created_by)||"SUPERVISOR_MCP",version:clamp(overrides.version||input.version,1,1,100000),previousVersionId:clean(overrides.previousVersionId)||null,rollbackToVersion:null,notes:clean(input.notes)||null,createdAt:date,updatedAt:date} as typeof operationalPolicies.$inferInsert;
}

export async function createOperationalPolicy(input: Record<string,unknown>) {
  if(upper(input.rule_type,"LEARNED_POLICY")==="CORE_RULE") throw new Error("CORE_RULE_IMMUTABLE");
  const row=policyInsert(input); await getDb().insert(operationalPolicies).values(row); invalidatePolicyCache();
  await recordPolicyEvent({policyId:row.id,policyVersion:row.version,eventType:"POLICY_CREATED",action:input.action||{},result:"DRAFT"});
  return {created:true,policy:row};
}

export async function editOperationalPolicy(input: Record<string,unknown>) {
  const db=getDb(), id=clean(input.policy_id); if(!id) throw new Error("POLICY_ID_REQUIRED");
  const [current]=await db.select().from(operationalPolicies).where(eq(operationalPolicies.id,id)).limit(1); if(!current) throw new Error("POLICY_NOT_FOUND");
  if(current.ruleType==="CORE_RULE") throw new Error("CORE_RULE_IMMUTABLE");
  const merged:Record<string,unknown>={name:input.name??current.name,description:input.description??current.description,category:input.category??current.category,status:input.status??current.status,rule_type:current.ruleType,scope_level:input.scope_level??current.scopeLevel,propagation_level:input.propagation_level??current.propagationLevel,domain:input.domain??current.domain,universe:input.universe??current.universe,work_type:input.work_type??current.workType,composition_class:input.composition_class??current.compositionClass,semantic_class:input.semantic_class??current.semanticClass,preset:input.preset??current.preset,project_id:input.project_id??current.projectId,item_id:input.item_id??current.itemId,condition:input.condition??parseJson(current.conditionJson,{}),action:input.action??parseJson(current.actionJson,{}),priority:input.priority??current.priority,confidence:input.confidence??current.confidence,source_gap_id:input.source_gap_id??current.sourceGapId,created_by:input.created_by??"SUPERVISOR_MCP",notes:input.notes??current.notes};
  const next=policyInsert(merged,{policyKey:current.policyKey,version:current.version+1,previousVersionId:current.id});
  await db.batch([db.update(operationalPolicies).set({status:"DEPRECATED",updatedAt:now()}).where(eq(operationalPolicies.id,current.id)),db.insert(operationalPolicies).values(next)]);
  invalidatePolicyCache(); await recordPolicyEvent({policyId:next.id,policyVersion:next.version,eventType:"POLICY_VERSION_CREATED",action:parseJson(next.actionJson,{}),result:`v${next.version}`});
  return {updated:true,previous_policy_id:current.id,policy:next};
}

export async function listOperationalPolicies(input:Record<string,unknown>={}){
  const limit=clamp(input.limit,100,1,500), rows=await getDb().select().from(operationalPolicies).orderBy(desc(operationalPolicies.updatedAt)).limit(1000);
  const filtered=rows.filter(r=>(!clean(input.status)||sameText(r.status,input.status))&&(!clean(input.category)||sameText(r.category,input.category))&&(!clean(input.domain)||sameText(r.domain,input.domain))&&(!clean(input.universe)||includesText(r.universe,input.universe)));
  return {policies:filtered.slice(0,limit),total:filtered.length,core_rules:CORE_RULES};
}

export async function getAppliedOperationalPolicies(input:Record<string,unknown>){
  const ctx:OperationalContext={domain:clean(input.domain),universe:clean(input.universe),work_type:clean(input.work_type),composition_class:clean(input.composition_class),semantic_class:clean(input.semantic_class),preset:clean(input.preset),project_id:clean(input.project_id),item_id:clean(input.item_id),source:clean(input.source),host:clean(input.host),tool:clean(input.tool),worker_type:clean(input.worker_type),requires_api_key:typeof input.requires_api_key==="boolean"?input.requires_api_key:null,configured:typeof input.configured==="boolean"?input.configured:null,project_items:Number(input.project_items)||null};
  return {context:ctx,core_rules:CORE_RULES,resolution:await resolveOperationalPolicies(ctx)};
}

async function recordPolicyEvent(input:{policyId?:string|null;policyVersion?:number|null;gapId?:string|null;projectId?:string|null;itemId?:string|null;eventType:string;before?:unknown;after?:unknown;action?:unknown;result?:string|null;timeSavedMs?:number;requestsSaved?:number;externalRequestsSaved?:number;falsePositive?:boolean}){
  await getDb().insert(operationalPolicyEvents).values({id:makeId("PEVT"),policyId:input.policyId||null,policyVersion:input.policyVersion||null,gapId:input.gapId||null,projectId:input.projectId||null,itemId:input.itemId||null,eventType:input.eventType,beforeStateJson:encode(input.before||{}),afterStateJson:encode(input.after||{}),actionJson:encode(input.action||{}),result:input.result||null,timeSavedMs:input.timeSavedMs||0,requestsSaved:input.requestsSaved||0,externalRequestsSaved:input.externalRequestsSaved||0,falsePositive:Boolean(input.falsePositive),createdAt:now()});
}

export async function recordPolicyApplications(resolution:PolicyResolution, ctx:OperationalContext, result="APPLIED"){
  if(!resolution.matched_policies.length)return;
  const db=getDb(), date=now();
  const events=resolution.matched_policies.map(p=>({id:makeId("PEVT"),policyId:p.id,policyVersion:p.version,projectId:clean(ctx.project_id)||null,itemId:clean(ctx.item_id)||null,eventType:"POLICY_APPLIED",beforeStateJson:"{}",afterStateJson:"{}",actionJson:encode(p.action),result,timeSavedMs:0,requestsSaved:(resolution.block_source||resolution.skip_source)?1:0,externalRequestsSaved:(resolution.block_source||resolution.skip_source)?1:0,falsePositive:false,createdAt:date}));
  for(const p of resolution.matched_policies){
    await db.update(operationalPolicies).set({timesMatched:sql`${operationalPolicies.timesMatched}+1`,timesApplied:sql`${operationalPolicies.timesApplied}+1`,lastAppliedAt:date,lastResult:result,updatedAt:date}).where(eq(operationalPolicies.id,p.id));
  }
  if(events.length) await db.insert(operationalPolicyEvents).values(events);
}

export async function testOperationalPolicy(input:Record<string,unknown>){
  const id=clean(input.policy_id); const [policy]=await getDb().select().from(operationalPolicies).where(eq(operationalPolicies.id,id)).limit(1); if(!policy)throw new Error("POLICY_NOT_FOUND");
  const days=clamp(input.lookback_days,30,1,365), since=new Date(Date.now()-days*86400000);
  const gaps=await getDb().select().from(operationalGaps).where(gte(operationalGaps.lastSeenAt,since)).orderBy(desc(operationalGaps.occurrenceCount)).limit(5000);
  const affected=gaps.filter(g=>baseScopeMatches(policy,{domain:g.domain,universe:g.universe,composition_class:g.compositionClass,semantic_class:g.semanticClass,preset:g.preset,project_id:g.projectId,item_id:g.itemId,source:g.source,host:g.host,tool:g.tool,worker_type:g.workerType})&&operationalConditionMatches(parseJson(policy.conditionJson,{}),{domain:g.domain,universe:g.universe,composition_class:g.compositionClass,semantic_class:g.semanticClass,preset:g.preset,project_id:g.projectId,item_id:g.itemId,source:g.source,host:g.host,tool:g.tool,worker_type:g.workerType}));
  const occurrences=affected.reduce((sum,g)=>sum+g.occurrenceCount,0), action=parseJson<PolicyAction>(policy.actionJson,{});
  const result={policy_id:id,dry_run:true,lookback_days:days,events_affected:affected.length,occurrences_affected:occurrences,estimated_calls_avoided:["BLOCK_SOURCE","SKIP_SOURCE"].includes(upper(action.type))?occurrences:0,estimated_time_saved_ms:occurrences*Math.max(1000,policy.avgTimeBeforeMs-policy.avgTimeAfterMs),successes_potentially_blocked:0,conflicts:[],risk:policy.scopeLevel==="GLOBAL"&&["BLOCK_SOURCE","SKIP_SOURCE"].includes(upper(action.type))?"HIGH_IMPACT_GLOBAL":"REVERSIBLE"};
  await recordPolicyEvent({policyId:policy.id,policyVersion:policy.version,eventType:"POLICY_DRY_RUN",action,result:encode(result)});
  return result;
}

async function setPolicyStatus(id:string,status:string,eventType:string){ const db=getDb(); const [p]=await db.select().from(operationalPolicies).where(eq(operationalPolicies.id,id)).limit(1); if(!p)throw new Error("POLICY_NOT_FOUND"); if(p.ruleType==="CORE_RULE")throw new Error("CORE_RULE_IMMUTABLE"); await db.update(operationalPolicies).set({status,updatedAt:now()}).where(eq(operationalPolicies.id,id));invalidatePolicyCache();await recordPolicyEvent({policyId:id,policyVersion:p.version,eventType,action:parseJson(p.actionJson,{}),result:status});return{policy_id:id,status}; }
export const activateOperationalPolicy=(id:string)=>setPolicyStatus(id,"ACTIVE","POLICY_ACTIVATED");
export const suspendOperationalPolicy=(id:string)=>setPolicyStatus(id,"SUSPENDED","POLICY_SUSPENDED");

export async function promoteOperationalPolicy(input:Record<string,unknown>){
  const id=clean(input.policy_id), target=upper(input.scope_level); const [p]=await getDb().select().from(operationalPolicies).where(eq(operationalPolicies.id,id)).limit(1); if(!p)throw new Error("POLICY_NOT_FOUND");
  if(target==="GLOBAL"&&input.confirmar_alto_impacto!==true) throw new Error("GLOBAL_PROMOTION_REQUIRES_EXPLICIT_GATE");
  const propagation=target==="GLOBAL"?4:target==="DOMAIN"?3:target==="UNIVERSE"?2:target==="PROJECT"?1:0;
  const updated=await editOperationalPolicy({policy_id:id,scope_level:target||p.scopeLevel,propagation_level:propagation,status:"PROMOTED",created_by:"SUPERVISOR_MCP",notes:clean(input.notes)||p.notes});
  return {...updated,promoted:true,scope_level:target||p.scopeLevel};
}

export async function rollbackOperationalPolicy(input:Record<string,unknown>){
  const db=getDb(), id=clean(input.policy_id); const [current]=await db.select().from(operationalPolicies).where(eq(operationalPolicies.id,id)).limit(1); if(!current)throw new Error("POLICY_NOT_FOUND");
  const targetVersion=Number(input.target_version)||current.version-1; const [target]=await db.select().from(operationalPolicies).where(and(eq(operationalPolicies.policyKey,current.policyKey),eq(operationalPolicies.version,targetVersion))).limit(1); if(!target)throw new Error("ROLLBACK_VERSION_NOT_FOUND");
  await db.batch([db.update(operationalPolicies).set({status:"ROLLED_BACK",rollbackToVersion:target.version,updatedAt:now()}).where(eq(operationalPolicies.id,current.id)),db.update(operationalPolicies).set({status:"ACTIVE",updatedAt:now()}).where(eq(operationalPolicies.id,target.id))]);
  invalidatePolicyCache();await recordPolicyEvent({policyId:current.id,policyVersion:current.version,eventType:"POLICY_ROLLED_BACK",action:parseJson(current.actionJson,{}),result:`rollback->v${target.version}`});
  return {rolled_back:true,from_policy_id:current.id,to_policy_id:target.id,to_version:target.version};
}

export async function linkGapPolicy(gapId:string,policyId:string){ const db=getDb(); await db.update(operationalGaps).set({resolutionPolicyId:policyId,status:"RESOLVED",lastSeenAt:now()}).where(eq(operationalGaps.id,gapId));await recordPolicyEvent({policyId,gapId,eventType:"GAP_LINKED_POLICY",result:"RESOLVED"});return{gap_id:gapId,policy_id:policyId,status:"RESOLVED"}; }

export async function getOperationalPolicyTelemetry(input:Record<string,unknown>={}){
  const days=clamp(input.days,30,1,365), since=new Date(Date.now()-days*86400000), db=getDb();
  const [policies,gaps,events]=await Promise.all([db.select().from(operationalPolicies).orderBy(desc(operationalPolicies.updatedAt)).limit(1000),db.select().from(operationalGaps).orderBy(desc(operationalGaps.lastSeenAt)).limit(5000),db.select().from(operationalPolicyEvents).where(gte(operationalPolicyEvents.createdAt,since)).orderBy(desc(operationalPolicyEvents.createdAt)).limit(10000)]);
  const active=policies.filter(p=>["ACTIVE","PROMOTED","TESTING"].includes(p.status));
  const timeSaved=events.reduce((s,e)=>s+e.timeSavedMs,0), requestsSaved=events.reduce((s,e)=>s+e.requestsSaved,0), externalSaved=events.reduce((s,e)=>s+e.externalRequestsSaved,0);
  return {period_days:days,policies_total:policies.length,policies_active:active.length,gaps_total:gaps.length,gaps_open:gaps.filter(g=>["OPEN","RECURRED"].includes(g.status)).length,repeated_gap_rate:gaps.length?gaps.filter(g=>g.occurrenceCount>1).length/gaps.length:0,policy_hit_rate:events.length?events.filter(e=>e.eventType==="POLICY_APPLIED").length/events.length:0,time_saved_ms:timeSaved,requests_saved:requestsSaved,external_requests_saved:externalSaved,false_positive_count:events.filter(e=>e.falsePositive).length,rollback_count:events.filter(e=>e.eventType==="POLICY_ROLLED_BACK").length,top_gaps:gaps.slice(0,20),top_policies:policies.sort((a,b)=>b.timesApplied-a.timesApplied).slice(0,20)};
}

export async function resolveGapAndLearn(input:Record<string,unknown>){
  const gap=await detectOperationalGap(input); let policy=null;
  if(input.policy&&typeof input.policy==="object"&&!Array.isArray(input.policy)){ policy=await createOperationalPolicy({...input.policy,source_gap_id:gap.gap_id,created_by:"SUPERVISOR_MCP"}); if(input.activate===true) await activateOperationalPolicy(String((policy as {policy:{id:string}}).policy.id)); await linkGapPolicy(String(gap.gap_id),String((policy as {policy:{id:string}}).policy.id)); }
  return {gap,policy,impact:{repeated_occurrences:gap.occurrence_count,workers_blocked:false,policy_saved:Boolean(policy)}};
}

export async function getOperationalPolicyWorkspaceDashboard(){
  const [gaps,policies,telemetry]=await Promise.all([listOperationalGaps({limit:50}),listOperationalPolicies({limit:100}),getOperationalPolicyTelemetry({days:30})]);
  return {generated_at:new Date().toISOString(),learning_enabled:true,core_rules:CORE_RULES,gaps:gaps.gaps,policies:policies.policies,telemetry};
}
