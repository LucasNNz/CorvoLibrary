import { env } from "./platform/runtime";
import { and, asc, desc, eq, inArray, like, or, sql } from "drizzle-orm";
import { getDb } from "../db";
import {
  collectionBatches, collectionCandidates, collectionSources, collectionSourceRuns, collectionTerms,
  automaticProjectItems, automaticProjects, assets, materializationCandidates, materializationFiles, materializationHostHealth, materializationItems, materializationLogs,
} from "../db/schema";
import { materializeBatch } from "./materializer";
import { recordRouteRun } from "./performance-control";
import { buildSourceRoutingPlan } from "./source-routing";

type SourceInput = { name: string; baseUrl: string; method: string; queryParam: string; limitParam: string; imagePath: string; thumbnailPath?: string; priority: number; active: boolean; apiKeyEnv?: string; apiKeyHeader?: string; headersJson?: string; userAgent?: string; timeoutMs?: number; note?: string; domain?: string; supportedUniverses?: string[]; supportedCompositionClasses?: string[]; canDiscover?: boolean; canMaterialize?: boolean; requiresExternalSearch?: boolean };
type TermInput = { term: string; quantity: number; kind: string; universe?: string };
type ParsedTerms = { terms: TermInput[]; warnings: Array<{ line: number; reason: string; content: string }>; totalLines: number };
const D1_TERM_ROWS_PER_INSERT = 6;
const D1_INSERTS_PER_BATCH = 40;
const makeId = (prefix: string) => `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
const clean = (value: unknown) => typeof value === "string" ? value.trim() : "";
const now = () => new Date();


type SearchPolicy = { preferred_sources: string[]; avoid_sources: string[]; strict_preferred_sources: boolean; negative_terms: string[]; preferred_hosts: string[]; avoid_hosts: string[]; queries: string[]; max_rounds?: number; max_urls_per_term?: number; max_sources_per_term?: number; timeout_ms?: number };
function parseSearchPolicy(raw: string | null | undefined): SearchPolicy {
  const empty: SearchPolicy = { preferred_sources: [], avoid_sources: [], strict_preferred_sources: false, negative_terms: [], preferred_hosts: [], avoid_hosts: [], queries: [] };
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return { ...empty, preferred_sources: parsed.map(String).filter(Boolean) };
    if (!parsed || typeof parsed !== "object") return empty;
    const row = parsed as Record<string, unknown>;
    const values = (key: string) => Array.isArray(row[key]) ? [...new Set((row[key] as unknown[]).map(String).map((v) => v.trim()).filter(Boolean))] : [];
    return { preferred_sources: values("preferred_sources").length ? values("preferred_sources") : values("sources"), avoid_sources: values("avoid_sources"), strict_preferred_sources: row.strict_preferred_sources === true, negative_terms: values("negative_terms"), preferred_hosts: values("preferred_hosts").map((v) => v.toLowerCase()), avoid_hosts: values("avoid_hosts").map((v) => v.toLowerCase()), queries: values("queries"), max_rounds: Number.isFinite(Number(row.max_rounds)) ? Math.max(1, Math.min(50, Number(row.max_rounds))) : undefined, max_urls_per_term: Number.isFinite(Number(row.max_urls_per_term)) ? Math.max(1, Math.min(500, Number(row.max_urls_per_term))) : undefined, max_sources_per_term: Number.isFinite(Number(row.max_sources_per_term)) ? Math.max(1, Math.min(100, Number(row.max_sources_per_term))) : undefined, timeout_ms: Number.isFinite(Number(row.timeout_ms)) ? Math.max(1000, Math.min(120000, Number(row.timeout_ms))) : undefined };
  } catch { return empty; }
}

function searchQueryForSource(sourceName: string, term: string, negativeTerms: string[]) {
  const normalized = sourceName.toLowerCase();
  if (!negativeTerms.length || !/(brave|google|bing|discovery|reddit|pinterest)/.test(normalized)) return term;
  return `${term} ${negativeTerms.map((value) => `-${value.includes(" ") ? `\"${value}\"` : value}`).join(" ")}`.trim();
}

function hostOfCandidate(url: string) { try { return new URL(url).hostname.toLowerCase(); } catch { return ""; } }

const UNIVERSE_ENTITY_GATES: Record<string,string[]> = {
  NARUTO: ["naruto","sasuke","sakura","kakashi","gaara","hinata","neji","lee","shikamaru","choji","ino","kiba","shino","orochimaru","jiraiya","tsunade","itachi","minato","madara","obito"],
  "MY HERO ACADEMIA": ["deku","midoriya","bakugo","todoroki","uraraka","all might","endeavor","shigaraki","dabi","hawks","aizawa"],
};
function normSemantic(value:string) { let decoded=value || ""; try { decoded=decodeURIComponent(decoded); } catch {} return decoded.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim(); }
function semanticCandidatePrecheck(term:string, universe:string|undefined, candidate:{url:string;thumbnail?:string|null}) {
  const corpus = normSemantic(`${candidate.url} ${candidate.thumbnail || ""}`);
  const wanted = normSemantic(term);
  const universeNorm = (universe || "").toUpperCase();
  const gateKey = Object.keys(UNIVERSE_ENTITY_GATES).find((key)=>universeNorm.includes(key)) || "";
  const entities = gateKey ? UNIVERSE_ENTITY_GATES[gateKey] : [];
  if (!entities.length) return { ok:true, reason:null as string|null };
  const required = entities.filter((entity)=>wanted.includes(entity));
  if (!required.length) return { ok:true, reason:null as string|null };
  const found = entities.filter((entity)=>corpus.includes(entity));
  if (found.length && !required.some((entity)=>found.includes(entity))) return { ok:false, reason:`SEMANTIC_URL_CONFLICT:${found.join(",")}` };
  return { ok:true, reason:null as string|null };
}

function safeUrl(raw: string) {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || !host || host === "localhost" || host.endsWith(".local") || host === "::1" || /^(10|127|0|169\.254|192\.168)\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) throw new Error("URL_DE_FONTE_BLOQUEADA");
  return url;
}

function parseBlocks(text: string) {
  return text.replace(/\r/g, "").split(/\n\s*\n|(?=\n?\[[^\]]+\]\s*\n)/).map((block) => block.trim()).filter(Boolean);
}

export function parseTerms(text: string): ParsedTerms {
  const lines = text.replace(/^\uFEFF/, "").replace(/\r/g, "").split("\n");
  const terms: TermInput[] = [], warnings: ParsedTerms["warnings"] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1, line = lines[index].trim();
    if (!line || line.startsWith("#") || line.startsWith("//") || line.startsWith(";")) continue;
    const parts = line.split("|").map((part) => part.trim());
    const [termRaw, quantityRaw, kindRaw, universeRaw] = parts;
    const normalizedHeader = parts.map((part) => part.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase());
    if (normalizedHeader[0] === "TERMO" && ["QUANTIDADE", "QTD", "PESO"].includes(normalizedHeader[1] || "")) {
      warnings.push({ line: lineNumber, reason: "CABECALHO_IGNORADO", content: line }); continue;
    }
    const quantity = Number(quantityRaw);
    if (!termRaw || !Number.isInteger(quantity) || quantity < 1 || quantity > 500) {
      warnings.push({ line: lineNumber, reason: !termRaw ? "TERMO_AUSENTE" : "QUANTIDADE_INVALIDA", content: line }); continue;
    }
    const rawKind = (kindRaw || "qualquer").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
    const kind = ["transparente", "contextual", "qualquer"].includes(rawKind.toLocaleLowerCase("pt-BR")) ? rawKind.toLocaleLowerCase("pt-BR") : rawKind.toUpperCase().replace(/\s+/g, "_");
    if (!kind || !/^[A-Z0-9_À-Ÿ-]+$/.test(kind) && !["transparente", "contextual", "qualquer"].includes(kind)) {
      warnings.push({ line: lineNumber, reason: "TIPO_INVALIDO", content: line }); continue;
    }
    terms.push({ term: termRaw, quantity, kind, universe: universeRaw || undefined });
  }
  if (!terms.length) throw new Error("TERMOS_OBRIGATORIOS");
  if (terms.length > 2000) throw new Error("LIMITE_2000_TERMOS");
  return { terms, warnings, totalLines: lines.length };
}

export function parseSources(text: string): SourceInput[] {
  const normalized = text.replace(/\r/g, "").trim();
  if (!normalized) return [];
  const blocks = parseBlocks(normalized);
  const sources = blocks.flatMap((block, index) => {
    const meaningful = block.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
    if (meaningful.length === 1 && meaningful[0].includes("|")) {
      const parts = meaningful[0].split("|").map((part) => part.trim());
      const [priority, name, baseUrl, queryParam, limitParam, imagePath, thumbnailPath] = parts;
      return [{ name, baseUrl, method: "GET", queryParam: queryParam || "q", limitParam: limitParam || "limit", imagePath, thumbnailPath, priority: Number(priority) || 3, active: true }];
    }
    const fields: Record<string, string> = {};
    for (const line of meaningful) {
      if (/^\[[^\]]+\]$/.test(line)) { fields.NOME ||= line.slice(1, -1); continue; }
      const separator = line.indexOf(":");
      if (separator > 0) fields[line.slice(0, separator).trim().toUpperCase()] = line.slice(separator + 1).trim();
    }
    if (!fields.URL_BASE && !fields.NOME) return [];
    return [{
      name: fields.NOME || `Fonte ${index + 1}`, baseUrl: fields.URL_BASE, method: (fields.METODO || "GET").toUpperCase(),
      queryParam: fields.PARAMETRO_DE_BUSCA || "q", limitParam: fields.PARAMETRO_DE_LIMITE || "limit",
      imagePath: fields.CAMINHO_DA_URL_DA_IMAGEM, thumbnailPath: fields.CAMINHO_DA_THUMBNAIL || undefined,
      priority: Number(fields.PRIORIDADE) || 3, active: !["NAO", "NÃO", "FALSE", "0"].includes((fields.ATIVO || "SIM").toUpperCase()),
      apiKeyEnv: fields.API_KEY_ENV || fields.VARIAVEL_DE_AMBIENTE || undefined, apiKeyHeader: fields.API_KEY_HEADER || undefined,
      headersJson: fields.HEADERS_PERMITIDOS || fields.HEADERS_JSON || undefined, userAgent: fields.USER_AGENT || undefined, timeoutMs: Number(fields.TIMEOUT_MS) || undefined,
      note: fields.OBSERVACAO || undefined,
      domain: fields.DOMINIO || fields.DOMAIN || undefined,
      supportedUniverses: (fields.UNIVERSOS || "").split(",").map((value)=>value.trim()).filter(Boolean),
      supportedCompositionClasses: (fields.COMPOSITION_CLASSES || fields.CLASSES_COMPOSICAO || "").split(",").map((value)=>value.trim().toUpperCase()).filter(Boolean),
      canDiscover: fields.CAN_DISCOVER === undefined ? undefined : !["NAO","NÃO","FALSE","0"].includes(fields.CAN_DISCOVER.toUpperCase()),
      canMaterialize: fields.CAN_MATERIALIZE === undefined ? undefined : !["NAO","NÃO","FALSE","0"].includes(fields.CAN_MATERIALIZE.toUpperCase()),
      requiresExternalSearch: fields.REQUIRES_EXTERNAL_SEARCH === undefined ? undefined : ["SIM","TRUE","1"].includes(fields.REQUIRES_EXTERNAL_SEARCH.toUpperCase()),
    }];
  });
  for (const [index, source] of sources.entries()) {
    if (!source.name || !source.baseUrl || !source.imagePath) throw new Error(`FONTE_INVALIDA_BLOCO_${index + 1}`);
    if (!new Set(["GET", "INTERNAL", "LOOKUP", "DIRECT", "DISCOVERY"]).has(source.method)) throw new Error(`METODO_NAO_SUPORTADO:${source.name}`);
    if (source.method === "GET" || source.method === "LOOKUP" || (source.method === "DIRECT" && /^https?:/i.test(source.baseUrl))) safeUrl(source.baseUrl);
    if (source.apiKeyEnv && !/^[A-Z][A-Z0-9_]*$/.test(source.apiKeyEnv)) throw new Error(`VARIAVEL_DE_AMBIENTE_INVALIDA:${source.name}`);
  }
  return sources;
}

export async function configureCollectionSources(text: string) {
  const db = getDb(), parsed = parseSources(text), saved = [];
  if (!parsed.length) throw new Error("FONTES_OBRIGATORIAS");
  for (const source of parsed) {
    const existing = await db.select().from(collectionSources).where(eq(collectionSources.name, source.name)).limit(1);
    const inferredCanDiscover = source.canDiscover ?? ["GET","LOOKUP","DISCOVERY"].includes(source.method);
    const values = { ...source, thumbnailPath: source.thumbnailPath || null, apiKeyEnv: source.apiKeyEnv || null, apiKeyHeader: source.apiKeyHeader || null, headersJson: source.headersJson || "{}", userAgent: source.userAgent || null, timeoutMs: Math.max(1000, Math.min(120000, source.timeoutMs || 25000)), note: source.note || null,
      domain: (source.domain || "MULTI").toUpperCase(), supportedUniverses: JSON.stringify(source.supportedUniverses || []), supportedCompositionClasses: JSON.stringify(source.supportedCompositionClasses?.length ? source.supportedCompositionClasses : ["CONTEXTUAL","ISOLATED"]),
      canDiscover: inferredCanDiscover, canMaterialize: source.canMaterialize ?? true, requiresExternalSearch: source.requiresExternalSearch ?? source.method === "DISCOVERY", configured: source.apiKeyEnv ? Boolean((env as unknown as Record<string,unknown>)[source.apiKeyEnv]) : true, capabilityVersion: 60,
      updatedAt: now() };
    if (existing[0]) {
      const [row] = await db.update(collectionSources).set(values).where(eq(collectionSources.id, existing[0].id)).returning(); saved.push(row);
    } else {
      const [row] = await db.insert(collectionSources).values({ id: makeId("SRC"), ...values }).returning(); saved.push(row);
    }
  }
  return { fontes: saved.map(safeSource), total: saved.length };
}

const safeSource = (source: typeof collectionSources.$inferSelect) => ({
  ...source,
  apiKeyConfigured: source.apiKeyEnv ? Boolean((env as unknown as Record<string, unknown>)[source.apiKeyEnv]) : true,
  operationalRole: source.method === "INTERNAL" || source.method === "DIRECT" ? "ADAPTER_MATERIALIZACAO" : source.method === "DISCOVERY" ? "DESCOBERTA_VIA_BRAVE" : "FONTE_PESQUISAVEL",
  configuredRuntime: source.apiKeyEnv ? Boolean((env as unknown as Record<string, unknown>)[source.apiKeyEnv]) : source.configured,
  capabilities: { can_discover: source.canDiscover, can_materialize: source.canMaterialize, domain: source.domain, supported_universes: (()=>{try{return JSON.parse(source.supportedUniverses||"[]")}catch{return []}})(), supported_composition_classes: (()=>{try{return JSON.parse(source.supportedCompositionClasses||"[]")}catch{return []}})() },
});

export async function listCollectionSources() {
  const rows = await getDb().select().from(collectionSources).orderBy(asc(collectionSources.priority), asc(collectionSources.name));
  return { fontes: rows.map(safeSource), total: rows.length };
}

export async function createCollectionBatch(input: Record<string, unknown>) {
  const db = getDb(), termsText = clean(input.termos_texto), sourceText = clean(input.fontes_texto);
  if (sourceText) await configureCollectionSources(sourceText);
  const sources = await db.select().from(collectionSources).where(eq(collectionSources.active, true)).limit(100);
  if (!sources.length) throw new Error("CONFIGURE_AO_MENOS_UMA_FONTE_ATIVA");
  const parsedTerms = parseTerms(termsText), terms = parsedTerms.terms, date = now(), batchId = makeId("COL");
  const name = clean(input.nome) || `Coleta ${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  const totalTarget = terms.reduce((sum, term) => sum + term.quantity, 0);
  await db.insert(collectionBatches).values({
    id: batchId, name, termsText, status: "CRIADO", nightMode: input.modo_noturno === undefined ? true : Boolean(input.modo_noturno), totalTerms: terms.length, totalTarget,
    maxUrlsPerTerm: Math.max(1, Math.min(500, Number(input.max_urls_por_termo) || 100)),
    maxSourcesPerTerm: Math.max(1, Math.min(100, Number(input.max_fontes_por_termo) || 20)),
    maxRoundsPerTerm: Math.max(1, Math.min(50, Number(input.max_rodadas_por_termo) || 5)),
    maxTermMinutes: Math.max(1, Math.min(1440, Number(input.max_minutos_por_termo) || 45)),
    maxTotalMinutes: Math.max(1, Math.min(2880, Number(input.max_minutos_total) || 480)), createdAt: date, updatedAt: date,
  });
  const termRows = terms.map((term, index) => ({ id: `${batchId}-T${String(index + 1).padStart(4, "0")}`, batchId, term: term.term, targetQuantity: term.quantity, kind: term.kind, universe: term.universe || null, createdAt: date, updatedAt: date }));
  const inserts = [];
  for (let offset = 0; offset < termRows.length; offset += D1_TERM_ROWS_PER_INSERT) {
    inserts.push(db.insert(collectionTerms).values(termRows.slice(offset, offset + D1_TERM_ROWS_PER_INSERT)));
  }
  try {
    for (let offset = 0; offset < inserts.length; offset += D1_INSERTS_PER_BATCH) {
      const statements = inserts.slice(offset, offset + D1_INSERTS_PER_BATCH);
      await db.batch(statements as [typeof statements[number], ...Array<typeof statements[number]>]);
    }
  } catch (error) {
    await db.batch([
      db.delete(collectionTerms).where(eq(collectionTerms.batchId, batchId)),
      db.delete(collectionBatches).where(eq(collectionBatches.id, batchId)),
    ]).catch(() => undefined);
    throw error;
  }
  return { ...(await getCollectionBatch(batchId)), importacao_txt: { linhas_totais: parsedTerms.totalLines, termos_aceitos: terms.length, linhas_ignoradas: parsedTerms.warnings.length, avisos: parsedTerms.warnings.slice(0, 100) } };
}

function valuesAtPath(value: unknown, path: string): unknown[] {
  const parts = path.replace(/\[\]/g, ".*").replace(/\[(\d+)\]/g, ".$1").replace(/^\$\.?/, "").split(".").filter(Boolean);
  let values: unknown[] = [value];
  for (const part of parts) {
    values = values.flatMap((entry) => {
      if (part === "*") return Array.isArray(entry) ? entry : [];
      if (/^\d+$/.test(part) && Array.isArray(entry)) return entry[Number(part)] === undefined ? [] : [entry[Number(part)]];
      if (Array.isArray(entry)) return entry.flatMap((item) => item && typeof item === "object" ? [(item as Record<string, unknown>)[part]] : []);
      return entry && typeof entry === "object" ? [(entry as Record<string, unknown>)[part]] : [];
    }).filter((entry) => entry !== undefined && entry !== null);
  }
  return values;
}

function normalizeCandidateUrl(value: unknown, baseUrl: string) {
  const raw = clean(value);
  if (!raw) return null;
  try { const url = new URL(raw, baseUrl); safeUrl(url.toString()); url.hash = ""; return url.toString(); } catch { return null; }
}

const discoveryDomains: Record<string, string> = {
  "Spriters Resource": "spriters-resource.com",
  "SteamGridDB CDN": "steamgriddb.com",
  "Game Icons": "game-icons.net",
};

async function requestJson(source: typeof collectionSources.$inferSelect, requestUrl: URL, timeoutMs = 25_000) {
  const headers = new Headers({ accept: "application/json" });
  const blockedHeaderNames = new Set(["authorization", "cookie", "proxy-authorization", "x-api-key"]);
  try {
    const configured = JSON.parse(source.headersJson || "{}") as Record<string, unknown>;
    for (const [key, value] of Object.entries(configured)) if (!blockedHeaderNames.has(key.toLowerCase()) && typeof value === "string" && value.length <= 500) headers.set(key, value);
  } catch { /* configuração inválida é ignorada; segredos continuam fora do D1 */ }
  if (source.userAgent) headers.set("user-agent", source.userAgent);
  else if (requestUrl.hostname.includes("reddit.com")) headers.set("user-agent", "CorvoLibrary/2.4 (+semantic-media-collector)");
  if (source.apiKeyEnv) {
    const secret = clean((env as unknown as Record<string, unknown>)[source.apiKeyEnv]);
    if (!secret) throw new Error(`SEGREDO_NAO_CONFIGURADO:${source.apiKeyEnv}`);
    if (source.apiKeyHeader) headers.set(source.apiKeyHeader, secret);
    else if (source.apiKeyEnv === "PIXABAY_API_KEY") requestUrl.searchParams.set("key", secret);
    else requestUrl.searchParams.set("key", secret);
  }
  const response = await fetch(requestUrl, { method: "GET", headers, redirect: "follow", signal: AbortSignal.timeout(Math.max(1000, Math.min(timeoutMs, source.timeoutMs || timeoutMs))) });
  if (!response.ok) throw new Error(`FONTE_HTTP_${response.status}`);
  return response.json();
}

async function queryStructuredSource(source: typeof collectionSources.$inferSelect, term: string, limit: number, timeoutMs = 25_000) {
  const requestUrl = safeUrl(source.baseUrl);
  requestUrl.searchParams.set(source.queryParam, term);
  if (source.limitParam) {
    const value = source.limitParam === "many" ? "true" : String(limit);
    requestUrl.searchParams.set(source.limitParam, value);
  }
  const payload = await requestJson(source, requestUrl, timeoutMs);
  const imageValues = valuesAtPath(payload, source.imagePath);
  const thumbs = source.thumbnailPath ? valuesAtPath(payload, source.thumbnailPath) : [];
  return imageValues.flatMap((value, index) => { const url = normalizeCandidateUrl(value, source.baseUrl); return url ? [{ url, thumbnail: normalizeCandidateUrl(thumbs[index], source.baseUrl) }] : []; });
}

async function queryLookupSource(source: typeof collectionSources.$inferSelect, term: string, timeoutMs = 25_000) {
  const guesses = [...new Set([
    term,
    term.replace(/\b(pokemon|pokémon|artwork|official|oficial|sprite|png|transparente|render)\b/gi, " "),
  ].map((value) => value.trim().toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")).filter(Boolean))];
  let lastError = "LOOKUP_SEM_RESULTADO";
  for (const guess of guesses) {
    try {
      const requestUrl = safeUrl(source.baseUrl.replace(/\/$/, "") + "/" + encodeURIComponent(guess));
      const payload = await requestJson(source, requestUrl, timeoutMs);
      const imageValues = valuesAtPath(payload, source.imagePath), thumbs = source.thumbnailPath ? valuesAtPath(payload, source.thumbnailPath) : [];
      const found = imageValues.flatMap((value, index) => { const url = normalizeCandidateUrl(value, source.baseUrl); return url ? [{ url, thumbnail: normalizeCandidateUrl(thumbs[index], source.baseUrl) }] : []; });
      if (found.length) return found;
    } catch (error) { lastError = error instanceof Error ? error.message : lastError; }
  }
  throw new Error(lastError);
}

async function queryDiscoverySource(source: typeof collectionSources.$inferSelect, term: string, limit: number, timeoutMs = 25_000) {
  const domain = discoveryDomains[source.name];
  if (!domain) throw new Error("DISCOVERY_DOMAIN_NAO_CONFIGURADO");
  const db = getDb();
  const [brave] = await db.select().from(collectionSources).where(and(eq(collectionSources.name, "Brave Image Search"), eq(collectionSources.active, true))).limit(1);
  if (!brave) throw new Error("BRAVE_DISCOVERY_NAO_CONFIGURADO");
  return queryStructuredSource(brave, `${term} site:${domain}`, limit, timeoutMs);
}

async function querySource(source: typeof collectionSources.$inferSelect, term: string, limit: number, timeoutMs = 25_000) {
  if (source.method === "GET") return queryStructuredSource(source, term, limit, timeoutMs);
  if (source.method === "LOOKUP") return queryLookupSource(source, term, timeoutMs);
  if (source.method === "DISCOVERY") return queryDiscoverySource(source, term, limit, timeoutMs);
  throw new Error(`FONTE_PROCESSADORA_NAO_PESQUISAVEL:${source.name}`);
}

async function buildReport(batchId: string) {
  const db = getDb();
  const [batch] = await db.select().from(collectionBatches).where(eq(collectionBatches.id, batchId)).limit(1);
  const terms = await db.select().from(collectionTerms).where(eq(collectionTerms.batchId, batchId)).orderBy(asc(collectionTerms.id));
  const candidates = await db.select().from(collectionCandidates).where(eq(collectionCandidates.batchId, batchId));
  const runs = await db.select().from(collectionSourceRuns).where(eq(collectionSourceRuns.batchId, batchId));
  const sources = await db.select().from(collectionSources);
  const sourceNames = new Map(sources.map((source) => [source.id, source.name]));
  const lines = ["RELATORIO DE COLETA AUTOMATICA", `LOTE: ${batch?.name || batchId}`, `BATCH_ID: ${batchId}`, `GERADO_EM_UTC: ${new Date().toISOString()}`, ""];
  for (const term of terms) {
    const termCandidates = candidates.filter((candidate) => candidate.termId === term.id);
    lines.push("==================================================", `TERMO: ${term.term}`, `TIPO: ${term.kind}`, `META: ${term.targetQuantity}`, `MATERIALIZADOS: ${term.collectedCount}`, `FALTARAM: ${Math.max(0, term.targetQuantity - term.collectedCount)}`, `STATUS: ${term.status}`, "", "FONTES:");
    for (const run of runs.filter((item) => item.termId === term.id)) lines.push(`${sourceNames.get(run.sourceId) || run.sourceId} | encontrados=${run.foundCount} | unicos=${run.uniqueCount} | materializados=${run.materializedCount} | falhas=${run.failureCount} | duracao_ms=${run.durationMs}`);
    const failures = termCandidates.filter((candidate) => candidate.status !== "PARA_ANALISE");
    if (failures.length) lines.push("", "FALHAS:", ...failures.map((candidate) => `${candidate.url}\nmotivo: ${candidate.failureReason || candidate.status}`));
    lines.push("");
  }
  return lines.join("\n");
}

const oneLine = (value: unknown) => String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim() || "—";
const iso = (value: Date | null | undefined) => value ? value.toISOString() : "—";

async function buildDetailedLog(batchId: string) {
  const db = getDb();
  const [batch] = await db.select().from(collectionBatches).where(eq(collectionBatches.id, batchId)).limit(1);
  if (!batch) throw new Error("LOTE_COLETA_NAO_ENCONTRADO");
  const [terms, candidates, runs, sources, items, logs] = await Promise.all([
    db.select().from(collectionTerms).where(eq(collectionTerms.batchId, batchId)).orderBy(asc(collectionTerms.id)),
    db.select().from(collectionCandidates).where(eq(collectionCandidates.batchId, batchId)).orderBy(asc(collectionCandidates.createdAt)),
    db.select().from(collectionSourceRuns).where(eq(collectionSourceRuns.batchId, batchId)).orderBy(asc(collectionSourceRuns.createdAt)),
    db.select().from(collectionSources).orderBy(asc(collectionSources.priority), asc(collectionSources.name)),
    db.select().from(materializationItems).where(like(materializationItems.batchId, `${batchId}-%`)).orderBy(asc(materializationItems.createdAt)),
    db.select().from(materializationLogs).where(like(materializationLogs.batchId, `${batchId}-%`)).orderBy(asc(materializationLogs.createdAt)),
  ]);
  const itemDbIds = items.map((item) => item.id);
  const materializerCandidates: Array<typeof materializationCandidates.$inferSelect> = [];
  const files: Array<typeof materializationFiles.$inferSelect> = [];
  for (let offset = 0; offset < itemDbIds.length; offset += 80) {
    const ids = itemDbIds.slice(offset, offset + 80);
    const [candidateRows, fileRows] = await Promise.all([
      db.select().from(materializationCandidates).where(inArray(materializationCandidates.itemDbId, ids)).orderBy(asc(materializationCandidates.priority)),
      db.select().from(materializationFiles).where(inArray(materializationFiles.itemDbId, ids)).orderBy(asc(materializationFiles.createdAt)),
    ]);
    materializerCandidates.push(...candidateRows); files.push(...fileRows);
  }

  const sourceNames = new Map(sources.map((source) => [source.id, source.name]));
  const termById = new Map(terms.map((term) => [term.id, term]));
  const itemByCandidateId = new Map(items.map((item) => [item.itemId, item]));
  const matCandidatesByItem = new Map<string, Array<typeof materializationCandidates.$inferSelect>>();
  const filesByItem = new Map<string, Array<typeof materializationFiles.$inferSelect>>();
  const logsByItem = new Map<string, Array<typeof materializationLogs.$inferSelect>>();
  for (const row of materializerCandidates) matCandidatesByItem.set(row.itemDbId, [...(matCandidatesByItem.get(row.itemDbId) || []), row]);
  for (const row of files) filesByItem.set(row.itemDbId, [...(filesByItem.get(row.itemDbId) || []), row]);
  for (const row of logs) if (row.itemDbId) logsByItem.set(row.itemDbId, [...(logsByItem.get(row.itemDbId) || []), row]);

  const missingTotal = Math.max(0, batch.totalTarget - batch.totalCollected);
  const discarded = candidates.filter((candidate) => candidate.status !== "PARA_ANALISE").length;
  const causeCounts = new Map<string, number>();
  const countCause = (value: unknown, amount = 1) => { const key = oneLine(value); if (key !== "—" && key !== "OK") causeCounts.set(key, (causeCounts.get(key) || 0) + amount); };
  for (const term of terms) countCause(term.failureReason, Math.max(1, term.targetQuantity - term.collectedCount));
  for (const run of runs) if (run.status !== "CONCLUIDA" || run.detail !== "OK") countCause(run.detail);
  for (const candidate of candidates) countCause(candidate.failureReason);
  for (const candidate of materializerCandidates) countCause(candidate.failureReason || (candidate.status !== "MATERIALIZED" ? candidate.status : null));

  const lines = [
    "LOG DETALHADO DA COLETA AUTOMATICA — CORVO LIBRARY",
    "Este arquivo registra fontes, URLs, etapas e causas sem ocultar falhas.", "",
    "[RESUMO DO LOTE]", `LOTE: ${batch.name}`, `LOTE_ID: ${batch.id}`, `STATUS: ${batch.status}`,
    `CRIADO_EM_UTC: ${iso(batch.createdAt)}`, `INICIADO_EM_UTC: ${iso(batch.startedAt)}`, `CONCLUIDO_EM_UTC: ${iso(batch.completedAt)}`,
    `LOG_GERADO_EM_UTC: ${new Date().toISOString()}`, `IMAGENS_ESPERADAS: ${batch.totalTarget}`,
    `IMAGENS_MATERIALIZADAS_PARA_ANALISE: ${batch.totalCollected}`, `IMAGENS_FALTANTES: ${missingTotal}`,
    `APROVEITAMENTO_PERCENTUAL: ${batch.totalTarget ? ((batch.totalCollected / batch.totalTarget) * 100).toFixed(2) : "0.00"}`,
    `TERMOS: ${terms.length}`, `CONSULTAS_A_FONTES: ${runs.length}`,
    `URLS_ENCONTRADAS: ${runs.reduce((sum, run) => sum + run.foundCount, 0)}`,
    `CANDIDATAS_UNICAS_REGISTRADAS: ${candidates.length}`, `CANDIDATAS_DESCARTADAS: ${discarded}`,
    `EVENTOS_DO_MATERIALIZADOR: ${logs.length}`, "", "[CAUSAS AGRUPADAS]",
    ...(causeCounts.size ? [...causeCounts.entries()].sort((a, b) => b[1] - a[1]).map(([cause, count]) => `${count} | ${cause}`) : ["Nenhuma causa registrada."]),
    "", "[DESEMPENHO POR FONTE]",
  ];

  for (const source of sources) {
    const sourceRuns = runs.filter((run) => run.sourceId === source.id);
    if (!sourceRuns.length) continue;
    lines.push(`FONTE: ${source.name}`, `METODO: ${source.method}`, `CONSULTAS: ${sourceRuns.length}`,
      `ENCONTRADOS: ${sourceRuns.reduce((sum, run) => sum + run.foundCount, 0)}`,
      `UNICOS: ${sourceRuns.reduce((sum, run) => sum + run.uniqueCount, 0)}`,
      `MATERIALIZADOS: ${sourceRuns.reduce((sum, run) => sum + run.materializedCount, 0)}`,
      `FALHAS: ${sourceRuns.reduce((sum, run) => sum + run.failureCount, 0)}`,
      `ERROS: ${[...new Set(sourceRuns.filter((run) => run.detail && run.detail !== "OK").map((run) => oneLine(run.detail)))].join(" ; ") || "—"}`, "---");
  }

  lines.push("", "[TERMOS, FONTES CONSULTADAS E GAPS]");
  for (const term of terms) {
    const termRuns = runs.filter((run) => run.termId === term.id), termCandidates = candidates.filter((candidate) => candidate.termId === term.id);
    const missing = Math.max(0, term.targetQuantity - term.collectedCount);
    lines.push("============================================================", `TERMO_ID: ${term.id}`, `TERMO: ${term.term}`, `TIPO: ${term.kind}`,
      `UNIVERSO: ${oneLine(term.universe)}`, `META: ${term.targetQuantity}`, `MATERIALIZADAS: ${term.collectedCount}`,
      `FALTANTES: ${missing}`, `STATUS: ${term.status}`, `ERRO_FINAL_DO_TERMO: ${oneLine(term.failureReason)}`,
      `RODADAS: ${term.rounds}`, `URLS_TENTADAS: ${term.attempts}`, "FONTES CONSULTADAS:");
    if (!termRuns.length) lines.push("- Nenhuma fonte consultada para este termo.");
    for (const run of termRuns) lines.push(`- ${sourceNames.get(run.sourceId) || run.sourceId} | status=${run.status} | encontrados=${run.foundCount} | unicos=${run.uniqueCount} | materializados=${run.materializedCount} | falhas=${run.failureCount} | duracao_ms=${run.durationMs} | erro=${oneLine(run.detail)} | utc=${iso(run.createdAt)}`);
    lines.push("GAPS INDIVIDUAIS:");
    if (!missing) lines.push("- Nenhum gap; meta atingida.");
    else {
      const fallbackCause = term.failureReason || termRuns.findLast((run) => run.detail && run.detail !== "OK")?.detail || (termRuns.length ? "FONTES_SEM_RESULTADO_APROVEITAVEL" : "TERMO_AINDA_NAO_PROCESSADO");
      for (let slot = term.collectedCount + 1; slot <= term.targetQuantity; slot += 1) lines.push(`- GAP ${String(slot).padStart(3, "0")}/${term.targetQuantity} | status=NAO_MATERIALIZADA | erro=${oneLine(fallbackCause)} | candidatas_do_termo=${termCandidates.length}`);
    }
  }

  lines.push("", "[DETALHE DE CADA URL CANDIDATA]");
  if (!candidates.length) lines.push("Nenhuma URL candidata foi registrada neste lote. Consulte as seções FONTES e GAPS para ver os erros de busca.");
  for (const candidate of candidates) {
    const term = termById.get(candidate.termId), item = itemByCandidateId.get(candidate.id);
    const itemCandidates = item ? matCandidatesByItem.get(item.id) || [] : [], itemFiles = item ? filesByItem.get(item.id) || [] : [], itemLogs = item ? logsByItem.get(item.id) || [] : [];
    lines.push("============================================================", `CANDIDATA_ID: ${candidate.id}`, `TERMO: ${term?.term || candidate.termId}`,
      `FONTE: ${sourceNames.get(candidate.sourceId) || candidate.sourceId}`, `URL_ORIGINAL: ${candidate.url}`,
      `THUMBNAIL: ${oneLine(candidate.thumbnail)}`, `STATUS_COLETA: ${candidate.status}`, `ERRO_COLETA: ${oneLine(candidate.failureReason)}`,
      `SHA256: ${oneLine(candidate.sha256)}`, `MATERIALIZATION_BATCH_ID: ${oneLine(candidate.materializationBatchId)}`,
      `MATERIALIZATION_ITEM_ID: ${oneLine(candidate.materializationItemId)}`, `MATERIALIZATION_FILE_ID: ${oneLine(candidate.materializationFileId)}`,
      `ASSET_ID: ${oneLine(candidate.assetId)}`, `STATUS_ITEM: ${oneLine(item?.status)}`, `ERRO_ITEM: ${oneLine(item?.failureReason)}`, "TENTATIVAS DO MATERIALIZADOR:");
    if (!itemCandidates.length) lines.push("- Nenhuma tentativa técnica registrada.");
    for (const attempt of itemCandidates) lines.push(`- prioridade=${attempt.priority} | status=${attempt.status} | erro=${oneLine(attempt.failureReason)} | url=${attempt.originalUrl} | resolvida=${oneLine(attempt.resolvedUrl)} | host=${oneLine(attempt.host)} | adapter=${attempt.adapter} | http=${attempt.httpStatus ?? "—"} | content_type=${oneLine(attempt.contentType)} | bytes=${attempt.contentLength ?? "—"} | redirects=${attempt.redirectsCount} | tentativas=${attempt.attempts}`);
    lines.push("ARQUIVOS GERADOS:");
    if (!itemFiles.length) lines.push("- Nenhum arquivo válido foi gravado no R2.");
    for (const file of itemFiles) lines.push(`- file_id=${file.id} | status=${file.technicalStatus} | r2=${file.r2Key} | mime=${file.mimeType} | bytes=${file.sizeBytes} | dimensoes=${file.width ?? "—"}x${file.height ?? "—"} | sha256=${file.sha256} | conversao=${oneLine(file.conversionType)}`);
    lines.push("EVENTOS:");
    if (!itemLogs.length) lines.push("- Nenhum evento técnico registrado.");
    for (const event of itemLogs) lines.push(`- utc=${iso(event.createdAt)} | evento=${event.event} | status=${oneLine(event.status)} | duracao_ms=${event.durationMs ?? "—"} | detalhe=${oneLine(event.detail)}`);
  }
  return lines.join("\n");
}

async function syncCollectionBatch(batchId: string) {
  const db = getDb(), terms = await db.select().from(collectionTerms).where(eq(collectionTerms.batchId, batchId));
  const totalCollected = terms.reduce((sum, term) => sum + term.collectedCount, 0);
  const open = terms.some((term) => !["META_ATINGIDA", "INSUFICIENTE", "CANCELADO", "FALHA_TECNICA"].includes(term.status));
  const [batch] = await db.select().from(collectionBatches).where(eq(collectionBatches.id, batchId)).limit(1);
  let status = batch?.status || "CRIADO";
  if (batch?.cancelled) status = "CANCELADO";
  else if (!open) status = terms.every((term) => term.status === "META_ATINGIDA") ? "CONCLUIDO" : "CONCLUIDO_COM_PENDENCIAS";
  const completed = status.startsWith("CONCLUIDO") || status === "CANCELADO";
  const reportText = completed ? await buildReport(batchId) : batch?.reportText;
  await db.update(collectionBatches).set({ status, totalCollected, reportText, completedAt: completed ? now() : batch?.completedAt, updatedAt: now() }).where(eq(collectionBatches.id, batchId));
  return getCollectionBatch(batchId);
}

async function retryCollectionDatabase<T>(operation: string, task: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      console.error("[collection/database] operation failed", {
        operation,
        attempt,
        attempts,
        error: error instanceof Error ? error.message : String(error),
      });
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 80));
    }
  }
  throw lastError;
}

async function isolateFailedCollectionTerm(batchId: string, error: unknown) {
  const db = getDb();
  const message = (error instanceof Error ? error.message : String(error)).replace(/[\r\n\t]+/g, " ").slice(0, 500);
  const [term] = await retryCollectionDatabase("identify_failed_term", () => db.select({ id: collectionTerms.id, term: collectionTerms.term })
    .from(collectionTerms)
    .where(and(eq(collectionTerms.batchId, batchId), or(
      eq(collectionTerms.status, "BUSCANDO"),
      eq(collectionTerms.status, "MATERIALIZANDO"),
      eq(collectionTerms.status, "PENDENTE"),
      eq(collectionTerms.status, "PARA_ANALISE"),
    )))
    .orderBy(asc(collectionTerms.id))
    .limit(1));
  if (!term) throw error;
  await retryCollectionDatabase("isolate_failed_term", () => db.update(collectionTerms).set({
    status: "FALHA_TECNICA",
    failureReason: `EXCECAO_ISOLADA:${message}`,
    updatedAt: now(),
  }).where(eq(collectionTerms.id, term.id)));
  console.error("[collection/term] isolated technical failure", { batchId, termId: term.id, term: term.term, error: message });
  return retryCollectionDatabase("sync_after_isolation", () => syncCollectionBatch(batchId));
}

export async function executeCollectionRound(batchId: string, forcedTermId?: string) {
  const db = getDb();
  const [batch] = await db.select().from(collectionBatches).where(eq(collectionBatches.id, batchId)).limit(1);
  if (!batch) throw new Error("LOTE_COLETA_NAO_ENCONTRADO");
  if (batch.cancelled) return syncCollectionBatch(batchId);
  const expired = batch.startedAt && Date.now() - batch.startedAt.getTime() > batch.maxTotalMinutes * 60_000;
  if (expired) {
    await db.update(collectionTerms).set({ status: "INSUFICIENTE", failureReason: "TEMPO_TOTAL_ESGOTADO", updatedAt: now() }).where(and(eq(collectionTerms.batchId, batchId), or(eq(collectionTerms.status, "PENDENTE"), eq(collectionTerms.status, "BUSCANDO"), eq(collectionTerms.status, "MATERIALIZANDO"))));
    return syncCollectionBatch(batchId);
  }
  if (batch.status === "PAUSADO") return getCollectionBatch(batchId);
  if (batch.status === "CRIADO") await db.update(collectionBatches).set({ status: "EXECUTANDO", startedAt: now(), updatedAt: now() }).where(eq(collectionBatches.id, batchId));
  const eligibleStatus = or(eq(collectionTerms.status, "PENDENTE"), eq(collectionTerms.status, "BUSCANDO"), eq(collectionTerms.status, "MATERIALIZANDO"), eq(collectionTerms.status, "PARA_ANALISE"));
  const [term] = forcedTermId
    ? await db.select().from(collectionTerms).where(and(eq(collectionTerms.batchId, batchId), eq(collectionTerms.id, forcedTermId), eligibleStatus)).limit(1)
    : await db.select().from(collectionTerms).where(and(eq(collectionTerms.batchId, batchId), eligibleStatus)).orderBy(asc(collectionTerms.id)).limit(1);
  if (!term) return syncCollectionBatch(batchId);
  const allSources = await db.select().from(collectionSources).where(eq(collectionSources.active, true)).orderBy(asc(collectionSources.priority), asc(collectionSources.name));
  const searchable = allSources.filter((source) => ["GET", "LOOKUP", "DISCOVERY"].includes(source.method));
  const searchPolicy = parseSearchPolicy(term.sourcePlan);
  const [projectItem] = await db.select().from(automaticProjectItems).where(eq(automaticProjectItems.collectionTermId, term.id)).limit(1).catch(()=>[]);
  const [project] = projectItem ? await db.select().from(automaticProjects).where(eq(automaticProjects.id, projectItem.projectId)).limit(1).catch(()=>[]) : [];
  const routing = await buildSourceRoutingPlan({
    projectId:projectItem?.projectId || null, itemId:projectItem?.id || null, collectionTermId:term.id,
    projectDomain:project?.projectDomain || projectItem?.itemDomain || null, universe:term.universe || projectItem?.universe || null,
    compositionClass:projectItem?.compositionClass || (term.kind === "contextual" ? "CONTEXTUAL" : "ISOLATED"), targetType:projectItem?.kind || term.kind,
    canonicalReference:projectItem?.semanticReference || term.term, preferredSources:searchPolicy.preferred_sources, avoidSources:searchPolicy.avoid_sources,
    allowGenericFallback:term.rounds >= 2, persist:true,
  });
  const eligibleIds = new Set(routing.discovery_sources.map((source)=>source.id));
  let sources = searchable.filter((source)=>eligibleIds.has(source.id));
  if (searchPolicy.strict_preferred_sources && searchPolicy.preferred_sources.length) {
    const normalizeSource = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    sources = sources.filter((source)=>searchPolicy.preferred_sources.some((name)=>{const a=normalizeSource(source.name),b=normalizeSource(name);return a.includes(b)||b.includes(a);}));
  }
  const routingRank = new Map(routing.discovery_sources.map((source,index)=>[source.id,index]));
  sources.sort((a,b)=>(routingRank.get(a.id) ?? 9999) - (routingRank.get(b.id) ?? 9999) || a.priority-b.priority || a.name.localeCompare(b.name));
  const termExpired = term.startedAt && Date.now() - term.startedAt.getTime() > batch.maxTermMinutes * 60_000;
  const sourceLimit = Math.min(batch.maxSourcesPerTerm, searchPolicy.max_sources_per_term || batch.maxSourcesPerTerm);
  const urlLimit = Math.min(batch.maxUrlsPerTerm, searchPolicy.max_urls_per_term || batch.maxUrlsPerTerm);
  if (!sources.length || term.sourceCursor >= Math.min(sources.length, sourceLimit) || term.attempts >= urlLimit || term.rounds >= Math.min(batch.maxRoundsPerTerm, searchPolicy.max_rounds || batch.maxRoundsPerTerm) || termExpired) {
    await db.update(collectionTerms).set({ status: "INSUFICIENTE", failureReason: !sources.length ? (routing.routing_gap || "ROUTING_CONFIGURATION_GAP") : termExpired ? "TEMPO_TERMO_ESGOTADO" : "LIMITES_ESGOTADOS", updatedAt: now() }).where(eq(collectionTerms.id, term.id));
    return syncCollectionBatch(batchId);
  }
  const source = sources[term.sourceCursor], started = Date.now(), remaining = term.targetQuantity - term.collectedCount;
  await db.update(collectionTerms).set({ status: "BUSCANDO", startedAt: term.startedAt || now(), updatedAt: now() }).where(eq(collectionTerms.id, term.id));
  await db.update(collectionBatches).set({ status: "EXECUTANDO", updatedAt: now() }).where(eq(collectionBatches.id, batchId));
  let found = 0, unique = 0, materialized = 0, failures = 0, detail = "OK";
  try {
    const plannedQuery = searchPolicy.queries.length ? searchPolicy.queries[Math.min(searchPolicy.queries.length - 1, term.rounds % searchPolicy.queries.length)] : term.term;
    const effectiveQuery = searchQueryForSource(source.name, plannedQuery, searchPolicy.negative_terms);
    const candidates = await querySource(source, effectiveQuery, Math.min(100, Math.max(10, remaining * 4)), searchPolicy.timeout_ms || 25_000); found = candidates.length;
    const existing = await db.select({ normalizedUrl: collectionCandidates.normalizedUrl }).from(collectionCandidates).where(eq(collectionCandidates.batchId, batchId));
    const seen = new Set(existing.map((row) => row.normalizedUrl));
    const healthRows = await db.select().from(materializationHostHealth).limit(500);
    const health = new Map(healthRows.map((row) => [row.host.toLowerCase(), row]));
    const hostMatches = (host: string, rule: string) => host === rule || host.endsWith(`.${rule}`);
    const preferredHostRank = (host: string) => {
      const index = searchPolicy.preferred_hosts.findIndex((rule) => hostMatches(host, rule));
      return index < 0 ? 10_000 : index;
    };
    const avoidedHost = (host: string) => searchPolicy.avoid_hosts.some((rule) => hostMatches(host, rule));
    const hostScore = (url: string) => {
      const host = hostOfCandidate(url), row = health.get(host), preferred = preferredHostRank(host);
      const blocked = row?.circuitState === "OPEN" && row.blockedUntil && row.blockedUntil.getTime() > Date.now();
      const reliability = row ? row.successCount - row.failureCount * 2 - row.recentFailureCount * 3 : 0;
      return { host, blocked: Boolean(blocked), preferred, reliability };
    };
    const selected = candidates
      .filter((candidate) => !seen.has(candidate.url))
      .filter((candidate) => semanticCandidatePrecheck(term.term, term.universe || undefined, candidate).ok)
      .filter((candidate) => { const info = hostScore(candidate.url); return Boolean(info.host) && !avoidedHost(info.host) && !info.blocked; })
      .sort((a, b) => { const ah = hostScore(a.url), bh = hostScore(b.url); return ah.preferred - bh.preferred || bh.reliability - ah.reliability; })
      .slice(0, Math.min(20, remaining)); unique = selected.length;
    const rows = selected.map((candidate, index) => ({ id: makeId("CAND"), batchId, termId: term.id, sourceId: source.id, url: candidate.url, normalizedUrl: candidate.url, thumbnail: candidate.thumbnail || null, estimatedType: term.kind, priority: index + 1, status: "CANDIDATA", createdAt: now(), updatedAt: now() }));
    if (rows.length) await db.insert(collectionCandidates).values(rows);
    if (rows.length) {
      await db.update(collectionTerms).set({ status: "MATERIALIZANDO", updatedAt: now() }).where(eq(collectionTerms.id, term.id));
      await db.update(collectionBatches).set({ updatedAt: now() }).where(eq(collectionBatches.id, batchId));
      const materializationBatchId = `${batchId}-R${term.rounds + 1}-${source.id.slice(-6)}`;
      await materializeBatch({ batch_id: materializationBatchId, projeto: batch.name, itens: rows.map((row, index) => ({ item_id: row.id, arquivo_alvo: `${term.term.replace(/[^a-zA-Z0-9À-ÿ._ -]/g, "-").slice(0, 100)}-${index + 1}.${term.kind === "transparente" ? "png" : "jpg"}`, conceito: term.term, referencia_visual: term.term, universo: term.universe, tipo: term.kind === "contextual" ? "Cenário" : "Imagem", tags: [term.term, term.kind], largura_minima: 64, altura_minima: 64, transparencia_necessaria: term.kind === "transparente", candidatas: [{ prioridade: 1, url: row.url, fonte: source.name }] })) });
      const items = await db.select().from(materializationItems).where(eq(materializationItems.batchId, materializationBatchId));
      const fileIds = items.map((item) => item.selectedFileId).filter((value): value is string => Boolean(value));
      const files = fileIds.length ? await db.select().from(materializationFiles).where(inArray(materializationFiles.id, fileIds)) : [];
      const filesById = new Map(files.map((file) => [file.id, file]));
      const collectedHashes = await db.select({ sha256: collectionCandidates.sha256 }).from(collectionCandidates).where(and(eq(collectionCandidates.batchId, batchId), eq(collectionCandidates.status, "PARA_ANALISE")));
      const catalogHashes = await db.select({ sha256: assets.sha256 }).from(assets).where(sql`${assets.sha256} is not null`);
      const knownHashes = new Set([...collectedHashes, ...catalogHashes].map((row) => row.sha256).filter(Boolean));
      for (const item of items) {
        const file = item.selectedFileId ? filesById.get(item.selectedFileId) : null;
        const duplicate = file ? knownHashes.has(file.sha256) : false;
        const status = file && item.status === "READY_FOR_VISUAL_QA" && !duplicate ? "PARA_ANALISE" : duplicate ? "DESCARTADO" : "DESCARTADO";
        const reason = duplicate ? "DUPLICATA_HASH" : status === "PARA_ANALISE" ? null : (item.failureReason || item.status);
        await db.update(collectionCandidates).set({ status, failureReason: reason, sha256: file?.sha256 || null, materializationBatchId, materializationItemId: item.id, materializationFileId: file?.id || null, updatedAt: now() }).where(eq(collectionCandidates.id, item.itemId));
        if (status === "PARA_ANALISE") { materialized += 1; if (file) knownHashes.add(file.sha256); } else failures += 1;
      }
    }
  } catch (error) {
    const raw = error instanceof Error ? error.message : "FALHA_FONTE";
    detail = /timeout|timed out|abort/i.test(raw) ? `SOURCE_TIMEOUT:${raw}` : raw.startsWith("SEGREDO_NAO_CONFIGURADO:") ? raw : `SOURCE_FAILURE:${raw}`;
    failures += 1;
  }
  const sourceNotConfigured = detail.startsWith("SEGREDO_NAO_CONFIGURADO:");
  if (sourceNotConfigured) {
    failures = 0;
    detail = `SOURCE_NOT_CONFIGURED:${detail.split(":").slice(1).join(":")}`;
    // Infraestrutura óbvia não consome Supervisor repetidamente. A fonte fica fora
    // do roteamento até ser reativada depois da credencial/configuração ser corrigida.
    await db.update(collectionSources).set({ active: false, updatedAt: now() }).where(eq(collectionSources.id, source.id)).catch(() => undefined);
  }
  else if (detail === "OK" && found === 0) detail = "SOURCE_EMPTY";
  else if (detail === "OK" && found > 0 && unique === 0) detail = "DUPLICATE_OR_HOST_POLICY_FILTERED";
  else if (detail === "OK" && unique > 0 && materialized === 0) detail = "MATERIALIZATION_FAILURE";
  const successfulRun = detail === "OK" || materialized > 0;
  const detailForLog = detail === "OK" ? `OK query=${searchQueryForSource(source.name, searchPolicy.queries.length ? searchPolicy.queries[Math.min(searchPolicy.queries.length - 1, term.rounds % searchPolicy.queries.length)] : term.term, searchPolicy.negative_terms)} preferred_hosts=${searchPolicy.preferred_hosts.length} avoid_hosts=${searchPolicy.avoid_hosts.length}` : detail;
  const duration = Date.now() - started, nextCount = term.collectedCount + materialized, nextCursor = term.sourceCursor + 1, attempts = term.attempts + unique;
  await recordRouteRun({ universe:term.universe, compositionClass:term.kind === "contextual" ? "CONTEXTUAL" : "ISOLATED", sourceId:source.id, sourceName:source.name, attempts:Math.max(1,unique), materialized, technicalFailures:failures, durationMs:duration }).catch(() => undefined);
  const termStatus = nextCount >= term.targetQuantity ? "META_ATINGIDA" : materialized > 0 ? "PARA_ANALISE" : "PENDENTE";
  await db.update(collectionTerms).set({ status: termStatus, collectedCount: nextCount, attempts, rounds: term.rounds + (sourceNotConfigured ? 0 : 1), sourceCursor: nextCursor, failureReason: successfulRun || sourceNotConfigured ? null : detail, updatedAt: now() }).where(eq(collectionTerms.id, term.id));
  await db.insert(collectionSourceRuns).values({ id: makeId("RUN"), batchId, termId: term.id, sourceId: source.id, foundCount: found, uniqueCount: unique, materializedCount: materialized, failureCount: failures, durationMs: duration, status: sourceNotConfigured ? "SKIPPED" : successfulRun ? "CONCLUIDA" : "FALHA", detail: detailForLog });
  if (!sourceNotConfigured) await db.update(collectionSources).set({ queryCount: sql`${collectionSources.queryCount} + 1`, foundCount: sql`${collectionSources.foundCount} + ${found}`, uniqueCount: sql`${collectionSources.uniqueCount} + ${unique}`, materializedCount: sql`${collectionSources.materializedCount} + ${materialized}`, failureCount: sql`${collectionSources.failureCount} + ${failures}`, totalDurationMs: sql`${collectionSources.totalDurationMs} + ${duration}`, updatedAt: now() }).where(eq(collectionSources.id, source.id));
  return syncCollectionBatch(batchId);
}

export async function executeCollection(input: Record<string, unknown>) {
  const sweeps = Math.max(1, Math.min(5, Number(input.max_rodadas) || 1));
  const parallelTerms = Math.max(1, Math.min(20, Number(input.paralelismo_termos) || 10));
  const batchId = clean(input.lote_id), db = getDb();
  let result: unknown = null;
  for (let sweep = 0; sweep < sweeps; sweep += 1) {
    const terms = await db.select({ id: collectionTerms.id }).from(collectionTerms)
      .where(and(eq(collectionTerms.batchId, batchId), or(eq(collectionTerms.status,"PENDENTE"),eq(collectionTerms.status,"BUSCANDO"),eq(collectionTerms.status,"MATERIALIZANDO"),eq(collectionTerms.status,"PARA_ANALISE"))))
      .orderBy(asc(collectionTerms.id)).limit(parallelTerms);
    if (!terms.length) { result = await syncCollectionBatch(batchId); break; }
    const settled = await Promise.allSettled(terms.map((term)=>retryCollectionDatabase(`execute_collection_round:${term.id}`,()=>executeCollectionRound(batchId,term.id))));
    for (let index=0; index<settled.length; index+=1) {
      const entry=settled[index]; if (entry.status==="fulfilled") continue;
      const message=entry.reason instanceof Error?entry.reason.message:String(entry.reason);
      await db.update(collectionTerms).set({status:"FALHA_TECNICA",failureReason:`EXCECAO_ISOLADA:${message}`.slice(0,500),updatedAt:now()}).where(eq(collectionTerms.id,terms[index].id)).catch(()=>undefined);
    }
    result = await syncCollectionBatch(batchId);
  }
  return result || syncCollectionBatch(batchId);
}

export async function getCollectionBatch(batchId: string) {
  const db = getDb(); const [batch] = await db.select().from(collectionBatches).where(eq(collectionBatches.id, batchId)).limit(1);
  if (!batch) throw new Error("LOTE_COLETA_NAO_ENCONTRADO");
  const allTerms = await db.select().from(collectionTerms).where(eq(collectionTerms.batchId, batchId)).orderBy(asc(collectionTerms.id));
  const currentTerm = allTerms.find((term) => ["BUSCANDO", "MATERIALIZANDO"].includes(term.status)) || allTerms.find((term) => ["PENDENTE", "PARA_ANALISE"].includes(term.status)) || null;
  const searchableSourcesBase = (await db.select().from(collectionSources).where(eq(collectionSources.active, true)).orderBy(asc(collectionSources.priority), asc(collectionSources.name))).filter((source) => ["GET", "LOOKUP", "DISCOVERY"].includes(source.method));
  const currentPlan = parseSearchPolicy(currentTerm?.sourcePlan).preferred_sources;
  const sourceNorm = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const currentRank = new Map(currentPlan.map((name, index) => [sourceNorm(name), index]));
  const rankOf = (name: string) => { const normalized = sourceNorm(name); for (const [planned, index] of currentRank) if (normalized.includes(planned) || planned.includes(normalized)) return index; return Number.MAX_SAFE_INTEGER; };
  const searchableSources = [...searchableSourcesBase].sort((a, b) => rankOf(a.name) - rankOf(b.name) || a.priority - b.priority || a.name.localeCompare(b.name));
  const currentSource = currentTerm ? searchableSources[currentTerm.sourceCursor] || null : null;
  const activity = await db.select({
    id: collectionSourceRuns.id, status: collectionSourceRuns.status, detail: collectionSourceRuns.detail,
    foundCount: collectionSourceRuns.foundCount, uniqueCount: collectionSourceRuns.uniqueCount,
    materializedCount: collectionSourceRuns.materializedCount, failureCount: collectionSourceRuns.failureCount,
    durationMs: collectionSourceRuns.durationMs, createdAt: collectionSourceRuns.createdAt,
    term: collectionTerms.term, source: collectionSources.name,
  }).from(collectionSourceRuns)
    .innerJoin(collectionTerms, eq(collectionTerms.id, collectionSourceRuns.termId))
    .innerJoin(collectionSources, eq(collectionSources.id, collectionSourceRuns.sourceId))
    .where(eq(collectionSourceRuns.batchId, batchId)).orderBy(desc(collectionSourceRuns.createdAt)).limit(20);
  const statusCounts = Object.fromEntries([...new Set(allTerms.map((term) => term.status))].map((status) => [status, allTerms.filter((term) => term.status === status).length]));
  const parsed = parseTerms(batch.termsText);
  return {
    lote: batch, termos: allTerms.slice(0, 120), termos_total: allTerms.length, contagem_status: statusCounts,
    termo_atual: currentTerm, fonte_atual: currentSource ? safeSource(currentSource) : null, atividade: activity,
    heartbeat_utc: batch.updatedAt.toISOString(),
    progresso_percentual: batch.totalTarget ? Math.round((batch.totalCollected / batch.totalTarget) * 100) : 0,
    retomavel: !batch.cancelled && !["CONCLUIDO", "CONCLUIDO_COM_PENDENCIAS"].includes(batch.status),
    importacao_txt: { linhas_totais: parsed.totalLines, termos_aceitos: parsed.terms.length, linhas_ignoradas: parsed.warnings.length, avisos: parsed.warnings.slice(0, 100) },
  };
}

export async function listCollectionBatches(limit = 50) {
  const rows = await getDb().select().from(collectionBatches).orderBy(desc(collectionBatches.createdAt)).limit(Math.max(1, Math.min(100, limit)));
  return { lotes: rows, total: rows.length };
}

export async function setCollectionBatchState(batchId: string, action: "pausar" | "retomar" | "cancelar") {
  const db = getDb(); const [batch] = await db.select().from(collectionBatches).where(eq(collectionBatches.id, batchId)).limit(1); if (!batch) throw new Error("LOTE_COLETA_NAO_ENCONTRADO");
  if (action === "cancelar") {
    await db.update(collectionBatches).set({ status: "CANCELADO", cancelled: true, completedAt: now(), updatedAt: now() }).where(eq(collectionBatches.id, batchId));
    await db.update(collectionTerms).set({ status: "CANCELADO", updatedAt: now() }).where(and(eq(collectionTerms.batchId, batchId), or(eq(collectionTerms.status, "PENDENTE"), eq(collectionTerms.status, "BUSCANDO"), eq(collectionTerms.status, "MATERIALIZANDO"), eq(collectionTerms.status, "PARA_ANALISE"))));
  } else await db.update(collectionBatches).set({ status: action === "pausar" ? "PAUSADO" : "EXECUTANDO", updatedAt: now() }).where(eq(collectionBatches.id, batchId));
  return syncCollectionBatch(batchId);
}

export async function listCollectionQa(input: Record<string, unknown>) {
  const db = getDb(); const conditions = [eq(collectionCandidates.status, clean(input.status) || "PARA_ANALISE")];
  if (clean(input.lote_id)) conditions.push(eq(collectionCandidates.batchId, clean(input.lote_id)));
  if (clean(input.termo)) conditions.push(like(collectionTerms.term, `%${clean(input.termo)}%`));
  if (clean(input.tipo)) conditions.push(eq(collectionTerms.kind, clean(input.tipo)));
  if (clean(input.fonte_id)) conditions.push(eq(collectionCandidates.sourceId, clean(input.fonte_id)));
  const rows = await db.select({ candidate: collectionCandidates, term: collectionTerms.term, kind: collectionTerms.kind, universe: collectionTerms.universe, source: collectionSources.name }).from(collectionCandidates).innerJoin(collectionTerms, eq(collectionTerms.id, collectionCandidates.termId)).innerJoin(collectionSources, eq(collectionSources.id, collectionCandidates.sourceId)).where(and(...conditions)).orderBy(desc(collectionCandidates.createdAt)).limit(Math.max(1, Math.min(100, Number(input.limite) || 20)));
  return { assets: rows.map((row) => ({ ...row.candidate, termo: row.term, tipo: row.kind, universo: row.universe, fonte: row.source })), total: rows.length };
}

export async function getCollectionReport(batchId: string) {
  const report = await buildReport(batchId); await getDb().update(collectionBatches).set({ reportText: report, updatedAt: now() }).where(eq(collectionBatches.id, batchId));
  return { lote_id: batchId, arquivo: `RELATORIO-${batchId}.txt`, mime_type: "text/plain; charset=utf-8", conteudo: report };
}

export async function getDetailedCollectionLog(batchId: string) {
  const log = await buildDetailedLog(batchId);
  return { lote_id: batchId, arquivo: `LOG-DETALHADO-${batchId}.txt`, mime_type: "text/plain; charset=utf-8", conteudo: log };
}
