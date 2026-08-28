"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isImageMedia, resolveMediaMime } from "../lib/media-mime";

type Asset = {
  id: string; name: string; universe: string; kind: string;
  status: string;
  uses: number; lastUse: string; image?: string; tags: string[];
  format: string; ratio: string; fileName: string; mimeType: string; transparent?: boolean;
};

type RequestRow = { id: string; project: string; itemCount: number; status: string; createdAt: string | number | Date };
type CatalogStats = { totalAssets:number; catalogAssets:number; universes:number; pending:number; rejected:number; reused:number; totalUses:number };

type McpInfo = { code: string; mcp_url: string; plugin_name: string; description: string; transport: string; auth: string };
type CloudflareInfo = { configured: boolean; accountId: string; bucket: string; accessKeyId: string; endpoint: string; hasSecret: boolean; d1Configured: boolean; d1DatabaseId: string; d1DatabaseName: string; hasD1Token: boolean; needsReconfigure?: boolean; encryptionBootstrap?: string; updatedAt: string | null; bindingActive?: boolean; configReference?: string; inheritedProfile?: boolean };
type CloudflareForm = { accountId: string; bucket: string; accessKeyId: string; secretAccessKey: string; endpoint: string; d1ApiToken: string; d1DatabaseId: string; d1DatabaseName: string };
type D1MigrationInfo = { ready:boolean; sourceDatabaseId:string; sourceDatabaseName:string; sourceCounts:Record<string,number>; targetCounts:Record<string,number>; targetHasApplicationData:boolean; targetTables:string[]; rollbackAvailable?:boolean; backupKey?:string; lastMigrationAt?:string; error?:string };
type D1MigrationResult = { ok:boolean; sourceDatabaseId:string; sourceDatabaseName:string; sourceCounts:Record<string,number>; targetCounts:Record<string,number>; tablesCompared:number; settingsSourceCount:number; settingsTargetCount:number; dumpBytes:number; migratedAt:string; backupKey?:string; backupBytes?:number; error?:string };
type AuthStatus = { loading:boolean; configured:boolean; authenticated:boolean; username:string };
type SupervisorInfo = { enabled: boolean; supervisor: string; operationalControl: string; externalVisualQa: string; persistentConfiguration: string; autonomousCollection: string; cloudAiRequired: boolean; defaultProfileId?: string | null; collectionTimeoutMs: number; parallelism: number };
type SupervisorForm = { enabled: boolean };
type CollectionBatch = { id: string; name: string; status: string; totalTerms: number; totalTarget: number; totalCollected: number; createdAt: string | number | Date; updatedAt: string | number | Date };
type CollectionActivity = { id:string; status:string; detail:string; foundCount:number; uniqueCount:number; materializedCount:number; failureCount:number; durationMs:number; createdAt:string|number|Date; term:string; source:string };
type CollectionTerm = { id:string; term:string; kind:string; targetQuantity:number; collectedCount:number; status:string; attempts:number; rounds:number; failureReason?:string|null };
type CollectionDetail = { lote:CollectionBatch; termos:CollectionTerm[]; termos_total:number; contagem_status:Record<string,number>; termo_atual:CollectionTerm|null; fonte_atual:{name:string;method:string}|null; atividade:CollectionActivity[]; heartbeat_utc:string; progresso_percentual:number; importacao_txt?:{termos_aceitos:number;linhas_ignoradas:number} };
type StockGroup = { key:string; concept:string; universe:string; kind:string; approved:number; rejected:number; uses:number; consultations:number; selected:number; materializing:number; qa:number; minimum:number; ideal:number; maximum:number; maturity:string; status:string; action:string; reuseRate:number; selectionRate:number; daysWithoutUse:number|null };
type HostScore = { host:string; score:number; classification:string; circuitState:string; technicalRate:number; visualRate:number; avgLatencyMs:number; p95LatencyMs:number; successes:number; failures:number; approved:number; rejected:number; bytes:number };
type InventoryDashboard = { generatedAt:string; totals:{approvedAssets:number;groups:number;belowMinimum:number;mature:number;saturated:number;neverUsed:number;reuseRate:number;materializing:number;qa:number}; groups:StockGroup[]; hosts:HostScore[]; pipeline:{statusCounts:Record<string,number>;avgDownloadMs:number;p95DownloadMs:number;avgQaWaitMs:number;p95QaWaitMs:number;batches:Array<{id:string;project:string;status:string;totalItems:number}>}; orchestration:{globalConcurrency:number;perHostConcurrency:number;fetchTimeoutMs:number;candidatesPerItem:number} };
type AutomaticProject = { id:string;name:string;status:string;projectDomain?:string;queuePriority?:number;pipelineStatus?:string|null;nextAction?:string|null;supervisorExecutionId?:string|null;supervisorStatus?:string|null;supervisorLeaseStartedAt?:string|number|Date|null;supervisorLastSeenAt?:string|number|Date|null;supervisorLeaseExpiresAt?:string|number|Date|null;previousExecutionId?:string|null;abandonedAt?:string|number|Date|null;resumeReason?:string|null;resumedAt?:string|number|Date|null;automatic:boolean;libraryFirst:boolean;externalSearch:boolean;automaticZip:boolean;deleteZipOnComplete:boolean;activeVersion:number;zipR2Key?:string|null;zipFileName?:string|null;zipSizeBytes?:number|null;productionRevision?:number;productionZipRevision?:number;productionZipR2Key?:string|null;productionZipFileName?:string|null;productionZipSizeBytes?:number|null;createdAt:string|number|Date;updatedAt:string|number|Date;groupCount?:number;executionIds?:string[];versions?:number[];errorCount?:number;hasErrors?:boolean;recent24h?:boolean };
type AutomaticProjectFile = { id:string;role:string;version:number;fileName:string;sizeBytes:number;createdAt:string|number|Date };
type AutomaticProjectItem = { id:string;itemKey:string;term:string;context?:string|null;kind:string;universe?:string|null;status:string;sourceType?:string|null;linkedAssetId?:string|null;failureReason?:string|null;attempts:number };
type ProjectThumbCandidate = { id:string;projectId:string;name:string;variant?:string|null;agentOrigin?:string|null;note?:string|null;status:string;selected:boolean;sourceType:string;sourceUrl?:string|null;mimeType:string;sizeBytes:number;createdAt:string|number|Date;download_path:string };
type ProjectTitleCandidate = { id:string;projectId:string;text:string;variant?:string|null;agentOrigin?:string|null;note?:string|null;score?:number|null;status:string;selected:boolean;createdAt:string|number|Date };
type ProductionPackage = { project_id:string;production_revision:number;production_zip_revision:number;production_zip_current:boolean;production_zip?:{file_name?:string|null;size_bytes?:number|null;download_path:string}|null;thumbs:ProjectThumbCandidate[];titles:ProjectTitleCandidate[];selected_thumb?:ProjectThumbCandidate|null;selected_title?:ProjectTitleCandidate|null;contributing_agents:string[];metrics:{images_resolved:number;thumbs_total:number;thumbs_candidates:number;thumbs_approved:number;thumbs_rejected:number;titles_total:number;titles_candidates:number;titles_approved:number;titles_rejected:number} };
type AutomaticProjectDetail = { projeto:AutomaticProject;arquivos:AutomaticProjectFile[];itens:AutomaticProjectItem[];eventos:Array<{id:string;event:string;status?:string|null;detail?:string|null;createdAt:string|number|Date}>;producao:ProductionPackage;contagem_status:Record<string,number>;metricas:{total:number;resolvidos:number;biblioteca:number;externos:number;qa:number;relink:number;falhas:number;progresso_percentual:number;tempo_total_ms:number;throughput_por_minuto:number} };
type OperationalDashboard = { generated_at:string; totals:{workers_active:number;queue_ready:number;queue_leased:number;queue_waiting_dependency:number;projects_in_progress:number;projects_ready_resume:number;projects_completed:number;throughput_last_hour:number;plans_active?:number;plan_branches_active?:number;plan_branches_waiting_supervisor?:number}; workers_active_by_type:Record<string,number>;workers_active_by_domain:Record<string,number>;queues_by_stage:Record<string,number>;queues_by_domain:Record<string,number>;bottlenecks:Array<{stage:string;count:number;active:number}>;utilization:Array<{worker_type:string;domain:string;active:number;max:number;utilization_pct:number}>;workers:Array<{worker_id:string;worker_type:string;worker_domain:string;execution_id:string;project_id?:string|null;project_name?:string|null;stage?:string|null;work_item_id?:string|null;item_id?:string|null;last_action?:string|null;last_heartbeat:string|number|Date;time_in_stage_ms:number;lease_remaining_ms:number;status:string}>;projects:Array<{project_id:string;name:string;domain:string;status:string;next_action?:string|null;last_action?:string|null;workers_active:number;workers_by_stage:Record<string,number>;queue_by_stage:Record<string,number>;progress:{completed:number;total:number};total_time_ms:number;last_activity:string|number|Date}>;domains:Array<{domain:string;active_projects:number;active_workers:number;queue:Record<string,number>}>; plans?:Array<{plan_id:string;project_id:string;intent:string;status:string;max_parallelism:number;branches_active:number;branches_by_status:Record<string,number>;accepted_at:string|number|Date;updated_at:string|number|Date}> };
type ManagementDashboard = { generated_at:string;period_days:number;totals:{projects_created:number;projects_completed:number;projects_in_progress:number;work_completed:number;relinks:number;lease_abandons:number;resumes:number};stage_metrics:Array<{stage:string;count:number;avg_ms:number;p50_ms:number;p95_ms:number;p99_ms:number;min_ms:number;max_ms:number;avg_queue_wait_ms:number}>;domains:Array<{domain:string;projects_created:number;projects_completed:number;work_completed:number;relinks:number;abandons:number}>;workers:Array<{worker_id:string;completed:number;failures:number;abandons:number;avg_duration_ms:number}>;throughput_by_day:Array<{day:string;completed:number;failed:number}> };
type PolicyGapRow = { id:string;signature:string;category:string;severity:string;occurrenceCount:number;status:string;projectId?:string|null;universe?:string|null;source?:string|null;symptom:string;resolutionPolicyId?:string|null;lastSeenAt:string|number|Date };
type OperationalPolicyRow = { id:string;policyKey:string;name:string;category:string;status:string;scopeLevel:string;domain?:string|null;universe?:string|null;priority:number;confidence:number;version:number;timesApplied:number;successCount:number;failureCount:number;updatedAt:string|number|Date };
type PolicyWorkspaceDashboard = { generated_at:string;learning_enabled:boolean;core_rules:string[];gaps:PolicyGapRow[];policies:OperationalPolicyRow[];telemetry:{policies_total:number;policies_active:number;gaps_total:number;gaps_open:number;repeated_gap_rate:number;policy_hit_rate:number;time_saved_ms:number;requests_saved:number;external_requests_saved:number;rollback_count:number} };
type FastPushCandidate = { id:string;operationId:string;batchId?:string|null;projectId?:string|null;itemId?:string|null;projectItemId?:string|null;projectLinkStatus?:string|null;materializationBatchId?:string|null;materializationItemId?:string|null;materializationFileId?:string|null;supervisorCandidateId?:string|null;linkedAt?:string|number|Date|null;slot?:string|null;targetName?:string|null;sourceUrl:string;sourceType:string;universe?:string|null;subject?:string|null;concept?:string|null;visualReference?:string|null;scriptReference?:string|null;scene?:string|null;arc?:string|null;episodeCandidate?:string|null;compositionClass?:string|null;tags:string[];usedFor?:string|null;priority:number;status:string;failureReason?:string|null;sha256?:string|null;r2Key?:string|null;mimeType?:string|null;sizeBytes?:number|null;assetId?:string|null;duplicateOfCandidateId?:string|null;decisionSource?:string|null;decisionNote?:string|null;createdAt:string|number|Date;updatedAt:string|number|Date };
type FastPushTotals = { total:number;pending:number;approved:number;rejected:number;failed:number };

const manifestTemplate = `PROJETO_ORIGEM:
PREENCHA_O_NOME_DO_PROJETO

UNIVERSO_PADRAO:
PREENCHA_O_UNIVERSO

DATA:
AAAA-MM-DD

MODO_IMPORTACAO:
NOVOS_ASSETS

REGISTRAR_USO_INICIAL:
SIM

GERAR_NOME_SEMANTICO:
COMPLEMENTAR

MANTER_NOME_ORIGINAL:
SIM

OBSERVACAO_GERAL:

FORMATOS_COMPATIVEIS:
PNG, JPG, JPEG, WEBP, AVIF, SVG, GIF, MP4, WEBM, MOV, M4V

TIPOS_RECOMENDADOS:
Imagem, GIF, Video, Fundo animado, Overlay animado, Efeito, Transicao, Clipe


[NOME_EXATO_DO_ARQUIVO.ext]

NOME_SEMANTICO:

UNIVERSO:

PERSONAGEM:

OBJETO:

LOCAL:

TIPO:

TAGS:

FUNCAO_VISUAL:

MOVIMENTO:

LOOP:

AUDIO:

DURACAO_SEGUNDOS:

ORIENTACAO:

RESOLUCAO:

FPS:

FUNDO:

TRANSPARENCIA:

PROJETO_ORIGEM:

BLOCO:

PRESET:

SLOT:

USADO_PARA:

REFERENCIA_ROTEIRO:

REFERENCIA_VISUAL:

FONTE:

URL_ORIGINAL:

STATUS_QA:
NAO_AVALIADO

OBSERVACAO:


INSTRUCOES:
1. Duplique a seção [NOME_EXATO_DO_ARQUIVO.ext] para cada mídia.
2. Use exatamente o mesmo nome do arquivo que está no ZIP.
3. Em TIPO, use Imagem, GIF, Video, Fundo animado, Overlay animado, Efeito, Transicao ou Clipe. Se ficar vazio, a biblioteca detecta Imagem, GIF ou Video pela extensão.
4. Para GIF e vídeo, descreva quando souber: FUNCAO_VISUAL, MOVIMENTO, LOOP, AUDIO, DURACAO_SEGUNDOS, ORIENTACAO, RESOLUCAO, FPS, FUNDO e TRANSPARENCIA.
5. Exemplos: LOOP: SIM | AUDIO: SEM_AUDIO | ORIENTACAO: 9:16 | RESOLUCAO: 1080x1920 | FUNDO: CHROMA_KEY_VERDE.
6. GIF, MP4, WEBM, MOV e M4V recebem a mesma semântica de personagem, universo, tags, roteiro, preset, slot e uso das imagens.
7. Remova campos desconhecidos; não invente informações.
8. Cada mídia dentro do ZIP pode ter até 150 MB; o conteúdo descompactado total pode ter até 1 GB.
9. Salve este arquivo com o nome IMPORTACAO.txt e coloque-o dentro do ZIP, junto com as mídias.
`;

const projectRequirementsTemplate = `# BIBLIOTECA SEMANTICA — TXT DE IMAGENS NECESSARIAS
#
# NOME RECOMENDADO: IMAGENS_NECESSARIAS.txt
# ANEXAR NO PROJETO COMO: REQUIREMENTS / IMAGENS NECESSARIAS
# CODIFICACAO: UTF-8
# UMA IMAGEM OU MIDIA NECESSARIA POR LINHA
#
# FORMATO OBRIGATORIO DAS COLUNAS:
ID | TERMO | TIPO | UNIVERSO | CONTEXTO | OBSERVACAO
#
# ID: identificador unico e estavel do item no roteiro.
# TERMO: o que deve ser procurado visualmente.
# TIPO: PERSONAGEM, CENARIO, OBJETO, TRANSPARENTE, GIF ou VIDEO.
# UNIVERSO: anime, jogo, filme, serie ou tema; pode ficar vazio.
# CONTEXTO: cena ou uso no roteiro; pode ficar vazio.
# OBSERVACAO: restricoes visuais; pode ficar vazio.
#
# REGRAS PARA A IA:
# - manter exatamente uma necessidade visual por linha;
# - nao transformar instrucoes, titulos ou regras em itens;
# - nao repetir o mesmo ID;
# - nao incluir URLs; a Biblioteca faz a busca automaticamente;
# - salvar o roteiro separadamente como SCRIPT;
# - anexar este arquivo preenchido como REQUIREMENTS;
# - o par SCRIPT + REQUIREMENTS inicia a esteira automatica.

ID | TERMO | TIPO | UNIVERSO | CONTEXTO | OBSERVACAO
`;

const navItems = ["Catálogo", "Projetos", "Solicitações", "Lotes", "Importações", "Coleta automática", "Operação", "Políticas", "Estoque & giro", "Inbox candidatas", "Pendentes", "Rejeitados", "Configurações"];

function Mark({ className = "" }: { className?: string }) {
  return <div className={`brand-mark ${className}`}><span className="beak" /></div>;
}

function SearchIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>;
}

export default function Home() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [catalogStats, setCatalogStats] = useState<CatalogStats>({ totalAssets:0, catalogAssets:0, universes:0, pending:0, rejected:0, reused:0, totalUses:0 });
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [dataLoading, setDataLoading] = useState(true);
  const [active, setActive] = useState("Catálogo");
  const [query, setQuery] = useState("");
  const [universe, setUniverse] = useState("Todos os universos");
  const [kind, setKind] = useState("Todos os tipos");
  const [usage, setUsage] = useState("Todos os usos");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [selected, setSelected] = useState<string[]>([]);
  const [detail, setDetail] = useState<Asset | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [connected, setConnected] = useState(false);
  const [cloudflareInfo, setCloudflareInfo] = useState<CloudflareInfo | null>(null);
  const [cloudflareSaving, setCloudflareSaving] = useState(false);
  const [supervisorOpen, setSupervisorOpen] = useState(false);
  const [supervisorInfo, setSupervisorInfo] = useState<SupervisorInfo | null>(null);
  const [supervisorSaving, setSupervisorSaving] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [mcpInfo, setMcpInfo] = useState<McpInfo | null>(null);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpError, setMcpError] = useState("");
  const [toast, setToast] = useState("");
  const [authStatus, setAuthStatus] = useState<AuthStatus>({ loading:true, configured:false, authenticated:false, username:"" });
  const [bulkProject, setBulkProject] = useState("");
  const [bulkText, setBulkText] = useState("");
  const importRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/auth/status", { cache:"no-store" })
      .then(async (response) => response.ok ? response.json() : { configured:false, authenticated:false, username:"" })
      .then((value) => setAuthStatus({ loading:false, configured:Boolean(value.configured), authenticated:Boolean(value.authenticated), username:String(value.username || "") }))
      .catch(() => setAuthStatus({ loading:false, configured:false, authenticated:false, username:"" }));
  }, []);

  useEffect(() => {
    if (!authStatus.authenticated) return;
    Promise.all([
      fetch("/api/assets", { cache: "no-store" }).then((r) => r.ok ? r.json() : { assets: [] }),
      fetch("/api/requests", { cache: "no-store" }).then((r) => r.ok ? r.json() : { requests: [] }),
    ]).then(([assetData, requestData]) => {
      setAssets((assetData.assets ?? []).map((row: Record<string, unknown>) => {
        const id = String(row.id), fileName = String(row.originalName ?? id), mimeType = resolveMediaMime(String(row.mimeType ?? "application/octet-stream"), fileName, String(row.r2Key ?? ""));
        return {
          id, name: String(row.name), universe: String(row.universe), kind: String(row.kind),
          status: String(row.status), uses: Number(row.useCount ?? 0),
          lastUse: row.lastUsedAt ? new Date(String(row.lastUsedAt)).toLocaleDateString("pt-BR") : "Nunca usado",
          tags: Array.isArray(row.tags) ? row.tags as string[] : JSON.parse(String(row.tags ?? "[]")),
          format: mimeType.split("/").pop()?.toUpperCase() ?? "ARQUIVO", ratio: "—",
          fileName, mimeType,
          image: (isImageMedia(mimeType, fileName, String(row.r2Key ?? "")) || /^(imagem|gif)$/i.test(String(row.kind ?? ""))) ? `/api/files/${encodeURIComponent(id)}?preview=1` : undefined,
        };
      }));
      if (assetData.stats) setCatalogStats(assetData.stats as CatalogStats);
      setRequests(requestData.requests ?? []);
    }).catch(() => undefined).finally(() => setDataLoading(false));
    fetch("/api/cloudflare-connection", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((value: CloudflareInfo | null) => { if (value) { setCloudflareInfo(value); setConnected(value.configured); } })
      .catch(() => undefined);
    fetch("/api/supervisor-connection", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((value: SupervisorInfo | null) => { if (value) setSupervisorInfo(value); })
      .catch(() => undefined);
    fetch("/api/mcp-connection", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((value: McpInfo | null) => { if (value) setMcpInfo(value); })
      .catch(() => undefined);
  }, [authStatus.authenticated]);

  const universes = useMemo(() => ["Todos os universos", ...Array.from(new Set(assets.map((a) => a.universe)))], [assets]);
  const filtered = useMemo(() => assets.filter((asset) => {
    const haystack = `${asset.id} ${asset.name} ${asset.universe} ${asset.tags.join(" ")}`.toLowerCase();
    const matchesQuery = haystack.includes(query.toLowerCase());
    const matchesUniverse = universe === "Todos os universos" || asset.universe === universe;
    const matchesKind = kind === "Todos os tipos" || asset.kind === kind;
    const matchesUsage = usage === "Todos os usos" || (usage === "Nunca usados" ? asset.uses === 0 : asset.uses > 0);
    const matchesSection = active === "Pendentes" ? asset.status.startsWith("Pendente") : active === "Rejeitados" ? asset.status === "Rejeitado" : asset.status === "Aprovado";
    return matchesQuery && matchesUniverse && matchesKind && matchesUsage && matchesSection;
  }), [assets, query, universe, kind, usage, active]);

  useEffect(() => { setSelected([]); }, [active]);

  function toggleSelected(id: string) {
    setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  function flash(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }

  async function createRequest() {
    try {
      const response = await fetch("/api/requests", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: bulkProject, items: bulkText }) });
      if (!response.ok) throw new Error();
      const payload = await response.json() as { request: RequestRow };
      setRequests((current) => [payload.request, ...current]);
      setBulkOpen(false);
      flash("Solicitação salva e enviada para validação");
    } catch {
      flash("Não foi possível salvar agora. Tente novamente.");
    }
  }

  async function uploadZip(file?: File) {
    if (!file) return;
    flash("Enviando ZIP para a fila de importação...");
    const form = new FormData();
    form.append("file", file);
    try {
      const response = await fetch("/api/import", { method: "POST", body: form });
      if (!response.ok) throw new Error();
      flash("ZIP processado: manifesto lido, mídias catalogadas e usos registrados.");
    } catch {
      flash("Não foi possível importar este ZIP.");
    }
  }

  async function connectStorage(values: CloudflareForm) {
    setCloudflareSaving(true);
    try {
      const response = await fetch("/api/cloudflare-connection", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(values) });
      const payload = await response.json().catch(() => null) as (CloudflareInfo & { error?: string }) | null;
      if (!response.ok || !payload) throw new Error(payload?.error || "Falha ao validar Cloudflare");
      setCloudflareInfo(payload); setConnected(payload.configured); setConnectOpen(false); flash("Cloudflare cravado no banco remoto para qualquer PC");
    } catch (error) {
      flash(error instanceof Error ? error.message : "Não foi possível salvar a configuração Cloudflare.");
    } finally { setCloudflareSaving(false); }
  }

  async function connectSupervisor(values: SupervisorForm) {
    setSupervisorSaving(true);
    try {
      const response = await fetch("/api/supervisor-connection", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(values) });
      const payload = await response.json().catch(() => null) as (SupervisorInfo & { error?: string }) | null;
      if (!response.ok || !payload) throw new Error(payload?.error || "Falha ao salvar");
      setSupervisorInfo(payload); setSupervisorOpen(false); flash(payload.enabled ? "Supervisor ChatGPT via MCP ativado" : "Supervisor desativado; coleta determinística continua ativa");
    } catch (error) {
      flash(error instanceof Error ? error.message : "Não foi possível salvar o Supervisor IA.");
    } finally { setSupervisorSaving(false); }
  }

  async function openMcpConnection() {
    setMcpOpen(true); setMcpLoading(true); setMcpError("");
    try {
      const response = await fetch("/api/mcp-connection", { cache: "no-store" });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error || `Falha HTTP ${response.status}`);
      }
      setMcpInfo(await response.json() as McpInfo);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Falha inesperada";
      setMcpError(message);
      flash("Não foi possível carregar a conexão MCP.");
    }
    finally { setMcpLoading(false); }
  }

  async function rotateMcpConnection() {
    if (!window.confirm("O link atual deixará de funcionar. Gerar um novo código?")) return;
    setMcpLoading(true);
    try {
      const response = await fetch("/api/mcp-connection", { method: "POST" });
      if (!response.ok) throw new Error();
      setMcpInfo(await response.json() as McpInfo); flash("Novo MCP ativo. O link anterior foi revogado imediatamente.");
    } catch { flash("Não foi possível renovar o código MCP."); }
    finally { setMcpLoading(false); }
  }

  async function copyText(value: string, label: string) {
    await navigator.clipboard.writeText(value); flash(`${label} copiado`);
  }

  function downloadManifestTemplate() {
    const blob = new Blob([manifestTemplate], { type: "text/plain;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = "IMPORTACAO.txt";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(href);
    flash("IMPORTACAO.txt salvo com campos para imagens, GIFs e vídeos.");
  }

  function downloadAsset(asset: Asset, announce = true) {
    const anchor = document.createElement("a");
    anchor.href = `/api/files/${encodeURIComponent(asset.id)}`;
    anchor.download = asset.fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    if (announce) flash(`Baixando ${asset.fileName}`);
  }

  function downloadSelected() {
    const chosen = selected.flatMap((id) => assets.find((asset) => asset.id === id) ?? []);
    chosen.forEach((asset, index) => window.setTimeout(() => downloadAsset(asset, false), index * 180));
    if (chosen.length) flash(chosen.length === 1 ? `Baixando ${chosen[0].fileName}` : `Iniciando ${chosen.length} downloads`);
  }

  async function refreshAssets() {
    const response = await fetch("/api/assets?limit=1000", { cache: "no-store" });
    if (!response.ok) throw new Error("Falha ao atualizar a Biblioteca.");
    const payload = await response.json() as { assets?:Record<string,unknown>[]; stats?:CatalogStats };
    setAssets((payload.assets ?? []).map((row) => {
      const id = String(row.id), fileName = String(row.originalName ?? id), mimeType = resolveMediaMime(String(row.mimeType ?? "application/octet-stream"), fileName, String(row.r2Key ?? ""));
      return { id, name:String(row.name), universe:String(row.universe), kind:String(row.kind), status:String(row.status), uses:Number(row.useCount ?? 0), lastUse:row.lastUsedAt ? new Date(String(row.lastUsedAt)).toLocaleDateString("pt-BR") : "Nunca usado", tags:Array.isArray(row.tags) ? row.tags as string[] : JSON.parse(String(row.tags ?? "[]")), format:mimeType.split("/").pop()?.toUpperCase() ?? "ARQUIVO", ratio:"—", fileName, mimeType, image:(isImageMedia(mimeType, fileName, String(row.r2Key ?? "")) || /^(imagem|gif)$/i.test(String(row.kind ?? ""))) ? `/api/files/${encodeURIComponent(id)}?preview=1` : undefined };
    }));
    if (payload.stats) setCatalogStats(payload.stats);
  }

  async function approveSelectedPending() {
    const ids = selected.filter((id) => assets.find((asset) => asset.id === id)?.status.startsWith("Pendente"));
    if (!ids.length) return;
    try {
      const response = await fetch("/api/assets", { method:"PATCH", headers:{"content-type":"application/json"}, body:JSON.stringify({ action:"approve_pending", asset_ids:ids }) });
      const payload = await response.json() as { approved?:number; error?:string; stats?:CatalogStats };
      if (!response.ok) throw new Error(payload.error || "Falha ao aprovar.");
      if (payload.stats) setCatalogStats(payload.stats);
      setSelected([]); setDetail(null); await refreshAssets();
      flash(`${payload.approved ?? ids.length} asset(s) aprovado(s) e movido(s) para o Catálogo.`);
    } catch (error) { flash(error instanceof Error ? error.message : "Não foi possível aprovar os pendentes."); }
  }

  async function deleteSelectedPending() {
    const ids = selected.filter((id) => assets.find((asset) => asset.id === id)?.status.startsWith("Pendente"));
    if (!ids.length) return;
    if (!window.confirm(`Excluir permanentemente ${ids.length} asset(s) pendente(s)? Esta ação remove o registro, os vínculos e o arquivo físico do R2 e não pode ser desfeita.`)) return;
    try {
      const response = await fetch("/api/assets", { method:"DELETE", headers:{"content-type":"application/json"}, body:JSON.stringify({ asset_ids:ids, confirmar:true }) });
      const payload = await response.json() as { deleted?:number; error?:string; stats?:CatalogStats; r2_cleanup_failures?:string[] };
      if (!response.ok) throw new Error(payload.error || "Falha ao excluir.");
      if (payload.stats) setCatalogStats(payload.stats);
      setSelected([]); setDetail(null); await refreshAssets();
      const r2Failures = payload.r2_cleanup_failures?.length ?? 0;
      flash(r2Failures
        ? `${payload.deleted ?? ids.length} asset(s) removido(s) do Catálogo; ${r2Failures} arquivo(s) R2 ficaram pendentes de limpeza.`
        : `${payload.deleted ?? ids.length} asset(s) removido(s) definitivamente da Biblioteca.`);
    } catch (error) { flash(error instanceof Error ? error.message : "Não foi possível excluir os pendentes."); }
  }

  async function completeAuth(endpoint: "/api/auth/setup" | "/api/auth/login", values: { username:string; password:string; remember:boolean }) {
    const response = await fetch(endpoint, { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(values) });
    const payload = await response.json().catch(() => null) as { username?:string; error?:string } | null;
    if (!response.ok) throw new Error(payload?.error === "INVALID_LOGIN" ? "Nome ou senha incorretos." : payload?.error || "Não foi possível entrar.");
    setAuthStatus({ loading:false, configured:true, authenticated:true, username:String(payload?.username || values.username) });
    window.location.reload();
  }

  async function logout() {
    await fetch("/api/auth/logout", { method:"POST" }).catch(() => undefined);
    window.location.reload();
  }

  const bulkRows = bulkText.split("\n").filter(Boolean);

  if (authStatus.loading) return <AuthLoading />;
  if (!authStatus.authenticated) return <AuthScreen configured={authStatus.configured} suggestedUsername={authStatus.username} onSubmit={completeAuth} />;

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><Mark /><div><strong>CORVO</strong><span>LIBRARY</span></div></div>
        <nav aria-label="Navegação principal">
          <p className="nav-label">ESPAÇO DE TRABALHO</p>
          {navItems.slice(0, 7).map((item, index) => (
            <button key={item} className={active === item ? "active" : ""} onClick={() => setActive(item)}>
              <span className="nav-glyph">{["◫", "◆", "✦", "▣", "⇧", "◉", "⌁"][index]}</span>{item}
              {item === "Solicitações" && requests.length > 0 && <em>{requests.length}</em>}
            </button>
          ))}
          <p className="nav-label">ORGANIZAÇÃO</p>
          {navItems.slice(7).map((item, index) => (
            <button key={item} className={active === item ? "active" : ""} onClick={() => setActive(item)}>
              <span className="nav-glyph">{["⚑", "◈", "▤", "◷", "⊘", "⚙"][index]}</span>{item}
              {item === "Pendentes" && catalogStats.pending > 0 && <em>{catalogStats.pending}</em>}
            </button>
          ))}
          <button className={`mobile-settings-nav ${active === "Configurações" ? "active" : ""}`} onClick={() => setActive("Configurações")}>
            <span className="nav-glyph">⚙</span>Configurações
          </button>
        </nav>
        <div className="storage-card">
          <div className="storage-top"><span>Armazenamento</span><b>{connected ? "Ativo" : "—"}</b></div>
          <small>D1 + R2 persistentes</small>
          <button onClick={() => setConnectOpen(true)}><span className={connected ? "status-dot on" : "status-dot"}/>{connected ? "Cloudflare conectado" : "Conectar Cloudflare"}</button>
        </div>
        <div className="profile"><div className="avatar">A</div><div><strong>Administrador</strong><span>Corvo Library</span></div></div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="mobile-brand"><Mark /> Corvo Library</div>
          <label className="global-search"><SearchIcon/><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar por nome, universo, personagem ou tag..."/><kbd>⌘ K</kbd></label>
          <button className="sync-button" onClick={() => flash("Catálogo sincronizado agora")}><span>↻</span> Sincronizar</button>
          <button className="mcp-button" onClick={openMcpConnection}><span>⌁</span> Conectar GPT</button>
          <button className="icon-button" aria-label="Abrir configurações" title="Configurações" onClick={() => setActive("Configurações")}>⚙</button>
        </header>

        {active === "Solicitações" ? <Requests rows={requests} onNew={() => setBulkOpen(true)} />
        : active === "Projetos" ? <AutomaticProjects onFlash={flash}/>
        : active === "Lotes" ? <Batches onDownload={() => flash("Preparando download do lote")}/>
        : active === "Importações" ? <Imports onImport={() => importRef.current?.click()} onTemplate={downloadManifestTemplate}/>
        : active === "Coleta automática" ? <AutomaticCollection onFlash={flash}/>
        : active === "Operação" ? <OperationsDashboard onFlash={flash}/>
        : active === "Políticas" ? <OperationalPolicyWorkspace onFlash={flash}/>
        : active === "Estoque & giro" ? <InventoryIntelligence onFlash={flash}/>
        : active === "Inbox candidatas" ? <FastPushInbox onFlash={flash}/>
        : active === "Configurações" ? <SettingsV2 connected={connected} cloudflareInfo={cloudflareInfo} supervisorInfo={supervisorInfo} mcpConfigured={Boolean(mcpInfo)} authUsername={authStatus.username} onAuthUpdated={(username) => setAuthStatus((current) => ({ ...current, username }))} onLogout={logout} onConnect={() => setConnectOpen(true)} onSupervisor={() => setSupervisorOpen(true)} onMcp={openMcpConnection} />
        : <Catalog active={active} query={query} setQuery={setQuery} universe={universe} setUniverse={setUniverse} universes={universes} kind={kind} setKind={setKind} usage={usage} setUsage={setUsage} view={view} setView={setView} filtered={filtered} allAssets={assets} stats={catalogStats} loading={dataLoading} selected={selected} toggleSelected={toggleSelected} setSelected={setSelected} setDetail={setDetail} onBulk={() => setBulkOpen(true)} onImport={() => importRef.current?.click()} onTemplate={downloadManifestTemplate} onMcp={openMcpConnection} />}
      </section>

      {selected.length > 0 && <div className={`selection-bar ${active === "Pendentes" ? "pending-selection" : ""}`}><div><b>{selected.length}</b><span>{active === "Pendentes" ? "pendentes selecionados" : "assets selecionados"}</span></div>{active === "Pendentes" ? <><button className="approve-selection" onClick={approveSelectedPending}>✓ Aprovar → Catálogo</button><button className="delete-selection" onClick={deleteSelectedPending}>⌫ Excluir definitivamente</button></> : <><button onClick={() => setBulkOpen(true)}>▣ Criar lote</button><button onClick={downloadSelected}>↓ Baixar</button><button onClick={() => flash("Editor de tags aberto")}># Editar tags</button></>}<button onClick={() => setSelected([])} className="clear">Limpar seleção</button></div>}
      {detail && <AssetDrawer asset={detail} onClose={() => setDetail(null)} onAdd={() => {toggleSelected(detail.id); flash(`${detail.id} adicionado ao lote`)}} onDownload={() => downloadAsset(detail)} />}
      {bulkOpen && <BulkModal rows={bulkRows} project={bulkProject} value={bulkText} onProjectChange={setBulkProject} onChange={setBulkText} onClose={() => setBulkOpen(false)} onCreate={createRequest} />}
      {connectOpen && <ConnectModal connected={connected} info={cloudflareInfo} saving={cloudflareSaving} onClose={() => setConnectOpen(false)} onConnect={connectStorage} />}
      {supervisorOpen && <SupervisorModal info={supervisorInfo} cloudflareAccountId={cloudflareInfo?.accountId || ""} saving={supervisorSaving} onClose={() => setSupervisorOpen(false)} onConnect={connectSupervisor} />}
      {mcpOpen && <McpModalV2 info={mcpInfo} loading={mcpLoading} error={mcpError} onRetry={openMcpConnection} onClose={() => setMcpOpen(false)} onRotate={rotateMcpConnection} onCopy={copyText} />}
      <input ref={importRef} className="visually-hidden" type="file" accept=".zip,application/zip" onChange={(event) => uploadZip(event.target.files?.[0])}/>
      {toast && <div className="toast"><span>✓</span>{toast}</div>}
    </main>
  );
}

type CatalogProps = { active: string; query: string; setQuery: (v:string)=>void; universe:string; setUniverse:(v:string)=>void; universes:string[]; kind:string; setKind:(v:string)=>void; usage:string; setUsage:(v:string)=>void; view:"grid"|"list"; setView:(v:"grid"|"list")=>void; filtered:Asset[]; allAssets:Asset[]; stats:CatalogStats; loading:boolean; selected:string[]; toggleSelected:(id:string)=>void; setSelected:(ids:string[])=>void; setDetail:(a:Asset)=>void; onBulk:()=>void; onImport:()=>void; onTemplate:()=>void; onMcp:()=>void };

function Catalog({active,query,setQuery,universe,setUniverse,universes,kind,setKind,usage,setUsage,view,setView,filtered,allAssets,stats,loading,selected,toggleSelected,setSelected,setDetail,onBulk,onImport,onTemplate,onMcp}: CatalogProps) {
  const pending = stats.pending;
  const reused = stats.reused;
  return <div className="content">
    <div className="page-heading"><div><p>BIBLIOTECA VISUAL</p><h1>{active === "Catálogo" ? "Catálogo" : active}</h1><span>{active === "Catálogo" ? "Somente assets aprovados. Os indicadores abaixo são agregações reais do D1." : active === "Pendentes" ? "Selecione pelos ícones ou deixe o Supervisor via MCP escolher e operar pendentes em lote." : `Revise os assets ${active.toLowerCase()} da biblioteca.`}</span></div><div className="heading-actions">{active === "Pendentes" ? <><button className="secondary" onClick={() => setSelected(filtered.map((asset)=>asset.id))}>☑ Selecionar visíveis</button><button className="secondary" onClick={onMcp}>⌁ Seleção por IA / MCP</button></> : <><button className="secondary" onClick={onTemplate}>↓ Modelo TXT</button><button className="secondary" onClick={onImport}>⇧ Importar ZIP</button><button className="primary" onClick={onBulk}>＋ Nova solicitação</button></>}</div></div>
    <div className="stats-row"><article><span className="stat-icon blue">◫</span><div><small>Total de assets</small><strong>{stats.catalogAssets}</strong><em>Aprovados no Catálogo</em></div></article><article><span className="stat-icon purple">✦</span><div><small>Universos</small><strong>{stats.universes}</strong><em>Entre assets aprovados</em></div></article><article><span className="stat-icon amber">◷</span><div><small>Pendentes</small><strong>{pending}</strong><em>{pending ? "Requer atenção" : "Nenhum pendente"}</em></div></article><article><span className="stat-icon green">✓</span><div><small>Reutilizados</small><strong>{reused}</strong><em>Aprovados com uso registrado</em></div></article></div>
    <div className="filter-panel"><label className="catalog-search"><SearchIcon/><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar no catálogo..."/></label><select value={universe} onChange={(e) => setUniverse(e.target.value)}>{universes.map((item) => <option key={item}>{item}</option>)}</select><select value={kind} onChange={(e) => setKind(e.target.value)}><option>Todos os tipos</option><option>Personagem</option><option>Cenário</option><option>Objeto</option></select><select value={usage} onChange={(e) => setUsage(e.target.value)}><option>Todos os usos</option><option>Nunca usados</option><option>Já usados</option></select><button className="filters-more">☷ Mais filtros</button><div className="view-switch"><button className={view === "grid" ? "active" : ""} onClick={() => setView("grid")}>▦</button><button className={view === "list" ? "active" : ""} onClick={() => setView("list")}>☷</button></div></div>
    <div className="results-heading"><span><b>{filtered.length}</b> resultados nesta visualização</span><label>Ordenar por: <select><option>Mais recentes</option><option>Mais usados</option><option>Nunca usados</option></select></label></div>
    {loading ? <EmptyState icon="◌" title="Carregando catálogo" text="Buscando os dados persistidos da biblioteca." /> : filtered.length === 0 ? <EmptyState icon="◫" title={allAssets.length ? "Nenhum resultado" : "Seu catálogo está vazio"} text={allAssets.length ? "Ajuste a busca ou os filtros para encontrar outros assets." : "Importe seu primeiro ZIP com o IMPORTACAO.txt para começar."} action={allAssets.length ? undefined : onImport} actionLabel="Importar primeiro ZIP" secondaryAction={allAssets.length ? undefined : onTemplate} secondaryLabel="Baixar modelo TXT" /> : <div className={view === "grid" ? "asset-grid" : "asset-list"}>{filtered.map((asset) => <article className={`asset-card ${selected.includes(asset.id) ? "selected" : ""}`} key={asset.id}><div className="asset-image" onClick={() => setDetail(asset)}>{asset.image ? <img src={asset.image} alt={asset.name}/> : <div className="asset-placeholder">▧<small>Arquivo armazenado</small></div>}<button className="check" aria-label={`Selecionar ${asset.name}`} onClick={(e) => {e.stopPropagation(); toggleSelected(asset.id)}}>{selected.includes(asset.id) ? "✓" : ""}</button>{asset.transparent && <span className="alpha">TRANSPARENTE</span>}<span className={`status ${asset.status.toLowerCase()}`}>{asset.status}</span><div className="quick-actions"><button onClick={(e) => {e.stopPropagation(); setDetail(asset)}}>Abrir</button><button onClick={(e) => {e.stopPropagation(); toggleSelected(asset.id)}}>{active === "Pendentes" ? "✓ Selecionar" : "＋ Lote"}</button></div></div><div className="asset-info" onClick={() => setDetail(asset)}><div className="asset-title"><strong>{asset.name}</strong><button>•••</button></div><span>{asset.universe} · {asset.kind}</span><div className="tags">{asset.tags.slice(0,2).map((tag) => <i key={tag}>{tag}</i>)}</div><footer><small>{asset.id}</small><span>↻ {asset.uses} {asset.uses === 1 ? "uso" : "usos"}</span></footer></div></article>)}</div>}
  </div>;
}

function AssetDrawer({ asset, onClose, onAdd, onDownload }: { asset: Asset; onClose: () => void; onAdd: () => void; onDownload: () => void }) {
  return <>
    <button className="backdrop" aria-label="Fechar detalhes" onClick={onClose} />
    <aside className="drawer" aria-label={`Detalhes de ${asset.name}`}>
      <header><div><span>ASSET</span><h2>{asset.id}</h2></div><button onClick={onClose} aria-label="Fechar">×</button></header>
      {asset.image ? <img src={asset.image} alt={asset.name} /> : <div className="drawer-placeholder">▧<span>Arquivo armazenado</span></div>}
      <div className="drawer-body">
        <div className="drawer-title"><div><h3>{asset.name}</h3><p>{asset.universe} · {asset.kind}</p></div><button onClick={onClose}>•••</button></div>
        <div className="drawer-actions"><button onClick={onDownload}>↓ Baixar</button><button onClick={onAdd}>＋ Adicionar ao lote</button></div>
        <dl>
          <div><dt>Status</dt><dd>{asset.status}</dd></div>
          <div><dt>Formato</dt><dd>{asset.format || asset.mimeType || "—"}</dd></div>
          <div><dt>Proporção</dt><dd>{asset.ratio || "—"}</dd></div>
          <div><dt>Usos</dt><dd>{asset.uses}</dd></div>
        </dl>
        <section><h4>Arquivo</h4><p>{asset.fileName || asset.id}</p></section>
        <section><h4>Tags</h4><div className="tags">{asset.tags.length ? asset.tags.map((tag) => <i key={tag}>{tag}</i>) : <i>sem tags</i>}</div></section>
      </div>
    </aside>
  </>;
}

function BulkModal({ rows, project, value, onProjectChange, onChange, onClose, onCreate }: { rows: string[]; project: string; value: string; onProjectChange: (value: string) => void; onChange: (value: string) => void; onClose: () => void; onCreate: () => void | Promise<void> }) {
  const canCreate = project.trim().length > 0 && rows.length > 0;
  return <div className="modal-wrap">
    <button className="backdrop" aria-label="Fechar solicitação" onClick={onClose} />
    <section className="modal bulk-modal" aria-label="Nova solicitação em lote">
      <header><div><span>SOLICITAÇÃO</span><h2>Nova solicitação em lote</h2><p>Informe o projeto e uma referência por linha.</p></div><button onClick={onClose} aria-label="Fechar">×</button></header>
      <div className="steps"><b>1</b><span>Projeto</span><i /><b>2</b><span>Itens</span><i /><b>3</b><span>Criar</span></div>
      <label>PROJETO<input value={project} onChange={(event) => onProjectChange(event.target.value)} placeholder="Nome do projeto" /></label>
      <label>ITENS<textarea rows={10} value={value} onChange={(event) => onChange(event.target.value)} placeholder="Uma referência por linha" /><small>{rows.length} {rows.length === 1 ? "item reconhecido" : "itens reconhecidos"}</small></label>
      {rows.length > 0 && <div className="validation-preview"><header><b>Prévia</b><span>{rows.length} linhas</span></header>{rows.slice(0, 8).map((row, index) => <div key={`${index}-${row}`}><b>{index + 1}</b><span>{row}</span><em className="pill done">OK</em></div>)}</div>}
      <footer><button onClick={onClose}>Cancelar</button><button className="primary" disabled={!canCreate} onClick={() => void onCreate()}>Criar solicitação</button></footer>
    </section>
  </div>;
}

function EmptyState({ icon, title, text, action, actionLabel, secondaryAction, secondaryLabel }: { icon:string; title:string; text:string; action?:()=>void; actionLabel?:string; secondaryAction?:()=>void; secondaryLabel?:string }) {
  return <div className="empty-state"><div>{icon}</div><h2>{title}</h2><p>{text}</p>{(action || secondaryAction) && <footer>{secondaryAction && <button className="secondary" onClick={secondaryAction}>{secondaryLabel}</button>}{action && <button className="primary" onClick={action}>{actionLabel}</button>}</footer>}</div>;
}

function Requests({ rows, onNew }: { rows: RequestRow[]; onNew: () => void }) {
  const inProgress = rows.filter((row) => !row.status.toLowerCase().includes("conclu")).length;
  return <div className="content"><div className="page-heading"><div><p>FILA OPERACIONAL</p><h1>Solicitações</h1><span>Peça, valide e agrupe assets em poucos passos.</span></div><button className="primary" onClick={onNew}>＋ Solicitação em lote</button></div><div className="request-summary"><article><small>Total</small><strong>{rows.length}</strong></article><article><small>Em andamento</small><strong>{inProgress}</strong></article><article><small>Concluídas</small><strong>{rows.length - inProgress}</strong></article></div>{rows.length === 0 ? <EmptyState icon="✦" title="Nenhuma solicitação" text="Crie a primeira solicitação em lote quando precisar localizar ou produzir assets." action={onNew} actionLabel="Criar solicitação" /> : <div className="data-card"><div className="data-head"><b>Solicitações recentes</b></div>{rows.map((row) => <div className="data-row" key={row.id}><span className="data-id">{row.id}</span><strong>{row.project}</strong><span>{row.itemCount} itens</span><em className={`pill ${row.status.toLowerCase().includes("conclu") ? "done" : "wait"}`}>{row.status}</em><small>{new Date(row.createdAt).toLocaleDateString("pt-BR")}</small><button>›</button></div>)}</div>}</div>;
}

function Batches({ onDownload }: { onDownload: () => void }) {
  return <div className="content"><div className="page-heading"><div><p>ENTREGAS</p><h1>Lotes</h1><span>Pacotes prontos para o Forma e outros projetos.</span></div></div><EmptyState icon="▣" title="Nenhum lote criado" text="Selecione assets no catálogo ou crie uma solicitação para montar seu primeiro lote." /></div>;
}

function Imports({ onImport, onTemplate }: { onImport: () => void; onTemplate: () => void }) {
  return <div className="content"><div className="page-heading"><div><p>INGESTÃO</p><h1>Importações</h1><span>Envie ZIPs sem interromper o restante da biblioteca.</span></div><div className="heading-actions"><button className="secondary" onClick={onTemplate}>↓ Baixar IMPORTACAO.txt</button><button className="primary" onClick={onImport}>⇧ Importar ZIP</button></div></div><div className="manifest-guide"><div className="manifest-icon">TXT</div><div><strong>O contexto deve viajar com as mídias</strong><p>Baixe o modelo, preencha uma seção para cada mídia e coloque o arquivo <b>IMPORTACAO.txt</b> dentro do ZIP.</p></div><button className="secondary" onClick={onTemplate}>↓ Salvar modelo TXT</button></div><div className="drop-zone"><div>⇧</div><h2>Envie seu arquivo ZIP</h2><p>Inclua o IMPORTACAO.txt junto com imagens, GIFs e vídeos MP4, WebM, MOV ou M4V.</p><button onClick={onImport}>Selecionar arquivo</button></div><p className="empty-imports">As importações reais aparecerão aqui após o envio.</p></div>;
}

function AutomaticProjects({ onFlash }: { onFlash: (message: string) => void }) {
  const [projects, setProjects] = useState<AutomaticProject[]>([]), [selectedId, setSelectedId] = useState("");
  const [selectedProjects, setSelectedProjects] = useState<string[]>([]), [projectTab, setProjectTab] = useState<"active"|"recent"|"errors"|"completed">("active");
  const [detail, setDetail] = useState<AutomaticProjectDetail | null>(null), [name, setName] = useState(""), [newProjectDomain, setNewProjectDomain] = useState("ANIME"), [newProjectPriority, setNewProjectPriority] = useState(1), [busy, setBusy] = useState(false), [runtimeError, setRuntimeError] = useState("");
  const scriptFile = useRef<HTMLInputElement>(null), requirementsFile = useRef<HTMLInputElement>(null), stepActive = useRef(false);
  const loadProjects = useCallback(async () => { const response = await fetch("/api/projects?limit=100", { cache:"no-store" }); if (response.ok) setProjects(((await response.json()) as {projetos:AutomaticProject[]}).projetos || []); }, []);
  const loadDetail = useCallback(async (id:string) => { if (!id) return; const response = await fetch(`/api/projects?id=${encodeURIComponent(id)}`, { cache:"no-store" }); if (response.ok) setDetail(await response.json() as AutomaticProjectDetail); }, []);
  useEffect(() => { const timer = window.setTimeout(() => loadProjects().catch(()=>undefined), 0); return () => window.clearTimeout(timer); }, [loadProjects]);
  useEffect(() => { if (!selectedId) return; const initial = window.setTimeout(() => loadDetail(selectedId).catch(()=>undefined), 0); const timer = window.setInterval(() => loadDetail(selectedId).catch(()=>undefined), 2500); return () => { window.clearTimeout(initial); window.clearInterval(timer); }; }, [selectedId, loadDetail]);
  const projectStatus = detail?.projeto.status;
  useEffect(() => {
    if (!selectedId || !projectStatus || !["READY","PROCESSING"].includes(projectStatus)) return;
    let stopped = false;
    async function drive() {
      while (!stopped) {
        if (stepActive.current) { await new Promise((resolve)=>window.setTimeout(resolve,500)); continue; }
        stepActive.current = true;
        try {
          const response = await fetch("/api/projects", { method:"PATCH", headers:{"content-type":"application/json"}, body:JSON.stringify({ projeto_id:selectedId, acao:"processar", max_etapas:1 }) });
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.error || "Falha na esteira");
          setDetail(payload as AutomaticProjectDetail); setRuntimeError(""); loadProjects().catch(()=>undefined);
          if (!["READY","PROCESSING"].includes(String(payload.projeto?.status))) break;
        } catch (error) { setRuntimeError(friendlyCollectionMessage(error instanceof Error ? error.message : error)); await new Promise((resolve)=>window.setTimeout(resolve,5000)); }
        finally { stepActive.current = false; }
        await new Promise((resolve)=>window.setTimeout(resolve,900));
      }
    }
    drive().catch(()=>undefined);
    return () => { stopped = true; };
  }, [selectedId, projectStatus, loadProjects]);
  async function createProject() {
    if (!name.trim()) return; setBusy(true);
    try { const response = await fetch("/api/projects", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({ nome:name, automatico:true, project_domain:newProjectDomain, prioridade_fila:newProjectPriority }) }); const payload = await response.json(); if (!response.ok) throw new Error(payload.error); setName(""); setSelectedId(payload.projeto.id); setDetail(payload); await loadProjects(); onFlash("Projeto aberto. Se o vídeo já existia, a Biblioteca reutilizou o mesmo projeto em vez de criar duplicata."); }
    catch { onFlash("Não foi possível criar o projeto."); } finally { setBusy(false); }
  }
  async function upload(role:"SCRIPT"|"REQUIREMENTS", file?:File) {
    if (!file || !selectedId) return; setBusy(true); const form = new FormData(); form.append("role",role); form.append("file",file);
    try { const response = await fetch(`/api/projects/${encodeURIComponent(selectedId)}/files`, { method:"POST", body:form }); const payload = await response.json(); if (!response.ok) throw new Error(payload.error); setDetail(payload); await loadProjects(); onFlash(role === "SCRIPT" ? "Roteiro salvo e versionado no mesmo projeto." : "TXT salvo; a esteira iniciou automaticamente quando o par ficou completo."); }
    catch { onFlash("Não foi possível anexar este TXT."); } finally { setBusy(false); }
  }
  async function action(actionName:string, extra:Record<string,unknown>={}) {
    if (!selectedId) return; setBusy(true);
    try { const response = await fetch("/api/projects", { method:"PATCH", headers:{"content-type":"application/json"}, body:JSON.stringify({ projeto_id:selectedId, acao:actionName, ...extra }) }); const payload = await response.json(); if (!response.ok) throw new Error(payload.error); if (payload.projeto?.id) setDetail(payload as AutomaticProjectDetail); else await loadDetail(selectedId); await loadProjects(); onFlash(actionName === "zip" ? "ZIP temporário regenerado." : actionName === "concluir" ? "Projeto marcado como concluído e movido para Concluídos." : actionName === "desconcluir" ? "Projeto reaberto com aprovados congelados e somente gaps liberados." : "Projeto atualizado."); }
    catch (error) { onFlash(friendlyCollectionMessage(error instanceof Error ? error.message : error)); } finally { setBusy(false); }
  }
  async function bulkComplete() {
    if (!selectedProjects.length) return; setBusy(true);
    try {
      const response = await fetch("/api/projects", { method:"PATCH", headers:{"content-type":"application/json"}, body:JSON.stringify({ acao:"concluir_lote", projeto_ids:selectedProjects }) });
      const payload = await response.json(); if (!response.ok) throw new Error(payload.error);
      setSelectedProjects([]); await loadProjects(); if (selectedId) await loadDetail(selectedId).catch(()=>undefined); setProjectTab("completed");
      onFlash(`${payload.atualizados || selectedProjects.length} projeto(s) concluído(s).`);
    } catch (error) { onFlash(friendlyCollectionMessage(error instanceof Error ? error.message : error)); } finally { setBusy(false); }
  }
  async function bulkDelete() {
    if (!selectedProjects.length || !window.confirm(`Excluir permanentemente ${selectedProjects.length} projeto(s) selecionado(s) e seus TXT/ZIPs temporários? Assets aprovados da Biblioteca serão preservados.`)) return;
    setBusy(true);
    try {
      const response = await fetch("/api/projects", { method:"DELETE", headers:{"content-type":"application/json"}, body:JSON.stringify({ projeto_ids:selectedProjects, confirmar:true }) });
      const payload = await response.json(); if (!response.ok) throw new Error(payload.error);
      const removedCurrent = selectedProjects.includes(selectedId);
      setSelectedProjects([]); if (removedCurrent) { setSelectedId(""); setDetail(null); }
      await loadProjects();
      const r2Failures = Array.isArray(payload.r2_cleanup_failures) ? payload.r2_cleanup_failures.length : 0;
      onFlash(r2Failures
        ? `${payload.grupos_excluidos || selectedProjects.length} projeto(s) removido(s) do D1; ${r2Failures} arquivo(s) R2 ficaram pendentes de limpeza.`
        : `${payload.grupos_excluidos || selectedProjects.length} projeto(s) removido(s) da visão operacional.`);
    } catch (error) { onFlash(friendlyCollectionMessage(error instanceof Error ? error.message : error)); } finally { setBusy(false); }
  }
  async function decide(item:AutomaticProjectItem,status:"APROVADO"|"REJEITADO") { await action("qa", { decisoes:[{item_id:item.id,status,observacao:status === "REJEITADO" ? "Candidata descartada; buscar nova referência." : "Aprovado no painel do projeto."}] }); }
  async function productionDecision(kind:"THUMB"|"TITLE", candidateId:string, decision:"APPROVE"|"REJECT"|"SELECT") {
    if (!selectedId) return; setBusy(true);
    try { const response = await fetch(`/api/projects/${encodeURIComponent(selectedId)}/production`, { method:"PATCH", headers:{"content-type":"application/json"}, body:JSON.stringify({ kind, candidate_id:candidateId, decision, source:"MANUAL" }) }); const payload = await response.json(); if (!response.ok) throw new Error(payload.error); await loadDetail(selectedId); await loadProjects(); onFlash(decision === "SELECT" ? `${kind === "THUMB" ? "Thumb" : "Título"} selecionado para o pacote.` : decision === "APPROVE" ? "Candidata aprovada." : "Candidata rejeitada."); }
    catch (error) { onFlash(friendlyCollectionMessage(error instanceof Error ? error.message : error)); } finally { setBusy(false); }
  }
  async function exportProduction() {
    if (!selectedId) return; setBusy(true);
    try { const response = await fetch(`/api/projects/${encodeURIComponent(selectedId)}/production`, { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({ action:"export" }) }); const payload = await response.json(); if (!response.ok) throw new Error(payload.error); await loadDetail(selectedId); await loadProjects(); onFlash("ZIP completo enfileirado no R2. Quando ficar READY_FOR_DOWNLOAD, o agente pode pedir o link assinado e baixar direto."); }
    catch (error) { onFlash(friendlyCollectionMessage(error instanceof Error ? error.message : error)); } finally { setBusy(false); }
  }
  function downloadRequirementsTemplate() {
    const href = URL.createObjectURL(new Blob([projectRequirementsTemplate], { type:"text/plain;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = href; anchor.download = "MODELO_IA_IMAGENS_NECESSARIAS.txt"; document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(href);
    onFlash("Modelo da IA salvo. Preencha e anexe como Imagens necessárias.");
  }
  const tabCounts = {
    active: projects.filter((project)=>!projectIsCompleted(project.status) && !project.hasErrors).length,
    recent: projects.filter((project)=>project.recent24h).length,
    errors: projects.filter((project)=>!projectIsCompleted(project.status) && project.hasErrors).length,
    completed: projects.filter((project)=>projectIsCompleted(project.status)).length,
  };
  const visibleProjects = projects.filter((project) => projectTab === "completed" ? projectIsCompleted(project.status) : projectTab === "errors" ? !projectIsCompleted(project.status) && Boolean(project.hasErrors) : projectTab === "recent" ? Boolean(project.recent24h) : !projectIsCompleted(project.status) && !project.hasErrors);
  const current = detail?.projeto, completed = Boolean(current && projectIsCompleted(current.status)), filesByRole = { SCRIPT:detail?.arquivos.find((file)=>file.role==="SCRIPT"), REQUIREMENTS:detail?.arquivos.find((file)=>file.role==="REQUIREMENTS") };
  return <div className="content projects-page"><div className="page-heading"><div><p>ESTEIRA AUTOMÁTICA</p><h1>Projetos</h1><span>Um vídeo ocupa uma única linha. Novos TXT entram como versões do mesmo projeto, nunca como cópias visuais.</span></div><div className="project-heading-actions"><button className="secondary" onClick={downloadRequirementsTemplate}>↓ TXT para a IA</button><div className="project-create"><input value={name} onChange={(event)=>setName(event.target.value)} placeholder="Nome do novo projeto"/><select value={newProjectDomain} onChange={(event)=>setNewProjectDomain(event.target.value)} title="Nicho do projeto"><option>ANIME</option><option>FOOTBALL</option><option>GAMES</option><option>GEEK</option><option>CARTOON</option><option>GENERAL</option></select><select value={newProjectPriority} onChange={(event)=>setNewProjectPriority(Number(event.target.value))} title="Prioridade FIFO"><option value={1}>Prioridade normal</option><option value={2}>Prioridade alta</option><option value={3}>Prioridade crítica</option></select><button className="primary" disabled={busy||!name.trim()} onClick={createProject}>＋ Criar automático</button></div></div></div>
    <div className="project-tabs"><button className={projectTab==="active"?"active":""} onClick={()=>{setProjectTab("active");setSelectedProjects([]);setSelectedId("");setDetail(null)}}>Ativos <b>{tabCounts.active}</b></button><button className={projectTab==="recent"?"active":""} onClick={()=>{setProjectTab("recent");setSelectedProjects([]);setSelectedId("");setDetail(null)}}>Últimas 24h <b>{tabCounts.recent}</b></button><button className={projectTab==="errors"?"active":""} onClick={()=>{setProjectTab("errors");setSelectedProjects([]);setSelectedId("");setDetail(null)}}>Erros <b>{tabCounts.errors}</b></button><button className={projectTab==="completed"?"active":""} onClick={()=>{setProjectTab("completed");setSelectedProjects([]);setSelectedId("");setDetail(null)}}>Concluídos <b>{tabCounts.completed}</b></button></div>
    {selectedProjects.length > 0 && <div className="project-bulkbar"><strong>{selectedProjects.length} selecionado(s)</strong><button className="secondary" disabled={busy} onClick={()=>setSelectedProjects([])}>Limpar</button><button className="secondary" disabled={busy} onClick={bulkDelete}>Excluir selecionados</button><button className="primary" disabled={busy} onClick={bulkComplete}>✓ Concluir selecionados</button></div>}
    <div className="projects-layout"><aside className="project-list"><header><strong>{projectTab === "active" ? "PROJETOS ATIVOS" : projectTab === "recent" ? "ADICIONADOS NAS ÚLTIMAS 24H" : projectTab === "errors" ? "PROJETOS COM ERRO" : "PROJETOS CONCLUÍDOS"}</strong><button onClick={()=>loadProjects()}>↻</button></header>{visibleProjects.length ? visibleProjects.map((project)=><article key={project.id} className={`project-list-row ${selectedId===project.id?"active":""}`}><label className="project-select" onClick={(event)=>event.stopPropagation()}><input type="checkbox" checked={selectedProjects.includes(project.id)} onChange={()=>setSelectedProjects((current)=>current.includes(project.id)?current.filter((id)=>id!==project.id):[...current,project.id])}/><i>{selectedProjects.includes(project.id)?"✓":""}</i></label><button onClick={()=>setSelectedId(project.id)}><span><strong>{project.name}</strong><small>{project.projectDomain || "GENERAL"} · {project.versions?.length || 1} {(project.versions?.length || 1) === 1 ? "versão" : "versões"} · {new Date(project.updatedAt).toLocaleString("pt-BR")}{project.errorCount?` · ${project.errorCount} erro(s)`:""}</small></span><em className={`project-status status-${project.hasErrors && !projectIsCompleted(project.status) && project.pipelineStatus!=="PRONTO_PARA_RETOMADA" ? "error" : projectOperationalClass(project)}`}>{project.hasErrors && !projectIsCompleted(project.status) && project.pipelineStatus!=="PRONTO_PARA_RETOMADA" ? "ERRO" : projectOperationalLabel(project)}</em></button></article>) : <p>Nenhum projeto nesta aba.</p>}</aside>
      <section className="project-workspace">{!current ? <EmptyState icon="◆" title="Selecione ou crie um projeto" text="Cada vídeo aparece uma única vez; roteiro e imagens necessárias ficam versionados dentro dele."/> : <><header className="project-header"><div><span>PROJETO ATIVO</span><h2>{current.name}</h2><small>{current.id} · {current.projectDomain || "GENERAL"} · prioridade {current.queuePriority || 1} · versão {current.activeVersion}</small></div><label className="auto-switch"><input type="checkbox" disabled={completed} checked={current.automatic && !completed} onChange={(event)=>action("configurar",{automatico:event.target.checked})}/><i/><span>{completed ? "IA BLOQUEADA" : `AUTOMÁTICO ${current.automatic?"LIGADO":"DESLIGADO"}`}</span></label><em className={`project-status status-${projectOperationalClass(current)}`}>{projectOperationalLabel(current)}</em></header>
        {current.pipelineStatus === "PRONTO_PARA_RETOMADA" && <div className="project-resume-state"><strong>PROCESSO NÃO FINALIZADO</strong><span>Execução anterior {current.previousExecutionId || current.supervisorExecutionId || "—"} deixou de renovar o lease. Estado preservado · próxima ação: {current.nextAction || "RECONCILIAR"}.</span></div>}
        {current.supervisorStatus === "ATIVO" && current.supervisorExecutionId && <div className="project-lease-state"><strong>Supervisor ativo</strong><span>{current.supervisorExecutionId} · lease até {current.supervisorLeaseExpiresAt ? new Date(current.supervisorLeaseExpiresAt).toLocaleTimeString("pt-BR") : "—"} · próxima ação: {current.nextAction || "—"}</span></div>}
        {runtimeError && <div className="project-alert"><strong>A esteira encontrou uma exceção</strong><span>{runtimeError}. Os demais itens continuam independentes.</span></div>}
        {completed && <div className="project-completed-lock"><strong>✓ Concluído por você</strong><span>Este vídeo está na aba Concluídos e não recebe nova produção automática até ser reaberto.</span></div>}
        <div className="project-file-grid">
          <article className={filesByRole.SCRIPT?"ready":""}><span>01</span><div><strong>Roteiro</strong><small>{filesByRole.SCRIPT ? `${filesByRole.SCRIPT.fileName} · v${filesByRole.SCRIPT.version}` : "Aguardando TXT"}</small></div>{filesByRole.SCRIPT && <a href={`/api/projects/${current.id}/files?file_id=${filesByRole.SCRIPT.id}`}>↓</a>}<button disabled={busy||completed} onClick={()=>scriptFile.current?.click()}>{completed?"Bloqueado":filesByRole.SCRIPT?"Nova versão":"Anexar"}</button><input ref={scriptFile} type="file" accept=".txt,text/plain" onChange={(event)=>upload("SCRIPT",event.target.files?.[0])}/></article>
          <article className={filesByRole.REQUIREMENTS?"ready":""}><span>02</span><div><strong>Imagens necessárias</strong><small>{filesByRole.REQUIREMENTS ? `${filesByRole.REQUIREMENTS.fileName} · v${filesByRole.REQUIREMENTS.version}` : "Aguardando TXT"}</small></div>{filesByRole.REQUIREMENTS && <a href={`/api/projects/${current.id}/files?file_id=${filesByRole.REQUIREMENTS.id}`}>↓</a>}<button disabled={busy||completed} onClick={()=>requirementsFile.current?.click()}>{completed?"Bloqueado":filesByRole.REQUIREMENTS?"Nova versão":"Anexar"}</button><input ref={requirementsFile} type="file" accept=".txt,text/plain" onChange={(event)=>upload("REQUIREMENTS",event.target.files?.[0])}/></article>
          <article className={current.zipR2Key?"ready":""}><span>03</span><div><strong>ZIP temporário</strong><small>{current.zipR2Key ? `${current.zipFileName} · ${Math.round((current.zipSizeBytes||0)/1024)} KB` : "Gerado com itens resolvidos"}</small></div>{current.zipR2Key && <a href={`/api/projects/${current.id}/zip`}>↓</a>}<button disabled={busy||!detail.metricas.resolvidos} onClick={()=>action("zip")}>Regenerar</button></article>
          <article className={detail.producao.production_zip_current?"ready":detail.producao.production_zip?"stale":""}><span>04</span><div><strong>ZIP de produção</strong><small>{detail.producao.production_zip ? `${detail.producao.production_zip.file_name || "Pacote"} · ${detail.producao.production_zip_current ? "atual" : "desatualizado após novas contribuições"}` : "Roteiro + imagens + thumbs + títulos"}</small></div>{detail.producao.production_zip && <a href={`/api/projects/${current.id}/production-zip`}>↓</a>}<button disabled={busy} onClick={exportProduction}>{detail.producao.production_zip?"Regenerar":"Gerar"}</button></article>
        </div>
        <section className="production-package-panel"><header><div><span>PACOTE DE PRODUÇÃO</span><strong>Contribuições dos agentes no mesmo projeto</strong><small>Rev. {detail.producao.production_revision} · {detail.producao.metrics.images_resolved} imagens · {detail.producao.metrics.thumbs_total} thumbs · {detail.producao.metrics.titles_total} títulos{detail.producao.contributing_agents.length ? ` · ${detail.producao.contributing_agents.join(", ")}` : ""}</small></div><button className="secondary" disabled={busy} onClick={exportProduction}>↓ Exportar projeto completo</button></header><div className="production-columns"><div><div className="production-title"><strong>THUMBS</strong><span>{detail.producao.selected_thumb ? `Selecionada: ${detail.producao.selected_thumb.name}` : "Nenhuma selecionada"}</span></div><div className="production-thumb-grid">{detail.producao.thumbs.length ? detail.producao.thumbs.map((thumb)=><article key={thumb.id} className={thumb.selected?"selected":""}><div className="production-thumb-preview"><img src={thumb.download_path} alt={thumb.name}/>{thumb.selected&&<b>SELECIONADA</b>}<em>{thumb.status.replace("THUMB_","")}</em></div><div><strong>{thumb.name}</strong><small>{thumb.variant||"Sem variante"}{thumb.agentOrigin?` · ${thumb.agentOrigin}`:""}</small><footer><button disabled={busy} onClick={()=>productionDecision("THUMB",thumb.id,"REJECT")}>Rejeitar</button><button disabled={busy} onClick={()=>productionDecision("THUMB",thumb.id,"APPROVE")}>Aprovar</button><button className="primary" disabled={busy} onClick={()=>productionDecision("THUMB",thumb.id,"SELECT")}>Selecionar</button></footer></div></article>) : <p>Nenhuma thumb enviada ainda.</p>}</div></div><div><div className="production-title"><strong>TÍTULOS</strong><span>{detail.producao.selected_title ? `Selecionado: ${detail.producao.selected_title.text}` : "Nenhum selecionado"}</span></div><div className="production-title-list">{detail.producao.titles.length ? detail.producao.titles.map((title)=><article key={title.id} className={title.selected?"selected":""}><div><strong>{title.text}</strong><small>{title.variant||"Sem variante"}{title.agentOrigin?` · ${title.agentOrigin}`:""}{title.score!=null?` · score ${title.score}`:""}</small><em>{title.status.replace("TITLE_","")}{title.selected?" · SELECIONADO":""}</em></div><footer><button disabled={busy} onClick={()=>productionDecision("TITLE",title.id,"REJECT")}>Rejeitar</button><button disabled={busy} onClick={()=>productionDecision("TITLE",title.id,"APPROVE")}>Aprovar</button><button className="primary" disabled={busy} onClick={()=>productionDecision("TITLE",title.id,"SELECT")}>Selecionar</button></footer></article>) : <p>Nenhuma ideia de título enviada ainda.</p>}</div></div></div></section>
        <div className="project-progress"><div><strong>{detail.metricas.progresso_percentual}%</strong><span>{detail.metricas.resolvidos} de {detail.metricas.total} resolvidos</span></div><div className="progress"><i style={{width:`${detail.metricas.progresso_percentual}%`}}/></div><section><span><b>{detail.metricas.biblioteca}</b>Biblioteca</span><span><b>{detail.metricas.externos}</b>Externos</span><span><b>{detail.metricas.qa}</b>Em QA</span><span><b>{detail.metricas.relink}</b>Relink</span><span><b>{detail.metricas.throughput_por_minuto}</b>/min</span></section></div>
        <div className="project-actions"><a className="button-link" href={`/api/projects?id=${encodeURIComponent(current.id)}&view=log`}>↓ Log completo</a>{current.zipR2Key && <a className="button-link" href={`/api/projects/${current.id}/zip`}>↓ Baixar ZIP</a>}<button className={completed?"secondary":"primary"} disabled={busy} onClick={()=>{ if (completed) { if (window.confirm("Reabrir este projeto preservando todos os assets já aprovados/congelados e liberando somente os gaps reais?")) action("desconcluir"); } else action("concluir"); }}>{completed?"↶ Reabrir projeto":"✓ Marcar como concluído"}</button></div>
        <div className="project-items"><header><div><strong>ITENS DO PROJETO</strong><span>Falhas isoladas nunca suspendem o lote.</span></div><b>{detail.metricas.total}</b></header>{detail.itens.length ? detail.itens.map((item)=><article key={item.id}><span className={`item-state state-${item.status.toLowerCase()}`}>●</span><div><strong>{item.itemKey} · {item.term}</strong><small>{item.universe||"Sem universo"} · {item.kind}{item.failureReason?` · ${friendlyCollectionMessage(item.failureReason)}`:""}</small></div><em>{item.status.replaceAll("_"," ")}</em>{item.linkedAssetId && <code>{item.linkedAssetId}</code>}{!completed&&item.status==="QA_READY" && <div className="qa-buttons"><button onClick={()=>decide(item,"REJEITADO")}>Rejeitar e relinkar</button><button className="primary" onClick={()=>decide(item,"APROVADO")}>Aprovar</button></div>}</article>) : <p className="project-empty-items">Envie o roteiro e o TXT de imagens. A leitura começa automaticamente quando os dois estiverem disponíveis.</p>}</div>
      </>}</section></div></div>;
}

function OperationsDashboard({ onFlash }: { onFlash: (message: string) => void }) {
  const [view, setView] = useState<"operational"|"management">("operational");
  const [operational, setOperational] = useState<OperationalDashboard | null>(null);
  const [management, setManagement] = useState<ManagementDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async (quiet=false) => {
    if (!quiet) setLoading(true);
    try {
      const endpoint = view === "management" ? "/api/operations?view=management&days=30" : "/api/operations?view=operational";
      const response = await fetch(endpoint, { cache:"no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Falha ao carregar operação");
      if (view === "management") setManagement(payload as ManagementDashboard); else setOperational(payload as OperationalDashboard);
    } catch (error) { if (!quiet) onFlash(error instanceof Error ? error.message : "Falha ao carregar painel operacional"); }
    finally { if (!quiet) setLoading(false); }
  }, [view, onFlash]);
  useEffect(() => { load().catch(()=>undefined); const timer=window.setInterval(()=>load(true).catch(()=>undefined),10000); return ()=>window.clearInterval(timer); }, [load]);
  const fmtDuration = (ms:number) => { const total=Math.max(0,Math.round(ms/1000)); const h=Math.floor(total/3600),m=Math.floor(total%3600/60),sec=total%60; return h ? `${h}h ${m}m` : m ? `${m}m ${sec}s` : `${sec}s`; };
  const downloadHref = `/api/operations?view=${view}&format=txt`;
  return <div className="content operations-page">
    <div className="page-heading"><div><p>SALA DE CONTROLE</p><h1>Operação</h1><span>FIFO por etapa, workers por nicho, leases granulares e métricas do estado persistido.</span></div><div className="heading-actions"><a className="button-link secondary" href={downloadHref}>↓ Exportar TXT</a><button className="secondary" onClick={()=>load()}>↻ Atualizar</button></div></div>
    <div className="operations-tabs"><button className={view==="operational"?"active":""} onClick={()=>setView("operational")}>Produção em tempo real</button><button className={view==="management"?"active":""} onClick={()=>setView("management")}>Gerencial / diretoria</button><span>Atualização automática · 10s</span></div>
    {loading && !(operational||management) ? <EmptyState icon="◌" title="Carregando operação" text="Lendo workers, filas e telemetria persistida."/> : view === "operational" ? operational ? <>
      <div className="operations-kpis"><article><small>Workers ativos</small><strong>{operational.totals.workers_active}</strong><span>{Object.entries(operational.workers_active_by_type).map(([k,v])=>`${k} ${v}`).join(" · ") || "Nenhum ativo"}</span></article><article><small>Fila pronta</small><strong>{operational.totals.queue_ready}</strong><span>{operational.totals.queue_leased} ocupados · {operational.totals.queue_waiting_dependency} dependências</span></article><article><small>Planos V60 ativos</small><strong>{operational.totals.plans_active ?? 0}</strong><span>{operational.totals.plan_branches_active ?? 0} branches · {operational.totals.plan_branches_waiting_supervisor ?? 0} divergências</span></article><article><small>Projetos em andamento</small><strong>{operational.totals.projects_in_progress}</strong><span>{operational.totals.projects_ready_resume} prontos para retomada</span></article><article><small>Throughput</small><strong>{operational.totals.throughput_last_hour}</strong><span>unidades concluídas na última hora</span></article></div>
      <div className="operations-grid">
        <section className="operations-card wide"><header><div><strong>WORKERS EM AÇÃO</strong><span>Worker · nicho · projeto · etapa · heartbeat · lease</span></div><b>{operational.workers.length}</b></header>{operational.workers.length ? <div className="worker-table"><div className="worker-row head"><span>Worker</span><span>Nicho / tipo</span><span>Projeto</span><span>Etapa / item</span><span>Última ação</span><span>Heartbeat</span><span>Lease</span></div>{operational.workers.map((worker)=><div className="worker-row" key={worker.execution_id}><span><b>{worker.worker_id}</b><small>{worker.status}</small></span><span><b>{worker.worker_domain}</b><small>{worker.worker_type}</small></span><span><b>{worker.project_name || worker.project_id || "—"}</b><small>{worker.project_id || "—"}</small></span><span><b>{worker.stage || "—"}</b><small>{worker.item_id || worker.work_item_id || "—"}</small></span><span><b>{worker.last_action || "—"}</b><small>na etapa {fmtDuration(worker.time_in_stage_ms)}</small></span><span><b>{new Date(worker.last_heartbeat).toLocaleTimeString("pt-BR")}</b><small>{new Date(worker.last_heartbeat).toLocaleDateString("pt-BR")}</small></span><span><b>{fmtDuration(worker.lease_remaining_ms)}</b><small>restante</small></span></div>)}</div> : <p className="operations-empty">Nenhum worker com lease ativo neste instante.</p>}</section>
        <section className="operations-card"><header><div><strong>FILAS POR ETAPA</strong><span>FIFO independente</span></div></header><div className="queue-list">{Object.entries(operational.queues_by_stage).length ? Object.entries(operational.queues_by_stage).map(([stage,count])=><div key={stage}><span>{stage}</span><b>{count}</b><i style={{width:`${Math.min(100,count*5)}%`}}/></div>) : <p>Filas vazias.</p>}</div></section>
        <section className="operations-card"><header><div><strong>SATURAÇÃO</strong><span>Capacidade configurada</span></div></header><div className="capacity-list">{operational.utilization.map((row)=><div key={`${row.worker_type}-${row.domain}`}><span><b>{row.worker_type}</b><small>{row.domain}</small></span><strong>{row.active}/{row.max}</strong><div><i style={{width:`${Math.min(100,row.utilization_pct)}%`}}/></div><em>{row.utilization_pct}%</em></div>)}</div></section>
        {(operational.plans?.length || 0) > 0 && <section className="operations-card wide"><header><div><strong>PLANOS V60</strong><span>1 comando do Supervisor → N branches internas</span></div><b>{operational.plans?.length || 0}</b></header><div className="operations-projects">{operational.plans?.map((plan)=><article key={plan.plan_id}><div><strong>{plan.plan_id}</strong><small>{plan.intent} · {plan.status}</small></div><span><b>{plan.branches_active}</b><small>branches ativos</small></span><span><b>{plan.branches_by_status.WAITING_SUPERVISOR || 0}</b><small>divergências</small></span><span><b>{plan.max_parallelism}</b><small>paralelismo máx.</small></span><span><b>{new Date(plan.updated_at).toLocaleTimeString("pt-BR")}</b><small>última atividade</small></span></article>)}</div></section>}
        <section className="operations-card wide"><header><div><strong>PROJETOS EM PRODUÇÃO</strong><span>Progresso canônico + workers + filas</span></div><b>{operational.projects.length}</b></header><div className="operations-projects">{operational.projects.map((project)=><article key={project.project_id}><div><strong>{project.name}</strong><small>{project.domain} · {project.status}</small></div><span><b>{project.progress.completed}/{project.progress.total}</b><small>resolvidos</small></span><span><b>{project.workers_active}</b><small>workers</small></span><span><b>{project.next_action || "—"}</b><small>próxima ação</small></span><span><b>{fmtDuration(project.total_time_ms)}</b><small>tempo total</small></span><div className="project-mini-progress"><i style={{width:`${project.progress.total?Math.round(project.progress.completed/project.progress.total*100):0}%`}}/></div></article>)}</div></section>
        <section className="operations-card"><header><div><strong>NICHO</strong><span>Isolamento operacional</span></div></header><div className="domain-list">{operational.domains.map((domain)=><article key={domain.domain}><strong>{domain.domain}</strong><span>{domain.active_projects} projetos · {domain.active_workers} workers</span><small>{Object.entries(domain.queue).filter(([,v])=>v).map(([k,v])=>`${k} ${v}`).join(" · ") || "sem backlog"}</small></article>)}</div></section>
        <section className="operations-card"><header><div><strong>GARGALOS</strong><span>Maior backlog por etapa</span></div></header><div className="bottleneck-list">{operational.bottlenecks.map((item)=><div key={item.stage}><span>{item.stage}</span><b>{item.count}</b><small>{item.active} worker(s) ativo(s)</small></div>)}</div></section>
      </div>
    </> : <EmptyState icon="!" title="Painel indisponível" text="Não foi possível obter a telemetria operacional."/> : management ? <>
      <div className="operations-kpis"><article><small>Projetos criados · 30d</small><strong>{management.totals.projects_created}</strong><span>{management.totals.projects_completed} concluídos</span></article><article><small>Unidades concluídas</small><strong>{management.totals.work_completed}</strong><span>{management.totals.projects_in_progress} projetos em andamento</span></article><article><small>Retrabalho</small><strong>{management.totals.relinks}</strong><span>relinks no período</span></article><article><small>Retomadas / abandonos</small><strong>{management.totals.resumes}/{management.totals.lease_abandons}</strong><span>eventos de lease</span></article></div>
      <div className="operations-grid management-grid">
        <section className="operations-card wide"><header><div><strong>TEMPO POR ETAPA</strong><span>Média · P50 · P95 · P99</span></div></header><div className="metrics-table"><div className="metric-row head"><span>Etapa</span><span>Concluídos</span><span>Média</span><span>P50</span><span>P95</span><span>P99</span><span>Espera média</span></div>{management.stage_metrics.map((row)=><div className="metric-row" key={row.stage}><span><b>{row.stage}</b></span><span>{row.count}</span><span>{fmtDuration(row.avg_ms)}</span><span>{fmtDuration(row.p50_ms)}</span><span>{fmtDuration(row.p95_ms)}</span><span>{fmtDuration(row.p99_ms)}</span><span>{fmtDuration(row.avg_queue_wait_ms)}</span></div>)}</div></section>
        <section className="operations-card"><header><div><strong>THROUGHPUT DIÁRIO</strong><span>Últimos {management.period_days} dias</span></div></header><div className="throughput-bars">{management.throughput_by_day.slice(-14).map((day)=>{const max=Math.max(1,...management.throughput_by_day.map((x)=>x.completed));return <div key={day.day}><small>{day.day.slice(5)}</small><span><i style={{height:`${Math.max(3,Math.round(day.completed/max*100))}%`}}/></span><b>{day.completed}</b></div>})}</div></section>
        <section className="operations-card"><header><div><strong>PRODUTIVIDADE POR NICHO</strong><span>Projetos e trabalho concluído</span></div></header><div className="domain-list">{management.domains.map((domain)=><article key={domain.domain}><strong>{domain.domain}</strong><span>{domain.projects_completed}/{domain.projects_created} projetos concluídos</span><small>{domain.work_completed} unidades · {domain.relinks} relinks · {domain.abandons} abandonos</small></article>)}</div></section>
        <section className="operations-card wide"><header><div><strong>PRODUTIVIDADE POR WORKER</strong><span>Histórico operacional do período</span></div></header><div className="worker-productivity">{management.workers.map((worker)=><article key={worker.worker_id}><strong>{worker.worker_id}</strong><span><b>{worker.completed}</b><small>concluídos</small></span><span><b>{fmtDuration(worker.avg_duration_ms)}</b><small>tempo médio</small></span><span><b>{worker.failures}</b><small>falhas</small></span><span><b>{worker.abandons}</b><small>abandono</small></span></article>)}</div></section>
      </div>
    </> : <EmptyState icon="!" title="Dashboard indisponível" text="Ainda não há telemetria gerencial suficiente."/>}
  </div>;
}

function OperationalPolicyWorkspace({ onFlash }: { onFlash:(message:string)=>void }) {
  const [data,setData]=useState<PolicyWorkspaceDashboard|null>(null);
  const [loading,setLoading]=useState(true);
  const [tab,setTab]=useState<"policies"|"gaps"|"core">("policies");
  const load=useCallback(async()=>{ const response=await fetch("/api/policies",{cache:"no-store"}); if(!response.ok)throw new Error(); setData(await response.json() as PolicyWorkspaceDashboard); },[]);
  useEffect(()=>{load().catch(()=>onFlash("Não foi possível carregar o Workspace de Políticas.")).finally(()=>setLoading(false));},[load,onFlash]);
  const telemetry=data?.telemetry;
  return <div className="content policy-workspace-page">
    <div className="page-heading"><div><p>APRENDIZADO INDUSTRIAL</p><h1>Políticas operacionais</h1><span>Gaps recorrentes viram regras versionadas, testáveis e reutilizáveis sem alterar CORE_RULES.</span></div><button className="secondary" onClick={()=>{setLoading(true);load().finally(()=>setLoading(false))}}>↻ Atualizar</button></div>
    <div className="inventory-kpis"><article><span>POLÍTICAS ATIVAS</span><strong>{telemetry?.policies_active??"—"}</strong><small>{telemetry?.policies_total??0} versões registradas</small></article><article className="critical"><span>GAPS ABERTOS</span><strong>{telemetry?.gaps_open??"—"}</strong><small>{Math.round((telemetry?.repeated_gap_rate||0)*100)}% recorrentes</small></article><article><span>CHAMADAS EVITADAS</span><strong>{telemetry?.requests_saved??0}</strong><small>{telemetry?.external_requests_saved??0} externas evitadas</small></article><article><span>ROLLBACKS</span><strong>{telemetry?.rollback_count??0}</strong><small>histórico preservado</small></article></div>
    <div className="inventory-tabs"><button className={tab==="policies"?"active":""} onClick={()=>setTab("policies")}>Políticas</button><button className={tab==="gaps"?"active":""} onClick={()=>setTab("gaps")}>Gaps</button><button className={tab==="core"?"active":""} onClick={()=>setTab("core")}>CORE_RULES</button><span>{data?.learning_enabled?"Aprendizado operacional · ON":"Aprendizado operacional · OFF"}</span></div>
    {loading?<EmptyState icon="◌" title="Carregando políticas" text="Compilando regras, gaps e telemetria do Workspace."/>:tab==="policies"?<section className="inventory-panel"><header><div><strong>Políticas versionadas</strong><span>Mais específico vence; CORE_RULE sempre tem precedência.</span></div></header><div className="policy-workspace-grid">{(data?.policies||[]).map((policy)=><article key={policy.id}><header><div><strong>{policy.name}</strong><span>{policy.category} · {policy.scopeLevel}</span></div><b>v{policy.version}</b></header><p>{policy.domain||"GLOBAL"}{policy.universe?` · ${policy.universe}`:""}</p><footer><em>{policy.status}</em><span>conf. {policy.confidence}% · {policy.timesApplied} aplicações</span></footer></article>)}</div></section>:tab==="gaps"?<section className="inventory-panel"><header><div><strong>Memória de gaps</strong><span>Assinaturas estáveis evitam redescobrir a mesma falha em novos projetos.</span></div></header><div className="policy-gap-list">{(data?.gaps||[]).map((gap)=><article key={gap.id}><div><strong>{gap.signature}</strong><span>{gap.category} · {gap.severity}</span></div><b>{gap.occurrenceCount}×</b><p>{gap.symptom}</p><em>{gap.status}</em></article>)}</div></section>:<section className="inventory-panel"><header><div><strong>CORE_RULES imutáveis</strong><span>Políticas aprendidas nunca podem sobrescrever estas regras.</span></div></header><div className="core-rule-list">{(data?.core_rules||[]).map((rule)=><span key={rule}>🔒 {rule.replaceAll("_"," ")}</span>)}</div></section>}
  </div>;
}

function FastPushInbox({ onFlash }: { onFlash:(message:string)=>void }) {
  const [rows,setRows]=useState<FastPushCandidate[]>([]), [totals,setTotals]=useState<FastPushTotals>({total:0,pending:0,approved:0,rejected:0,failed:0});
  const [loading,setLoading]=useState(true), [busy,setBusy]=useState(false), [selected,setSelected]=useState<string[]>([]);
  const [textFilter,setTextFilter]=useState(""), [projectFilter,setProjectFilter]=useState(""), [universeFilter,setUniverseFilter]=useState(""), [statusFilter,setStatusFilter]=useState("PENDING_ANALYSIS"), [sourceFilter,setSourceFilter]=useState("");
  const load=useCallback(async()=>{
    const params=new URLSearchParams({limit:"200"});
    if(textFilter) params.set("q",textFilter); if(projectFilter) params.set("project_id",projectFilter); if(universeFilter) params.set("universe",universeFilter); if(statusFilter) params.set("status",statusFilter); if(sourceFilter) params.set("source_type",sourceFilter);
    const response=await fetch(`/api/fast-push?${params.toString()}`,{cache:"no-store"});
    if(!response.ok) throw new Error("Falha ao carregar Inbox.");
    const payload=await response.json() as {candidates:FastPushCandidate[];totals:FastPushTotals}; setRows(payload.candidates||[]);setTotals(payload.totals||{total:0,pending:0,approved:0,rejected:0,failed:0});
  },[textFilter,projectFilter,universeFilter,statusFilter,sourceFilter]);
  useEffect(()=>{const timer=window.setTimeout(()=>load().catch(()=>onFlash("Não foi possível carregar a Inbox FAST PUSH.")).finally(()=>setLoading(false)),120);return()=>window.clearTimeout(timer)},[load,onFlash]);
  async function decide(action:"approve"|"reject") {
    if(!selected.length) return; setBusy(true);
    try { const response=await fetch("/api/fast-push",{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({action,candidate_ids:selected,note:action==="approve"?"Aprovado manualmente na Inbox FAST PUSH":"Rejeitado manualmente na Inbox FAST PUSH"})}); const payload=await response.json() as {error?:string;summary?:Record<string,number>}; if(!response.ok) throw new Error(payload.error||"Falha na decisão."); setSelected([]); await load(); const promoted=payload.summary?.PROMOTED_TO_ASSET||0, rejected=payload.summary?.REJECTED||0; onFlash(action==="approve"?`${promoted} candidata(s) promovida(s) ao Catálogo.`:`${rejected} candidata(s) rejeitada(s).`); }
    catch(error){onFlash(error instanceof Error?error.message:"Falha na decisão FAST PUSH.")} finally{setBusy(false)}
  }
  function toggle(id:string){setSelected((current)=>current.includes(id)?current.filter((value)=>value!==id):[...current,id])}
  const pendingSelectable=rows.filter((row)=>["PENDING_ANALYSIS","DUPLICATE_REUSED","APPROVED_CANDIDATE"].includes(row.status));
  return <div className="content fast-push-page">
    <div className="page-heading"><div><p>INGESTÃO DE ALTA VAZÃO</p><h1>Inbox de candidatas</h1><span>FAST PUSH salva primeiro e decide depois. Aprovação manual, Supervisor e análise automática compartilham a mesma fila.</span></div><div className="heading-actions"><button className="secondary" onClick={()=>{setLoading(true);load().finally(()=>setLoading(false))}}>↻ Atualizar</button><button className="secondary" onClick={()=>setSelected(pendingSelectable.map((row)=>row.id))}>☑ Selecionar visíveis</button></div></div>
    <div className="fast-push-kpis"><article><span>TOTAL</span><strong>{totals.total}</strong><small>candidatas ingeridas</small></article><article className="pending"><span>PENDING ANALYSIS</span><strong>{totals.pending}</strong><small>aguardando decisão</small></article><article><span>PROMOVIDAS</span><strong>{totals.approved}</strong><small>asset permanente</small></article><article><span>REJEITADAS / FALHAS</span><strong>{totals.rejected} / {totals.failed}</strong><small>registro preservado</small></article></div>
    <div className="fast-push-filters"><label><SearchIcon/><input value={textFilter} onChange={(event)=>setTextFilter(event.target.value)} placeholder="Conceito, cena, sujeito ou URL..."/></label><input value={projectFilter} onChange={(event)=>setProjectFilter(event.target.value)} placeholder="Projeto ID"/><input value={universeFilter} onChange={(event)=>setUniverseFilter(event.target.value)} placeholder="Universo"/><select value={statusFilter} onChange={(event)=>setStatusFilter(event.target.value)}><option value="">Todos os status</option><option>PENDING_ANALYSIS</option><option>DUPLICATE_REUSED</option><option>PROMOTED_TO_ASSET</option><option>REJECTED</option><option>FAILED_HTTP</option><option>FAILED_INVALID_MIME</option><option>FAILED_DOWNLOAD</option></select><input value={sourceFilter} onChange={(event)=>setSourceFilter(event.target.value)} placeholder="Fonte"/></div>
    {selected.length>0&&<div className="selection-bar pending-selection fast-push-selection"><div><b>{selected.length}</b><span>candidatas selecionadas</span></div><button className="approve-selection" disabled={busy} onClick={()=>decide("approve")}>✓ Aprovar e promover</button><button className="delete-selection" disabled={busy} onClick={()=>decide("reject")}>⊘ Rejeitar</button><button className="clear" onClick={()=>setSelected([])}>Limpar seleção</button></div>}
    {loading?<EmptyState icon="◌" title="Carregando Inbox" text="Lendo candidatas persistidas no D1."/>:rows.length===0?<EmptyState icon="▤" title="Nenhuma candidata neste filtro" text="FAST PUSH aparecerá aqui assim que URLs ou arquivos forem ingeridos."/>:<div className="fast-push-grid">{rows.map((row)=><article className={`fast-push-card ${selected.includes(row.id)?"selected":""}`} key={row.id}><div className="fast-push-preview">{row.r2Key&&row.mimeType?.startsWith("image/")?<img src={`/api/fast-push/${encodeURIComponent(row.id)}?preview=1`} alt={row.concept||row.subject||row.id}/>:<div className="asset-placeholder">▧<small>{row.mimeType||"sem arquivo"}</small></div>}<button className="check" onClick={()=>toggle(row.id)}>{selected.includes(row.id)?"✓":""}</button><span className={`fast-status state-${row.status.toLowerCase()}`}>{row.status.replaceAll("_"," ")}</span></div><div className="fast-push-info"><header><div><strong>{row.concept||row.subject||row.targetName||"Candidata"}</strong><span>{row.universe||"Sem universo"} · {row.sourceType}</span></div><b>P{row.priority}</b></header><p>{row.scene||row.visualReference||row.scriptReference||"Sem referência de cena"}</p><div className="fast-meta"><span>Projeto <b>{row.projectId||"—"}</b></span><span>PITEM <b>{row.projectItemId||row.itemId||"—"}</b></span><span>Vínculo <b>{row.projectLinkStatus?.replaceAll("_"," ")||"—"}</b></span><span>Slot <b>{row.slot||row.itemId||"—"}</b></span><span>SHA <b>{row.sha256?.slice(0,10)||"—"}</b></span></div><div className="tags">{row.tags.slice(0,4).map((tag)=><i key={tag}>{tag}</i>)}</div>{row.failureReason&&<em className="fast-error">{row.failureReason}</em>}<footer><small>{row.id}</small>{row.assetId&&<span>→ {row.assetId}</span>}<a href={row.sourceUrl.startsWith("https://")?row.sourceUrl:undefined} target="_blank" rel="noreferrer">fonte ↗</a></footer></div></article>)}</div>}
  </div>;
}

function InventoryIntelligence({ onFlash }: { onFlash: (message: string) => void }) {
  const [dashboard, setDashboard] = useState<InventoryDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"estoque"|"hosts"|"pipeline">("estoque");
  const [filter, setFilter] = useState("");
  const load = useCallback(async () => {
    const response = await fetch("/api/inventory", { cache: "no-store" });
    if (!response.ok) throw new Error();
    setDashboard(await response.json() as InventoryDashboard);
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => load().catch(() => onFlash("Não foi possível carregar a inteligência de estoque.")).finally(() => setLoading(false)), 0);
    return () => window.clearTimeout(timer);
  }, [load, onFlash]);
  async function configure(group: StockGroup) {
    const minimum = Number(window.prompt("Estoque mínimo", String(group.minimum)));
    if (!Number.isFinite(minimum)) return;
    const ideal = Number(window.prompt("Estoque ideal", String(group.ideal)));
    if (!Number.isFinite(ideal)) return;
    const maximum = Number(window.prompt("Estoque máximo", String(group.maximum)));
    if (!Number.isFinite(maximum)) return;
    const response = await fetch("/api/inventory", { method:"PUT", headers:{"content-type":"application/json"}, body:JSON.stringify({ conceito:group.concept, universo:group.universe, tipo:group.kind, minimo:minimum, ideal, maximo:maximum }) });
    if (!response.ok) { onFlash("Não foi possível salvar a política."); return; }
    await load(); onFlash("Política de estoque salva e aplicada.");
  }
  const groups = (dashboard?.groups || []).filter((group) => `${group.concept} ${group.universe} ${group.kind}`.toLowerCase().includes(filter.toLowerCase()));
  const totals = dashboard?.totals;
  return <div className="content inventory-page">
    <div className="page-heading"><div><p>INTELIGÊNCIA OPERACIONAL</p><h1>Estoque & giro</h1><span>A Biblioteca decide quando reutilizar, coletar, reduzir ou bloquear novas entradas.</span></div><button className="secondary" onClick={() => {setLoading(true);load().finally(()=>setLoading(false))}}>↻ Atualizar métricas</button></div>
    <div className="inventory-kpis"><article><span>ASSETS APROVADOS</span><strong>{totals?.approvedAssets ?? "—"}</strong><small>{totals?.reuseRate ?? 0}% já reutilizados</small></article><article className="critical"><span>LACUNAS ABAIXO DO MÍNIMO</span><strong>{totals?.belowMinimum ?? "—"}</strong><small>coleta priorizada</small></article><article><span>GRUPOS MADUROS</span><strong>{totals?.mature ?? "—"}</strong><small>5+ variações</small></article><article><span>EM MATERIALIZAÇÃO / QA</span><strong>{(totals?.materializing ?? 0) + (totals?.qa ?? 0)}</strong><small>{totals?.materializing ?? 0} processando · {totals?.qa ?? 0} em QA</small></article></div>
    <div className="inventory-tabs"><button className={tab==="estoque"?"active":""} onClick={()=>setTab("estoque")}>Estoque semântico</button><button className={tab==="hosts"?"active":""} onClick={()=>setTab("hosts")}>Ranking de fontes</button><button className={tab==="pipeline"?"active":""} onClick={()=>setTab("pipeline")}>Pipeline & filas</button><span>8 globais · 2/host · timeout 12s</span></div>
    {loading ? <EmptyState icon="◌" title="Calculando estoque" text="Cruzando catálogo, consultas, materializações, QA e fontes."/> : tab === "estoque" ? <section className="inventory-panel"><header><div><strong>Saldo por conceito</strong><span>Mínimo / ideal / máximo controlam a coleta externa.</span></div><div className="inventory-panel-actions"><input value={filter} onChange={(event)=>setFilter(event.target.value)} placeholder="Filtrar conceito..."/><a className="button-link" href={`/api/inventory?format=txt&tab=estoque&concept=${encodeURIComponent(filter)}`}>↓ Exportar TXT</a></div></header>{groups.length ? <div className="stock-table"><div className="stock-row stock-head"><span>Conceito</span><span>Saldo</span><span>Fluxo</span><span>Giro</span><span>Política</span><span>Decisão</span></div>{groups.map((group)=><div className="stock-row" key={group.key}><div><strong>{group.concept}</strong><small>{group.universe} · {group.kind}</small></div><span><b>{group.approved}</b> aprovados<small>{group.rejected} rejeitados</small></span><span><b>{group.materializing + group.qa}</b> ativos<small>{group.qa} aguardando QA</small></span><span><b>{group.uses}</b> usos<small>{group.daysWithoutUse === null ? "nunca usado" : `${group.daysWithoutUse} dias sem uso`}</small></span><button className="policy-button" onClick={()=>configure(group)}>{group.minimum} / {group.ideal} / {group.maximum}<small>ajustar</small></button><em className={`stock-decision ${group.status.toLowerCase()}`}>{group.action.replaceAll("_"," ")}<small>{group.maturity}</small></em></div>)}</div> : <EmptyState icon="◈" title="Sem grupos semânticos" text="Os grupos aparecem após catalogar assets ou configurar a primeira política."/>}</section>
    : tab === "hosts" ? <section className="inventory-panel"><header><div><strong>Score técnico das fontes</strong><span>Sucesso técnico × QA visual × velocidade × estabilidade.</span></div><a className="button-link" href="/api/inventory?format=txt&tab=hosts">↓ Exportar TXT</a></header>{dashboard?.hosts.length ? <div className="host-grid">{dashboard.hosts.map((host)=><article key={host.host}><header><div><strong>{host.host}</strong><span>{host.classification}</span></div><b>{host.score}</b></header><div className="scorebar"><i style={{width:`${host.score}%`}}/></div><dl><div><dt>Técnico</dt><dd>{host.technicalRate}%</dd></div><div><dt>QA visual</dt><dd>{host.visualRate}%</dd></div><div><dt>Latência média</dt><dd>{(host.avgLatencyMs/1000).toFixed(1)}s</dd></div><div><dt>P95</dt><dd>{(host.p95LatencyMs/1000).toFixed(1)}s</dd></div></dl></article>)}</div> : <EmptyState icon="⌁" title="Ainda sem histórico de hosts" text="O ranking surge quando a fila tenta materializar URLs externas."/>}</section>
    : <section className="inventory-panel"><header><div><strong>Telemetria do pipeline</strong><span>Estados persistidos, latência e espera por QA.</span></div><a className="button-link" href="/api/inventory?format=txt&tab=pipeline">↓ Exportar TXT</a></header><div className="pipeline-grid"><article><span>DOWNLOAD MÉDIO</span><strong>{((dashboard?.pipeline.avgDownloadMs||0)/1000).toFixed(1)}s</strong><small>P95 {((dashboard?.pipeline.p95DownloadMs||0)/1000).toFixed(1)}s</small></article><article><span>ESPERA MÉDIA DE QA</span><strong>{((dashboard?.pipeline.avgQaWaitMs||0)/60000).toFixed(1)}min</strong><small>P95 {((dashboard?.pipeline.p95QaWaitMs||0)/60000).toFixed(1)}min</small></article><article className="pipeline-statuses"><span>ESTADOS DA FILA</span><div>{Object.entries(dashboard?.pipeline.statusCounts||{}).map(([status,count])=><i key={status}><b>{count}</b>{status.replaceAll("_"," ")}</i>)}</div></article></div></section>}
  </div>;
}

function friendlyCollectionMessage(value: unknown) {
  const raw = String(value || "");
  if (!raw || raw === "OK") return "Rodada concluída";
  if (/failed query:\s*insert into [\"`]collection_terms/i.test(raw) || raw.includes("too many SQL variables")) return "Não foi possível gravar os termos no banco. Nenhum lote parcial foi mantido; tente novamente.";
  if (raw.includes("SEGREDO_NAO_CONFIGURADO")) return "Fonte pulada: chave de API ainda não configurada";
  if (raw.includes("FONTE_HTTP_")) return `Fonte recusou a consulta (${raw.match(/FONTE_HTTP_(\d+)/)?.[1] || "HTTP"})`;
  if (raw.includes("TIMEOUT")) return "Fonte demorou demais e foi pulada";
  if (raw.includes("LIMITES_ESGOTADOS")) return "Limites do termo atingidos";
  if (raw.includes("DUPLICATA")) return "Resultado duplicado descartado";
  if (raw.includes("BRAVE_DISCOVERY_NAO_CONFIGURADO")) return "Discovery pulado: Brave ainda não configurado";
  return raw.replace(/[_:]+/g, " ").toLocaleLowerCase("pt-BR").slice(0, 150);
}

function friendlyProjectStatus(status: string) {
  const labels: Record<string,string> = {
    CONCLUIDO_MANUAL: "CONCLUÍDO",
    COMPLETED: "CONCLUÍDO",
    COMPLETED_WITH_WARNINGS: "CONCLUÍDO",
    FORCED_CLOSED: "CONCLUÍDO",
    MOTOR_LIBRARY_RODADO: "MOTOR LIBRARY RODADO",
  };
  return labels[status] || status.replaceAll("_", " ");
}

function projectIsCompleted(status: string) {
  return ["CONCLUIDO_MANUAL", "COMPLETED", "COMPLETED_WITH_WARNINGS", "FORCED_CLOSED"].includes(status);
}

function projectOperationalLabel(project: AutomaticProject) {
  if (project.pipelineStatus === "PRONTO_PARA_RETOMADA") return "PROCESSO NÃO FINALIZADO";
  if (project.pipelineStatus === "AGUARDANDO_QA") return "AGUARDANDO SUPERVISOR";
  if (project.pipelineStatus === "AGUARDANDO_RELINK") return "AGUARDANDO RELINK";
  if (project.resumedAt && project.supervisorStatus === "ATIVO") return "RETOMADO";
  return friendlyProjectStatus(project.status);
}

function projectOperationalClass(project: AutomaticProject) {
  if (project.pipelineStatus === "PRONTO_PARA_RETOMADA") return "pronto_para_retomada";
  if (project.pipelineStatus === "AGUARDANDO_QA" || project.pipelineStatus === "AGUARDANDO_RELINK") return "aguardando_supervisor";
  if (project.resumedAt && project.supervisorStatus === "ATIVO") return "retomado";
  return project.status.toLowerCase();
}

function AutomaticCollection({ onFlash }: { onFlash: (message: string) => void }) {
  const [batches, setBatches] = useState<CollectionBatch[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<CollectionDetail | null>(null);
  const [name, setName] = useState(""), [terms, setTerms] = useState(""), [sources, setSources] = useState("");
  const [busy, setBusy] = useState(false), [stepActive, setStepActive] = useState(false), [runtimeError, setRuntimeError] = useState("");
  const termsFile = useRef<HTMLInputElement>(null), sourcesFile = useRef<HTMLInputElement>(null), requestActive = useRef(false);

  const loadBatches = useCallback(async () => {
    const response = await fetch("/api/collections", { cache: "no-store" });
    if (response.ok) setBatches(((await response.json()) as { lotes: CollectionBatch[] }).lotes || []);
  }, []);
  const loadDetail = useCallback(async (id: string) => {
    if (!id) return;
    const response = await fetch(`/api/collections?id=${encodeURIComponent(id)}`, { cache: "no-store" });
    if (response.ok) setDetail(await response.json() as CollectionDetail);
  }, []);

  useEffect(() => { const timer = window.setTimeout(() => loadBatches().catch(() => undefined), 0); return () => window.clearTimeout(timer); }, [loadBatches]);
  useEffect(() => {
    if (!selectedId) return;
    const initial = window.setTimeout(() => loadDetail(selectedId).catch(() => undefined), 0);
    const timer = window.setInterval(() => loadDetail(selectedId).catch(() => undefined), 2500);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [selectedId, loadDetail]);
  useEffect(() => {
    if (!selectedId || detail?.lote.status !== "EXECUTANDO") return;
    let stopped = false;
    const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
    async function loop() {
      while (!stopped) {
        if (requestActive.current) { await wait(400); continue; }
        requestActive.current = true; setStepActive(true);
        try {
          const response = await fetch("/api/collections", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ lote_id: selectedId, acao: "executar", max_rodadas: 1 }) });
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.error || "Falha temporária da rodada");
          setDetail(payload as CollectionDetail); setRuntimeError(""); loadBatches().catch(() => undefined);
          if (["CONCLUIDO", "CONCLUIDO_COM_PENDENCIAS", "CANCELADO", "PAUSADO"].includes(String(payload.lote?.status))) break;
          await wait(900);
        } catch (error) {
          setRuntimeError(friendlyCollectionMessage(error instanceof Error ? error.message : error));
          await wait(5000);
        } finally { requestActive.current = false; setStepActive(false); }
      }
    }
    loop().catch(() => undefined);
    return () => { stopped = true; };
  }, [selectedId, detail?.lote.status, loadBatches]);

  async function loadTxt(file: File | undefined, setter: (value: string) => void) { if (file) setter(await file.text()); }
  async function createBatch() {
    if (!terms.trim()) return onFlash("Informe os termos da coleta."); setBusy(true);
    try {
      const response = await fetch("/api/collections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nome: name, termos_texto: terms, fontes_texto: sources, max_urls_por_termo: 100, max_fontes_por_termo: 20, max_rodadas_por_termo: 5, max_minutos_por_termo: 45, max_minutos_total: 480 }) });
      const payload = await response.json(); if (!response.ok) throw new Error(payload.error || "Falha ao criar lote");
      setSelectedId(payload.lote.id); setDetail(payload as CollectionDetail); await loadBatches();
      const imported = payload.importacao_txt; onFlash(imported ? `${imported.termos_aceitos} termos carregados; ${imported.linhas_ignoradas} linha ignorada.` : "Lote criado.");
    } catch (error) { onFlash(friendlyCollectionMessage(error instanceof Error ? error.message : error)); } finally { setBusy(false); }
  }
  async function control(action: "executar" | "pausar" | "retomar" | "cancelar") {
    if (!selectedId) return; setBusy(true);
    try {
      const response = await fetch("/api/collections", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ lote_id: selectedId, acao: action, max_rodadas: 1 }) });
      const payload = await response.json(); if (!response.ok) throw new Error(payload.error || "Falha na ação"); setDetail(payload as CollectionDetail); await loadBatches(); setRuntimeError("");
      onFlash(action === "pausar" ? "Coleta pausada com progresso salvo." : action === "cancelar" ? "Lote cancelado." : "Coleta iniciada; o monitor continuará atualizando.");
    } catch (error) { onFlash(friendlyCollectionMessage(error instanceof Error ? error.message : error)); } finally { setBusy(false); }
  }
  function saveTemplate(kind: "terms" | "sources") {
    const content = kind === "terms" ? "TERMO | QUANTIDADE | TIPO | UNIVERSO_OPCIONAL\n" : "[NOME_DA_FONTE]\nNOME:\nURL_BASE:\nMETODO: GET\nPARAMETRO_DE_BUSCA:\nPARAMETRO_DE_LIMITE:\nCAMINHO_DA_URL_DA_IMAGEM:\nCAMINHO_DA_THUMBNAIL:\nPRIORIDADE:\nATIVO: SIM\nAPI_KEY_ENV:\nAPI_KEY_HEADER:\nOBSERVACAO:\n";
    const href = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" })); const anchor = document.createElement("a"); anchor.href = href; anchor.download = kind === "terms" ? "TERMOS_COLETA.txt" : "FONTES_COLETA.txt"; anchor.click(); URL.revokeObjectURL(href);
  }
  const current = detail?.lote, currentTerm = detail?.termo_atual;
  const heartbeat = detail?.heartbeat_utc ? new Date(detail.heartbeat_utc).toLocaleTimeString("pt-BR") : "—";
  return <div className="content collection-page">
    <div className="page-heading"><div><p>ABASTECIMENTO AUTÔNOMO</p><h1>Coleta automática</h1><span>Monitor legível de pesquisa, materialização e fila para análise.</span></div><div className="heading-actions"><button className="secondary" onClick={() => saveTemplate("terms")}>↓ Modelo de termos</button><button className="secondary" onClick={() => saveTemplate("sources")}>↓ Modelo de fontes</button></div></div>
    <div className="collection-layout">
      <section className="collection-config"><header><div><small>NOVO LOTE</small><h2>Configuração persistente</h2></div><span className="night-badge">☾ MODO NOTURNO</span></header><label>NOME DO LOTE<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Nome opcional"/></label><label>TERMOS <em>TERMO | quantidade | tipo | universo</em><textarea rows={7} value={terms} onChange={(event) => setTerms(event.target.value)} placeholder="Cole ou carregue o TXT"/></label><div className="file-actions"><button onClick={() => termsFile.current?.click()}>⇧ Carregar TXT de termos</button><input ref={termsFile} type="file" accept=".txt,text/plain" onChange={(event) => loadTxt(event.target.files?.[0], setTerms)}/><span>{Math.max(0, terms.split("\n").filter((line) => line.trim()).length - (terms.toUpperCase().startsWith("TERMO |") ? 1 : 0))} termos</span></div><label>FONTES <em>Se vazio, usa as fontes salvas</em><textarea rows={7} value={sources} onChange={(event) => setSources(event.target.value)} placeholder="Cole ou carregue o TXT das fontes"/></label><div className="file-actions"><button onClick={() => sourcesFile.current?.click()}>⇧ Carregar TXT de fontes</button><input ref={sourcesFile} type="file" accept=".txt,text/plain" onChange={(event) => loadTxt(event.target.files?.[0], setSources)}/><span>Chaves protegidas por ambiente</span></div><button className="primary collection-create" disabled={busy || !terms.trim()} onClick={createBatch}>{busy ? "Salvando…" : "＋ Criar lote persistente"}</button></section>
      <section className="collection-monitor"><header><div><small>MONITOR AO VIVO</small><h2>{current?.name || "Selecione um lote"}</h2></div>{current && <em className={`collection-state state-${current.status.toLowerCase()}`}>{current.status}</em>}</header>
        {!current ? <div className="collection-empty">◉<strong>Nenhuma coleta selecionada</strong><span>Crie um lote ou abra um histórico.</span></div> : <>
          <div className={`live-strip ${current.status === "EXECUTANDO" ? "live" : ""}`}><i/><div><strong>{current.status === "EXECUTANDO" ? stepActive ? "Coletando agora" : "Preparando próxima rodada" : current.status === "PAUSADO" ? "Coleta pausada" : current.status.startsWith("CONCLUIDO") ? "Coleta finalizada" : "Aguardando início"}</strong><span>Último sinal às {heartbeat}{runtimeError ? ` · nova tentativa automática em instantes` : ""}</span></div></div>
          {runtimeError && <div className="runtime-warning"><strong>Uma rodada falhou, mas o lote não parou.</strong><span>{runtimeError}</span></div>}
          <div className="now-grid"><article><small>TERMO ATUAL</small><strong>{currentTerm?.term || "—"}</strong><span>{currentTerm ? `${currentTerm.collectedCount}/${currentTerm.targetQuantity} · ${currentTerm.status}` : "Nenhum termo em andamento"}</span></article><article><small>FONTE ATUAL</small><strong>{detail?.fonte_atual?.name || "—"}</strong><span>{detail?.fonte_atual?.method || "Aguardando"}</span></article></div>
          <div className="collection-progress"><div><strong>{detail?.progresso_percentual || 0}%</strong><span>{current.totalCollected} de {current.totalTarget} materializados</span></div><div className="progress"><i style={{ width: `${Math.min(100, detail?.progresso_percentual || 0)}%` }}/></div></div>
          <div className="collection-actions">{current.status === "PAUSADO" ? <button className="primary" disabled={busy} onClick={() => control("retomar")}>▶ Retomar</button> : !current.status.startsWith("CONCLUIDO") && current.status !== "CANCELADO" && <><button className="primary" disabled={busy || current.status === "EXECUTANDO"} onClick={() => control("executar")}>{current.status === "EXECUTANDO" ? "● Em execução" : "▶ Iniciar"}</button><button disabled={busy} onClick={() => control("pausar")}>Ⅱ Pausar</button></>} {!current.status.startsWith("CONCLUIDO") && current.status !== "CANCELADO" && <button className="danger-soft" disabled={busy} onClick={() => control("cancelar")}>Cancelar</button>}<a className="button-link" href={`/api/collections?id=${encodeURIComponent(current.id)}&view=report`}>↓ Resumo</a><a className="button-link log-download" href={`/api/collections?id=${encodeURIComponent(current.id)}&view=detailed-log`} download title="Baixa fontes, URLs, etapas e erros de cada imagem">↓ Log detalhado TXT</a></div>
          <div className="status-chips">{Object.entries(detail?.contagem_status || {}).map(([status, count]) => <span key={status}><b>{count}</b>{status}</span>)}</div>
          <div className="activity-feed"><header><strong>Atividade recente</strong><span>Atualização automática</span></header>{detail?.atividade?.length ? detail.atividade.map((item) => <article key={item.id}><i className={item.status === "CONCLUIDA" ? "ok" : "fail"}/><div><strong>{item.term}</strong><span>{item.source} · {friendlyCollectionMessage(item.detail)}</span></div><em>+{item.materializedCount} · {item.foundCount} encontrados</em></article>) : <p>A primeira consulta aparecerá aqui assim que terminar.</p>}</div>
          <div className="term-list"><header><strong>Termos do lote</strong><span>Mostrando {detail?.termos.length || 0} de {detail?.termos_total || current.totalTerms}</span></header>{detail?.termos.map((term) => <article key={term.id}><div><strong>{term.term}</strong><span>{term.kind} · {term.collectedCount}/{term.targetQuantity}</span></div><em>{term.status}</em></article>)}</div>
        </>}
      </section>
    </div>
    <section className="collection-history"><header><div><small>HISTÓRICO</small><h2>Lotes de coleta</h2></div><button onClick={loadBatches}>↻ Atualizar</button></header>{batches.length === 0 ? <p>Nenhum lote criado.</p> : batches.map((batch) => <button key={batch.id} className={selectedId === batch.id ? "active" : ""} onClick={() => setSelectedId(batch.id)}><span><strong>{batch.name}</strong><small>{new Date(batch.createdAt).toLocaleString("pt-BR")}</small></span><b>{batch.totalCollected}/{batch.totalTarget}</b><em>{batch.status}</em></button>)}</section>
  </div>;
}

function AutomaticCollectionLegacy({ onFlash }: { onFlash: (message: string) => void }) {
  const [batches, setBatches] = useState<CollectionBatch[]>([]), [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<{ lote: CollectionBatch; termos: Array<{ id:string; term:string; kind:string; targetQuantity:number; collectedCount:number; status:string }>; progresso_percentual:number } | null>(null);
  const [name, setName] = useState(""), [terms, setTerms] = useState(""), [sources, setSources] = useState(""), [busy, setBusy] = useState(false);
  const termsFile = useRef<HTMLInputElement>(null), sourcesFile = useRef<HTMLInputElement>(null);
  const refresh = async (id = selectedId) => {
    const listResponse = await fetch("/api/collections", { cache: "no-store" });
    if (listResponse.ok) setBatches(((await listResponse.json()) as { lotes: CollectionBatch[] }).lotes || []);
    if (id) { const response = await fetch(`/api/collections?id=${encodeURIComponent(id)}`, { cache: "no-store" }); if (response.ok) setDetail(await response.json()); }
  };
  useEffect(() => { const timer = window.setTimeout(() => refresh().catch(() => undefined), 0); return () => window.clearTimeout(timer); }, []);
  useEffect(() => {
    if (!selectedId || detail?.lote.status !== "EXECUTANDO") return;
    const timer = window.setTimeout(() => run("executar", false).catch(() => undefined), 1400);
    return () => window.clearTimeout(timer);
  }, [selectedId, detail?.lote.status, detail?.lote.totalCollected, detail?.lote.updatedAt]);
  async function loadTxt(file: File | undefined, setter: (value: string) => void) { if (file) setter(await file.text()); }
  async function createBatch() {
    if (!terms.trim()) return onFlash("Informe os termos da coleta."); setBusy(true);
    try {
      const response = await fetch("/api/collections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nome: name, termos_texto: terms, fontes_texto: sources, max_urls_por_termo: 100, max_fontes_por_termo: 20, max_rodadas_por_termo: 5, max_minutos_por_termo: 45, max_minutos_total: 480 }) });
      const payload = await response.json(); if (!response.ok) throw new Error(payload.error || "Falha"); setSelectedId(payload.lote.id); setDetail(payload); await refresh(payload.lote.id); onFlash("Lote persistido. Use iniciar para executar a coleta.");
    } catch (error) { onFlash(error instanceof Error ? error.message : "Não foi possível criar o lote."); } finally { setBusy(false); }
  }
  async function run(action: "executar" | "pausar" | "retomar" | "cancelar", announce = true) {
    if (!selectedId) return; setBusy(true);
    try { const response = await fetch("/api/collections", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ lote_id: selectedId, acao: action, max_rodadas: 1 }) }); const payload = await response.json(); if (!response.ok) throw new Error(payload.error || "Falha"); setDetail(payload); await refresh(selectedId); if (announce) onFlash(action === "pausar" ? "Coleta pausada com progresso salvo." : action === "cancelar" ? "Lote cancelado." : "Coleta automática em execução."); }
    catch (error) { if (announce) onFlash(error instanceof Error ? error.message : "Não foi possível executar a ação."); throw error; } finally { setBusy(false); }
  }
  function saveTemplate(kind: "terms" | "sources") {
    const content = kind === "terms" ? "TERMO | QUANTIDADE | TIPO | UNIVERSO_OPCIONAL\n" : "[NOME_DA_FONTE]\nNOME:\nURL_BASE:\nMETODO: GET\nPARAMETRO_DE_BUSCA:\nPARAMETRO_DE_LIMITE:\nCAMINHO_DA_URL_DA_IMAGEM:\nCAMINHO_DA_THUMBNAIL:\nPRIORIDADE:\nATIVO: SIM\nAPI_KEY_ENV:\nAPI_KEY_HEADER:\nOBSERVACAO:\n";
    const href = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" })); const anchor = document.createElement("a"); anchor.href = href; anchor.download = kind === "terms" ? "TERMOS_COLETA.txt" : "FONTES_COLETA.txt"; anchor.click(); URL.revokeObjectURL(href);
  }
  const current = detail?.lote;
  return <div className="content collection-page"><div className="page-heading"><div><p>ABASTECIMENTO AUTÔNOMO</p><h1>Coleta automática</h1><span>Pesquise por saldo, materialize no R2 e envie tudo para QA posterior.</span></div><div className="heading-actions"><button className="secondary" onClick={() => saveTemplate("terms")}>↓ Modelo de termos</button><button className="secondary" onClick={() => saveTemplate("sources")}>↓ Modelo de fontes</button></div></div>
    <div className="collection-layout"><section className="collection-config"><header><div><small>NOVO LOTE</small><h2>Configuração persistente</h2></div><span className="night-badge">☾ MODO NOTURNO</span></header><label>NOME DO LOTE<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Nome opcional"/></label><label>TERMOS <em>TERMO | quantidade | tipo | universo opcional</em><textarea rows={7} value={terms} onChange={(event) => setTerms(event.target.value)} placeholder="Cole uma linha por termo"/></label><div className="file-actions"><button onClick={() => termsFile.current?.click()}>⇧ Carregar TXT de termos</button><input ref={termsFile} type="file" accept=".txt,text/plain" onChange={(event) => loadTxt(event.target.files?.[0], setTerms)}/><span>{terms.split("\n").filter((line) => line.trim()).length} termos</span></div><label>FONTES <em>Se vazio, usa as fontes salvas</em><textarea rows={7} value={sources} onChange={(event) => setSources(event.target.value)} placeholder="Cole os blocos de configuração das fontes"/></label><div className="file-actions"><button onClick={() => sourcesFile.current?.click()}>⇧ Carregar TXT de fontes</button><input ref={sourcesFile} type="file" accept=".txt,text/plain" onChange={(event) => loadTxt(event.target.files?.[0], setSources)}/><span>Segredos só por API_KEY_ENV</span></div><button className="primary collection-create" disabled={busy || !terms.trim()} onClick={createBatch}>＋ Criar lote persistente</button></section>
      <section className="collection-monitor"><header><div><small>EXECUÇÃO</small><h2>{current?.name || "Selecione um lote"}</h2></div>{current && <em className={`collection-state state-${current.status.toLowerCase()}`}>{current.status}</em>}</header>{!current ? <div className="collection-empty">◉<strong>Nenhuma coleta selecionada</strong><span>Crie um lote ou abra um histórico abaixo.</span></div> : <><div className="collection-progress"><div><strong>{detail?.progresso_percentual || 0}%</strong><span>{current.totalCollected} de {current.totalTarget} materializados</span></div><div className="progress"><i style={{ width: `${Math.min(100, detail?.progresso_percentual || 0)}%` }}/></div></div><div className="collection-actions">{current.status === "PAUSADO" ? <button className="primary" disabled={busy} onClick={() => run("retomar")}>▶ Retomar</button> : !current.status.startsWith("CONCLUIDO") && current.status !== "CANCELADO" && <><button className="primary" disabled={busy} onClick={() => run("executar")}>{current.status === "EXECUTANDO" ? "◌ Executando" : "▶ Iniciar"}</button><button disabled={busy} onClick={() => run("pausar")}>Ⅱ Pausar</button></>} {!current.status.startsWith("CONCLUIDO") && current.status !== "CANCELADO" && <button className="danger-soft" disabled={busy} onClick={() => run("cancelar")}>Cancelar</button>}<a className="button-link" href={`/api/collections?id=${encodeURIComponent(current.id)}&view=report`}>↓ Relatório TXT</a></div><div className="term-list">{detail?.termos.map((term) => <article key={term.id}><div><strong>{term.term}</strong><span>{term.kind} · {term.collectedCount}/{term.targetQuantity}</span></div><em>{term.status}</em></article>)}</div></>}</section></div>
    <section className="collection-history"><header><div><small>HISTÓRICO</small><h2>Lotes de coleta</h2></div><button onClick={() => refresh()}>↻ Atualizar</button></header>{batches.length === 0 ? <p>Nenhum lote criado.</p> : batches.map((batch) => <button key={batch.id} className={selectedId === batch.id ? "active" : ""} onClick={async () => { setSelectedId(batch.id); await refresh(batch.id); }}><span><strong>{batch.name}</strong><small>{batch.id} · {new Date(batch.createdAt).toLocaleString("pt-BR")}</small></span><b>{batch.totalCollected}/{batch.totalTarget}</b><em>{batch.status}</em></button>)}</section></div>;
}


function AuthLoading() {
  return <main className="auth-shell"><section className="auth-card"><Mark className="auth-mark"/><span>CARREGANDO</span><h1>Corvo Library</h1><p>Preparando o acesso seguro…</p></section></main>;
}

function AuthScreen({ configured, suggestedUsername, onSubmit }: { configured:boolean; suggestedUsername:string; onSubmit:(endpoint:"/api/auth/setup"|"/api/auth/login",values:{username:string;password:string;remember:boolean})=>Promise<void> }) {
  const [username,setUsername]=useState(suggestedUsername || "admin");
  const [password,setPassword]=useState("");
  const [remember,setRemember]=useState(true);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  async function submit(event:React.FormEvent){event.preventDefault();setBusy(true);setError("");try{await onSubmit(configured?"/api/auth/login":"/api/auth/setup",{username,password,remember});}catch(err){setError(err instanceof Error?err.message:"Não foi possível entrar.");setBusy(false);}}
  return <main className="auth-shell"><form className="auth-card" onSubmit={submit}><Mark className="auth-mark"/><span>{configured?"ACESSO À LIBRARY":"PRIMEIRO ACESSO"}</span><h1>{configured?"Entrar":"Criar login"}</h1><p>{configured?"Use o nome e a senha gravados na Library.":"Escolha um nome e uma senha simples. Eles ficam gravados para os próximos acessos."}</p><label>NOME<input autoFocus autoComplete="username" value={username} onChange={e=>setUsername(e.target.value)} placeholder="admin"/></label><label>SENHA<input type="password" autoComplete={configured?"current-password":"new-password"} value={password} onChange={e=>setPassword(e.target.value)} placeholder="Sua senha"/></label><label className="remember-row"><input type="checkbox" checked={remember} onChange={e=>setRemember(e.target.checked)}/><span>Lembrar neste aparelho</span></label>{error&&<div className="auth-error">{error}</div>}<button className="primary auth-submit" disabled={busy||username.trim().length<2||password.length<4}>{busy?"Entrando…":configured?"Entrar":"Salvar e entrar"}</button><small>Senha mínima: 4 caracteres. Você poderá alterar o login depois em Configurações.</small></form></main>;
}

function AccessSettings({ username, onUpdated, onLogout }: { username:string; onUpdated:(username:string)=>void; onLogout:()=>void }) {
  const [editing,setEditing]=useState(false),[currentPassword,setCurrentPassword]=useState(""),[nextUsername,setNextUsername]=useState(username),[nextPassword,setNextPassword]=useState(""),[busy,setBusy]=useState(false),[message,setMessage]=useState("");
  async function save(){setBusy(true);setMessage("");try{const response=await fetch("/api/auth/credentials",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({currentPassword,username:nextUsername,newPassword:nextPassword,remember:true})});const payload=await response.json().catch(()=>null) as {username?:string;error?:string}|null;if(!response.ok)throw new Error(payload?.error==="CURRENT_PASSWORD_INVALID"?"Senha atual incorreta.":payload?.error||"Falha ao alterar login.");onUpdated(String(payload?.username||nextUsername));setEditing(false);setCurrentPassword("");setNextPassword("");setMessage("Login atualizado e gravado.");}catch(error){setMessage(error instanceof Error?error.message:"Falha ao alterar login.");}finally{setBusy(false)}}
  return <section><div><h3>Acesso à Library</h3><p>Login simples e persistente. Marque “lembrar” para este aparelho continuar conectado.</p></div>{editing?<div className="access-edit"><label>NOME<input value={nextUsername} onChange={e=>setNextUsername(e.target.value)}/></label><label>SENHA ATUAL<input type="password" value={currentPassword} onChange={e=>setCurrentPassword(e.target.value)}/></label><label>NOVA SENHA<input type="password" value={nextPassword} onChange={e=>setNextPassword(e.target.value)} placeholder="mínimo 4 caracteres"/></label><div><button onClick={()=>setEditing(false)}>Cancelar</button><button className="primary" disabled={busy||nextUsername.trim().length<2||nextPassword.length<4||currentPassword.length<4} onClick={save}>{busy?"Salvando…":"Salvar novo login"}</button></div>{message&&<small>{message}</small>}</div>:<div className="connection-box"><span className="status-dot on"/><div><strong>{username || "Usuário da Library"}</strong><p>Sessão protegida por cookie seguro · credenciais gravadas no banco remoto.</p>{message&&<small>{message}</small>}</div><button onClick={()=>{setNextUsername(username);setEditing(true)}}>Alterar login</button><button onClick={onLogout}>Sair</button></div>}</section>;
}

function SettingsV2({ connected, cloudflareInfo, supervisorInfo, mcpConfigured, authUsername, onAuthUpdated, onLogout, onConnect, onSupervisor, onMcp }: { connected: boolean; cloudflareInfo: CloudflareInfo | null; supervisorInfo: SupervisorInfo | null; mcpConfigured: boolean; authUsername:string; onAuthUpdated:(username:string)=>void; onLogout:()=>void; onConnect: () => void; onSupervisor: () => void; onMcp: () => void }) {
  const enabled = supervisorInfo?.enabled ?? true;
  const [migration, setMigration] = useState<D1MigrationInfo | null>(null);
  const [migrationBusy, setMigrationBusy] = useState(false);
  const [migrationMessage, setMigrationMessage] = useState("");

  const refreshMigration = useCallback(async () => {
    if (!cloudflareInfo?.d1Configured) { setMigration(null); return; }
    try {
      const response = await fetch("/api/migration/d1-to-turso", { cache: "no-store" });
      const payload = await response.json().catch(() => null) as D1MigrationInfo | null;
      if (!response.ok || !payload) throw new Error(payload?.error || "Falha ao verificar a migração");
      setMigration(payload);
    } catch (error) {
      setMigration({ ready:false, sourceDatabaseId:"", sourceDatabaseName:"", sourceCounts:{}, targetCounts:{}, targetHasApplicationData:false, targetTables:[], error:error instanceof Error ? error.message : String(error) });
    }
  }, [cloudflareInfo?.d1Configured]);

  useEffect(() => { void refreshMigration(); }, [refreshMigration]);

  async function rollbackMigration() {
    if (!migration?.rollbackAvailable || migrationBusy) return;
    if (!window.confirm("Restaurar o backup do Turso criado antes da última substituição D1 → Turso?")) return;
    setMigrationBusy(true); setMigrationMessage("Restaurando backup anterior do Turso…");
    try {
      const response = await fetch("/api/migration/d1-to-turso", { method:"DELETE", headers:{"content-type":"application/json"}, body:JSON.stringify({confirmation:"RESTAURAR_BACKUP_ANTERIOR"}) });
      const payload = await response.json().catch(() => null) as {ok?:boolean;error?:string}|null;
      if (!response.ok || !payload?.ok) throw new Error(payload?.error || "Falha ao restaurar backup.");
      setMigrationMessage("Backup anterior restaurado com sucesso.");
      window.setTimeout(() => window.location.reload(), 1000);
    } catch (error) {
      setMigrationMessage(error instanceof Error ? error.message : "Falha ao restaurar backup.");
    } finally {
      setMigrationBusy(false);
    }
  }

  const sourceRows = Object.values(migration?.sourceCounts || {}).reduce((sum, value) => sum + Number(value || 0), 0);
  const targetRows = Object.values(migration?.targetCounts || {}).reduce((sum, value) => sum + Number(value || 0), 0);

  async function runMigration() {
    if (!cloudflareInfo?.d1Configured || migrationBusy) return;
    const replaceExisting = Boolean(migration?.targetHasApplicationData);
    const warning = replaceExisting
      ? `O Turso já possui dados (${targetRows.toLocaleString("pt-BR")} registros). Isso SUBSTITUIRÁ o destino pela cópia do D1 atual. O R2 não será alterado. Continuar?`
      : `Copiar o D1 atual (${sourceRows.toLocaleString("pt-BR")} registros contabilizados) para o Turso? O R2 não será alterado.`;
    if (!window.confirm(warning)) return;
    setMigrationBusy(true); setMigrationMessage("Exportando D1 e transferindo para o Turso…");
    try {
      const response = await fetch("/api/migration/d1-to-turso", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ replaceExisting, ...(replaceExisting ? { confirmation: "SUBSTITUIR_TURSO_PELO_D1" } : {}) }),
      });
      const payload = await response.json().catch(() => null) as D1MigrationResult | null;
      if (!response.ok || !payload?.ok) throw new Error(payload?.error || "Falha durante a migração D1 → Turso");
      setMigrationMessage(`Migração concluída: ${payload.tablesCompared} tabelas conferidas · ${(payload.dumpBytes / 1024 / 1024).toFixed(1)} MB de SQL${payload.backupKey ? " · backup anterior salvo no R2" : ""}.`);
      await refreshMigration();
      window.setTimeout(() => window.location.reload(), 1200);
    } catch (error) {
      setMigrationMessage(error instanceof Error ? error.message : "Falha durante a migração.");
    } finally { setMigrationBusy(false); }
  }

  return <div className="content settings"><div className="page-heading"><div><p>PREFERÊNCIAS</p><h1>Configurações</h1><span>Gerencie conexão, sincronização e comportamento da biblioteca.</span></div></div><AccessSettings username={authUsername} onUpdated={onAuthUpdated} onLogout={onLogout}/><section className="mcp-settings"><div><div className="mcp-mini">⌁</div><h3>MCP para GPT</h3><p>O MCP expõe estado, evidências e controles; o ChatGPT atua como supervisor operacional.</p></div><div className="connection-box"><span className={mcpConfigured ? "status-dot on" : "status-dot"}/><div><strong>{mcpConfigured ? "Supervisor MCP conectado" : "Servidor MCP disponível"}</strong><p>Projetos, coleta, fila de decisões, QA visual, perfis, circuit breaker e ZIP.</p></div><button onClick={onMcp}>{mcpConfigured ? "Ver conexão" : "Gerar conexão"}</button></div></section><section><div><h3>Supervisor IA — Controle via MCP</h3><p>Ligar libera controle supervisor completo para o ChatGPT. Não chama Cloudflare, Llama, Qwen nem outra API de IA.</p></div><div className="connection-box"><span className={enabled ? "status-dot on" : "status-dot"}/><div><strong>{enabled ? "ChatGPT via MCP · LIGADO" : "Supervisor · DESLIGADO"}</strong><p>{enabled ? "Controle operacional COMPLETO · QA visual externo ATIVO · configurações persistentes ATIVAS." : "Somente execução determinística. Coleta autônoma continua ativa e acumula PARA_ANALISE."}</p></div><button onClick={onSupervisor}>{enabled ? "Gerenciar" : "Ligar"}</button></div></section><section><div><h3>Cloudflare — R2 + D1</h3><p>Credenciais persistentes no banco remoto. Configure uma vez pelo app e reutilize em qualquer PC.</p></div><div className="connection-box"><span className={connected || cloudflareInfo?.d1Configured ? "status-dot on" : "status-dot"}/><div><strong>{connected || cloudflareInfo?.d1Configured ? "Configuração persistente salva" : "Não configurado"}</strong><p>{cloudflareInfo?.needsReconfigure ? "Configuração antiga precisa ser substituída." : `${connected ? `R2 ${cloudflareInfo?.bucket || "configurado"}` : "R2 pendente"} · ${cloudflareInfo?.d1Configured ? `D1 ${cloudflareInfo.d1DatabaseName || "localizado"}` : "D1 pendente"}`}</p></div><button onClick={onConnect}>{connected || cloudflareInfo?.d1Configured ? "Gerenciar" : "Configurar"}</button></div></section><section><div><h3>Migração da Library — D1 → Turso</h3><p>A própria aplicação exporta o banco atual, importa no Turso e confere as contagens. Os arquivos do R2 permanecem no mesmo bucket.</p></div><div className="connection-box"><span className={migration?.ready ? "status-dot on" : "status-dot"}/><div><strong>{migrationBusy ? "Migração em andamento…" : migration?.ready ? `D1 ${migration.sourceDatabaseName || "localizado"} pronto para copiar` : cloudflareInfo?.d1Configured ? "Verificando origem e destino…" : "Configure o D1 primeiro"}</strong><p>{migration?.error ? migration.error : migration?.ready ? `Origem: ${sourceRows.toLocaleString("pt-BR")} registros · Turso: ${targetRows.toLocaleString("pt-BR")} registros${migration.targetHasApplicationData ? " · destino já contém dados" : ""}` : "Depois de salvar o Cloudflare, este botão substitui scripts e terminal."}</p>{migrationMessage && <small>{migrationMessage}</small>}</div><div className="migration-actions"><button disabled={!migration?.ready || migrationBusy} onClick={runMigration}>{migrationBusy ? "Transferindo…" : migration?.targetHasApplicationData ? "Reimportar do D1" : "Migrar D1 → Turso"}</button>{migration?.rollbackAvailable && <button disabled={migrationBusy} onClick={rollbackMigration}>Restaurar backup anterior</button>}</div></div></section><section><div><h3>Coleta autônoma noturna</h3><p>Pesquisa, testa URLs, materializa, valida tecnicamente e salva candidatas em PARA_ANALISE sem depender de IA.</p></div><label className="toggle"><input type="checkbox" checked readOnly/><span/></label></section><section><div><h3>QA visual obrigatório</h3><p>MATERIALIZADO não significa APROVADO. Somente decisão visual do Supervisor MCP pode aprovar candidatas novas.</p></div><label className="toggle"><input type="checkbox" checked readOnly/><span/></label></section></div>;
}

function SupervisorModal({ info, saving, onClose, onConnect }: { info: SupervisorInfo | null; cloudflareAccountId: string; saving: boolean; onClose: () => void; onConnect: (values: SupervisorForm) => void }) {
  const [enabled, setEnabled] = useState(info?.enabled ?? true);
  return <div className="modal-wrap"><div className="backdrop" onClick={onClose}/><section className="modal connect-modal"><header><div><span>SUPERVISOR IA</span><h2>Controle via MCP</h2><p>O toggle controla apenas a supervisão pelo ChatGPT. A coleta determinística funciona independentemente dele.</p></div><button onClick={onClose}>×</button></header><div className="secure-note"><span>⌁</span><p><b>Supervisor: ChatGPT via MCP</b><br/>Nenhuma chave de modelo é necessária. Ligar não consome Workers AI, Neurons ou API de IA.</p></div><div className="connection-box"><span className={enabled ? "status-dot on" : "status-dot"}/><div><strong>{enabled ? "LIGADO" : "DESLIGADO"}</strong><p>{enabled ? "Controle operacional COMPLETO · QA visual externo ATIVO" : "Execução determinística · PARA_ANALISE · métricas e logs"}</p></div><label className="toggle"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)}/><span/></label></div><footer><button onClick={onClose}>Cancelar</button><button className="primary" disabled={saving} onClick={() => onConnect({ enabled })}>{saving ? "Salvando..." : "Salvar"}</button></footer></section></div>;
}

function ConnectModal({ connected, info, saving, onClose, onConnect }: { connected: boolean; info: CloudflareInfo | null; saving: boolean; onClose: () => void; onConnect: (values: CloudflareForm) => void }) {
  const [values, setValues] = useState<CloudflareForm>(() => ({ accountId: info?.accountId ?? "", bucket: info?.bucket ?? "", accessKeyId: info?.accessKeyId ?? "", secretAccessKey: "", endpoint: info?.endpoint ?? "", d1ApiToken: "", d1DatabaseId: info?.d1DatabaseId ?? "", d1DatabaseName: info?.d1DatabaseName ?? "" }));
  const set = (key: keyof CloudflareForm, value: string) => setValues((current) => ({ ...current, [key]: value }));
  const r2Ready = Boolean(values.accountId.trim() && values.bucket.trim() && values.accessKeyId.trim() && (info?.hasSecret || values.secretAccessKey.trim()));
  const d1Ready = Boolean(values.accountId.trim() && (info?.hasD1Token || values.d1ApiToken.trim()));
  const ready = r2Ready || d1Ready;
  return <div className="modal-wrap"><div className="backdrop" onClick={onClose}/><section className="modal connect-modal"><header><div><span>INFRAESTRUTURA CLOUDFLARE</span><h2>{connected || info?.d1Configured ? "Gerenciar Cloudflare" : "Configurar Cloudflare"}</h2><p>Salve uma vez. A configuração fica no banco remoto e passa a valer em qualquer computador.</p></div><button onClick={onClose}>×</button></header>{info?.needsReconfigure && <div className="secure-note"><span>!</span><p><b>Configuração antiga detectada</b><br/>O perfil antigo foi herdado. Os campos recuperáveis já foram preenchidos; informe apenas o segredo/token que estiver indisponível e salve para substituir sem afetar os dados.</p></div>}<div className="secure-note"><span>◇</span><p><b>Configuração persistente e criptografada</b><br/>R2 e D1 ficam gravados no servidor. Depois de salvar, nenhum PC precisa de TXT, edição de código ou variáveis Cloudflare na Vercel.</p></div><div className="form-grid"><label>ACCOUNT ID<input autoComplete="off" placeholder="Cloudflare Account ID" value={values.accountId} onChange={(event) => set("accountId", event.target.value)}/><small>Compartilhado pelo R2 e D1.</small></label><label>BUCKET R2<input autoComplete="off" placeholder="Nome do bucket" value={values.bucket} onChange={(event) => set("bucket", event.target.value)}/></label><label>ACCESS KEY ID — R2<input autoComplete="off" placeholder="R2 Access Key ID" value={values.accessKeyId} onChange={(event) => set("accessKeyId", event.target.value)}/></label><label>R2 ENDPOINT (OPCIONAL)<input autoComplete="off" placeholder="https://ACCOUNT.r2.cloudflarestorage.com" value={values.endpoint} onChange={(event) => set("endpoint", event.target.value)}/><small>Vazio = derivado automaticamente do Account ID.</small></label><label>SECRET ACCESS KEY — R2<input autoComplete="new-password" type="password" placeholder={info?.hasSecret ? "R2 Secret já salvo — deixe vazio para manter" : "R2 Secret Access Key"} value={values.secretAccessKey} onChange={(event) => set("secretAccessKey", event.target.value)}/><small>{info?.hasSecret ? "Preencha apenas se quiser trocar a chave R2." : "Necessária para ativar o bucket."}</small></label><label>API TOKEN — D1<input autoComplete="new-password" type="password" placeholder={info?.hasD1Token ? "Token D1 já salvo — deixe vazio para manter" : "Cloudflare API Token com D1 Read"} value={values.d1ApiToken} onChange={(event) => set("d1ApiToken", event.target.value)}/><small>Usado para localizar/exportar o D1 real. Nunca é devolvido para o navegador.</small></label><label>D1 DATABASE ID (OPCIONAL)<input autoComplete="off" placeholder="Deixe vazio para localizar automaticamente" value={values.d1DatabaseId} onChange={(event) => set("d1DatabaseId", event.target.value)}/><small>{info?.d1Configured ? `Atual: ${info.d1DatabaseName || info.d1DatabaseId}` : "Se vazio, o app procura o banco pela estrutura da Corvo Library."}</small></label><label>D1 DATABASE NAME (OPCIONAL)<input autoComplete="off" placeholder="Nome do banco, se quiser restringir a busca" value={values.d1DatabaseName} onChange={(event) => set("d1DatabaseName", event.target.value)}/></label></div><footer><button onClick={onClose}>Cancelar</button><button className="primary" disabled={!ready || saving} onClick={() => onConnect(values)}>{saving ? "Testando e salvando..." : "Salvar e cravar configuração"}</button></footer></section></div>;
}

function McpModalV2({ info, loading, error, onRetry, onClose, onRotate, onCopy }: { info: McpInfo | null; loading: boolean; error: string; onRetry: () => void; onClose: () => void; onRotate: () => void; onCopy: (value: string, label: string) => void }) {
  return <div className="modal-wrap"><div className="backdrop" onClick={onClose}/><section className="modal mcp-modal"><header><div><span>CONEXÃO COM A IA</span><h2>Conectar o GPT por MCP</h2><p>O código ativo fica salvo. Só existe uma conexão válida por vez.</p></div><button onClick={onClose}>×</button></header>{loading && !info ? <div className="mcp-loading"><i/>Carregando conexão segura...</div> : !info && error ? <div className="mcp-error"><b>Não foi possível carregar a conexão</b><span>{error}</span><button onClick={onRetry}>Tentar novamente</button></div> : info && <><div className="mcp-hero"><div className="mcp-logo">⌁</div><div><strong>Corvo Library MCP</strong><span><i/> Código atual ativo</span></div><em>Supervisor MCP</em></div><div className="mcp-warning"><b>Guarde este link como uma senha.</b><span>Ao gerar um novo código, este link é revogado imediatamente e o novo passa a ser o único ativo.</span></div><div className="connection-field"><label>CÓDIGO ATIVO</label><div><code>{info.code}</code><button onClick={() => onCopy(info.code, "Código")}>Copiar</button></div></div><div className="connection-field"><label>ENDPOINT HTTPS — TERMINA EM /MCP</label><div><code>{info.mcp_url}</code><button onClick={() => onCopy(info.mcp_url, "Link MCP")}>Copiar link</button></div></div><div className="mcp-steps"><b>Como ativar no ChatGPT</b><ol><li>Ative <strong>Configurações → Segurança e login → Modo de desenvolvedor</strong></li><li>Abra <strong>Plugins → ＋</strong> e informe o nome <strong>Corvo Library</strong></li><li>Cole o endpoint acima e selecione <strong>Sem autenticação</strong></li><li>Atualize a conexão e confira as ferramentas do Supervisor MCP, incluindo estado consolidado, fila de decisões, perfis, coleta, materialização e QA</li></ol></div><footer><button onClick={onRotate} disabled={loading}>↻ Revogar e gerar novo</button><button className="primary" onClick={() => onCopy(info.mcp_url, "Link MCP")}>Copiar endpoint atual</button></footer></>}</section></div>;
}

function McpModal({ info, loading, onClose, onRotate, onCopy }: { info: McpInfo | null; loading: boolean; onClose: () => void; onRotate: () => void; onCopy: (value: string, label: string) => void }) {
  return <div className="modal-wrap"><div className="backdrop" onClick={onClose}/><section className="modal mcp-modal"><header><div><span>CONEXÃO COM A IA</span><h2>Conectar o GPT por MCP</h2><p>O código ativo fica salvo. Só existe uma conexão válida por vez.</p></div><button onClick={onClose}>×</button></header>{loading && !info ? <div className="mcp-loading"><i/>Carregando conexão segura...</div> : info && <><div className="mcp-hero"><div className="mcp-logo">⌁</div><div><strong>Corvo Library MCP</strong><span><i/> Código atual ativo</span></div><em>Supervisor MCP</em></div><div className="mcp-warning"><b>Guarde este link como uma senha.</b><span>Ao gerar um novo código, este link é revogado imediatamente e o novo passa a ser o único ativo.</span></div><div className="connection-field"><label>CÓDIGO ATIVO</label><div><code>{info.code}</code><button onClick={() => onCopy(info.code, "Código")}>Copiar</button></div></div><div className="connection-field"><label>ENDPOINT HTTPS — TERMINA EM /MCP</label><div><code>{info.mcp_url}</code><button onClick={() => onCopy(info.mcp_url, "Link MCP")}>Copiar link</button></div></div><div className="mcp-steps"><b>Como ativar no ChatGPT</b><ol><li>Ative <strong>Configurações → Segurança e login → Modo de desenvolvedor</strong></li><li>Abra <strong>Plugins → ＋</strong> e informe o nome <strong>Corvo Library</strong></li><li>Cole o endpoint acima e selecione <strong>Sem autenticação</strong></li><li>Atualize a conexão e confira as ferramentas do Supervisor MCP para coleta, QA visual e ZIP final</li></ol></div><footer><button onClick={onRotate} disabled={loading}>↻ Revogar e gerar novo</button><button className="primary" onClick={() => onCopy(info.mcp_url, "Link MCP")}>Copiar endpoint atual</button></footer></>}</section></div>;
}
