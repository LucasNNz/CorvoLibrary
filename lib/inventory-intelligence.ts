import { eq } from "drizzle-orm";
import { getDb } from "../db";
import {
  assetConsultations,
  assets,
  materializationBatches,
  materializationCandidates,
  materializationFiles,
  materializationHostHealth,
  materializationItems,
  materializationLogs,
  semanticStockPolicies,
} from "../db/schema";

const clean = (value: unknown) => typeof value === "string" ? value.trim() : "";
const normalized = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const percentile = (values: number[], ratio: number) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor((values.length - 1) * ratio))] : 0;
const daysAgo = (value: Date | null) => value ? Math.max(0, Math.floor((Date.now() - value.getTime()) / 86_400_000)) : null;
const policyId = (concept: string, universe: string, kind: string) => `STOCK-${normalized(`${universe}-${kind}-${concept}`)}`.slice(0, 190);

export async function setStockPolicy(input: Record<string, unknown>) {
  const concept = clean(input.conceito);
  const universe = clean(input.universo) || "Sem universo";
  const kind = clean(input.tipo) || "Todos";
  const minimum = Math.max(0, Number(input.minimo) || 3);
  const ideal = Math.max(minimum, Number(input.ideal) || 5);
  const maximum = Math.max(ideal, Number(input.maximo) || 10);
  if (!concept) throw new Error("CONCEITO_REQUIRED");
  const row = { id: policyId(concept, universe, kind), concept, universe, kind, minimum, ideal, maximum, active: input.ativa !== false, updatedAt: new Date() };
  await getDb().insert(semanticStockPolicies).values(row).onConflictDoUpdate({ target: semanticStockPolicies.id, set: row });
  return { politica: row };
}

export async function registerAssetConsultation(input: Record<string, unknown>) {
  const concept = clean(input.conceito);
  if (!concept) throw new Error("CONCEITO_REQUIRED");
  const assetId = clean(input.asset_id) || null;
  if (assetId) {
    const [asset] = await getDb().select({ id: assets.id }).from(assets).where(eq(assets.id, assetId)).limit(1);
    if (!asset) throw new Error("ASSET_NOT_FOUND");
  }
  const row = {
    id: `CONS-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    assetId, concept, project: clean(input.projeto) || null, query: clean(input.consulta) || null,
    selected: input.selecionado === true, createdAt: new Date(),
  };
  await getDb().insert(assetConsultations).values(row);
  return { consulta: row };
}

export async function getInventoryDashboard(input: Record<string, unknown> = {}) {
  const db = getDb();
  const [assetRows, consultationRows, policyRows, itemRows, candidateRows, fileRows, hostRows, logRows, batchRows] = await Promise.all([
    db.select().from(assets), db.select().from(assetConsultations), db.select().from(semanticStockPolicies),
    db.select().from(materializationItems), db.select().from(materializationCandidates), db.select().from(materializationFiles),
    db.select().from(materializationHostHealth), db.select().from(materializationLogs), db.select().from(materializationBatches),
  ]);
  const groupMap = new Map<string, {
    key: string; concept: string; universe: string; kind: string; approved: number; rejected: number; uses: number;
    lastUsedAt: Date | null; consultations: number; selected: number; materializing: number; qa: number;
  }>();
  const ensure = (concept: string, universe: string, kind: string) => {
    const key = normalized(`${universe}::${kind}::${concept}`);
    if (!groupMap.has(key)) groupMap.set(key, { key, concept, universe, kind, approved: 0, rejected: 0, uses: 0, lastUsedAt: null, consultations: 0, selected: 0, materializing: 0, qa: 0 });
    return groupMap.get(key)!;
  };
  for (const asset of assetRows) {
    const group = ensure(asset.semanticFamily || asset.subject || asset.name, asset.universe || "Sem universo", asset.kind || "Imagem");
    if (asset.status === "Aprovado") group.approved += 1;
    if (asset.status === "Rejeitado") group.rejected += 1;
    group.uses += asset.useCount;
    if (asset.lastUsedAt && (!group.lastUsedAt || asset.lastUsedAt > group.lastUsedAt)) group.lastUsedAt = asset.lastUsedAt;
  }
  for (const item of itemRows) {
    const group = ensure(item.concept, item.universe || "Sem universo", item.kind || "Imagem");
    if (["READY_FOR_VISUAL_QA"].includes(item.status)) group.qa += 1;
    else if (!["FROZEN", "CANCELLED", "RELINK_REQUIRED"].includes(item.status)) group.materializing += 1;
  }
  for (const consultation of consultationRows) {
    const matches = [...groupMap.values()].filter((group) => normalized(group.concept) === normalized(consultation.concept));
    const targets = matches.length ? matches : [ensure(consultation.concept, "Sem universo", "Todos")];
    for (const group of targets) { group.consultations += 1; if (consultation.selected) group.selected += 1; }
  }
  for (const policy of policyRows.filter((row) => row.active)) ensure(policy.concept, policy.universe, policy.kind);
  const policies = new Map(policyRows.filter((row) => row.active).map((row) => [normalized(`${row.universe}::${row.kind}::${row.concept}`), row]));
  const groups = [...groupMap.values()].map((group) => {
    const policy = policies.get(group.key);
    const minimum = policy?.minimum ?? 3, ideal = policy?.ideal ?? 5, maximum = policy?.maximum ?? 10;
    const maturity = group.approved > maximum ? "SATURADO" : group.approved >= 5 ? "MADURO" : "LACUNA";
    const status = group.approved < minimum ? "CRITICO" : group.approved < ideal ? "ABAIXO_IDEAL" : group.approved > maximum ? "SATURADO" : "MADURO";
    const action = status === "CRITICO" ? "PRIORIZAR_COLETA" : status === "ABAIXO_IDEAL" ? "COLETA_PERMITIDA" : status === "SATURADO" ? "BLOQUEAR_COLETA" : "REUTILIZAR_PRIMEIRO";
    return { ...group, minimum, ideal, maximum, maturity, status, action, reuseRate: group.approved ? Math.round((group.uses / group.approved) * 100) / 100 : 0, selectionRate: group.consultations ? Math.round(group.selected / group.consultations * 100) : 0, daysWithoutUse: daysAgo(group.lastUsedAt) };
  }).sort((a, b) => a.approved - b.approved || b.materializing - a.materializing || a.concept.localeCompare(b.concept)).slice(0, 200);

  const candidateById = new Map(candidateRows.map((row) => [row.id, row]));
  const itemById = new Map(itemRows.map((row) => [row.id, row]));
  const logsByHost = new Map<string, typeof logRows>();
  for (const log of logRows) {
    const host = log.candidateId ? candidateById.get(log.candidateId)?.host : null;
    if (host) logsByHost.set(host, [...(logsByHost.get(host) || []), log]);
  }
  const hosts = hostRows.map((host) => {
    const total = host.successCount + host.failureCount;
    const technicalRate = total ? host.successCount / total : 0;
    const hostCandidates = candidateRows.filter((candidate) => candidate.host === host.host);
    const selectedItemIds = new Set(hostCandidates.filter((candidate) => ["MATERIALIZED", "DUPLICATE", "VISUAL_QA_REJECTED"].includes(candidate.status)).map((candidate) => candidate.itemDbId));
    const qaItems = [...selectedItemIds].map((id) => itemById.get(id)).filter(Boolean);
    const approved = qaItems.filter((item) => item?.status === "FROZEN").length;
    const rejected = hostCandidates.filter((candidate) => candidate.status === "VISUAL_QA_REJECTED").length;
    const visualRate = approved + rejected ? approved / (approved + rejected) : 0.5;
    const durations = (logsByHost.get(host.host) || []).map((log) => log.durationMs || 0).filter(Boolean);
    const avgLatencyMs = durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : 0;
    const speed = avgLatencyMs ? Math.max(0.2, 1 - avgLatencyMs / 20_000) : 0.6;
    const stability = Math.max(0, 1 - host.recentFailureCount / 4);
    const recency = host.updatedAt.getTime() > Date.now() - 30 * 86_400_000 ? 1 : 0.7;
    const score = host.circuitState === "OPEN" ? 0 : Math.round(technicalRate * visualRate * speed * stability * recency * 100);
    const classification = host.circuitState === "OPEN" ? "BLOQUEADO" : score >= 75 ? "PREFERENCIAL" : score >= 50 ? "ESTAVEL" : score >= 25 ? "OBSERVACAO" : "EVITAR";
    return { host: host.host, score, classification, circuitState: host.circuitState, technicalRate: Math.round(technicalRate * 100), visualRate: Math.round(visualRate * 100), avgLatencyMs, p95LatencyMs: percentile(durations, 0.95), successes: host.successCount, failures: host.failureCount, approved, rejected, bytes: fileRows.filter((file) => hostCandidates.some((candidate) => candidate.id === file.candidateId)).reduce((sum, file) => sum + file.sizeBytes, 0), updatedAt: host.updatedAt };
  }).sort((a, b) => b.score - a.score).slice(0, 100);

  const statusCounts: Record<string, number> = {};
  for (const item of itemRows) statusCounts[item.status] = (statusCounts[item.status] || 0) + 1;
  const downloadDurations = logRows.filter((log) => log.event === "qa_ready" || log.event === "candidate_failed").map((log) => log.durationMs || 0).filter(Boolean);
  const qaDurations = logRows.filter((log) => log.event === "qa_decision").map((log) => log.durationMs || 0).filter(Boolean);
  const totals = {
    approvedAssets: assetRows.filter((asset) => asset.status === "Aprovado").length,
    groups: groups.length,
    belowMinimum: groups.filter((group) => group.approved < group.minimum).length,
    mature: groups.filter((group) => group.maturity === "MADURO").length,
    saturated: groups.filter((group) => group.maturity === "SATURADO").length,
    neverUsed: assetRows.filter((asset) => asset.status === "Aprovado" && asset.useCount === 0).length,
    reuseRate: assetRows.length ? Math.round(assetRows.filter((asset) => asset.useCount > 0).length / assetRows.length * 100) : 0,
    materializing: itemRows.filter((item) => !["FROZEN", "READY_FOR_VISUAL_QA", "CANCELLED", "RELINK_REQUIRED"].includes(item.status)).length,
    qa: itemRows.filter((item) => item.status === "READY_FOR_VISUAL_QA").length,
  };
  const filter = clean(input.conceito).toLowerCase();
  return {
    generatedAt: new Date(), totals,
    groups: filter ? groups.filter((group) => group.concept.toLowerCase().includes(filter)) : groups,
    hosts,
    pipeline: { statusCounts, avgDownloadMs: downloadDurations.length ? Math.round(downloadDurations.reduce((a, b) => a + b, 0) / downloadDurations.length) : 0, p95DownloadMs: percentile(downloadDurations, 0.95), avgQaWaitMs: qaDurations.length ? Math.round(qaDurations.reduce((a, b) => a + b, 0) / qaDurations.length) : 0, p95QaWaitMs: percentile(qaDurations, 0.95), batches: batchRows.slice(-20).reverse() },
    policyDefaults: { minimum: 3, ideal: 5, maximum: 10, maturityAt: 5 },
    orchestration: { globalConcurrency: 8, perHostConcurrency: 2, fetchTimeoutMs: 12000, candidatesPerItem: 5 },
  };
}

export async function evaluateCollectionNeed(input: Record<string, unknown>) {
  const concept = clean(input.conceito);
  if (!concept) throw new Error("CONCEITO_REQUIRED");
  const dashboard = await getInventoryDashboard({ conceito: concept });
  const group = dashboard.groups.find((row) => normalized(row.concept) === normalized(concept)) || dashboard.groups[0];
  if (!group) return { conceito: concept, coletar: true, prioridade: "CRITICA", motivo: "Nenhum asset aprovado", quantidade_sugerida: 5 };
  return { conceito: concept, coletar: group.approved < group.ideal, prioridade: group.status, acao: group.action, motivo: `${group.approved} aprovados; mínimo ${group.minimum}, ideal ${group.ideal}, máximo ${group.maximum}`, quantidade_sugerida: Math.max(0, group.ideal - group.approved), grupo: group };
}

export async function getHostRanking() {
  const dashboard = await getInventoryDashboard();
  return { hosts: dashboard.hosts, total: dashboard.hosts.length, generatedAt: dashboard.generatedAt };
}

export async function getPipelineTelemetry() {
  const dashboard = await getInventoryDashboard();
  return { pipeline: dashboard.pipeline, orchestration: dashboard.orchestration, generatedAt: dashboard.generatedAt };
}

export async function exportInventoryTabText(input: Record<string, unknown> = {}) {
  const requested = clean(input.aba).toLowerCase();
  const tab = requested === "hosts" || requested === "fontes" ? "hosts" : requested === "pipeline" || requested === "filas" ? "pipeline" : "estoque";
  const dashboard = await getInventoryDashboard({ conceito: clean(input.conceito) });
  const generated = new Date(dashboard.generatedAt);
  const lines = [
    "CORVO LIBRARY — ESTOQUE & GIRO",
    `ABA: ${tab === "estoque" ? "ESTOQUE SEMANTICO" : tab === "hosts" ? "RANKING DE FONTES" : "PIPELINE E FILAS"}`,
    `GERADO_EM: ${generated.toISOString()}`,
    "",
  ];
  if (tab === "estoque") {
    lines.push(
      `ASSETS_APROVADOS: ${dashboard.totals.approvedAssets}`,
      `GRUPOS: ${dashboard.totals.groups}`,
      `ABAIXO_MINIMO: ${dashboard.totals.belowMinimum}`,
      `MADUROS: ${dashboard.totals.mature}`,
      `SATURADOS: ${dashboard.totals.saturated}`,
      `NUNCA_USADOS: ${dashboard.totals.neverUsed}`,
      `TAXA_REUSO_PERCENTUAL: ${dashboard.totals.reuseRate}`,
      "",
      "CONCEITO\tUNIVERSO\tTIPO\tAPROVADOS\tREJEITADOS\tATIVOS\tQA\tUSOS\tDIAS_SEM_USO\tMIN\tIDEAL\tMAX\tMATURIDADE\tSTATUS\tACAO",
    );
    for (const group of dashboard.groups) lines.push([
      group.concept, group.universe, group.kind, group.approved, group.rejected, group.materializing, group.qa, group.uses,
      group.daysWithoutUse ?? "NUNCA_USADO", group.minimum, group.ideal, group.maximum, group.maturity, group.status, group.action,
    ].join("\t"));
  } else if (tab === "hosts") {
    lines.push("HOST\tSCORE\tCLASSIFICACAO\tCIRCUIT\tSUCESSO_TECNICO_PERCENTUAL\tQA_VISUAL_PERCENTUAL\tLATENCIA_MEDIA_MS\tP95_MS\tSUCESSOS\tFALHAS\tAPROVADOS\tREJEITADOS\tBYTES");
    for (const host of dashboard.hosts) lines.push([
      host.host, host.score, host.classification, host.circuitState, host.technicalRate, host.visualRate, host.avgLatencyMs,
      host.p95LatencyMs, host.successes, host.failures, host.approved, host.rejected, host.bytes,
    ].join("\t"));
  } else {
    lines.push(
      `DOWNLOAD_MEDIO_MS: ${dashboard.pipeline.avgDownloadMs}`,
      `DOWNLOAD_P95_MS: ${dashboard.pipeline.p95DownloadMs}`,
      `QA_ESPERA_MEDIA_MS: ${dashboard.pipeline.avgQaWaitMs}`,
      `QA_ESPERA_P95_MS: ${dashboard.pipeline.p95QaWaitMs}`,
      `CONCORRENCIA_GLOBAL: ${dashboard.orchestration.globalConcurrency}`,
      `CONCORRENCIA_POR_HOST: ${dashboard.orchestration.perHostConcurrency}`,
      `FETCH_TIMEOUT_MS: ${dashboard.orchestration.fetchTimeoutMs}`,
      `CANDIDATAS_POR_ITEM: ${dashboard.orchestration.candidatesPerItem}`,
      "",
      "ESTADOS_DA_FILA",
    );
    for (const [status, count] of Object.entries(dashboard.pipeline.statusCounts)) lines.push(`${status}\t${count}`);
    lines.push("", "LOTES_RECENTES", "ID\tPROJETO\tSTATUS\tITENS");
    for (const batch of dashboard.pipeline.batches) lines.push([batch.id, batch.project, batch.status, batch.totalItems].join("\t"));
  }
  const suffix = generated.toISOString().replace(/[:.]/g, "-");
  return { aba: tab, arquivo: `ESTOQUE_GIRO_${tab.toUpperCase()}_${suffix}.txt`, conteudo: lines.join("\n"), generatedAt: generated };
}
