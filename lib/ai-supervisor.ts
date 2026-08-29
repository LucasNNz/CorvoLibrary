import { env } from "./platform/runtime";
import { getSupervisorConnection } from "./secure-settings";

export type CompositionClass = "CONTEXTUAL" | "ISOLATED";
export type SemanticClass = "PERSONAGEM_ANIME" | "PERSONAGEM_CARTOON" | "PERSONAGEM_GEEK" | "GAME_RENDER" | "CENARIO_ANIME" | "CENARIO_REAL" | "OBJETO_GEEK" | "ARMA" | "VEICULO" | "MEME" | "PNG_ISOLADO" | "FOTO_REAL_FALLBACK";

export type SupervisorEvent = "ITEM_START" | "SEARCH_EXHAUSTED" | "READY_FOR_VISUAL_QA" | "RELINK_REQUIRED" | "TECHNICAL_CORRECTION_REQUIRED" | "NEXT_CANDIDATE";
export type SupervisorAction = "USE_LIBRARY_ASSET" | "START_EXTERNAL_SEARCH" | "TRY_NEXT_QUERY" | "TRY_NEXT_SOURCE" | "TRY_NEXT_CANDIDATE" | "MATERIALIZE_URL" | "APPLY_TECHNICAL_FIX" | "APPROVE_AND_FREEZE" | "REJECT_AND_NEXT_CANDIDATE" | "RELINK_ITEM" | "CANCEL_ITEM" | "PROBE_URL" | "WAIT_FOR_VISUAL_QA";
export type SupervisorProviderMode = "EXTERNAL_AI" | "CLOUDFLARE_AI_BINDING" | "CLOUDFLARE_AI_REST" | "OPENAI_RESPONSES" | "DETERMINISTIC_FALLBACK";

export type SupervisorInput = {
  event: SupervisorEvent;
  project: { id: string; name: string };
  item: {
    id: string;
    term: string;
    type?: string | null;
    universe?: string | null;
    context?: string | null;
    preset?: string | null;
    slot?: string | null;
    observacao?: string | null;
    composition_class?: CompositionClass;
  };
  library_state?: { close_variations_count?: number; library_candidates?: unknown[] };
  strategy_state?: Record<string, unknown>;
  telemetry?: Record<string, unknown>;
  candidates?: Array<{ id?: string; url?: string; source?: string; host?: string; status?: string; failure_reason?: string | null }>;
  image?: { mime_type: string; base64: string; file_id?: string | null };
};

export type SupervisorOutput = {
  action: SupervisorAction;
  reason: string;
  reference?: string | null;
  universe_reference?: string | null;
  reference_type?: string | null;
  semantic_class?: SemanticClass;
  composition_class?: CompositionClass;
  queries?: string[];
  negative_terms?: string[];
  preferred_sources?: string[];
  preferred_hosts?: string[];
  avoid_hosts?: string[];
  selected_url?: string | null;
  selected_asset_id?: string | null;
  technical_fixes?: string[];
  technical_parameters?: Record<string, unknown>;
  qa_labels?: { semantic?: string | null; technical?: string | null; visual?: string | null };
  notes?: string;
  confidence?: number;
  alternatives_relink?: string[];
  max_rounds?: number;
  provider_mode?: SupervisorProviderMode;
  provider_model?: string | null;
};

const ACTIONS = new Set<SupervisorAction>(["USE_LIBRARY_ASSET", "START_EXTERNAL_SEARCH", "TRY_NEXT_QUERY", "TRY_NEXT_SOURCE", "TRY_NEXT_CANDIDATE", "MATERIALIZE_URL", "APPLY_TECHNICAL_FIX", "APPROVE_AND_FREEZE", "REJECT_AND_NEXT_CANDIDATE", "RELINK_ITEM", "CANCEL_ITEM", "PROBE_URL", "WAIT_FOR_VISUAL_QA"]);
const SEMANTIC_CLASSES = new Set<SemanticClass>(["PERSONAGEM_ANIME", "PERSONAGEM_CARTOON", "PERSONAGEM_GEEK", "GAME_RENDER", "CENARIO_ANIME", "CENARIO_REAL", "OBJETO_GEEK", "ARMA", "VEICULO", "MEME", "PNG_ISOLADO", "FOTO_REAL_FALLBACK"]);
export const LLAMA_VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const clean = (value: unknown) => typeof value === "string" ? value.trim() : "";
const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR");
const strings = (value: unknown, limit = 20) => Array.isArray(value) ? [...new Set(value.map(clean).filter(Boolean))].slice(0, limit) : [];

export function classifyComposition(kind?: string | null, notes?: string | null, term?: string | null): CompositionClass {
  const haystack = normalize([kind, notes, term].filter(Boolean).join(" "));
  if (/png|transpar|isolad|render|sprite|icone|ícone|sem fundo|alpha/.test(haystack)) return "ISOLATED";
  return "CONTEXTUAL";
}

export function classifySemantic(term: string, kind?: string | null, universe?: string | null, composition?: CompositionClass): SemanticClass {
  const haystack = normalize([term, kind, universe].filter(Boolean).join(" "));
  if (composition === "ISOLATED") return "PNG_ISOLADO";
  if (/meme|reaction|reacao/.test(haystack)) return "MEME";
  if (/arma|espada|rifle|pistola|machado|katana|weapon/.test(haystack)) return "ARMA";
  if (/carro|veiculo|veículo|moto|nave|navio|kart|vehicle/.test(haystack)) return "VEICULO";
  if (/cenario|cenário|cidade|floresta|praia|quarto|sala|base|interior|exterior|background/.test(haystack)) return /anime|manga|mangá/.test(haystack) ? "CENARIO_ANIME" : "CENARIO_REAL";
  if (/game|jogo|fortnite|minecraft|zelda|pokemon|pokémon/.test(haystack)) return "GAME_RENDER";
  if (/anime|manga|mangá|dandadan|naruto|dragon ball|one piece|demon slayer|frieren/.test(haystack)) return "PERSONAGEM_ANIME";
  if (/cartoon|desenho|disney|pixar/.test(haystack)) return "PERSONAGEM_CARTOON";
  return "PERSONAGEM_GEEK";
}

function sourcePlan(semanticClass: SemanticClass) {
  if (semanticClass === "CENARIO_REAL") return ["Pexels", "Pixabay", "Openverse", "Wikimedia"];
  if (semanticClass === "GAME_RENDER") return ["Spriters Resource", "Raw GitHub", "SteamGridDB CDN", "Fandom Wikia Adapter"];
  if (semanticClass === "PERSONAGEM_ANIME") return ["Fandom Wikia Adapter", "Konachan", "Pinterest Adapter", "Reddit", "Openverse"];
  if (semanticClass === "PNG_ISOLADO") return ["Fandom Wikia Adapter", "Spriters Resource", "Raw GitHub", "Pinterest Adapter", "Openverse"];
  return ["Fandom Wikia Adapter", "Pinterest Adapter", "Openverse", "Wikimedia"];
}

const KNOWN_REFERENCE_RULES: Array<{ pattern: RegExp; reference: string; universe: string; type: string; alternatives: string[] }> = [
  { pattern: /cientista|laboratorio|laboratório|science/, reference: "Senku Ishigami", universe: "Dr. Stone", type: "PERSONAGEM", alternatives: ["Bulma Dragon Ball", "Dr. Gero Dragon Ball", "Mayuri Kurotsuchi Bleach"] },
  { pattern: /medic|hospital|cura|healer/, reference: "Tsunade", universe: "Naruto", type: "PERSONAGEM", alternatives: ["Sakura Haruno Naruto", "Recovery Girl My Hero Academia"] },
  { pattern: /computador|hacker|terminal|supercomputador/, reference: "Futaba Sakura", universe: "Persona 5", type: "PERSONAGEM", alternatives: ["MAGI Evangelion", "Bulma computer Dragon Ball"] },
  { pattern: /base secreta|local secreto|esconderijo|caverna secreta/, reference: "Batcave", universe: "Batman", type: "LOCAL", alternatives: ["Konoha underground base Naruto", "Avengers Compound interior"] },
  { pattern: /treino|training|manequim|dummy/, reference: "Training Dummy", universe: "Minecraft", type: "OBJETO", alternatives: ["Naruto training field", "Dragon Ball gravity training room"] },
  { pattern: /arsenal|armory|armamento/, reference: "Fortnite Armory", universe: "Fortnite", type: "LOCAL", alternatives: ["Batman weapon vault", "Overwatch armory"] },
  { pattern: /trono|throne/, reference: "Frieza throne", universe: "Dragon Ball", type: "OBJETO", alternatives: ["Thanos throne Marvel", "Demon King throne anime"] },
  { pattern: /simbolo medico|símbolo médico|cruz medica|cruz médica/, reference: "Medical cross icon", universe: "Geek", type: "OBJETO", alternatives: ["Pokemon Center symbol", "healing icon game"] },
];

function deterministicReference(term: string) {
  const normalized = normalize(term);
  return KNOWN_REFERENCE_RULES.find((rule) => rule.pattern.test(normalized)) || null;
}

function queryPlan(reference: string, universe?: string | null, composition?: CompositionClass) {
  const base = [reference, universe].filter(Boolean).join(" ").trim();
  const suffix = composition === "ISOLATED" ? "png render transparent" : "anime cartoon screenshot scene";
  return [...new Set([
    `${base} ${suffix}`.trim(),
    `${base} official`.trim(),
    `${reference} ${universe || ""} high quality`.trim(),
  ])];
}

export function deterministicSupervisor(input: SupervisorInput): SupervisorOutput {
  const composition = input.item.composition_class || classifyComposition(input.item.type, input.item.observacao, input.item.term);
  const semanticClass = classifySemantic(input.item.term, input.item.type, input.item.universe, composition);
  const linked = deterministicReference(input.item.term);
  const reference = linked?.reference || clean(input.item.term);
  const universeReference = linked?.universe || input.item.universe || null;
  const queries = queryPlan(reference, universeReference, composition);
  const preferredSources = sourcePlan(semanticClass);
  const telemetryPreferredHosts = Array.isArray(input.telemetry?.preferred_hosts) ? strings(input.telemetry?.preferred_hosts, 20).map((host) => host.toLowerCase()) : [];
  const telemetryBadHosts = Array.isArray(input.telemetry?.bad_hosts) ? strings(input.telemetry?.bad_hosts, 30).map((host) => host.toLowerCase()) : [];
  const history = Array.isArray(input.strategy_state?.query_history) ? input.strategy_state?.query_history as string[] : [];
  const unusedQueries = queries.filter((query) => !history.includes(query));
  const matureLibrary = Number(input.library_state?.close_variations_count || 0) >= 5;
  const libraryCandidates = Array.isArray(input.library_state?.library_candidates) ? input.library_state?.library_candidates as Array<Record<string, unknown>> : [];

  if (input.event === "READY_FOR_VISUAL_QA") {
    return {
      action: "WAIT_FOR_VISUAL_QA",
      reason: "QA visual exige um provedor multimodal configurado; o fallback determinístico não aprova imagem.",
      reference, universe_reference: universeReference, reference_type: linked?.type || null,
      semantic_class: semanticClass, composition_class: composition, provider_mode: "DETERMINISTIC_FALLBACK",
      notes: "Configure Workers AI/Cloudflare AI, OPENAI_API_KEY ou SUPERVISOR_IA_ENDPOINT para QA visual automático.",
    };
  }

  if (input.event === "TECHNICAL_CORRECTION_REQUIRED") {
    if (composition === "ISOLATED") return {
      action: "APPLY_TECHNICAL_FIX", reason: "Slot isolado pode receber somente correção técnica determinística.",
      reference, universe_reference: universeReference, semantic_class: semanticClass, composition_class: composition,
      technical_fixes: ["REMOVE_BACKGROUND", "TRIM_HALO"], technical_parameters: { mode: "simple_background" }, confidence: 0.45,
      provider_mode: "DETERMINISTIC_FALLBACK",
    };
    return { action: "RELINK_ITEM", reason: "Slot contextual não pode ser construído por correção técnica.", reference, semantic_class: semanticClass, composition_class: composition, queries: unusedQueries, alternatives_relink: linked?.alternatives || [], provider_mode: "DETERMINISTIC_FALLBACK" };
  }

  if (input.event === "ITEM_START" && matureLibrary && libraryCandidates.length) {
    const first = libraryCandidates[0];
    return {
      action: "USE_LIBRARY_ASSET", reason: "Biblioteca madura para o conceito; tentar variação aprovada antes da coleta externa.",
      selected_asset_id: clean(first.id), reference, universe_reference: universeReference, reference_type: linked?.type || null,
      semantic_class: semanticClass, composition_class: composition, confidence: 0.65, provider_mode: "DETERMINISTIC_FALLBACK",
    };
  }

  if (input.event === "SEARCH_EXHAUSTED" || input.event === "RELINK_REQUIRED") {
    const alternatives = linked?.alternatives || [];
    const nextReference = alternatives.find((candidate) => !(Array.isArray(input.strategy_state?.reference_history) ? input.strategy_state?.reference_history as string[] : []).includes(candidate)) || reference;
    const relinkQueries = queryPlan(nextReference, universeReference, composition).filter((query) => !history.includes(query));
    return {
      action: "RELINK_ITEM",
      reason: nextReference !== reference ? "A rota anterior esgotou; referência conhecida alternativa selecionada." : "A rota anterior esgotou; trocar consulta e reiniciar fontes sem repetir URLs/candidatas.",
      reference: nextReference,
      universe_reference: universeReference,
      reference_type: linked?.type || null,
      semantic_class: semanticClass,
      composition_class: composition,
      queries: relinkQueries.length ? relinkQueries : unusedQueries,
      negative_terms: ["watermark", "fanart", "cosplay", "manga panel", "text"],
      preferred_sources: preferredSources,
      preferred_hosts: telemetryPreferredHosts, avoid_hosts: telemetryBadHosts, max_rounds: 3,
      alternatives_relink: alternatives,
      confidence: linked ? 0.72 : 0.5,
      provider_mode: "DETERMINISTIC_FALLBACK",
    };
  }

  return {
    action: "START_EXTERNAL_SEARCH",
    reason: linked ? "Referência conhecida vinculada deterministicamente e plano de busca criado." : "Plano inicial criado a partir da classe semântica e da composição do slot.",
    reference, universe_reference: universeReference, reference_type: linked?.type || null,
    semantic_class: semanticClass,
    composition_class: composition,
    queries,
    negative_terms: ["watermark", "fanart", "cosplay", "manga panel", "text"],
    preferred_sources: preferredSources,
    preferred_hosts: telemetryPreferredHosts, avoid_hosts: telemetryBadHosts, max_rounds: 3,
    alternatives_relink: linked?.alternatives || [],
    confidence: linked ? 0.76 : 0.6,
    provider_mode: "DETERMINISTIC_FALLBACK",
  };
}

async function providerEnvironment() {
  const environment = { ...(env as unknown as Record<string, unknown>) };
  try {
    const saved = await getSupervisorConnection();
    if (saved) {
      const connection = saved.connection;
      environment.CLOUDFLARE_ACCOUNT_ID ||= connection.cloudflareAccountId;
      environment.CLOUDFLARE_AI_API_TOKEN ||= connection.cloudflareApiToken;
      environment.SUPERVISOR_CLOUDFLARE_MODEL ||= connection.cloudflareModel;
      environment.OPENAI_API_KEY ||= connection.openaiApiKey;
      environment.SUPERVISOR_OPENAI_MODEL ||= connection.openaiModel;
      environment.SUPERVISOR_IA_ENDPOINT ||= connection.externalEndpoint;
      environment.SUPERVISOR_IA_TOKEN ||= connection.externalToken;
      environment.SUPERVISOR_PREFERRED_PROVIDER = connection.provider;
    }
  } catch {
    // Variáveis de ambiente continuam disponíveis mesmo se a configuração persistida não puder ser lida.
  }
  return environment;
}

export async function supervisorProviderStatus() {
  const environment = await providerEnvironment();
  const aiBinding = environment.AI && typeof environment.AI === "object" && typeof (environment.AI as { run?: unknown }).run === "function";
  const cloudflareRest = Boolean(clean(environment.CLOUDFLARE_ACCOUNT_ID) && clean(environment.CLOUDFLARE_AI_API_TOKEN || environment.CLOUDFLARE_API_TOKEN));
  const openai = Boolean(clean(environment.OPENAI_API_KEY));
  const external = Boolean(clean(environment.SUPERVISOR_IA_ENDPOINT));
  return {
    configured: aiBinding || cloudflareRest || openai || external,
    providers: { cloudflare_ai_binding: aiBinding, cloudflare_ai_rest: cloudflareRest, openai_responses: openai, external_endpoint: external },
    preferred_order: [external && "EXTERNAL_AI", aiBinding && "CLOUDFLARE_AI_BINDING", cloudflareRest && "CLOUDFLARE_AI_REST", openai && "OPENAI_RESPONSES"].filter(Boolean),
    cloudflare_model: clean(environment.SUPERVISOR_CLOUDFLARE_MODEL) || "@cf/qwen/qwen3.8-27b",
    openai_model: clean(environment.SUPERVISOR_OPENAI_MODEL) || "gpt-5.6-sol",
  };
}

export async function supervisorConfigured() {
  return (await supervisorProviderStatus()).configured;
}

function isSupervisorOutput(value: unknown): value is SupervisorOutput {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.action === "string" && ACTIONS.has(row.action as SupervisorAction) && typeof row.reason === "string" && Boolean(clean(row.reason));
}

function sanitizeOutput(value: SupervisorOutput, mode: SupervisorProviderMode, model?: string | null): SupervisorOutput {
  const composition = value.composition_class === "ISOLATED" ? "ISOLATED" : value.composition_class === "CONTEXTUAL" ? "CONTEXTUAL" : undefined;
  const semantic = value.semantic_class && SEMANTIC_CLASSES.has(value.semantic_class) ? value.semantic_class : undefined;
  return {
    ...value,
    action: ACTIONS.has(value.action) ? value.action : "START_EXTERNAL_SEARCH",
    reason: clean(value.reason) || "Supervisor retornou decisão sem justificativa.",
    reference: clean(value.reference) || null,
    universe_reference: clean(value.universe_reference) || null,
    reference_type: clean(value.reference_type) || null,
    semantic_class: semantic,
    composition_class: composition,
    queries: strings(value.queries, 12),
    negative_terms: strings(value.negative_terms, 20),
    preferred_sources: strings(value.preferred_sources, 20),
    preferred_hosts: strings(value.preferred_hosts, 30).map((host) => host.toLowerCase()),
    avoid_hosts: strings(value.avoid_hosts, 50).map((host) => host.toLowerCase()),
    technical_fixes: strings(value.technical_fixes, 10).map((fix) => fix.toUpperCase()),
    alternatives_relink: strings(value.alternatives_relink, 10),
    max_rounds: Number.isFinite(Number(value.max_rounds)) ? Math.max(1, Math.min(20, Number(value.max_rounds))) : undefined,
    provider_mode: mode,
    provider_model: model || null,
  };
}

function jsonFromText(text: string) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  const attempts = [trimmed, trimmed.replace(/,\s*([}\]])/g, "$1")];
  for (const candidate of attempts) try { return JSON.parse(candidate) as unknown; } catch { /* continue */ }
  let depth = 0, start = -1, quoted = false, escaped = false;
  const candidates: string[] = [];
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') { quoted = true; continue; }
    if (character === "{") { if (depth === 0) start = index; depth += 1; }
    if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) candidates.push(trimmed.slice(start, index + 1));
    }
  }
  for (const candidate of candidates.reverse()) {
    for (const attempt of [candidate, candidate.replace(/,\s*([}\]])/g, "$1")]) try { return JSON.parse(attempt) as unknown; } catch { /* continue */ }
  }
  throw new Error("SUPERVISOR_AI_INVALID_JSON");
}

function extractText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (!payload || typeof payload !== "object") return "";
  const row = payload as Record<string, unknown>;
  if (typeof row.output_text === "string") return row.output_text;
  if (typeof row.response === "string") return row.response;
  if (typeof row.result === "string") return row.result;
  if (row.result && typeof row.result === "object") {
    const nested = extractText(row.result);
    if (nested) return nested;
  }
  if (Array.isArray(row.output)) {
    for (const item of row.output) {
      if (!item || typeof item !== "object") continue;
      const content = (item as Record<string, unknown>).content;
      if (Array.isArray(content)) for (const part of content) if (part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string") return (part as Record<string, unknown>).text as string;
    }
  }
  if (Array.isArray(row.choices)) {
    const first = row.choices[0];
    if (first && typeof first === "object") {
      const message = (first as Record<string, unknown>).message;
      if (message && typeof message === "object") {
        const content = (message as Record<string, unknown>).content;
        if (typeof content === "string") return content;
        if (Array.isArray(content)) for (const part of content) if (part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string") return (part as Record<string, unknown>).text as string;
        const reasoning = (message as Record<string, unknown>).reasoning_content;
        if (typeof reasoning === "string" && reasoning.includes("{")) return reasoning;
      }
    }
  }
  return "";
}

function supervisorOutputFromPayload(payload: unknown): SupervisorOutput {
  const queue: unknown[] = [payload];
  const visited = new Set<unknown>();
  while (queue.length) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    if (isSupervisorOutput(current)) return current;
    if (!current || typeof current !== "object") continue;
    const row = current as Record<string, unknown>;
    for (const key of ["result", "response", "output", "data"]) if (row[key] !== undefined) queue.push(row[key]);
  }
  const raw = extractText(payload);
  if (!raw) throw new Error("CLOUDFLARE_AI_EMPTY_OUTPUT");
  const parsed = jsonFromText(raw);
  if (!isSupervisorOutput(parsed)) throw new Error("CLOUDFLARE_AI_INVALID_OUTPUT");
  return parsed;
}

function supervisorPrompt(input: SupervisorInput) {
  const history = input.strategy_state || {};
  const telemetry = input.telemetry || {};
  const library = input.library_state || {};
  const candidates = input.candidates || [];
  return [
    "Você é SUPERVISOR_IA_BS9, o cérebro de decisão da Corvo Library.",
    "REGRA DE OURO: não gere imagem, não crie fundo, não combine cenas, não faça composição criativa. Encontre uma referência existente e mande a biblioteca executar.",
    "Quando o slot for CONTEXTUAL, personagem/objeto + ação + cenário devem existir juntos na fonte; não converta isolado em contextual.",
    "Correção técnica só pode ser pedida para ISOLATED e apenas para crop/resize/upscale/conversão/compressão/remoção de fundo simples/alpha/halo/fragmentos.",
    "Nunca aprove QA visual se não tiver certeza do conceito, referência, preset, qualidade e ausência de watermark/texto intrusivo.",
    "No QA visual também verifique cenário/background correto, transparência alpha real quando exigida, checkerboard falso, halo e fragmentos. Defeito apenas técnico em ISOLATED pode virar APPLY_TECHNICAL_FIX; erro de personagem/objeto/cena/background deve rejeitar ou relinkar.",
    "Não repita URL, candidata, query ou referência claramente falha. Fonte sem segredo deve ser pulada sem consumir tentativa.",
    "Se close_variations_count >= 5, tente a biblioteca primeiro e use selected_asset_id válido quando apropriado.",
    "Use telemetria de hosts para priorizar estáveis e evitar circuit breaker/hosts ruins.",
    "A saída deve ser SOMENTE um objeto JSON, sem markdown.",
    `Ações permitidas: ${[...ACTIONS].join(" | ")}`,
    "Campos úteis: action, reason, reference, universe_reference, reference_type, semantic_class, composition_class, queries, negative_terms, preferred_sources, preferred_hosts, avoid_hosts, selected_url, selected_asset_id, technical_fixes, technical_parameters, qa_labels, notes, confidence, alternatives_relink, max_rounds.",
    "Para READY_FOR_VISUAL_QA: use APPROVE_AND_FREEZE, REJECT_AND_NEXT_CANDIDATE, RELINK_ITEM ou APPLY_TECHNICAL_FIX. Para APPLY_TECHNICAL_FIX informe technical_fixes.",
    "Para ITEM_START: escolha referência conhecida reconhecível (personagem/objeto/local/veículo/arma) antes de pesquisar; não use o conceito genérico se uma referência conhecida comunicar melhor.",
    "CONTEXTO DO EVENTO:",
    JSON.stringify({ event: input.event, project: input.project, item: input.item, library_state: library, strategy_state: history, telemetry, candidates }).slice(0, 48_000),
  ].join("\n");
}

function multimodalUserContent(prompt: string, input: SupervisorInput) {
  const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
  if (input.image?.base64 && input.image.mime_type) content.push({ type: "image_url", image_url: { url: `data:${input.image.mime_type};base64,${input.image.base64}` } });
  return content;
}

function cloudflareSupportsJsonMode(model: string) {
  return new Set([
    "@cf/meta/llama-3.1-8b-instruct-fast",
    "@cf/meta/llama-3.1-70b-instruct",
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    "@cf/meta/llama-3-8b-instruct",
    "@cf/meta/llama-3.1-8b-instruct",
    "@cf/meta/llama-3.2-11b-vision-instruct",
    "@hf/nousresearch/hermes-2-pro-mistral-7b",
    "@hf/thebloke/deepseek-coder-6.7b-instruct-awq",
    "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
  ]).has(model.toLowerCase());
}

function cloudflareRequestBody(model: string, messages: Array<Record<string, unknown>>, maxCompletionTokens: number) {
  const body: Record<string, unknown> = {
    messages,
    max_completion_tokens: maxCompletionTokens,
    temperature: 0,
    stream: false,
  };
  // Workers AI returns HTTP 400 when response_format is sent to models that
  // are not in its JSON Mode allow-list (including Qwen 3.8). The prompt and
  // tolerant parser still enforce the contract for those models.
  if (cloudflareSupportsJsonMode(model)) body.response_format = { type: "json_object" };
  return body;
}

function cloudflareErrorDetail(value: string) {
  if (!value) return "SEM_DETALHE";
  try {
    const payload = JSON.parse(value) as Record<string, unknown>;
    const errors = Array.isArray(payload.errors) ? payload.errors : [];
    const first = errors[0] as Record<string, unknown> | undefined;
    const message = clean(first?.message) || clean(payload.message) || clean((payload.result as Record<string, unknown> | undefined)?.error);
    return (message || "RESPOSTA_INVALIDA").replace(/[^a-z0-9 ._:@/-]+/gi, " ").replace(/\s+/g, " ").trim().slice(0, 240);
  } catch {
    return value.replace(/[^a-z0-9 ._:@/-]+/gi, " ").replace(/\s+/g, " ").trim().slice(0, 240) || "RESPOSTA_INVALIDA";
  }
}

export async function acceptCloudflareLlamaLicense(accountId: string, apiToken: string, model = LLAMA_VISION_MODEL) {
  const account = clean(accountId);
  const token = clean(apiToken);
  if (!account || !token) throw new Error("CLOUDFLARE_AI_CREDENTIALS_REQUIRED");
  if (model !== LLAMA_VISION_MODEL) throw new Error("CLOUDFLARE_AI_MODEL_AGREEMENT_NOT_REQUIRED");
  const modelPath = model.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai/run/${modelPath}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ prompt: "agree" }),
    signal: AbortSignal.timeout(20_000),
  });
  const responseText = await response.text();
  if (!response.ok) throw new Error(`CLOUDFLARE_AI_LICENSE_HTTP_${response.status}:${cloudflareErrorDetail(responseText)}`);
  return { success: true as const, model, licenseAccepted: true as const };
}

async function callExternalEndpoint(input: SupervisorInput, environment: Record<string, unknown>) {
  const endpoint = clean(environment.SUPERVISOR_IA_ENDPOINT);
  if (!endpoint) return null;
  const headers = new Headers({ "content-type": "application/json", accept: "application/json" });
  const token = clean(environment.SUPERVISOR_IA_TOKEN);
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(input), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`SUPERVISOR_IA_HTTP_${response.status}`);
  const payload = await response.json();
  const output = (payload && typeof payload === "object" && "output" in payload) ? (payload as { output: unknown }).output : payload;
  if (!isSupervisorOutput(output)) throw new Error("SUPERVISOR_IA_INVALID_OUTPUT");
  return sanitizeOutput(output, "EXTERNAL_AI", "custom-endpoint");
}

async function callCloudflareBinding(input: SupervisorInput, environment: Record<string, unknown>) {
  const ai = environment.AI as { run?: (model: string, input: Record<string, unknown>) => Promise<unknown> } | undefined;
  if (!ai?.run) return null;
  const model = clean(environment.SUPERVISOR_CLOUDFLARE_MODEL) || "@cf/qwen/qwen3.8-27b";
  const prompt = supervisorPrompt(input);
  const messages: Array<Record<string, unknown>> = [{ role: "system", content: "Return only valid JSON for the requested Corvo Library supervisor contract." }];
  if (input.image?.base64) messages.push({ role: "user", content: multimodalUserContent(prompt, input) });
  else messages.push({ role: "user", content: prompt });
  const response = await ai.run(model, cloudflareRequestBody(model, messages, 1200));
  const parsed = supervisorOutputFromPayload(response);
  return sanitizeOutput(parsed, "CLOUDFLARE_AI_BINDING", model);
}

async function callCloudflareRest(input: SupervisorInput, environment: Record<string, unknown>) {
  const account = clean(environment.CLOUDFLARE_ACCOUNT_ID);
  const token = clean(environment.CLOUDFLARE_AI_API_TOKEN || environment.CLOUDFLARE_API_TOKEN);
  if (!account || !token) return null;
  const model = clean(environment.SUPERVISOR_CLOUDFLARE_MODEL) || "@cf/qwen/qwen3.8-27b";
  const prompt = supervisorPrompt(input).slice(0, input.image?.base64 ? 18_000 : 28_000);
  const messages: Array<Record<string, unknown>> = [{ role: "system", content: "Return only valid JSON for the requested Corvo Library supervisor contract." }];
  if (input.image?.base64) messages.push({ role: "user", content: multimodalUserContent(prompt, input) });
  else messages.push({ role: "user", content: prompt });
  const headers = new Headers({ authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" });
  const modelPath = model.split("/").map(encodeURIComponent).join("/");
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai/run/${modelPath}`;
  let lastError = "CLOUDFLARE_AI_UNKNOWN";
  let malformedOutput = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const attemptMessages = attempt === 0 ? messages : [
        { role: "system", content: "Return exactly one compact valid JSON object. No markdown, reasoning, preface or trailing text." },
        ...(malformedOutput
          ? [{ role: "user", content: `Repair this supervisor output without changing its decision:\n${malformedOutput.slice(0, 6000)}` }]
          : messages.filter((message) => message.role !== "system")),
      ];
      const response = await fetch(endpoint, {
        method: "POST", headers, signal: AbortSignal.timeout(attempt === 0 ? 28_000 : 18_000),
        body: JSON.stringify(cloudflareRequestBody(model, attemptMessages, attempt === 0 ? 1000 : 700)),
      });
      const responseText = await response.text();
      if (!response.ok) {
        lastError = `CLOUDFLARE_AI_HTTP_${response.status}:${cloudflareErrorDetail(responseText)}`;
        if (attempt === 0 && response.status === 403 && model === LLAMA_VISION_MODEL && /model agreement|agree/i.test(responseText)) {
          try {
            await acceptCloudflareLlamaLicense(account, token, model);
            lastError = "CLOUDFLARE_AI_MODEL_AGREEMENT_ACCEPTED_RETRYING";
            continue;
          } catch (error) {
            lastError = error instanceof Error ? error.message : "CLOUDFLARE_AI_MODEL_AGREEMENT_FAILED";
          }
        }
        // A second request is useful for transient failures and for a compact
        // repair prompt, but authentication/permission failures need no retry.
        if (response.status === 401 || response.status === 403) break;
        continue;
      }
      let parsedResponse: unknown;
      try { parsedResponse = JSON.parse(responseText); }
      catch { lastError = "CLOUDFLARE_AI_RESPONSE_NOT_JSON"; malformedOutput = responseText; continue; }
      const raw = extractText(parsedResponse);
      malformedOutput = raw;
      try {
        return sanitizeOutput(supervisorOutputFromPayload(parsedResponse), "CLOUDFLARE_AI_REST", model);
      } catch (error) {
        lastError = error instanceof Error ? error.message : "CLOUDFLARE_AI_INVALID_OUTPUT";
        continue;
      }
    } catch (error) {
      lastError = error instanceof Error && error.name === "TimeoutError" ? "CLOUDFLARE_AI_TIMEOUT" : error instanceof Error ? error.message : "CLOUDFLARE_AI_UNKNOWN";
    }
  }
  throw new Error(lastError);
}

async function callOpenAiResponses(input: SupervisorInput, environment: Record<string, unknown>) {
  const apiKey = clean(environment.OPENAI_API_KEY);
  if (!apiKey) return null;
  const model = clean(environment.SUPERVISOR_OPENAI_MODEL) || "gpt-5.6-sol";
  const prompt = supervisorPrompt(input);
  const userContent: Array<Record<string, unknown>> = [{ type: "input_text", text: prompt }];
  if (input.image?.base64 && input.image.mime_type) userContent.push({ type: "input_image", image_url: `data:${input.image.mime_type};base64,${input.image.base64}`, detail: "auto" });
  const body = {
    model,
    input: [
      { role: "developer", content: [{ type: "input_text", text: "Return only valid JSON for the Corvo Library supervisor contract. Never claim to have inspected an image unless an image input is present." }] },
      { role: "user", content: userContent },
    ],
    max_output_tokens: 1800,
    text: { format: { type: "json_object" } },
    store: false,
  };
  const response = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(45_000) });
  if (!response.ok) throw new Error(`OPENAI_RESPONSES_HTTP_${response.status}`);
  const payload = await response.json();
  const parsed = jsonFromText(extractText(payload));
  if (!isSupervisorOutput(parsed)) throw new Error("OPENAI_RESPONSES_INVALID_OUTPUT");
  return sanitizeOutput(parsed, "OPENAI_RESPONSES", model);
}

export async function runSupervisor(input: SupervisorInput): Promise<SupervisorOutput> {
  const environment = await providerEnvironment();
  const failures: string[] = [];
  const providers = [
    ["external", () => callExternalEndpoint(input, environment)],
    ["binding", () => callCloudflareBinding(input, environment)],
    ["cloudflare-rest", () => callCloudflareRest(input, environment)],
    ["openai", () => callOpenAiResponses(input, environment)],
  ] as const;
  const preferred = clean(environment.SUPERVISOR_PREFERRED_PROVIDER);
  const ordered = preferred === "cloudflare"
    ? [providers[1], providers[2], providers[0], providers[3]]
    : preferred === "openai" ? [providers[3], providers[0], providers[1], providers[2]]
      : preferred === "external" ? [providers[0], providers[1], providers[2], providers[3]] : providers;
  for (const [name, task] of ordered) {
    try {
      const output = await task();
      if (output) return output;
    } catch (error) {
      failures.push(`${name}:${error instanceof Error ? error.message : "UNKNOWN"}`);
    }
  }
  const fallback = deterministicSupervisor(input);
  return {
    ...fallback,
    reason: failures.length ? `SUPERVISOR_PROVIDER_FAILURE(${failures.join(";")}). ${fallback.reason}` : fallback.reason,
    notes: [fallback.notes, failures.length ? "Falhas de IA foram isoladas; o fallback não aprovou QA visual sem modelo multimodal." : "Nenhum provedor de IA configurado."].filter(Boolean).join(" "),
    provider_mode: "DETERMINISTIC_FALLBACK",
  };
}
