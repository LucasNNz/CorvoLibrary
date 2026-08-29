import { and, asc, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import { getDb } from "../db";
import {
  automaticProjectEvents,
  automaticProjectItems,
  automaticProjects,
  collectionBatches,
  collectionCandidates,
  collectionSourceRuns,
  collectionSources,
  collectionTerms,
  materializationCandidates,
  materializationFiles,
  materializationHostHealth,
  materializationItems,
  settings,
  sourceProfiles,
  supervisorConfigEvents,
  supervisorDecisionQueue,
  supervisorProjectCandidates,
} from "../db/schema";
import { createSignedR2GetUrl } from "./r2-download";
import { signedDownloadUrl } from "./download-signature";
import { materializeUrl } from "./materializer";
import { bridgeMaterializationToSupervisor, reconcileSupervisorMaterializations, resolveBridgedCandidate } from "./supervisor-materialization-bridge";
import { deriveProjectPipelineState, getSupervisorLeaseTelemetry, requireSupervisorLeaseForWrite, runSupervisorWatchdog } from "./supervisor-lease";
import { getOperationalSnapshot, getRouteRanking } from "./performance-control";

const now = () => new Date();
const makeId = (prefix: string) => `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
const clean = (value: unknown) => typeof value === "string" ? value.trim() : "";
const bool = (value: unknown, fallback = false) => typeof value === "boolean" ? value : value === "true" ? true : value === "false" ? false : fallback;
const num = (value: unknown, fallback: number, min = 0, max = 1_000_000) => Math.max(min, Math.min(max, Number.isFinite(Number(value)) ? Number(value) : fallback));
const json = <T,>(value: string | null | undefined, fallback: T): T => { try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; } };
const list = (value: unknown) => Array.isArray(value) ? [...new Set(value.map((v) => clean(v)).filter(Boolean))] : typeof value === "string" ? [...new Set(value.split(/[,\n]/).map((v) => v.trim()).filter(Boolean))] : [];
const encode = (value: unknown) => JSON.stringify(value ?? null);

const SUPERVISOR_ENABLED_KEY = "supervisor_mcp_enabled";
const DEFAULT_PROFILE_KEY = "supervisor_default_source_profile";
const COLLECTION_TIMEOUT_KEY = "collection_fetch_timeout_ms";
const GLOBAL_PARALLELISM_KEY = "collection_parallelism";

export async function getSupervisorMode() {
  const rows = await getDb().select().from(settings).where(inArray(settings.key, [SUPERVISOR_ENABLED_KEY, DEFAULT_PROFILE_KEY, COLLECTION_TIMEOUT_KEY, GLOBAL_PARALLELISM_KEY]));
  const values = new Map(rows.map((row) => [row.key, row.value]));
  return {
    enabled: values.get(SUPERVISOR_ENABLED_KEY) !== "false",
    supervisor: "ChatGPT via MCP",
    operationalControl: "COMPLETO",
    externalVisualQa: values.get(SUPERVISOR_ENABLED_KEY) !== "false" ? "ATIVO" : "INATIVO",
    persistentConfiguration: "ATIVA",
    autonomousCollection: "ATIVA",
    cloudAiRequired: false,
    defaultProfileId: values.get(DEFAULT_PROFILE_KEY) || null,
    collectionTimeoutMs: Number(values.get(COLLECTION_TIMEOUT_KEY) || 5000),
    parallelism: Number(values.get(GLOBAL_PARALLELISM_KEY) || 8),
  };
}

async function configEvent(action: string, key: string | null, previousValue: unknown, nextValue: unknown, reason?: string | null, projectId?: string | null, itemId?: string | null) {
  await getDb().insert(supervisorConfigEvents).values({ id: makeId("SCFG"), action, key, previousValue: previousValue == null ? null : encode(previousValue), nextValue: nextValue == null ? null : encode(nextValue), reason: reason || null, projectId: projectId || null, itemId: itemId || null, source: "SUPERVISOR_MCP", createdAt: now() });
}

async function setSetting(key: string, value: string, reason?: string) {
  const db = getDb();
  const [before] = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
  const date = now();
  await db.insert(settings).values({ key, value, updatedAt: date }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: date } });
  await configEvent("CONFIG_UPDATE", key, before?.value ?? null, value, reason || null);
}

export async function setSupervisorMode(enabled: boolean, reason?: string) {
  await setSetting(SUPERVISOR_ENABLED_KEY, enabled ? "true" : "false", reason || (enabled ? "Supervisor ChatGPT via MCP ativado" : "Supervisor ChatGPT via MCP desativado"));
  return getSupervisorMode();
}

export async function updateGlobalCollectorConfig(input: Record<string, unknown>) {
  if (input.timeout_ms !== undefined) await setSetting(COLLECTION_TIMEOUT_KEY, String(num(input.timeout_ms, 5000, 1000, 120000)), clean(input.motivo));
  if (input.paralelismo !== undefined) await setSetting(GLOBAL_PARALLELISM_KEY, String(num(input.paralelismo, 8, 1, 20)), clean(input.motivo));
  return getSupervisorMode();
}

export async function listSourceProfiles(status?: string) {
  const rows = status ? await getDb().select().from(sourceProfiles).where(eq(sourceProfiles.status, status)).orderBy(asc(sourceProfiles.priority)) : await getDb().select().from(sourceProfiles).orderBy(asc(sourceProfiles.priority));
  return rows.map((row) => ({ ...row, universes: json<string[]>(row.universes, []), preferredHosts: json<string[]>(row.preferredHosts, []), blockedHosts: json<string[]>(row.blockedHosts, []), preferredSources: json<string[]>(row.preferredSources, []), negativeTerms: json<string[]>(row.negativeTerms, []), acceptedFormats: json<string[]>(row.acceptedFormats, []), allowedConversions: json<string[]>(row.allowedConversions, []) }));
}

let profileMetricsRefreshedAt = 0;
async function refreshSourceProfileTechnicalMetrics(force = false) {
  if (!force && Date.now() - profileMetricsRefreshedAt < 60_000) return;
  profileMetricsRefreshedAt = Date.now();
  const db = getDb();
  const [profiles, sources] = await Promise.all([db.select().from(sourceProfiles), db.select().from(collectionSources)]);
  const normalized = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  for (const profile of profiles) {
    const preferred = json<string[]>(profile.preferredSources, []).map(normalized).filter(Boolean);
    if (!preferred.length) continue;
    const matched = sources.filter((source) => preferred.some((name) => normalized(source.name).includes(name) || name.includes(normalized(source.name))));
    if (!matched.length) continue;
    const successes = matched.reduce((sum, source) => sum + source.materializedCount, 0);
    const failures = matched.reduce((sum, source) => sum + source.failureCount, 0);
    const queries = matched.reduce((sum, source) => sum + source.queryCount, 0);
    const duration = matched.reduce((sum, source) => sum + source.totalDurationMs, 0);
    const total = successes + failures;
    await db.update(sourceProfiles).set({ technicalSuccesses: successes, technicalFailures: failures, technicalSuccessRate: total ? Math.round(successes / total * 100) : profile.technicalSuccessRate, avgTimeMs: queries ? Math.round(duration / queries) : profile.avgTimeMs, updatedAt: now() }).where(eq(sourceProfiles.id, profile.id));
  }
}

export async function saveSourceProfile(input: Record<string, unknown>) {
  const db = getDb(), id = clean(input.id) || makeId("SPROF"), date = now();
  const [before] = await db.select().from(sourceProfiles).where(eq(sourceProfiles.id, id)).limit(1);
  const data = {
    id,
    name: clean(input.nome) || clean(input.name) || before?.name || `Perfil ${id}`,
    status: clean(input.status).toUpperCase() || before?.status || "ATIVO",
    type: clean(input.tipo) || before?.type || "qualquer",
    domain: clean(input.domain || input.dominio).toUpperCase() || before?.domain || "GENERAL",
    universes: encode(list(input.universos).length ? list(input.universos) : json(before?.universes, [])),
    compositionClass: clean(input.composition_class) || before?.compositionClass || null,
    semanticClass: clean(input.semantic_class) || before?.semanticClass || null,
    preferredHosts: encode(list(input.hosts_prioritarios).length ? list(input.hosts_prioritarios) : json(before?.preferredHosts, [])),
    blockedHosts: encode(list(input.hosts_bloqueados).length ? list(input.hosts_bloqueados) : json(before?.blockedHosts, [])),
    preferredSources: encode(list(input.fontes_prioritarias).length ? list(input.fontes_prioritarias) : json(before?.preferredSources, [])),
    queryTemplate: clean(input.query_template) || before?.queryTemplate || null,
    negativeTerms: encode(list(input.negative_terms).length ? list(input.negative_terms) : json(before?.negativeTerms, [])),
    timeoutMs: num(input.timeout_ms, before?.timeoutMs ?? 5000, 1000, 120000),
    maxConsecutiveFailures: num(input.max_falhas_consecutivas, before?.maxConsecutiveFailures ?? 2, 1, 20),
    maxUrlsPerTerm: num(input.max_urls_por_termo, before?.maxUrlsPerTerm ?? 60, 1, 500),
    maxSourcesPerTerm: num(input.max_fontes_por_termo, before?.maxSourcesPerTerm ?? 20, 1, 100),
    maxRounds: num(input.max_rodadas, before?.maxRounds ?? 3, 1, 20),
    acceptedFormats: encode(list(input.formatos_aceitos).length ? list(input.formatos_aceitos) : json(before?.acceptedFormats, ["png","webp","jpg","jpeg"])),
    materializationMode: clean(input.materializacao) || before?.materializationMode || "direta",
    allowedConversions: encode(list(input.conversoes_permitidas).length ? list(input.conversoes_permitidas) : json(before?.allowedConversions, [])),
    transparency: clean(input.transparencia) || before?.transparency || null,
    minWidth: num(input.largura_minima, before?.minWidth ?? 64, 1, 10000),
    minHeight: num(input.altura_minima, before?.minHeight ?? 64, 1, 10000),
    technicalSuccessRate: before?.technicalSuccessRate ?? 0,
    visualApprovalRate: before?.visualApprovalRate ?? 0,
    avgTimeMs: before?.avgTimeMs ?? 0,
    technicalSuccesses: before?.technicalSuccesses ?? 0,
    technicalFailures: before?.technicalFailures ?? 0,
    visualApprovals: before?.visualApprovals ?? 0,
    visualRejections: before?.visualRejections ?? 0,
    priority: num(input.prioridade, before?.priority ?? 3, 1, 100),
    isDefault: bool(input.padrao, before?.isDefault ?? false),
    notes: clean(input.observacoes) || before?.notes || null,
    createdAt: before?.createdAt || date,
    updatedAt: date,
  };
  const { id: _profileId, createdAt: _profileCreatedAt, ...profileUpdates } = data;
  await db.insert(sourceProfiles).values(data).onConflictDoUpdate({ target: sourceProfiles.id, set: profileUpdates });
  if (data.isDefault) {
    await db.update(sourceProfiles).set({ isDefault: false, updatedAt: date }).where(and(sql`${sourceProfiles.id} <> ${id}`, eq(sourceProfiles.isDefault, true)));
    await setSetting(DEFAULT_PROFILE_KEY, id, "Perfil salvo como padrão pelo Supervisor MCP");
  }
  await configEvent(before ? "SOURCE_PROFILE_UPDATE" : "SOURCE_PROFILE_CREATE", id, before || null, data, clean(input.motivo));
  return (await listSourceProfiles()).find((row) => row.id === id)!;
}

export async function setSourceProfileState(id: string, active: boolean, reason?: string) {
  const db = getDb(); const [before] = await db.select().from(sourceProfiles).where(eq(sourceProfiles.id, id)).limit(1); if (!before) throw new Error("SOURCE_PROFILE_NOT_FOUND");
  await db.update(sourceProfiles).set({ status: active ? "ATIVO" : "INATIVO", updatedAt: now() }).where(eq(sourceProfiles.id, id));
  await configEvent(active ? "SOURCE_PROFILE_ACTIVATE" : "SOURCE_PROFILE_DEACTIVATE", id, before.status, active ? "ATIVO" : "INATIVO", reason);
  return (await listSourceProfiles()).find((row) => row.id === id)!;
}

export async function saveProfileAsDefault(id: string, reason?: string) {
  const db = getDb(), date = now(); const [row] = await db.select().from(sourceProfiles).where(eq(sourceProfiles.id, id)).limit(1); if (!row) throw new Error("SOURCE_PROFILE_NOT_FOUND");
  await db.update(sourceProfiles).set({ isDefault: false, updatedAt: date }).where(eq(sourceProfiles.isDefault, true));
  await db.update(sourceProfiles).set({ isDefault: true, status: "ATIVO", updatedAt: date }).where(eq(sourceProfiles.id, id));
  await setSetting(DEFAULT_PROFILE_KEY, id, reason || "SALVAR COMO PADRAO");
  await configEvent("SAVE_AS_DEFAULT", id, null, row.name, reason || "SALVAR COMO PADRAO");
  return (await listSourceProfiles()).find((profile) => profile.id === id)!;
}

export async function bestSourceProfile(input: { compositionClass?: string | null; semanticClass?: string | null; universe?: string | null; kind?: string | null; domain?: string | null }) {
  await refreshSourceProfileTechnicalMetrics();
  const profiles = (await listSourceProfiles("ATIVO"));
  const universe = clean(input.universe).toLowerCase(), composition = clean(input.compositionClass).toUpperCase(), semantic = clean(input.semanticClass).toUpperCase(), kind = clean(input.kind).toLowerCase(), domain = clean(input.domain).toUpperCase();
  const scored = profiles.map((profile) => {
    if (domain && profile.domain && !["GENERAL", "MULTI", domain].includes(profile.domain.toUpperCase())) return { profile, score: -10000 };
    let score = (profile.isDefault ? 10 : 0) + Math.max(0, 10 - profile.priority);
    if (domain && profile.domain?.toUpperCase() === domain) score += 40;
    if (profile.compositionClass && profile.compositionClass.toUpperCase() === composition) score += 30;
    if (profile.semanticClass && profile.semanticClass.toUpperCase() === semantic) score += 20;
    if (profile.type && profile.type !== "qualquer" && profile.type.toLowerCase() === kind) score += 15;
    if (profile.universes.some((value) => value.toLowerCase() === universe)) score += 25;
    score += Math.round(profile.visualApprovalRate / 10) + Math.round(profile.technicalSuccessRate / 10);
    return { profile, score };
  }).sort((a,b) => b.score - a.score || a.profile.priority - b.profile.priority);
  return scored[0]?.profile || null;
}

export async function sourcePolicyForItem(input: { term: string; compositionClass?: string | null; semanticClass?: string | null; universe?: string | null; kind?: string | null; domain?: string | null }) {
  const profile = await bestSourceProfile(input);
  const universe = clean(input.universe);
  const composition = clean(input.compositionClass).toUpperCase();
  const ranking = await getRouteRanking(universe || undefined, composition || undefined, 30).catch(() => []);
  const learnedPreferred = ranking.filter((row) => row.score > 0).map((row) => row.sourceName);
  const learnedAvoid = ranking.filter((row) => row.score < -100).map((row) => row.sourceName);
  const preferredSources = [...new Set([...(profile?.preferredSources || []), ...learnedPreferred])];
  const profileSpecificToUniverse = Boolean(profile && universe && profile.universes.some((value) => value.toLowerCase() === universe.toLowerCase()));
  const profileSpecificToComposition = Boolean(profile?.compositionClass && composition && profile.compositionClass.toUpperCase() === composition);
  const query = profile?.queryTemplate ? profile.queryTemplate.replace(/\{(?:personagem|termo|conceito|referencia)\}/gi, input.term).replace(/\{universo\}/gi, universe) : input.term;
  return {
    profile_id: profile?.id || null,
    query,
    preferred_sources: preferredSources,
    avoid_sources: learnedAvoid,
    strict_preferred_sources: preferredSources.length > 0 && (profileSpecificToUniverse || profileSpecificToComposition),
    negative_terms: profile?.negativeTerms || [],
    preferred_hosts: profile?.preferredHosts || [],
    avoid_hosts: profile?.blockedHosts || [],
    max_rounds: profile?.maxRounds || 3,
    max_urls_per_term: profile?.maxUrlsPerTerm || 60,
    max_sources_per_term: profile?.maxSourcesPerTerm || 20,
    timeout_ms: profile?.timeoutMs || (await getSupervisorMode()).collectionTimeoutMs,
  };
}

export async function ensureDecision(input: { projectId?: string | null; itemId?: string | null; candidateId?: string | null; type: string; priority?: number; evidence?: unknown; allowedActions?: string[] }) {
  const db = getDb(), type = input.type.toUpperCase();
  const where = input.itemId ? and(eq(supervisorDecisionQueue.itemId, input.itemId), eq(supervisorDecisionQueue.type, type), eq(supervisorDecisionQueue.state, "PENDENTE")) : input.projectId ? and(eq(supervisorDecisionQueue.projectId, input.projectId), eq(supervisorDecisionQueue.type, type), eq(supervisorDecisionQueue.state, "PENDENTE")) : and(eq(supervisorDecisionQueue.type, type), eq(supervisorDecisionQueue.state, "PENDENTE"));
  const [existing] = await db.select().from(supervisorDecisionQueue).where(where).limit(1);
  if (existing) {
    await db.update(supervisorDecisionQueue).set({ candidateId: input.candidateId || existing.candidateId, evidence: encode(input.evidence || json(existing.evidence, {})), allowedActions: encode(input.allowedActions || json(existing.allowedActions, [])), updatedAt: now() }).where(eq(supervisorDecisionQueue.id, existing.id));
    return { ...existing, evidence: input.evidence || json(existing.evidence, {}), allowedActions: input.allowedActions || json(existing.allowedActions, []) };
  }
  const row = { id: makeId("SDEC"), projectId: input.projectId || null, itemId: input.itemId || null, candidateId: input.candidateId || null, type, priority: input.priority || 1, state: "PENDENTE", evidence: encode(input.evidence || {}), allowedActions: encode(input.allowedActions || []), source: "AUTOMATICO", createdAt: now(), updatedAt: now() };
  await db.insert(supervisorDecisionQueue).values(row);
  return { ...row, evidence: input.evidence || {}, allowedActions: input.allowedActions || [] };
}

export async function syncDecisionQueue(projectId: string) {
  const db = getDb();
  const [project] = await db.select().from(automaticProjects).where(eq(automaticProjects.id, projectId)).limit(1); if (!project) throw new Error("PROJECT_NOT_FOUND");
  const items = await db.select().from(automaticProjectItems).where(and(eq(automaticProjectItems.projectId, projectId), eq(automaticProjectItems.version, project.activeVersion))).orderBy(asc(automaticProjectItems.priority));
  const bridged = await db.select().from(supervisorProjectCandidates).where(and(eq(supervisorProjectCandidates.projectId, projectId), eq(supervisorProjectCandidates.status, "PARA_QA_VISUAL")));
  const bridgeByItem = new Map(bridged.map((row) => [row.itemId, row]));
  let created = 0;
  for (const item of items) {
    const activeBridge = bridgeByItem.get(item.id);
    if (item.status === "QA_READY") { await ensureDecision({ projectId, itemId: item.id, candidateId: activeBridge?.id || item.collectionCandidateId, type: "QA_VISUAL", priority: item.priority, evidence: { target_file: item.targetFile || item.itemKey, term: item.term, reference: item.semanticReference || item.term, universe: item.universe, composition_class: item.compositionClass, supervisor_candidate_id: activeBridge?.id || null, materialization_file_id: activeBridge?.materializationFileId || item.materializationFileId }, allowedActions: ["APROVADO","REJEITADO","RELINK_REQUIRED","CORRECAO_TECNICA_PERMITIDA"] }); created += 1; }
    else if (item.status === "RELINK_REQUIRED") { await ensureDecision({ projectId, itemId: item.id, type: "RELINK", priority: item.priority, evidence: { term: item.term, reference: item.semanticReference, failure: item.failureReason }, allowedActions: ["ALTERAR_REFERENCIA","ALTERAR_QUERY","TROCAR_FONTE","CANCELAR_ITEM","RETOMAR_ITEM"] }); created += 1; }
    else if (item.status === "TECHNICAL_CORRECTION_REQUIRED") { await ensureDecision({ projectId, itemId: item.id, candidateId: item.collectionCandidateId, type: "TECHNICAL_FIX", priority: item.priority, evidence: { target_file: item.targetFile || item.itemKey, composition_class: item.compositionClass, failure: item.failureReason }, allowedActions: ["APLICAR_CORRECAO_TECNICA","RELINK_REQUIRED","REJEITADO"] }); created += 1; }
    else if (["FAILED_INFRASTRUCTURE","FAILED"].includes(item.status)) {
      const obviousInfra = /HTTP_404|HTTP_403|SOURCE_EMPTY|SOURCE_NOT_CONFIGURED|SEGREDO_NAO_CONFIGURADO|BRAVE_DISCOVERY_NAO_CONFIGURADO|DOWNLOAD_TIMEOUT|RATE_LIMITED/i.test(item.failureReason || "");
      if (!obviousInfra) { await ensureDecision({ projectId, itemId: item.id, type: "MATERIALIZATION_FAILURE", priority: item.priority, evidence: { failure: item.failureReason, attempts: item.attempts }, allowedActions: ["TROCAR_FONTE","ALTERAR_TIMEOUT","RELINK_REQUIRED","CANCELAR_ITEM"] }); created += 1; }
    }
  }
  const relinkItems = items.filter((item) => item.status === "RELINK_REQUIRED");
  if (relinkItems.length >= 3 || (items.length >= 4 && relinkItems.length / items.length >= 0.25)) {
    await ensureDecision({ projectId, type: "STRATEGY_REVIEW", priority: 1, evidence: { relink_count: relinkItems.length, total_items: items.length }, allowedActions: ["ALTERAR_PRIORIDADE_FONTE","SALVAR_PERFIL_COLETA","ALTERAR_LIMITES_COLETA","CONTINUAR_PROCESSAMENTO"] });
    created += 1;
  }
  if (project.collectionBatchId) {
    const runs = await db.select().from(collectionSourceRuns).where(eq(collectionSourceRuns.batchId, project.collectionBatchId)).orderBy(desc(collectionSourceRuns.createdAt)).limit(100);
    const badRuns = runs.filter((run) => run.failureCount > 0 || !["OK","SUCESSO","COMPLETO","CONCLUIDA"].includes(run.status.toUpperCase()));
    const supervisorRuns = badRuns.filter((run) => !/SOURCE_NOT_CONFIGURED|SEGREDO_NAO_CONFIGURADO|SOURCE_EMPTY|HTTP_404|FONTE_HTTP_404|BRAVE_DISCOVERY_NAO_CONFIGURADO/i.test(run.detail || ""));
    if (supervisorRuns.length) {
      await ensureDecision({ projectId, type: "SOURCE_FAILURE", priority: 2, evidence: { runs: supervisorRuns.slice(0, 15).map((run) => ({ source_id: run.sourceId, failures: run.failureCount, status: run.status, detail: run.detail })) }, allowedActions: ["TROCAR_FONTE","ALTERAR_PRIORIDADE_FONTE","DESATIVAR_FONTE","ALTERAR_TIMEOUT"] });
      created += 1;
    }
    const projectCandidates = await db.select().from(collectionCandidates).where(eq(collectionCandidates.batchId, project.collectionBatchId)).limit(300);
    const candidateHosts = new Set(projectCandidates.map((candidate) => { try { return new URL(candidate.url).hostname.toLowerCase(); } catch { return ""; } }).filter(Boolean));
    if (candidateHosts.size) {
      const hostRows = await db.select().from(materializationHostHealth).where(eq(materializationHostHealth.circuitState, "OPEN")).limit(200);
      const related = hostRows.filter((host) => candidateHosts.has(host.host.toLowerCase()));
      if (related.length) {
        await ensureDecision({ projectId, type: "CIRCUIT_BREAKER", priority: 2, evidence: { hosts: related.map((host) => ({ host: host.host, blocked_until: host.blockedUntil, failures: host.recentFailureCount })) }, allowedActions: ["MANTER_BLOQUEIO","DESBLOQUEAR_HOST","TROCAR_FONTE","ALTERAR_QUERY"] });
        created += 1;
      }
    }
  }
  return { projeto_id: projectId, sincronizadas: created };
}

export async function resolveDecision(id: string, decision: string, observation?: string, executionId?: string) {
  const db = getDb(); const [row] = await db.select().from(supervisorDecisionQueue).where(eq(supervisorDecisionQueue.id, id)).limit(1); if (!row) throw new Error("SUPERVISOR_DECISION_NOT_FOUND");
  if (row.projectId) await requireSupervisorLeaseForWrite(row.projectId, executionId, "RESOLVER_DECISAO_SUPERVISOR");
  await db.update(supervisorDecisionQueue).set({ state: "RESOLVIDA", decision, observation: observation || null, source: "SUPERVISOR_MCP", resolvedAt: now(), updatedAt: now() }).where(eq(supervisorDecisionQueue.id, id));
  return { ...row, state: "RESOLVIDA", decision, observation: observation || null };
}

export async function listPendingDecisions(projectId?: string, limit = 50) {
  const db = getDb();
  const where = projectId ? and(eq(supervisorDecisionQueue.projectId, projectId), eq(supervisorDecisionQueue.state, "PENDENTE")) : eq(supervisorDecisionQueue.state, "PENDENTE");
  const rows = await db.select().from(supervisorDecisionQueue).where(where).orderBy(asc(supervisorDecisionQueue.priority), asc(supervisorDecisionQueue.createdAt)).limit(Math.max(1, Math.min(200, limit)));
  return rows.map((row) => ({ ...row, evidence: json(row.evidence, {}), allowedActions: json(row.allowedActions, []) }));
}

export async function getVisualQaEvidence(projectId: string, limit = 20, origin?: string, code?: string) {
  // V56: leitura de QA é side-effect free. Backfill/reconciliação é feito na ponte de
  // materialização e, para legado, somente pela ferramenta explícita de reconciliação.
  const db = getDb();
  const [project] = await db.select({ id: automaticProjects.id, activeVersion: automaticProjects.activeVersion }).from(automaticProjects).where(eq(automaticProjects.id, projectId)).limit(1);
  if (!project) throw new Error("PROJECT_NOT_FOUND");
  const max = Math.max(1, Math.min(50, limit));
  const queueRows = await db.select().from(supervisorProjectCandidates)
    .where(and(eq(supervisorProjectCandidates.projectId, projectId), eq(supervisorProjectCandidates.status, "PARA_QA_VISUAL")))
    .orderBy(asc(supervisorProjectCandidates.createdAt)).limit(max);
  if (!queueRows.length) return { projeto_id: projectId, candidatas: [], total: 0, regra: "Leitura direta do D1; use reconciliar_projeto_automatico apenas para backfill legado.", __resources: [] };

  const itemIds = [...new Set(queueRows.map((row) => row.itemId).filter(Boolean))];
  const fileIds = [...new Set(queueRows.map((row) => row.materializationFileId).filter(Boolean))];
  const matItemIds = [...new Set(queueRows.map((row) => row.materializationItemId).filter(Boolean))];
  const [items, files, matItems] = await Promise.all([
    itemIds.length ? db.select().from(automaticProjectItems).where(and(inArray(automaticProjectItems.id, itemIds), eq(automaticProjectItems.version, project.activeVersion))) : Promise.resolve([]),
    fileIds.length ? db.select().from(materializationFiles).where(inArray(materializationFiles.id, fileIds)) : Promise.resolve([]),
    matItemIds.length ? db.select().from(materializationItems).where(inArray(materializationItems.id, matItemIds)) : Promise.resolve([]),
  ]);
  const itemMap = new Map(items.map((row) => [row.id, row]));
  const fileMap = new Map(files.map((row) => [row.id, row]));
  const matItemMap = new Map(matItems.map((row) => [row.id, row]));
  const output = [];
  for (const queued of queueRows) {
    const item = itemMap.get(queued.itemId), file = fileMap.get(queued.materializationFileId), matItem = matItemMap.get(queued.materializationItemId);
    if (!item || !file || !matItem) continue;
    const expires = Date.now() + 30 * 60_000;
    let fileUrl = origin ? signedDownloadUrl(origin, `/api/materializations/${encodeURIComponent(file.id)}`, expires) : "";
    if (!fileUrl) { try { fileUrl = await createSignedR2GetUrl(file.r2Key, 30, item.targetFile || item.itemKey, file.mimeType); } catch { fileUrl = ""; } }
    output.push({
      candidate_id: queued.id, collection_candidate_id: queued.collectionCandidateId, materialization_candidate_id: queued.materializationCandidateId,
      item_id: item.id, item_key: item.itemKey, target_filename: item.targetFile || item.itemKey,
      semantic_reference: item.semanticReference || item.term, visual_reference: matItem.visualReference || item.semanticReference || item.term,
      universe: item.universe, preset: matItem.preset || null, slot: matItem.slot || null, context: item.context,
      source: queued.source || item.sourceType, original_url: queued.originalUrl || null, host: queued.host || null,
      file_id: file.id, file_url: fileUrl || null, mime_type: file.mimeType, width: file.width, height: file.height, size_bytes: file.sizeBytes,
      transparency_required: Boolean(matItem.requiresAlpha), technical_status: file.technicalStatus, attempt_history: json<Record<string, unknown>>(item.strategyState, {}),
      qa_status: queued.status, project_id: projectId, materialization_batch_id: queued.materializationBatchId, materialization_item_id: queued.materializationItemId,
    });
  }
  return { projeto_id: projectId, candidatas: output, total: output.length, regra: "Toda candidata vem de arquivo real materializado e vinculado a project_id + item_id. Leitura QA não executa reconciliação.", __resources: output.filter((entry) => typeof entry.file_url === "string" && entry.file_url).map((entry) => ({ name: entry.target_filename, uri: entry.file_url as string, mimeType: entry.mime_type, description: `Candidata ${entry.candidate_id || entry.item_id} pronta para QA visual do Supervisor MCP` })) };
}

export async function controlProject(projectId: string, action: "pausar" | "retomar" | "cancelar" | "continuar") {
  const db = getDb(); const [project] = await db.select().from(automaticProjects).where(eq(automaticProjects.id, projectId)).limit(1); if (!project) throw new Error("PROJECT_NOT_FOUND");
  if (["COMPLETED","COMPLETED_WITH_WARNINGS","FORCED_CLOSED","CONCLUIDO_MANUAL"].includes(project.status)) throw new Error("PROJECT_COMPLETED_LOCKED");
  const status = action === "pausar" ? "PAUSED_BY_SUPERVISOR" : action === "cancelar" ? "CANCELLED" : "PROCESSING";
  await db.update(automaticProjects).set({ status, updatedAt: now() }).where(eq(automaticProjects.id, projectId));
  await db.insert(automaticProjectEvents).values({ id: makeId("PEVT"), projectId, event: `supervisor_${action}`, status, detail: encode({ source: "SUPERVISOR_MCP" }), createdAt: now() });
  return { projeto_id: projectId, acao: action, status };
}

export async function controlItem(projectId: string, itemId: string, action: "pausar" | "retomar" | "cancelar") {
  const db = getDb(); const [item] = await db.select().from(automaticProjectItems).where(and(eq(automaticProjectItems.projectId, projectId), or(eq(automaticProjectItems.id, itemId), eq(automaticProjectItems.itemKey, itemId)))).limit(1); if (!item) throw new Error("ITEM_NOT_FOUND");
  if (["APPROVED","FROZEN","LINKED_FROM_LIBRARY","LINKED_FROM_FAMILY"].includes(item.status) && action !== "pausar") throw new Error("ITEM_FROZEN_LOCKED");
  const status = action === "pausar" ? "PAUSED_BY_SUPERVISOR" : action === "cancelar" ? "CANCELLED" : item.collectionTermId ? "SEARCHING_EXTERNALLY" : "QUEUED";
  await db.update(automaticProjectItems).set({ status, failureReason: action === "cancelar" ? "CANCELLED_BY_SUPERVISOR" : null, updatedAt: now() }).where(eq(automaticProjectItems.id, item.id));
  await db.insert(automaticProjectEvents).values({ id: makeId("PEVT"), projectId, itemId: item.id, event: `supervisor_item_${action}`, status, detail: encode({ source: "SUPERVISOR_MCP" }), createdAt: now() });
  return { projeto_id: projectId, item_id: item.id, acao: action, status };
}

export async function alterItemStrategy(input: Record<string, unknown>) {
  const projectId = clean(input.projeto_id), itemId = clean(input.item_id), db = getDb();
  const [item] = await db.select().from(automaticProjectItems).where(and(eq(automaticProjectItems.projectId, projectId), or(eq(automaticProjectItems.id, itemId), eq(automaticProjectItems.itemKey, itemId)))).limit(1); if (!item) throw new Error("ITEM_NOT_FOUND");
  if (["APPROVED","FROZEN","LINKED_FROM_LIBRARY","LINKED_FROM_FAMILY"].includes(item.status)) throw new Error("ITEM_FROZEN_LOCKED");
  const state = json<Record<string, unknown>>(item.strategyState, {}), current = (state.current_strategy && typeof state.current_strategy === "object" ? state.current_strategy as Record<string, unknown> : {});
  const reference = clean(input.referencia), query = clean(input.query), source = clean(input.fonte), timeout = input.timeout_ms === undefined ? undefined : num(input.timeout_ms, 5000, 1000, 120000);
  const next = { ...current, ...(query ? { queries: [query] } : {}), ...(source ? { preferred_sources: [source] } : {}), ...(timeout ? { timeout_ms: timeout } : {}) };
  state.current_strategy = next;
  await db.update(automaticProjectItems).set({ semanticReference: reference || item.semanticReference, searchPlan: encode(next), strategyState: encode(state), status: query || reference || source ? "RELINK_REQUIRED" : item.status, failureReason: clean(input.motivo) || item.failureReason, updatedAt: now() }).where(eq(automaticProjectItems.id, item.id));
  if (item.collectionTermId && query) await db.update(collectionTerms).set({ term: query, status: "PENDENTE", sourceCursor: 0, rounds: 0, attempts: 0, failureReason: null, sourcePlan: encode(next), updatedAt: now() }).where(eq(collectionTerms.id, item.collectionTermId));
  await configEvent("ITEM_STRATEGY_UPDATE", "item_strategy", { reference: item.semanticReference, searchPlan: item.searchPlan }, { reference: reference || item.semanticReference, strategy: next }, clean(input.motivo), projectId, item.id);
  return { projeto_id: projectId, item_id: item.id, referencia: reference || item.semanticReference, estrategia: next, status: "RELINK_REQUIRED" };
}

export async function alterItemsStrategiesBatch(projectId: string, changes: Array<Record<string, unknown>>) {
  const db = getDb(), rows = changes.slice(0,20);
  if (!rows.length) throw new Error("ITENS_REQUIRED");
  const keys = [...new Set(rows.map((row)=>clean(row.item_id)).filter(Boolean))];
  const items = keys.length ? await db.select().from(automaticProjectItems).where(and(eq(automaticProjectItems.projectId,projectId),or(inArray(automaticProjectItems.id,keys),inArray(automaticProjectItems.itemKey,keys)))) : [];
  const itemMap = new Map<string,typeof automaticProjectItems.$inferSelect>();
  for (const item of items) { itemMap.set(item.id,item); itemMap.set(item.itemKey,item); }
  const updates = [], termUpdates = [], results = [];
  for (const row of rows) {
    const itemKey = clean(row.item_id), item = itemMap.get(itemKey);
    if (!item) { results.push({item_id:itemKey,erro:"ITEM_NOT_FOUND"}); continue; }
    if (["APPROVED","FROZEN","LINKED_FROM_LIBRARY","LINKED_FROM_FAMILY"].includes(item.status)) { results.push({item_id:itemKey,erro:"ITEM_FROZEN_LOCKED"}); continue; }
    const state = json<Record<string,unknown>>(item.strategyState,{}), current = state.current_strategy && typeof state.current_strategy === "object" ? state.current_strategy as Record<string,unknown> : {};
    const reference=clean(row.referencia), query=clean(row.query), source=clean(row.fonte), timeout=row.timeout_ms===undefined?undefined:num(row.timeout_ms,5000,1000,120000);
    const queryVariants=Array.isArray(row.queries)?[...new Set((row.queries as unknown[]).map(String).map((v)=>v.trim()).filter(Boolean))]:query?[query]:[];
    const preferredSources=Array.isArray(row.preferred_sources)?[...new Set((row.preferred_sources as unknown[]).map(String).map((v)=>v.trim()).filter(Boolean))]:source?[source]:[];
    const blockedSources=Array.isArray(row.blocked_sources)?[...new Set((row.blocked_sources as unknown[]).map(String).map((v)=>v.trim()).filter(Boolean))]:[];
    const next={...current,...(queryVariants.length?{queries:queryVariants}:{}),...(preferredSources.length?{preferred_sources:preferredSources,strict_preferred_sources:true}:{}),...(blockedSources.length?{avoid_sources:blockedSources}:{}),...(timeout?{timeout_ms:timeout}:{})};
    state.current_strategy=next;
    updates.push(db.update(automaticProjectItems).set({semanticReference:reference||item.semanticReference,searchPlan:encode(next),strategyState:encode(state),status:"RELINK_REQUIRED",failureReason:clean(row.motivo)||item.failureReason,stageReadyAt:now(),updatedAt:now()}).where(eq(automaticProjectItems.id,item.id)));
    if (item.collectionTermId && query) termUpdates.push(db.update(collectionTerms).set({term:query,status:"PENDENTE",sourceCursor:0,rounds:0,attempts:0,failureReason:null,sourcePlan:encode(next),updatedAt:now()}).where(eq(collectionTerms.id,item.collectionTermId)));
    results.push({item_id:item.itemKey,status:"RELINK_REQUIRED",referencia:reference||item.semanticReference,query:query||null,fonte:source||null});
  }
  if (updates.length) await db.batch(updates as [typeof updates[number], ...Array<typeof updates[number]>]);
  if (termUpdates.length) await db.batch(termUpdates as [typeof termUpdates[number], ...Array<typeof termUpdates[number]>]);
  return {projeto_id:projectId,processados:results.length,resultados:results};
}

export async function blockHost(hostInput: string, blocked: boolean, reason?: string, minutes = 120) {
  const host = clean(hostInput).toLowerCase(); if (!host) throw new Error("HOST_REQUIRED"); const db = getDb(), date = now();
  const [before] = await db.select().from(materializationHostHealth).where(eq(materializationHostHealth.host, host)).limit(1);
  const values = { host, successCount: before?.successCount || 0, failureCount: before?.failureCount || 0, recentFailureCount: before?.recentFailureCount || 0, circuitState: blocked ? "OPEN" : "CLOSED", blockedUntil: blocked ? new Date(Date.now() + Math.max(1, minutes) * 60_000) : null, updatedAt: date };
  await db.insert(materializationHostHealth).values(values).onConflictDoUpdate({ target: materializationHostHealth.host, set: { circuitState: values.circuitState, blockedUntil: values.blockedUntil, recentFailureCount: blocked ? Math.max(2, values.recentFailureCount) : 0, updatedAt: date } });
  await configEvent(blocked ? "HOST_BLOCK" : "HOST_UNBLOCK", host, before || null, values, reason);
  return values;
}

export async function changeSourcePriority(sourceIdOrName: string, priority: number, active?: boolean, reason?: string) {
  const db = getDb(); const key = clean(sourceIdOrName); const [source] = await db.select().from(collectionSources).where(or(eq(collectionSources.id, key), eq(collectionSources.name, key))).limit(1); if (!source) throw new Error("COLLECTION_SOURCE_NOT_FOUND");
  const set: Record<string, unknown> = { priority: num(priority, source.priority, 1, 100), updatedAt: now() }; if (typeof active === "boolean") set.active = active;
  await db.update(collectionSources).set(set).where(eq(collectionSources.id, source.id)); await configEvent("SOURCE_PRIORITY_UPDATE", source.id, { priority: source.priority, active: source.active }, set, reason);
  return { ...source, ...set };
}

export async function changeCollectionLimits(input: Record<string, unknown>) {
  const batchId = clean(input.lote_id), db = getDb(); const [batch] = await db.select().from(collectionBatches).where(eq(collectionBatches.id, batchId)).limit(1); if (!batch) throw new Error("COLLECTION_BATCH_NOT_FOUND");
  const set = { maxUrlsPerTerm: num(input.max_urls_por_termo, batch.maxUrlsPerTerm, 1, 500), maxSourcesPerTerm: num(input.max_fontes_por_termo, batch.maxSourcesPerTerm, 1, 100), maxRoundsPerTerm: num(input.max_rodadas, batch.maxRoundsPerTerm, 1, 50), maxTermMinutes: num(input.max_minutos_por_termo, batch.maxTermMinutes, 1, 1440), maxTotalMinutes: num(input.max_minutos_total, batch.maxTotalMinutes, 1, 10080), updatedAt: now() };
  await db.update(collectionBatches).set(set).where(eq(collectionBatches.id, batchId)); await configEvent("COLLECTION_LIMITS_UPDATE", batchId, batch, set, clean(input.motivo)); return { ...batch, ...set };
}

export async function discardCollectionCandidate(candidateId: string, reason?: string) {
  const db = getDb(); const [candidate] = await db.select().from(collectionCandidates).where(eq(collectionCandidates.id, candidateId)).limit(1); if (!candidate) throw new Error("COLLECTION_CANDIDATE_NOT_FOUND");
  await db.update(collectionCandidates).set({ status: "DESCARTADO", failureReason: reason || "DESCARTADO_PELO_SUPERVISOR", updatedAt: now() }).where(eq(collectionCandidates.id, candidateId));
  await configEvent("CANDIDATE_DISCARD", candidateId, candidate.status, "DESCARTADO", reason); return { ...candidate, status: "DESCARTADO", failureReason: reason || "DESCARTADO_PELO_SUPERVISOR" };
}

export async function recordQaMetrics(projectId: string, itemId: string, decision: string) {
  const approved = decision.toUpperCase() === "APROVADO";
  const rejected = decision.toUpperCase() === "REJEITADO";
  const db = getDb();
  const [item] = await db.select().from(automaticProjectItems).where(eq(automaticProjectItems.id, itemId)).limit(1); if (!item) return;
  const [candidate] = item.collectionCandidateId ? await db.select().from(collectionCandidates).where(eq(collectionCandidates.id, item.collectionCandidateId)).limit(1) : [null];
  if (candidate?.sourceId) {
    const [source] = await db.select().from(collectionSources).where(eq(collectionSources.id, candidate.sourceId)).limit(1);
    if (source) await configEvent(approved ? "VISUAL_APPROVAL" : "VISUAL_REJECTION", source.id, null, { projectId, itemId, candidateId: candidate.id }, null, projectId, itemId);
  }
  const [project] = await db.select().from(automaticProjects).where(eq(automaticProjects.id, projectId)).limit(1);
  const profile = await bestSourceProfile({ compositionClass: item.compositionClass, semanticClass: item.semanticClass, universe: item.universe, kind: item.kind, domain: item.itemDomain || project?.projectDomain });
  if (profile && (approved || rejected)) {
    const approvals = profile.visualApprovals + (approved ? 1 : 0), rejects = profile.visualRejections + (rejected ? 1 : 0), total = approvals + rejects;
    await db.update(sourceProfiles).set({ visualApprovals: approvals, visualRejections: rejects, visualApprovalRate: total ? Math.round(approvals / total * 100) : 0, updatedAt: now() }).where(eq(sourceProfiles.id, profile.id));
  }
  const [activeBridge] = await db.select().from(supervisorProjectCandidates).where(and(eq(supervisorProjectCandidates.itemId, itemId), eq(supervisorProjectCandidates.status, "PARA_QA_VISUAL"))).limit(1);
  // Se uma rejeição promoveu a próxima candidata, preserve a nova decisão QA pendente.
  if (!activeBridge) await db.update(supervisorDecisionQueue).set({ state: "RESOLVIDA", decision: decision.toUpperCase(), source: "SUPERVISOR_MCP", resolvedAt: now(), updatedAt: now() }).where(and(eq(supervisorDecisionQueue.itemId, itemId), eq(supervisorDecisionQueue.type, "QA_VISUAL"), eq(supervisorDecisionQueue.state, "PENDENTE")));
}

export async function getNightlySummary(hours = 12) {
  await refreshSourceProfileTechnicalMetrics(true);
  const db = getDb(), since = new Date(Date.now() - Math.max(1, Math.min(168, hours)) * 60 * 60_000);
  const batches = await db.select().from(collectionBatches).where(and(eq(collectionBatches.nightMode, true), gte(collectionBatches.updatedAt, since))).orderBy(desc(collectionBatches.updatedAt));
  if (!batches.length) return { periodo: { inicio: since.toISOString(), fim: new Date().toISOString() }, projetos_processados: 0, conceitos_total: 0, conceitos_com_candidatas: 0, conceitos_sem_candidatas: 0, urls_testadas: 0, arquivos_materializados: 0, para_analise: 0, falhas_tecnicas: 0, hosts_bloqueados: 0, fontes_melhores: [], fontes_piores: [], tempo_total_ms: 0, gaps: [], decisoes_pendentes: 0, candidatas_prioritarias: [] };
  const batchIds = batches.map((b) => b.id), terms = await db.select().from(collectionTerms).where(inArray(collectionTerms.batchId, batchIds)), candidates = await db.select().from(collectionCandidates).where(inArray(collectionCandidates.batchId, batchIds)), runs = await db.select().from(collectionSourceRuns).where(inArray(collectionSourceRuns.batchId, batchIds));
  const sourceIds = [...new Set(runs.map((r) => r.sourceId))]; const sources = sourceIds.length ? await db.select().from(collectionSources).where(inArray(collectionSources.id, sourceIds)) : [];
  const sourceMap = new Map(sources.map((s) => [s.id, s.name])); const performance = new Map<string,{source:string;materialized:number;failures:number;found:number}>();
  for (const run of runs) { const current = performance.get(run.sourceId) || { source: sourceMap.get(run.sourceId) || run.sourceId, materialized: 0, failures: 0, found: 0 }; current.materialized += run.materializedCount; current.failures += run.failureCount; current.found += run.foundCount; performance.set(run.sourceId,current); }
  const ranked = [...performance.values()].map((p) => ({ ...p, score: p.materialized * 5 + p.found - p.failures * 2 })).sort((a,b) => b.score-a.score);
  const blocked = await db.select().from(materializationHostHealth).where(and(eq(materializationHostHealth.circuitState, "OPEN"), gte(materializationHostHealth.blockedUntil, now()))); const pending = await listPendingDecisions(undefined, 200);
  const para = candidates.filter((c) => c.status === "PARA_ANALISE");
  return {
    periodo: { inicio: since.toISOString(), fim: new Date().toISOString() }, projetos_processados: batches.length, conceitos_total: terms.length,
    conceitos_com_candidatas: terms.filter((t) => t.collectedCount > 0).length, conceitos_sem_candidatas: terms.filter((t) => t.collectedCount === 0).length,
    urls_testadas: candidates.length, arquivos_materializados: candidates.filter((c) => Boolean(c.materializationFileId)).length, para_analise: para.length,
    falhas_tecnicas: candidates.filter((c) => c.status === "DESCARTADO" || Boolean(c.failureReason)).length, hosts_bloqueados: blocked.length,
    fontes_melhores: ranked.slice(0,5), fontes_piores: [...ranked].reverse().slice(0,5),
    tempo_total_ms: runs.reduce((sum,r) => sum + r.durationMs, 0),
    gaps: terms.filter((t) => t.collectedCount === 0).slice(0,100).map((t) => ({ termo_id:t.id, termo:t.term, universo:t.universe, status:t.status, motivo:t.failureReason })),
    decisoes_pendentes: pending.length,
    candidatas_prioritarias: para.slice(0,50).map((c) => ({ id:c.id, termo_id:c.termId, fonte_id:c.sourceId, url:c.url, materialization_file_id:c.materializationFileId })),
  };
}

export async function getSupervisorState(projectId?: string) {
  // V59: leitura quente por projeto é o mesmo snapshot compacto do control plane.
  // Perfis, breakers, histórico, lotes detalhados e métricas ficam em ferramentas específicas.
  const db = getDb();
  if (projectId) {
    const snapshot = await getOperationalSnapshot(projectId, 0, 20);
    const packet = snapshot.work_packet || { qa:[], relink:[], technical:[], source_decisions:[] };
    return {
      projeto:{ id:projectId,status:snapshot.status,pipeline_status:snapshot.pipeline_status,state_version:snapshot.version,project_domain:snapshot.domain },
      counts:snapshot.counts,
      lease:snapshot.lease,
      qa:packet.qa,
      relink:packet.relink,
      technical:packet.technical,
      source_decisions:packet.source_decisions,
      next_actions:snapshot.next_actions,
      read_only_snapshot:true,
    };
  }

  const mode = await getSupervisorMode();
  const [projects, pending, profileCountRows, breakerCountRows, leaseTelemetry] = await Promise.all([
    db.select({ id:automaticProjects.id, name:automaticProjects.name, status:automaticProjects.status, pipelineStatus:automaticProjects.pipelineStatus, projectDomain:automaticProjects.projectDomain, stateVersion:automaticProjects.stateVersion, totalItems:automaticProjects.totalItems, pendingCount:automaticProjects.pendingCount, waitingQaCount:automaticProjects.waitingQaCount, relinkCount:automaticProjects.relinkCount, updatedAt:automaticProjects.updatedAt }).from(automaticProjects).orderBy(desc(automaticProjects.updatedAt)).limit(20),
    listPendingDecisions(undefined, 20),
    db.select({count:sql<number>`count(*)`}).from(sourceProfiles).where(eq(sourceProfiles.status,"ATIVO")).catch(()=>[]),
    db.select({count:sql<number>`count(*)`}).from(materializationHostHealth).where(and(eq(materializationHostHealth.circuitState,"OPEN"),gte(materializationHostHealth.blockedUntil,now()))).catch(()=>[]),
    getSupervisorLeaseTelemetry(24).catch(() => null),
  ]);
  return { supervisor:mode, projetos:projects, resumo_configuracao:{perfis_ativos:Number(profileCountRows?.[0]?.count||0),circuit_breakers_ativos:Number(breakerCountRows?.[0]?.count||0),timeout_ms:mode.collectionTimeoutMs,paralelismo:mode.parallelism}, decisoes_pendentes:pending, leases:leaseTelemetry, read_only_snapshot:true };
}


export async function markItemRelink(projectId: string, itemId: string, reason?: string) {
  const db = getDb();
  const [item] = await db.select().from(automaticProjectItems).where(and(eq(automaticProjectItems.projectId, projectId), or(eq(automaticProjectItems.id, itemId), eq(automaticProjectItems.itemKey, itemId)))).limit(1);
  if (!item) throw new Error("ITEM_NOT_FOUND");
  if (["APPROVED","FROZEN","LINKED_FROM_LIBRARY","LINKED_FROM_FAMILY"].includes(item.status)) throw new Error("ITEM_FROZEN_LOCKED");
  await resolveBridgedCandidate(projectId, item.id, "RELINK_REQUIRED", reason || null);
  await db.update(automaticProjectItems).set({ status: "RELINK_REQUIRED", failureReason: reason || "RELINK_REQUIRED_BY_SUPERVISOR", updatedAt: now() }).where(eq(automaticProjectItems.id, item.id));
  await ensureDecision({ projectId, itemId: item.id, candidateId: item.collectionCandidateId, type: "RELINK", priority: item.priority, evidence: { term: item.term, reference: item.semanticReference, reason }, allowedActions: ["ALTERAR_REFERENCIA","ALTERAR_QUERY","TROCAR_FONTE","CANCELAR_ITEM","RETOMAR_ITEM"] });
  await db.insert(automaticProjectEvents).values({ id: makeId("PEVT"), projectId, itemId: item.id, event: "supervisor_relink_required", status: "RELINK_REQUIRED", detail: encode({ reason, source: "SUPERVISOR_MCP" }), createdAt: now() });
  return { projeto_id: projectId, item_id: item.id, status: "RELINK_REQUIRED", motivo: reason || null };
}

export async function materializeCollectionCandidate(candidateId: string) {
  const db = getDb();
  const [candidate] = await db.select().from(collectionCandidates).where(eq(collectionCandidates.id, candidateId)).limit(1);
  if (!candidate) throw new Error("COLLECTION_CANDIDATE_NOT_FOUND");
  if (candidate.materializationFileId && candidate.status === "PARA_ANALISE") return { candidata: candidate, ja_materializada: true };
  const [term] = await db.select().from(collectionTerms).where(eq(collectionTerms.id, candidate.termId)).limit(1);
  const [source] = await db.select().from(collectionSources).where(eq(collectionSources.id, candidate.sourceId)).limit(1);
  if (!term) throw new Error("COLLECTION_TERM_NOT_FOUND");
  const batchId = `SUP-MAT-${candidate.id}`;
  const result = await materializeUrl({ batch_id: batchId, projeto: "Supervisor MCP", item_id: candidate.id, arquivo_alvo: `${term.term.replace(/[^a-zA-Z0-9À-ÿ._ -]/g, "-").slice(0, 100)}.${term.kind === "transparente" ? "png" : "jpg"}`, conceito: term.term, referencia_visual: term.term, universo: term.universe, url: candidate.url, fonte: source?.name || candidate.sourceId });
  const [matItem] = await db.select().from(materializationItems).where(and(eq(materializationItems.batchId, batchId), eq(materializationItems.itemId, candidate.id))).limit(1);
  const file = matItem?.selectedFileId ? (await db.select().from(materializationFiles).where(eq(materializationFiles.id, matItem.selectedFileId)).limit(1))[0] : null;
  const ready = Boolean(file && matItem?.status === "READY_FOR_VISUAL_QA");
  await db.update(collectionCandidates).set({ status: ready ? "PARA_ANALISE" : "DESCARTADO", failureReason: ready ? null : matItem?.failureReason || matItem?.status || "MATERIALIZATION_FAILED", materializationBatchId: batchId, materializationItemId: matItem?.id || null, materializationFileId: file?.id || null, sha256: file?.sha256 || null, updatedAt: now() }).where(eq(collectionCandidates.id, candidate.id));
  let supervisorBridge: unknown = null;
  if (ready && matItem) {
    const [projectItem] = await db.select().from(automaticProjectItems).where(eq(automaticProjectItems.collectionTermId, candidate.termId)).limit(1);
    if (projectItem) supervisorBridge = await bridgeMaterializationToSupervisor(matItem.id, { projectId: projectItem.projectId, itemId: projectItem.id, collectionCandidateId: candidate.id });
  }
  return { candidata_id: candidate.id, status: ready ? "PARA_ANALISE" : "DESCARTADO", arquivo: file || null, materializacao: result, supervisor_bridge: supervisorBridge };
}


export async function updateCollectionSource(input: Record<string, unknown>) {
  const db = getDb(), key = clean(input.fonte);
  let [source] = await db.select().from(collectionSources).where(or(eq(collectionSources.id, key), eq(collectionSources.name, key))).limit(1);
  if (!source) {
    const endpoint = clean(input.endpoint), imagePath = clean(input.caminho_imagem);
    if (!key || !endpoint || !imagePath || !/^https?:\/\//i.test(endpoint)) throw new Error("NEW_SOURCE_REQUIRES_NAME_ENDPOINT_IMAGE_PATH");
    const id = makeId("SRC"), date = now();
    await db.insert(collectionSources).values({ id, name: key, baseUrl: endpoint, method: "GET", queryParam: clean(input.parametro_busca) || "q", limitParam: clean(input.parametro_limite) || "limit", imagePath, thumbnailPath: clean(input.caminho_thumbnail) || null, priority: 3, active: typeof input.ativo === "boolean" ? input.ativo : true, apiKeyEnv: null, apiKeyHeader: null, headersJson: "{}", userAgent: clean(input.user_agent) || null, timeoutMs: num(input.timeout_ms, 25000, 1000, 120000), note: clean(input.motivo) || "Criada pelo Supervisor MCP", createdAt: date, updatedAt: date });
    [source] = await db.select().from(collectionSources).where(eq(collectionSources.id, id)).limit(1);
    await configEvent("COLLECTION_SOURCE_CREATE", id, null, source, clean(input.motivo));
  }
  if (!source) throw new Error("COLLECTION_SOURCE_NOT_FOUND");
  let headersJson = source.headersJson || "{}";
  if (input.headers_permitidos && typeof input.headers_permitidos === "object") {
    const blocked = new Set(["authorization","cookie","proxy-authorization","x-api-key"]), safe: Record<string,string> = {};
    for (const [name,value] of Object.entries(input.headers_permitidos as Record<string, unknown>)) if (!blocked.has(name.toLowerCase()) && typeof value === "string" && value.length <= 500) safe[name] = value;
    headersJson = JSON.stringify(safe);
  }
  const baseUrl = clean(input.endpoint) || source.baseUrl;
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error("SOURCE_ENDPOINT_INVALID");
  const set = {
    baseUrl,
    queryParam: clean(input.parametro_busca) || source.queryParam,
    limitParam: clean(input.parametro_limite) || source.limitParam,
    imagePath: clean(input.caminho_imagem) || source.imagePath,
    thumbnailPath: input.caminho_thumbnail === null ? null : clean(input.caminho_thumbnail) || source.thumbnailPath,
    headersJson,
    userAgent: clean(input.user_agent) || source.userAgent,
    timeoutMs: input.timeout_ms === undefined ? source.timeoutMs : num(input.timeout_ms, source.timeoutMs, 1000, 120000),
    active: typeof input.ativo === "boolean" ? input.ativo : source.active,
    updatedAt: now(),
  };
  await db.update(collectionSources).set(set).where(eq(collectionSources.id, source.id));
  await configEvent("COLLECTION_SOURCE_UPDATE", source.id, { baseUrl: source.baseUrl, queryParam: source.queryParam, headersJson: source.headersJson, userAgent: source.userAgent, timeoutMs: source.timeoutMs }, set, clean(input.motivo));
  return { ...source, ...set, headersJson: json<Record<string,string>>(headersJson, {}) };
}
