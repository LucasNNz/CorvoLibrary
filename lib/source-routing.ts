import { env } from "./platform/runtime";
import { and, asc, eq } from "drizzle-orm";
import { getDb } from "../db";
import { automaticProjectItems, automaticProjects, collectionSources, sourceRoutingPlans } from "../db/schema";
import { getRouteRanking } from "./performance-control";
import { detectOperationalGap, resolveOperationalPolicies, recordPolicyApplications, type PolicyResolution } from "./operational-policy-workspace";

const now = () => new Date();
const clean = (value: unknown) => typeof value === "string" ? value.trim() : "";
const upper = (value: unknown, fallback = "") => clean(value || fallback).toUpperCase();
const norm = (value: unknown) => clean(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const parseList = (raw: string | null | undefined) => { try { const value = raw ? JSON.parse(raw) : []; return Array.isArray(value) ? value.map(String).map((v)=>v.trim()).filter(Boolean) : []; } catch { return []; } };
const parseJson = <T,>(raw: string | null | undefined, fallback: T): T => { try { return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; } };
const encode = (value: unknown) => JSON.stringify(value ?? null);

const BROAD_GENERIC = /openverse|wikimedia|pexels|pixabay/;
const ANIME_ONLY = /fandom|wikia|zerochan|konachan/;
const GAME_ONLY = /pokeapi|bulbagarden|spriter|steamgrid|game icons/;

function inferredDomain(name: string, stored: string) {
  const n = norm(name);
  if (ANIME_ONLY.test(n)) return "ANIME";
  if (/pokeapi|bulbagarden|spriter|steamgrid|game icons/.test(n)) return "GAMES";
  if (/youtube|pinterest|brave|openverse|wikimedia/.test(n)) return "MULTI";
  return upper(stored, "MULTI") || "MULTI";
}

function universeMatches(sourceUniverses: string[], universe: string) {
  if (!sourceUniverses.length || !universe) return true;
  const wanted = norm(universe);
  return sourceUniverses.some((value) => {
    const candidate = norm(value);
    return candidate === wanted || candidate.includes(wanted) || wanted.includes(candidate);
  });
}

function compositionMatches(sourceClasses: string[], compositionClass: string) {
  if (!sourceClasses.length || !compositionClass) return true;
  const wanted = upper(compositionClass);
  return sourceClasses.some((value) => upper(value) === wanted || upper(value) === "ANY" || upper(value) === "QUALQUER");
}

function explicitUniverseMismatch(projectDomain: string, universe: string, sourceName: string) {
  const u = upper(universe);
  const n = norm(sourceName);
  if (projectDomain === "ANIME" && (u.includes("NARUTO") || u.includes("BORUTO") || u.includes("MY HERO") || u.includes("BOKU NO HERO"))) {
    if (/pokeapi|bulbagarden/.test(n)) return "UNIVERSE_MISMATCH";
    if (/spriter/.test(n)) return "DOMAIN_MISMATCH";
  }
  return null;
}

function sourceConfigured(source: typeof collectionSources.$inferSelect) {
  if (source.apiKeyEnv) return Boolean(clean((env as unknown as Record<string, unknown>)[source.apiKeyEnv]));
  return source.configured !== false;
}

export type RoutingExcluded = { source_id: string; source: string; reason: string };
export type RoutingSource = { id: string; name: string; priority: number; domain: string; method: string; fallback: boolean; score: number };

export type SourceRoutingPlanResult = {
  routing_plan_id: string;
  project_id: string | null;
  item_id: string | null;
  collection_term_id: string | null;
  project_domain: string;
  universe: string | null;
  composition_class: string;
  eligible_sources: RoutingSource[];
  excluded_sources: RoutingExcluded[];
  discovery_sources: RoutingSource[];
  materialization_sources: RoutingSource[];
  fallback_sources: RoutingSource[];
  routing_version: number;
  routing_gap: string | null;
  applied_policies: Array<{policy_id:string;policy_key:string;source:string;action:string}>;
};

export async function buildSourceRoutingPlan(input: {
  projectId?: string | null;
  itemId?: string | null;
  collectionTermId?: string | null;
  projectDomain?: string | null;
  universe?: string | null;
  compositionClass?: string | null;
  targetType?: string | null;
  canonicalReference?: string | null;
  preferredSources?: string[];
  avoidSources?: string[];
  allowGenericFallback?: boolean;
  persist?: boolean;
}) : Promise<SourceRoutingPlanResult> {
  const db = getDb();
  let projectDomain = upper(input.projectDomain, "GENERAL") || "GENERAL";
  let universe = clean(input.universe) || null;
  let itemId = clean(input.itemId) || null;
  let projectId = clean(input.projectId) || null;
  let compositionClass = upper(input.compositionClass, "") || "CONTEXTUAL";
  let canonicalReference = clean(input.canonicalReference) || null;
  let targetType = clean(input.targetType) || null;
  let projectItems = 0;

  if (itemId) {
    const [item] = await db.select().from(automaticProjectItems).where(eq(automaticProjectItems.id, itemId)).limit(1);
    if (item) {
      projectId ||= item.projectId;
      universe ||= item.universe || null;
      compositionClass = upper(input.compositionClass || item.compositionClass, "CONTEXTUAL");
      canonicalReference ||= item.semanticReference || item.term;
      targetType ||= item.kind || null;
      projectDomain = upper(input.projectDomain || item.itemDomain, projectDomain);
    }
  }
  if (projectId) {
    const [project] = await db.select({ projectDomain: automaticProjects.projectDomain, totalItems: automaticProjects.totalItems }).from(automaticProjects).where(eq(automaticProjects.id, projectId)).limit(1);
    if (project) {
      projectItems = project.totalItems || 0;
      if (!input.projectDomain || projectDomain === "GENERAL") projectDomain = upper(project.projectDomain, projectDomain);
    }
  }
  // Backstop para projetos/itens legados ainda marcados GENERAL: universos anime conhecidos
  // devem entrar no hard-filter ANIME antes do ranking, nunca depois.
  if (projectDomain === "GENERAL" && /naruto|boruto|my hero academia|boku no hero|jujutsu|demon slayer|kimetsu|one piece|dragon ball|chainsaw|dandadan|jojo/i.test(universe || "")) projectDomain = "ANIME";

  const [sources, ranking] = await Promise.all([
    db.select().from(collectionSources).where(eq(collectionSources.active, true)).orderBy(asc(collectionSources.priority), asc(collectionSources.name)),
    getRouteRanking(universe || undefined, compositionClass || undefined, 200).catch(() => []),
  ]);
  const routeScore = new Map(ranking.map((row) => [row.sourceId || norm(row.sourceName), row.score || 0]));
  const preferred = (input.preferredSources || []).map(norm).filter(Boolean);
  const avoided = (input.avoidSources || []).map(norm).filter(Boolean);
  const excluded: RoutingExcluded[] = [];
  const eligible: RoutingSource[] = [];
  const fallback: RoutingSource[] = [];
  const discovery: RoutingSource[] = [];
  const materialization: RoutingSource[] = [];
  const appliedPolicies: Array<{policy_id:string;policy_key:string;source:string;action:string}> = [];
  const policyOutcomes: Array<{resolution:PolicyResolution;source:string;configured:boolean;requiresApiKey:boolean}> = [];
  const brave = sources.find((source)=>norm(source.name).includes("brave"));
  const braveConfigured = brave ? sourceConfigured(brave) : false;

  for (const source of sources) {
    const sourceName = source.name;
    const sourceNorm = norm(sourceName);
    const domain = inferredDomain(sourceName, source.domain);
    const sourceUniverses = parseList(source.supportedUniverses);
    const sourceClasses = parseList(source.supportedCompositionClasses);
    let baseReason: string | null = null;

    const configured = sourceConfigured(source);
    const policyResolution = await resolveOperationalPolicies({ domain:projectDomain, universe, composition_class:compositionClass, project_id:projectId, item_id:itemId, source:sourceName, requires_api_key:Boolean(source.apiKeyEnv), configured, project_items:projectItems });
    if (policyResolution.matched_policies.length) {
      for (const matched of policyResolution.matched_policies) appliedPolicies.push({policy_id:matched.id,policy_key:matched.policy_key,source:sourceName,action:upper(matched.action.type)});
      policyOutcomes.push({resolution:policyResolution,source:sourceName,configured,requiresApiKey:Boolean(source.apiKeyEnv)});
    }

    // Workspace de Políticas é resolvido antes do ranking. Uma regra aprendida específica
    // impede que o fan-out sequer considere uma rota conhecida como incompatível.
    if (policyResolution.block_source || policyResolution.skip_source) baseReason = policyResolution.block_reason || "SKIPPED_BY_POLICY";
    else if (!configured) baseReason = "SOURCE_NOT_CONFIGURED";
    else if (avoided.some((value)=>sourceNorm.includes(value) || value.includes(sourceNorm))) baseReason = "SOURCE_POLICY_BLOCKED";
    else if (projectDomain !== "GENERAL" && domain !== projectDomain && domain !== "MULTI") baseReason = "DOMAIN_MISMATCH";
    else if (!universeMatches(sourceUniverses, universe || "")) baseReason = "UNIVERSE_MISMATCH";
    else if (!compositionMatches(sourceClasses, compositionClass)) baseReason = "COMPOSITION_CLASS_MISMATCH";
    else baseReason = explicitUniverseMismatch(projectDomain, universe || "", sourceName);

    if (baseReason) { excluded.push({ source_id:source.id, source:sourceName, reason:baseReason }); continue; }

    const isBroadFallback = projectDomain === "ANIME" && BROAD_GENERIC.test(sourceNorm);
    const score = routeScore.get(source.id) ?? routeScore.get(sourceNorm) ?? 0;
    const preferredRank = preferred.findIndex((value)=>sourceNorm.includes(value) || value.includes(sourceNorm));
    const learnedPreferred = policyResolution.preferred_sources.some((value)=>sourceNorm.includes(norm(value)) || norm(value).includes(sourceNorm));
    const row: RoutingSource = { id:source.id, name:sourceName, priority:preferredRank >= 0 ? -100 + preferredRank : learnedPreferred ? Math.min(Number(source.priority),-20) : Number(source.priority), domain, method:source.method, fallback:isBroadFallback, score };

    // Capability split V60: uma fonte pode ser excelente para materializar um URL conhecido
    // sem ser capaz de descobrir esse URL. Não confundir adapter com search/discovery source.
    if (source.canMaterialize !== false) materialization.push(row);

    let discoveryReason: string | null = null;
    if (!source.canDiscover) discoveryReason = "DISCOVERY_CAPABILITY_MISSING";
    else if (source.requiresExternalSearch && !braveConfigured && !sourceNorm.includes("brave")) discoveryReason = "ROUTING_DEPENDENCY_NOT_CONFIGURED";
    if (discoveryReason) { excluded.push({ source_id:source.id, source:sourceName, reason:discoveryReason }); continue; }

    if (isBroadFallback && !input.allowGenericFallback) fallback.push(row);
    else { eligible.push(row); discovery.push(row); }
  }

  const sortRows = (rows: RoutingSource[]) => rows.sort((a,b)=>a.priority-b.priority || b.score-a.score || a.name.localeCompare(b.name));
  sortRows(eligible); sortRows(discovery); sortRows(materialization); sortRows(fallback);
  const routingGap = eligible.length ? null : fallback.length ? "FALLBACK_ONLY" : excluded.some((row)=>row.reason === "DISCOVERY_CAPABILITY_MISSING") ? "DISCOVERY_ADAPTER_MISSING" : "ROUTING_CONFIGURATION_GAP";
  const routingPlanId = `ROUTE-${clean(input.collectionTermId) || itemId || projectId || crypto.randomUUID()}-V60`.slice(0,190);

  const result: SourceRoutingPlanResult = {
    routing_plan_id:routingPlanId, project_id:projectId, item_id:itemId, collection_term_id:clean(input.collectionTermId)||null,
    project_domain:projectDomain, universe, composition_class:compositionClass,
    eligible_sources:eligible, excluded_sources:excluded, discovery_sources:discovery, materialization_sources:materialization,
    fallback_sources:fallback, routing_version:60, routing_gap:routingGap, applied_policies:appliedPolicies,
  };

  // Telemetria é persistida em lote após o roteamento; nunca exige uma chamada MCP por fonte.
  await Promise.all(policyOutcomes.filter((entry)=>entry.resolution.block_source||entry.resolution.skip_source).slice(0,20).map((entry)=>
    recordPolicyApplications(entry.resolution,{domain:projectDomain,universe,composition_class:compositionClass,project_id:projectId,item_id:itemId,source:entry.source,requires_api_key:entry.requiresApiKey,configured:entry.configured,project_items:projectItems},"SOURCE_ROUTING")
  )).catch(()=>undefined);
  if (routingGap && routingGap !== "FALLBACK_ONLY") {
    await detectOperationalGap({ category:"SOURCE_ROUTING", severity:"HIGH", project_id:projectId, item_id:itemId, domain:projectDomain, universe, composition_class:compositionClass, symptom:routingGap, root_cause:routingGap === "DISCOVERY_ADAPTER_MISSING" ? "DISCOVERY_CAPABILITY_MISSING" : "NO_ELIGIBLE_DISCOVERY_SOURCE", evidence:{excluded_sources:excluded.slice(0,20).map((row)=>({source:row.source,reason:row.reason}))} }).catch(()=>undefined);
  }

  if (input.persist !== false) {
    const date = now();
    await db.insert(sourceRoutingPlans).values({
      id:routingPlanId, projectId, itemId, collectionTermId:clean(input.collectionTermId)||null, projectDomain, universe,
      compositionClass, targetType, canonicalReference, eligibleSourcesJson:encode(eligible), excludedSourcesJson:encode(excluded),
      discoverySourcesJson:encode(discovery), materializationSourcesJson:encode(materialization), fallbackSourcesJson:encode(fallback),
      routingVersion:60, createdAt:date, updatedAt:date,
    }).onConflictDoUpdate({ target:sourceRoutingPlans.id, set:{ projectId,itemId,collectionTermId:clean(input.collectionTermId)||null,projectDomain,universe,compositionClass,targetType,canonicalReference,eligibleSourcesJson:encode(eligible),excludedSourcesJson:encode(excluded),discoverySourcesJson:encode(discovery),materializationSourcesJson:encode(materialization),fallbackSourcesJson:encode(fallback),routingVersion:60,updatedAt:date } });
  }
  return result;
}

export async function getLatestSourceRoutingPlan(projectId: string, itemId?: string) {
  const conditions = [eq(sourceRoutingPlans.projectId, projectId)];
  if (itemId) conditions.push(eq(sourceRoutingPlans.itemId, itemId));
  const rows = await getDb().select().from(sourceRoutingPlans).where(and(...conditions)).orderBy(asc(sourceRoutingPlans.updatedAt)).limit(100);
  const row = rows.at(-1);
  if (!row) return { found:false, project_id:projectId, item_id:itemId || null };
  return {
    found:true, routing_plan_id:row.id, project_id:row.projectId, item_id:row.itemId, project_domain:row.projectDomain, universe:row.universe,
    composition_class:row.compositionClass, eligible_sources:parseJson<RoutingSource[]>(row.eligibleSourcesJson,[]), excluded_sources:parseJson<RoutingExcluded[]>(row.excludedSourcesJson,[]),
    discovery_sources:parseJson<RoutingSource[]>(row.discoverySourcesJson,[]), materialization_sources:parseJson<RoutingSource[]>(row.materializationSourcesJson,[]), fallback_sources:parseJson<RoutingSource[]>(row.fallbackSourcesJson,[]),
    routing_version:row.routingVersion, applied_policies:[], updated_at:row.updatedAt,
  };
}
