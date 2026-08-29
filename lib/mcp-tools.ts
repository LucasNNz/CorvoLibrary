import { env, testR2Connection } from "./platform/runtime";
import { and, desc, eq, inArray, like, or, sql } from "drizzle-orm";
import { strToU8, Zip, ZipPassThrough } from "fflate";
import { getDb } from "../db";
import { assetUsage, assets, automaticProjectItems, automaticProjects, batchAssets, batches, imports, mcpAudit, requests, settings, supervisorProjectCandidates } from "../db/schema";
import { getCloudflareConnection, safeCloudflareConnection, saveCloudflareConnection } from "./secure-settings";
import { resolveCorvoD1Database } from "./cloudflare-admin";
import { approvePendingAssets, deleteAssetsPermanently, getCatalogStats } from "./asset-catalog-admin";
import { processZipImport, SUPPORTED_MEDIA_MIME } from "./import-processor";
import { createSignedR2GetUrl } from "./r2-download";
import { signedDownloadUrl } from "./download-signature";
import { confirmMediaUpload, decideThumbnailBatch, fastPushGeneratedMedia, getProjectThumbnailLinks, prepareMediaUpload } from "./media-delivery";
import { confirmDownloadPackage, getDownloadPackageLink, listReadyDownloadPackages, queueFinalPackage } from "./delivery-packages";
import { decideFastPushBatch, decideFastPushCandidates, deleteFastPushCandidatesBatch, ingestFastPushBatch, ingestFastPushFileBytes, linkFastPushCandidatesToProject, listFastPushCandidates, listFastPushProjectTargets } from "./fast-push";
import { decideProjectThumbnails, decideProjectTitles, getProjectProductionPackage, pushProjectThumbnailUrlBatch, pushProjectTitles } from "./project-production-package";
import { kindFromMediaMime, resolveMediaMime } from "./media-mime";
import {
  addCandidates,
  applyTechnicalCorrection,
  cancelMaterializationBatch,
  cleanupBatchTemps,
  createMaterializationQueue,
  enqueueMaterializationItems,
  exportBatchZip,
  findDuplicateHash,
  getBatchStatus,
  getHostHealth,
  probeMaterializationUrl,
  getMaterializationLog,
  getMaterializationStatus,
  listAdapters,
  materializationStats,
  materializeBatch,
  materializeUrl,
  qaFiles,
  registerQaBatch,
  resolveOrTestUrl,
  retryItem,
} from "./materializer";
import { evaluateCollectionNeed, exportInventoryTabText, getHostRanking, getInventoryDashboard, getPipelineTelemetry, registerAssetConsultation, setStockPolicy } from "./inventory-intelligence";
import { attachAutomaticProjectFileFromUrl, backfillAutomaticProjectItemsFromFiles, createAutomaticProject, getAutomaticProject, getAutomaticProjectFile, getAutomaticProjectLog, getAutomaticProjectSummary, getProjectAutomationAvailability, getProjectConsistencyGate, listAutomaticProjects, listAutomaticProjectsFast, processAutomaticProject, qaAutomaticProject, reconcileAutomaticProject, regenerateProjectZip, reopenAutomaticProject, updateAutomaticProject } from "./automatic-projects";
import {
  alterItemStrategy, alterItemsStrategiesBatch, blockHost, changeCollectionLimits, changeSourcePriority, controlItem, controlProject, discardCollectionCandidate, markItemRelink, materializeCollectionCandidate,
  getNightlySummary, getSupervisorMode, getSupervisorState, getVisualQaEvidence, listPendingDecisions, listSourceProfiles,
  resolveDecision, saveProfileAsDefault, saveSourceProfile, setSourceProfileState, setSupervisorMode, syncDecisionQueue, updateCollectionSource, updateGlobalCollectorConfig,
} from "./supervisor-control";
import { getMcpRiskPolicy, getMcpRiskPolicySummary } from "./mcp-risk-policy";
import { backfillLegacyProjects, beginOperation, completeOperation, failOperation, getMcpPerformanceSummary, getOperationResult, getLatestOperationResult, getOperationalSnapshot, getRouteRanking, refreshProjectSummary } from "./performance-control";
import { acquireNextSupervisorWork, completeSupervisorExecution, deriveProjectPipelineState, getSupervisorLeaseTelemetry, recordSupervisorProjectReconciled, renewSupervisorLease, requireSupervisorLeaseForWrite, runSupervisorWatchdog, touchSupervisorLeaseForRead } from "./supervisor-lease";
import { acquireNextWorkerWork, completeWorkerWork, configureWorkerCapacity, exportOperationsText, failWorkerWork, getManagementDashboard, getOperationalDashboard, renewWorkerLeaseByActivity, requireWorkerLeaseForWrite, runWorkerWatchdog, setProjectDomain, syncWorkerQueue, syncWorkerItemsQueue } from "./worker-orchestration";
import { controlPlan, executeUntilDivergence, getPlanDetails, getPlanExceptions, getPlanStatus, getWorkPacket, runSupervisorPlansTick, supervisorExchange } from "./supervisor-plan-engine";
import { getInternalDispatcherHealth, runInternalWorkerDispatcher } from "./internal-worker-dispatcher";
import { enqueueFastApproveProjectItems, enqueueFastCandidateDecisionBatch, enqueueSupervisorDecisionBatch } from "./fast-supervisor-decisions";
import { buildSourceRoutingPlan, getLatestSourceRoutingPlan } from "./source-routing";
import { configureChatDeliveryMode, exportQaPacketJson, generateCandidateContactSheet, getChatDeliveryMode, getFastVisualPacket, getMaterializationQaLinks, getOperationalSummaryShort, getPendingCatalogQaLinks, getWorkPacketLite, isMcpFileResourceDeliveryEnabled } from "./industrial-supervisor";
import {
  activateOperationalPolicy, createOperationalPolicy, detectOperationalGap, editOperationalPolicy, getAppliedOperationalPolicies, getOperationalGap,
  getOperationalPolicyTelemetry, getOperationalPolicyWorkspaceDashboard, linkGapPolicy, listOperationalGaps, listOperationalPolicies, promoteOperationalPolicy,
  resolveGapAndLearn, rollbackOperationalPolicy, suspendOperationalPolicy, testOperationalPolicy,
} from "./operational-policy-workspace";
import {
  configureCollectionSources,
  createCollectionBatch,
  executeCollection,
  getCollectionBatch,
  getCollectionReport,
  getDetailedCollectionLog,
  listCollectionBatches,
  listCollectionQa,
  listCollectionSources,
  setCollectionBatchState,
} from "./auto-collector";

type Tool = { name: string; title: string; description: string; inputSchema: Record<string, unknown>; annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }; securitySchemes: Array<{ type: "noauth" }>; _meta?: Record<string, unknown> };
const objectSchema = (properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const text = (description: string) => ({ type: "string", description });
const integer = (description: string) => ({ type: "integer", description });
const boolean = (description: string) => ({ type: "boolean", description });
const array = (items: Record<string, unknown>, description: string) => ({ type: "array", items, description });
const tool = (name: string, title: string, description: string, inputSchema: Record<string, unknown>, readOnlyHint: boolean, destructiveHint = false, openWorldHint = false, meta?: Record<string, unknown>): Tool => {
  const risk = getMcpRiskPolicy(name, readOnlyHint, destructiveHint);
  return {
    name, title, description, inputSchema,
    annotations: {
      readOnlyHint,
      destructiveHint: risk.riskLevel === "destructive",
      idempotentHint: risk.idempotentHint,
      openWorldHint,
    },
    securitySchemes: [{ type: "noauth" }],
    _meta: {
      ...(meta || {}),
      "corvo/riskLevel": risk.riskLevel,
      "corvo/continuousEligible": risk.continuousEligible,
      "corvo/requiresExplicitConfirmation": risk.requiresExplicitConfirmation,
      "openai/isConsequential": risk.requiresExplicitConfirmation,
    },
  };
};
const openAiFileSchema = { type: "object", properties: { download_url: { type: "string" }, file_id: { type: "string" }, mime_type: { type: "string" }, file_name: { type: "string" } }, required: ["download_url", "file_id"], additionalProperties: false };
const projectFileSchema = { type: "object", properties: { download_url: { type: "string" }, downloadUrl: { type: "string" }, url: { type: "string" }, uri: { type: "string" }, file_id: { type: "string" }, mime_type: { type: "string" }, file_name: { type: "string" }, content: { type: "string" }, text: { type: "string" } }, additionalProperties: false };
const candidateSchema = objectSchema({ prioridade: integer("Ordem de tentativa; menor vem primeiro"), url: text("URL pública HTTP(S) da candidata"), fonte: text("Fonte ou mecanismo de descoberta") }, ["url"]);
const materializationItemSchema = objectSchema({
  item_id: text("Identificador estável do item no lote"), arquivo_alvo: text("Nome final desejado com extensão"), conceito: text("Conceito semântico"),
  referencia_visual: text("Descrição da referência visual"), universo: text("Universo"), preset: text("Preset/cena"), slot: text("Slot da cena"),
  tipo: text("Imagem, GIF, vídeo ou função visual"), sujeito: text("Personagem, objeto ou local"), tags: array(text("Tag"), "Tags semânticas"),
  referencia_roteiro: text("Contexto do roteiro"), usado_para: text("Finalidade no projeto"), largura_minima: integer("Largura técnica mínima"),
  altura_minima: integer("Altura técnica mínima"), transparencia_necessaria: boolean("Preservar canal alpha; força PNG quando necessário"), candidatas: array(candidateSchema, "Até cinco URLs em ordem de preferência"),
}, ["item_id", "arquivo_alvo", "conceito", "candidatas"]);
const qaDecisionSchema = objectSchema({ item_id: text("Item do lote"), status: text("APROVADO, REJEITADO, RELINK_REQUIRED ou CORRECAO_TECNICA_PERMITIDA"), observacao: text("Justificativa ou ressalva") }, ["item_id", "status"]);
const supervisorPlanCommandSchema = objectSchema({
  item_id:text("ID/chave do item"), action:text("APPROVE, REJECT_NEXT_CANDIDATE, REJECT_AND_BRANCH_SEARCH, RELINK_WITH_ALTERNATIVES, TECH_FIX_AND_RECHECK ou NO_ACTION_CONTINUE"), status:text("Alias compatível para action/status de QA"),
  observacao:text("Motivo/decisão"), canonical_reference:text("Referência canônica opcional"), query:text("Query principal opcional"), queries:array(text("Query"),"Variações de query"),
  fonte:text("Fonte principal opcional"), preferred_sources:array(text("Fonte"),"Fontes preferidas"), blocked_sources:array(text("Fonte"),"Fontes bloqueadas para este plano"),
  max_materializations:integer("Máximo de materializações derivadas"), stop_when_valid_count:integer("Parar quando houver N candidatas válidas"), timeout_ms:integer("Timeout técnico opcional")
},["item_id","action"]);
const supervisorPlanScopeSchema = objectSchema({ item_ids:array(text("Item ID/chave"),"Escopo opcional de itens"), max_items:integer("Máximo de itens do plano") });
const supervisorPlanPoliciesSchema = objectSchema({
  packet_threshold:integer("Tamanho do work packet"), candidate_buffer_min:integer("Buffer mínimo por item"), candidate_buffer_target:integer("Buffer alvo por item"),
  auto_relink:boolean("Permitir relink determinístico de níveis autorizados"), auto_technical:boolean("Permitir correções técnicas já autorizadas"),
  stop_conditions:array(text("Condição"),"DECISION_BOUNDARY, PACKET_READY, PROJECT_COMPLETED, REAL_ERROR"), success_conditions:array(text("Condição"),"Condições de sucesso"),
  preferred_sources:array(text("Fonte"),"Preferências globais do plano"), blocked_sources:array(text("Fonte"),"Bloqueios globais do plano")
});
const openPolicyJsonSchema = { type:"object", description:"Objeto de condição/ação da política", additionalProperties:true };
const fastPushItemSchema = objectSchema({
  operation_id:text("ID idempotente obrigatório por candidata"), batch_id:text("Lote opcional"), project_id:text("Projeto automático; use listar_destinos_fast_push_projeto antes quando houver projeto"), item_id:text("Compatibilidade: ID/chave do item"), project_item_id:text("PITEM canônico retornado por listar_destinos_fast_push_projeto; preferencial para vínculo exato"), item_projeto_id:text("Alias de project_item_id/PITEM"), slot:text("Slot/referência do roteiro"), target_name:text("Nome de arquivo desejado"), target_file:text("Alias canônico de target_file do PITEM"),
  source_url:text("URL HTTPS pública já descoberta pelo Supervisor"), source_type:text("Fonte: WEB, YOUTUBE, API etc."), universe:text("Universo"), subject:text("Personagem/objeto/cenário"), concept:text("Conceito/cena"),
  visual_reference:text("Referência visual"), semantic_reference:text("Alias de referência semântica do PITEM"), script_reference:text("Referência do roteiro"), scene:text("Cena provável"), arc:text("Arco/evento"), episode_candidate:text("Episódio provável"), composition_class:text("Classe de composição"),
  tags:array(text("Tag"),"Tags da candidata"), used_for:text("Finalidade"), priority:integer("Prioridade"), search_metadata:openPolicyJsonSchema,
}, ["operation_id", "source_url"]);
const fastPushFileContextSchema = objectSchema({
  operation_id:text("ID idempotente obrigatório"), batch_id:text("Lote opcional"), project_id:text("Projeto opcional"), item_id:text("Compatibilidade: item/chave"), project_item_id:text("PITEM canônico; preferencial para vínculo exato"), item_projeto_id:text("Alias de project_item_id/PITEM"), slot:text("Slot"), target_name:text("Nome alvo"), target_file:text("target_file canônico do PITEM"), source_type:text("CHAT_FILE por padrão"), universe:text("Universo"), subject:text("Sujeito"), concept:text("Conceito"), visual_reference:text("Referência visual"), semantic_reference:text("Alias de referência semântica"), script_reference:text("Referência roteiro"), scene:text("Cena"), arc:text("Arco"), episode_candidate:text("Episódio"), composition_class:text("Composição"), tags:array(text("Tag"),"Tags"), used_for:text("Finalidade"), priority:integer("Prioridade"), search_metadata:openPolicyJsonSchema,
}, ["operation_id"]);
const productionThumbUrlSchema = objectSchema({
  operation_id:text("ID idempotente opcional"), source_url:text("URL pública da thumb"), name:text("Nome do arquivo"), variant:text("Variante A/B/C"), agente_origem:text("Agente que produziu/encontrou"), observacao:text("Observação"), source_type:text("WEB/API/etc."),
}, ["source_url"]);
const productionThumbFileContextSchema = objectSchema({
  operation_id:text("ID idempotente opcional"), project_id:text("Projeto central"), name:text("Nome da thumb"), variant:text("Variante A/B/C"), agente_origem:text("Agente de thumbnail"), observacao:text("Observação"),
}, ["project_id"]);
const productionTitleSchema = objectSchema({
  operation_id:text("ID idempotente opcional"), texto:text("Ideia de título"), variante:text("Variante"), agente_origem:text("Agente de títulos"), observacao:text("Observação"), score:integer("Score opcional 0..100"),
}, ["texto"]);
const operationalContextSchema = objectSchema({
  domain:text("Domínio"), universe:text("Universo"), work_type:text("Tipo de trabalho"), composition_class:text("CONTEXTUAL/ISOLATED"), semantic_class:text("Classe semântica"), preset:text("Preset"),
  project_id:text("Projeto"), item_id:text("Item"), source:text("Fonte"), host:text("Host"), tool:text("Ferramenta"), worker_type:text("Tipo de worker"),
  requires_api_key:boolean("Fonte exige credencial"), configured:boolean("Fonte está configurada"), project_items:integer("Quantidade de itens do projeto")
});
const operationalPolicySchema = objectSchema({
  policy_key:text("Chave estável da família da política"), name:text("Nome"), description:text("Descrição"), category:text("SOURCE_ROUTING, PERFORMANCE, QA etc."), status:text("DRAFT/TESTING/ACTIVE/PROMOTED"),
  scope_level:text("GLOBAL, DOMAIN, UNIVERSE, WORK_TYPE, COMPOSITION_CLASS, SEMANTIC_CLASS, PRESET, PROJECT ou ITEM"), propagation_level:integer("0 ITEM a 4 GLOBAL"), domain:text("Domínio"), universe:text("Universo"), work_type:text("Tipo"), composition_class:text("Classe de composição"), semantic_class:text("Classe semântica"), preset:text("Preset"), project_id:text("Projeto"), item_id:text("Item"), condition:openPolicyJsonSchema, action:openPolicyJsonSchema, priority:integer("Prioridade"), confidence:integer("0..100"), source_gap_id:text("Gap origem"), notes:text("Notas")
});
const executionField = text("supervisor_execution_id atual; obrigatório para mutações do Supervisor após adquirir o lease");

export const tools: Tool[] = [
  tool("obter_contexto_biblioteca", "Obter contexto da biblioteca", "Retorna totais, estados, universos, últimas importações e saúde operacional.", objectSchema(), true),
  tool("buscar_assets", "Buscar assets", "Pesquisa o catálogo por texto, universo, tipo, status, uso e tags.", objectSchema({ texto: text("Busca livre"), universo: text("Universo exato"), tipo: text("Tipo exato"), status: text("Status exato"), nunca_usado: boolean("Somente assets nunca usados"), limite: integer("Máximo de resultados, até 200") }), true),
  tool("obter_asset", "Obter asset", "Retorna o dossiê completo de um asset pelo ID.", objectSchema({ asset_id: text("ID permanente do asset") }, ["asset_id"]), true),
  tool("obter_historico_asset", "Obter histórico do asset", "Retorna todas as utilizações registradas de um asset.", objectSchema({ asset_id: text("ID permanente do asset") }, ["asset_id"]), true),
  tool("listar_pendentes", "Listar pendentes", "Lista assets pendentes de catalogação ou revisão.", objectSchema({ limite: integer("Máximo de resultados") }), true),
  tool("obter_pendentes_para_qa_catalogo", "Ver pendentes reais para QA do Catálogo", "Compatibilidade: no modo industrial retorna somente IDs/metadados/URLs assinadas R2. resource_link é bloqueado por padrão.", objectSchema({ asset_ids: array(text("Asset ID"), "IDs opcionais; vazio usa os pendentes mais recentes"), limite: integer("Até 20 arquivos por chamada") }), true),
  tool("catalogar_asset", "Catalogar asset", "Cria um asset no catálogo com metadados completos e referência física no R2.", objectSchema({ asset_id: text("ID permanente; opcional"), nome: text("Nome semântico"), r2_key: text("Chave do arquivo no R2"), arquivo_original: text("Nome original"), mime_type: text("MIME type"), universo: text("Universo"), tipo: text("Personagem, objeto, cenário etc."), sujeito: text("Personagem, objeto ou local"), tags: array(text("Tag"), "Tags"), projeto_origem: text("Projeto de origem"), referencia_roteiro: text("Contexto do roteiro"), referencia_visual: text("Referência visual"), fonte_url: text("URL original"), nota_operacional: text("Memória operacional"), status_qa: text("APROVADO, RESSALVA ou NAO_AVALIADO") }, ["nome", "r2_key", "arquivo_original", "mime_type"]), false),
  tool("editar_metadados", "Editar metadados", "Atualiza qualquer conjunto permitido de metadados de um asset.", objectSchema({ asset_id: text("ID permanente"), nome: text("Nome semântico"), universo: text("Universo"), tipo: text("Tipo"), sujeito: text("Personagem, objeto ou local"), tags: array(text("Tag"), "Tags"), projeto_origem: text("Projeto"), referencia_roteiro: text("Referência do roteiro"), referencia_visual: text("Referência visual"), fonte_url: text("Fonte original"), nota_operacional: text("Nota operacional"), status_qa: text("Status de QA") }, ["asset_id"]), false),
  tool("registrar_uso", "Registrar uso", "Registra uma utilização, atualiza último uso e incrementa o contador.", objectSchema({ asset_id: text("ID permanente"), projeto: text("Projeto"), bloco: text("Bloco/cena"), preset: text("Preset"), slot: text("Slot"), funcao: text("Função do asset"), referencia_roteiro: text("Contexto do roteiro"), observacao: text("Observação") }, ["asset_id", "projeto"]), false),
  tool("registrar_uso_lote", "Registrar uso em lote", "Registra vários usos de assets numa única operação.", objectSchema({ usos: array(objectSchema({ asset_id: text("ID"), projeto: text("Projeto"), bloco: text("Bloco"), preset: text("Preset"), slot: text("Slot"), funcao: text("Função"), referencia_roteiro: text("Referência"), observacao: text("Observação") }, ["asset_id", "projeto"]), "Lista de usos") }, ["usos"]), false),
  tool("marcar_rejeitado", "Rejeitar asset", "Move logicamente um asset para rejeitados preservando histórico e possibilidade de restauração.", objectSchema({ asset_id: text("ID"), motivo: text("Motivo da rejeição") }, ["asset_id", "motivo"]), false),
  tool("restaurar_asset", "Restaurar asset", "Restaura um asset rejeitado ao status anterior ou Pendente.", objectSchema({ asset_id: text("ID") }, ["asset_id"]), false),
  tool("excluir_asset_permanentemente", "Excluir asset permanentemente", "Remove o asset, histórico, vínculos de lote e arquivo físico. Operação irreversível.", objectSchema({ asset_id: text("ID"), confirmar: boolean("Deve ser true") }, ["asset_id", "confirmar"]), false, true),
  tool("aprovar_pendentes_em_lote", "Aprovar pendentes em lote", "Permite ao Supervisor selecionar vários assets pendentes e movê-los ao Catálogo em uma única operação. Só altera assets que ainda estejam Pendentes.", objectSchema({ asset_ids: array(text("Asset ID"), "Pendentes selecionados pela IA ou pelo usuário"), observacao: text("Justificativa opcional da aprovação em lote") }, ["asset_ids"]), false),
  tool("excluir_pendentes_permanentemente_em_lote", "Excluir pendentes permanentemente em lote", "Remove definitivamente os pendentes selecionados, seus arquivos físicos no R2 e vínculos operacionais. Use somente após inspeção; exige confirmar=true.", objectSchema({ asset_ids: array(text("Asset ID"), "Pendentes selecionados pela IA ou pelo usuário"), confirmar: boolean("Deve ser true") }, ["asset_ids", "confirmar"]), false, true),
  tool("listar_solicitacoes", "Listar solicitações", "Lista solicitações em ordem recente.", objectSchema({ limite: integer("Máximo") }), true),
  tool("criar_solicitacao", "Criar solicitação", "Cria solicitação individual ou em lote a partir de texto estruturado.", objectSchema({ projeto: text("Projeto"), itens: text("Linhas do lote") }, ["projeto", "itens"]), false),
  tool("atualizar_solicitacao", "Atualizar solicitação", "Atualiza projeto, conteúdo ou status de uma solicitação.", objectSchema({ solicitacao_id: text("ID"), projeto: text("Projeto"), itens: text("Itens"), status: text("Status") }, ["solicitacao_id"]), false),
  tool("listar_lotes", "Listar lotes", "Lista lotes e seus estados.", objectSchema({ limite: integer("Máximo") }), true),
  tool("criar_lote", "Criar lote", "Cria um lote e pode adicionar assets na mesma operação.", objectSchema({ nome: text("Nome"), projeto: text("Projeto"), asset_ids: array(text("Asset ID"), "Assets iniciais") }, ["nome"]), false),
  tool("obter_lote", "Obter lote", "Retorna dossiê, manifesto e assets de um lote.", objectSchema({ lote_id: text("ID") }, ["lote_id"]), true),
  tool("adicionar_assets_ao_lote", "Adicionar assets ao lote", "Adiciona assets existentes a um lote.", objectSchema({ lote_id: text("ID do lote"), asset_ids: array(text("Asset ID"), "Assets") }, ["lote_id", "asset_ids"]), false),
  tool("remover_assets_do_lote", "Remover assets do lote", "Remove vínculos de assets sem excluir os assets da biblioteca.", objectSchema({ lote_id: text("ID do lote"), asset_ids: array(text("Asset ID"), "Assets") }, ["lote_id", "asset_ids"]), false),
  tool("atualizar_status_lote", "Atualizar status do lote", "Altera o status operacional de um lote.", objectSchema({ lote_id: text("ID"), status: text("Novo status") }, ["lote_id", "status"]), false),
  tool("gerar_manifesto_lote", "Gerar manifesto do lote", "Gera e persiste o manifesto TXT do lote com contexto e assets.", objectSchema({ lote_id: text("ID") }, ["lote_id"]), false),
  tool("listar_importacoes", "Listar importações", "Lista importações ZIP e seus estados.", objectSchema({ limite: integer("Máximo") }), true),
  tool("importar_zip_arquivo", "Importar ZIP anexado", "Recebe diretamente um ZIP anexado, salva no R2, lê o IMPORTACAO.txt interno, extrai imagens, GIFs e vídeos MP4, WebM, MOV ou M4V, cataloga tudo no D1 e registra os usos iniciais. Use esta ferramenta como primeira opção quando o usuário anexar um ZIP.", objectSchema({ arquivo: openAiFileSchema, manifesto_txt: text("Conteúdo opcional do IMPORTACAO.txt, caso não esteja dentro do ZIP") }, ["arquivo"]), false, false, false, { "openai/fileParams": ["arquivo"] }),
  tool("importar_midia_arquivo", "Importar mídia anexada", "Recebe diretamente da conversa uma imagem, GIF, MP4, WebM, MOV ou M4V, salva no R2 e cataloga no D1 com semântica completa, características de reprodução e uso inicial opcional.", objectSchema({ arquivo: openAiFileSchema, nome: text("Nome semântico"), universo: text("Universo"), tipo: text("Imagem, GIF, Vídeo, Fundo animado, Overlay animado, Efeito, Transição ou Clipe"), sujeito: text("Personagem, objeto ou local"), tags: array(text("Tag"), "Tags semânticas"), funcao_visual: text("Função visual da mídia"), movimento: text("Descrição do movimento ou animação"), loop: boolean("A mídia deve funcionar em loop"), audio: text("Com áudio, sem áudio, música, fala ou efeito sonoro"), duracao_segundos: text("Duração aproximada em segundos"), orientacao: text("16:9, 9:16, 1:1 ou outra"), resolucao: text("Resolução, por exemplo 1080x1920"), fps: text("Quadros por segundo"), fundo: text("Tipo de fundo, inclusive chroma key"), transparencia: text("Transparente, alpha parcial ou opaco"), projeto_origem: text("Projeto de origem"), referencia_roteiro: text("Contexto no roteiro"), referencia_visual: text("Referência visual"), fonte_url: text("URL de origem"), nota_operacional: text("Observação operacional"), status_qa: text("APROVADO, RESSALVA ou NAO_AVALIADO"), registrar_uso_inicial: boolean("Registrar uso inicial"), bloco: text("Bloco/cena"), preset: text("Preset"), slot: text("Slot"), usado_para: text("Função da mídia") }, ["arquivo", "nome"]), false, false, false, { "openai/fileParams": ["arquivo"] }),
  tool("listar_destinos_fast_push_projeto", "Listar destinos canônicos FAST PUSH", "Leia antes de empurrar imagens para um projeto. Retorna os PITEMs reais da versão ativa com project_item_id, item_key, target_file, termo, contexto e status. Use project_id + project_item_id no PUSH para evitar associação ambígua.", objectSchema({ project_id:text("ID do projeto automático"), limite:integer("Até 500 itens") }, ["project_id"]), true),
  tool("obter_modo_entrega_chat", "Obter modo de entrega ao chat", "Mostra se o MCP está em LINKS_ONLY. Por padrão V61.8 mantém CHAT_FILE_DELIVERY_MODE=OFF: nenhuma resposta anexa resource_link de arquivo ao chat; arquivos permanecem no R2 e QA usa URLs assinadas.", objectSchema(), true),
  tool("configurar_modo_entrega_chat", "Confirmar modo links-only", "A V61.9 industrial opera estruturalmente em OFF. Esta ferramenta apenas reafirma OFF; ON é bloqueado para impedir resource_link e transporte automático de arquivo no chat.", objectSchema({ modo:text("Somente OFF") }, ["modo"]), false),
  tool("fast_visual_packet", "FAST VISUAL PACKET", "Rota padrão de QA visual industrial. Retorna IDs, contexto, metadados e signed_preview_url/signed_original_url do arquivo canônico no R2; nunca retorna resource_link. Filtra por project_id, item_ids/target_files e PARA_QA_VISUAL.", objectSchema({ project_id:text("Projeto"), limit:integer("Até 50"), item_ids:array(text("PITEM/item_key"),"Itens opcionais"), target_files:array(text("target_file"),"Arquivos opcionais"), only_waiting_qa:boolean("Somente PARA_QA_VISUAL; padrão true"), include_original_url:boolean("Incluir signed_original_url") }, ["project_id"]), true),
  tool("obter_candidatas_qa_links", "Obter candidatas QA por links", "Alias de fast_visual_packet para agentes que precisam apenas de links assinados R2, sem recurso MCP de arquivo.", objectSchema({ project_id:text("Projeto"), limit:integer("Até 50"), item_ids:array(text("PITEM/item_key"),"Itens opcionais"), target_files:array(text("target_file"),"Arquivos opcionais") }, ["project_id"]), true),
  tool("obter_work_packet_lite", "Obter work packet lite", "Payload operacional mínimo: contadores + próximos PITEMs + status/referência/contexto/prioridade e, quando houver candidata pronta, candidate_id + matfile_id + preview_url assinada.", objectSchema({ project_id:text("Projeto"), limit:integer("Até 50") }, ["project_id"]), true),
  tool("obter_resumo_operacional_curto", "Obter resumo operacional curto", "Retorna somente total, approved, waiting_qa, relink, collecting, failed, last_operation_ms e next_recommended_action.", objectSchema({ project_id:text("Projeto") }, ["project_id"]), true),
  tool("exportar_pacote_qa_json", "Exportar pacote QA JSON", "Persiste no R2 um JSON links-only com candidatas, preview/original R2 URLs, referências, contexto, target_file, candidate_id e status. Retorna URL assinada; não entrega arquivo como resource MCP.", objectSchema({ project_id:text("Projeto"), limit:integer("Até 50"), item_ids:array(text("PITEM/item_key"),"Itens opcionais"), target_files:array(text("target_file"),"Arquivos opcionais") }, ["project_id"]), false),
  tool("gerar_grid_candidatas", "Gerar contact sheet de candidatas", "Monta no backend uma grid PNG de até 20 candidatas a partir dos bytes canônicos no R2, salva a grid no R2 e retorna apenas URL assinada + mapa posição→candidate_id. Nunca anexa a grid ao chat.", objectSchema({ project_id:text("Projeto"), limit:integer("Até 20"), columns:integer("2 a 5 colunas"), item_ids:array(text("PITEM/item_key"),"Itens opcionais"), target_files:array(text("target_file"),"Arquivos opcionais") }, ["project_id"]), false),
  tool("fast_decidir_candidatas_lote", "FAST DECIDE — approve/reject/relink", "Rota compacta para candidatas de imagem ou THUMBNAIL. Para PITEMs usa candidate_id/item_id/target_file e ACK assíncrono; para thumbs use kind=THUMBNAIL + asset_id/candidate_id e APPROVE|REJECT|SELECT sem transportar arquivo.", objectSchema({ project_id:text("Projeto"), decisions:array(objectSchema({ candidate_id:text("Candidate ID opcional"), asset_id:text("Asset/Thumb ID opcional"), kind:text("THUMBNAIL opcional"), item_id:text("PITEM/item_key opcional"), target_file:text("target_file opcional"), action:text("APPROVE, REJECT, RELINK ou SELECT para thumb"), reason:text("Motivo opcional") }, ["action"]),"Até 200 decisões"), operation_id:text("Recibo idempotente"), execution_id:executionField }, ["project_id","decisions"]), false),
  tool("aprovar_itens_lote", "Aprovar PITEMs rapidamente", "Alias assíncrono por item_id/target_file. Se houver exatamente uma candidata elegível, aprova; se houver várias, o resultado final da operação informa AMBIGUOUS_REQUIRES_CANDIDATE_ID.", objectSchema({ project_id:text("Projeto"), item_ids:array(text("PITEM/item_key"),"Itens"), target_files:array(text("target_file"),"Arquivos"), reason:text("Motivo"), operation_id:text("Recibo idempotente"), execution_id:executionField }, ["project_id"]), false),
  tool("aprovar_target_files_lote", "Aprovar target_files rapidamente", "Alias de aprovar_itens_lote focado em target_files.", objectSchema({ project_id:text("Projeto"), target_files:array(text("target_file"),"Arquivos"), reason:text("Motivo"), operation_id:text("Recibo idempotente"), execution_id:executionField }, ["project_id","target_files"]), false),
  tool("relink_itens_lote", "FAST RELINK por item/target_file", "Marca rapidamente PITEMs como RELINK em uma operação assíncrona curta. Aceita item_ids ou target_files e motivo; não exige descobrir candidate_ids.", objectSchema({ project_id:text("Projeto"), item_ids:array(text("PITEM/item_key"),"Itens"), target_files:array(text("target_file"),"Arquivos"), reason:text("Motivo"), operation_id:text("Recibo idempotente"), execution_id:executionField }, ["project_id"]), false),
  tool("fast_push_urls_lote", "FAST PUSH URLs — rota industrial", "Alias explícito da rota principal importar_candidatas_url_lote: recebe URLs públicas já encontradas, baixa no servidor, salva no R2/D1 e liga ao PITEM sem entregar arquivo ao chat.", objectSchema({ batch_id:text("ID opcional do lote"), itens:array(fastPushItemSchema,"Até 20 candidatas") }, ["itens"]), false, false, true, { "corvo/fastPush":true }),
  tool("importar_candidatas_url_lote", "FAST PUSH — importar candidatas URL em lote", "Recebe até 20 URLs já encontradas. Quando project_id + project_item_id são informados, cria automaticamente a mesma ponte canônica de Pendentes/QA do Supervisor: supervisor_project_candidates + QA_READY + decision_queue, sem duplicar os bytes no R2. O retorno informa project_link_status por item; falha de vínculo não é escondida.", objectSchema({ batch_id:text("ID opcional do lote"), itens:array(fastPushItemSchema,"Até 20 candidatas") }, ["itens"]), false, false, true, { "corvo/fastPush":true }),
  tool("importar_candidata_arquivo_fast_push", "FAST PUSH FILE — importar arquivo do chat", "Atalho secundário quando a mídia já está anexada no ChatGPT. A rota principal continua sendo importar_candidatas_url_lote quando existe URL pública útil. O arquivo anexado entra como CHAT_FILE, é deduplicado por SHA e, com project_id + project_item_id/target_file, cria a mesma ponte canônica de Pendentes/QA sem armazenar a URL temporária de transporte como origem web.", objectSchema({ arquivo:openAiFileSchema, contexto:fastPushFileContextSchema }, ["arquivo","contexto"]), false, false, false, { "openai/fileParams":["arquivo"], "corvo/fastPush":true }),
  tool("vincular_candidatas_fast_push_ao_projeto", "Vincular FAST PUSH ao projeto", "Backfill sem redownload: associa candidatas já ingeridas a PITEMs canônicos e cria a ponte de Pendentes/QA. Use quando o PUSH foi feito sem projeto ou quando o retorno indicar PROJECT_ITEM_NOT_FOUND/BRIDGE_ERROR.", objectSchema({ vinculos:array(objectSchema({ candidate_id:text("FPC ID"), project_id:text("Projeto"), project_item_id:text("PITEM canônico"), slot:text("Slot opcional") }, ["candidate_id","project_id","project_item_id"]), "Até 100 vínculos") }, ["vinculos"]), false),
  tool("listar_inbox_candidatas", "Listar Inbox de candidatas", "Lista candidatas FAST PUSH com filtros por projeto, universo, item/slot, status, fonte, lote e texto, incluindo project_item_id, project_link_status e supervisor_candidate_id.", objectSchema({ projeto_id:text("Projeto"), universo:text("Universo"), item_id:text("Item/slot"), status:text("Status"), fonte:text("Tipo/fonte"), lote_id:text("Lote"), texto:text("Busca livre"), limite:integer("Até 200") }), true),
  tool("aprovar_candidatas_fast_push_lote", "Aprovar candidatas FAST PUSH em lote", "Aprova manualmente ou pelo Supervisor candidatas já ingeridas, promove para asset permanente, registra uso e tenta resolver o slot do projeto.", objectSchema({ candidate_ids:array(text("Candidate ID"),"Até 100 IDs"), origem_decisao:text("MANUAL, SUPERVISOR ou AI"), observacao:text("Observação") }, ["candidate_ids"]), false),
  tool("rejeitar_candidatas_fast_push_lote", "Rejeitar candidatas FAST PUSH em lote", "Rejeita candidatas da Inbox preservando o registro e a proveniência. A decisão explícita tem precedência sobre análise automática.", objectSchema({ candidate_ids:array(text("Candidate ID"),"Até 100 IDs"), origem_decisao:text("MANUAL, SUPERVISOR ou AI"), observacao:text("Observação") }, ["candidate_ids"]), false),
  tool("decidir_candidatas_lote", "Decidir candidatas em lote", "Atalho principal de decisão rápida. APROVAR/REJEITAR até 200 candidatas por candidate_ids ou por PITEM/target_file dentro de um project_id. REJEITAR por item rejeita todas as candidatas ativas; APROVAR por item só executa quando existe exatamente uma candidata ativa; com múltiplas opções retorna AMBIGUOUS_REQUIRES_CANDIDATE_ID.", objectSchema({ project_id:text("Projeto para restringir a decisão"), candidate_ids:array(text("Candidate ID"),"IDs explícitos"), item_ids:array(text("PITEM/item_key"),"PITEMs/itens"), target_files:array(text("target_file"),"Nomes de arquivo dos PITEMs"), acao:text("APROVAR ou REJEITAR"), origem_decisao:text("MANUAL, SUPERVISOR ou AI"), motivo:text("Motivo/observação") }, ["acao"]), false),
  tool("aprovar_candidatas_lote", "Aprovar candidatas em lote", "Alias curto para aprovação rápida por candidate_id. Promove assets e sincroniza Pendentes/QA do projeto.", objectSchema({ project_id:text("Projeto para restringir IDs"), candidate_ids:array(text("Candidate ID"),"Até 200 IDs"), motivo:text("Motivo"), origem_decisao:text("MANUAL, SUPERVISOR ou AI"), operation_id:text("Recibo idempotente opcional") }, ["project_id","candidate_ids"]), false),
  tool("rejeitar_candidatas_lote", "Rejeitar candidatas em lote", "Alias curto para rejeição rápida por candidate_id. Preserva registro/proveniência e promove a próxima candidata do PITEM para QA quando aplicável.", objectSchema({ project_id:text("Projeto para restringir IDs"), candidate_ids:array(text("Candidate ID"),"Até 200 IDs"), motivo:text("Motivo"), origem_decisao:text("MANUAL, SUPERVISOR ou AI"), operation_id:text("Recibo idempotente opcional") }, ["project_id","candidate_ids"]), false),
  tool("rejeitar_itens_lote", "Rejeitar candidatas por PITEM em lote", "Recebe project_id + item_ids/target_files e rejeita todas as candidatas FAST PUSH ainda ativas desses PITEMs em uma chamada. Não desfaz assets já promovidos/congelados.", objectSchema({ project_id:text("Projeto"), item_ids:array(text("PITEM/item_key"),"Itens"), target_files:array(text("target_file"),"Arquivos-alvo"), motivo:text("Motivo"), origem_decisao:text("MANUAL, SUPERVISOR ou AI"), operation_id:text("Recibo idempotente opcional") }, ["project_id"]), false),
  tool("excluir_candidatas_lote", "Excluir candidatas permanentemente em lote", "Hard delete raro. Remove definitivamente registros FAST PUSH selecionados do projeto. Opcionalmente remove materialização e bytes R2 somente quando os bytes pertencem à própria candidata e não possuem outras referências. Candidatas promovidas são protegidas por padrão.", objectSchema({ project_id:text("Projeto"), candidate_ids:array(text("Candidate ID"),"Até 200 IDs"), motivo:text("Motivo"), confirmar:boolean("Deve ser true"), apagar_materializacao:boolean("Também remover registros técnicos de materialização"), apagar_bytes:boolean("Também apagar bytes R2 quando comprovadamente sem outras referências"), permitir_promovidas:boolean("Excepcional: permitir remover o envelope de candidata já promovida; o asset permanente é preservado") }, ["project_id","candidate_ids","confirmar"]), false, true),
  tool("fast_push_thumbs_url_lote", "FAST PUSH THUMBS por URL", "Rota principal para propostas de thumbnail já disponíveis em URLs públicas. Salva as thumbs no mesmo projeto como THUMB_CANDIDATE, sem PITEM, com falha independente por item e deduplicação por SHA.", objectSchema({ project_id:text("Projeto central existente"), itens:array(productionThumbUrlSchema,"Até 20 thumbs") }, ["project_id","itens"]), false),
  tool("fast_push_generated_media", "FAST PUSH mídia gerada por URL", "Fluxo industrial recomendado para THUMBNAIL: recebe image_url HTTPS, baixa servidor→servidor, valida formato/dimensões, calcula SHA-256, salva no R2 e vincula ao projeto. Nunca recebe arquivo do chat.", objectSchema({ project_id:text("Projeto"), kind:text("THUMBNAIL"), name:text("Nome"), image_url:text("URL HTTPS temporária"), universe:text("Universo"), tags:array(text("Tag"),"Tags"), referencia_roteiro:text("Referência no roteiro"), status_qa:text("READY_FOR_QA, APPROVED ou PUBLISHED_THUMB"), metadata:{type:"object",additionalProperties:true}, operation_id:text("Idempotência"), agente_origem:text("Agente de origem") }, ["project_id","kind","name","image_url"]), false, false, true, { "corvo/linksOnly":true, "corvo/projectProduction":true }),
  tool("importar_midia_por_url", "Importar mídia por URL", "Alias links-only de fast_push_generated_media para THUMBNAIL. Nenhum byte trafega pelo chat.", objectSchema({ project_id:text("Projeto"), kind:text("THUMBNAIL"), name:text("Nome"), image_url:text("URL HTTPS"), universe:text("Universo"), tags:array(text("Tag"),"Tags"), referencia_roteiro:text("Referência no roteiro"), status_qa:text("READY_FOR_QA, APPROVED ou PUBLISHED_THUMB"), metadata:{type:"object",additionalProperties:true}, operation_id:text("Idempotência") }, ["project_id","kind","name","image_url"]), false, false, true, { "corvo/linksOnly":true }),
  tool("preparar_upload_midia", "Preparar upload direto de mídia", "Gera URL PUT assinada do R2 para THUMBNAIL. O agente/serviço envia direto ao bucket; o chat recebe apenas URL, token e metadados.", objectSchema({ project_id:text("Projeto"), kind:text("THUMBNAIL"), filename:text("Nome do arquivo"), mime_type:text("image/png, image/jpeg, image/webp, image/avif ou image/gif"), validade_minutos:integer("1..60"), universe:text("Universo"), tags:array(text("Tag"),"Tags"), referencia_roteiro:text("Referência"), status_qa:text("READY_FOR_QA, APPROVED ou PUBLISHED_THUMB"), metadata:{type:"object",additionalProperties:true} }, ["project_id","kind","filename","mime_type"]), false, false, false, { "corvo/linksOnly":true, "corvo/directUpload":true }),
  tool("confirmar_upload_midia", "Confirmar upload direto de mídia", "Confirma que a THUMBNAIL chegou ao R2, valida bytes/dimensões/hash, cataloga no pacote do projeto e devolve IDs/status. Não transporta o arquivo.", objectSchema({ project_id:text("Projeto"), upload_token:text("Token retornado por preparar_upload_midia"), name:text("Nome opcional"), status_qa:text("READY_FOR_QA, APPROVED ou PUBLISHED_THUMB"), metadata:{type:"object",additionalProperties:true} }, ["project_id","upload_token"]), false, false, false, { "corvo/linksOnly":true }),
  tool("obter_thumbs_links", "Obter thumbs por links", "QA links-only das thumbnails do projeto. Retorna asset_id, preview_signed_url, dimensões, SHA, contexto e status; nunca resource_link.", objectSchema({ project_id:text("Projeto"), status:text("READY_FOR_QA/THUMB_APPROVED/PUBLISHED_THUMB opcional"), limit:integer("Até 100"), validade_minutos:integer("1..60") }, ["project_id"]), true, false, false, { "corvo/linksOnly":true }),
  tool("fast_decidir_thumbs_lote", "FAST DECIDE thumbs", "Aprova, rejeita ou seleciona thumbnails por asset_id/candidate_id em lote sem transportar arquivo.", objectSchema({ project_id:text("Projeto"), asset_ids:array(text("Thumb ID"),"Até 100"), action:text("APPROVE, REJECT ou SELECT"), reason:text("Motivo"), operation_id:text("Recibo") }, ["project_id","asset_ids","action"]), false),
  tool("fast_push_titulos", "FAST PUSH ideias de títulos", "Anexa até 20 ideias de títulos como registros estruturados no mesmo projeto. Não cria arquivo físico por título e mantém candidatos para aprovação/rejeição/seleção posterior.", objectSchema({ project_id:text("Projeto central existente"), titulos:array(productionTitleSchema,"Até 20 títulos") }, ["project_id","titulos"]), false),
  tool("listar_pacote_producao_projeto", "Listar pacote completo de produção", "Mostra roteiro/requirements, imagens resolvidas, thumbs, títulos, selecionados, agentes e estado do ZIP de produção do mesmo project_id.", objectSchema({ project_id:text("Projeto central") }, ["project_id"]), true),
  tool("decidir_thumbs_projeto", "Decidir thumbs do projeto", "APROVE mantém uma thumb aprovada, REJECT rejeita, SELECT escolhe a thumb ativa sem rejeitar automaticamente as outras aprovadas. Decisão repetida é idempotente.", objectSchema({ candidate_ids:array(text("Thumb candidate ID"),"Até 100 IDs"), decisao:text("APPROVE, REJECT ou SELECT"), origem_decisao:text("MANUAL, SUPERVISOR ou AI"), observacao:text("Observação") }, ["candidate_ids","decisao"]), false),
  tool("decidir_titulos_projeto", "Decidir títulos do projeto", "APROVE mantém um título aprovado, REJECT rejeita, SELECT escolhe o título ativo sem apagar outras opções. Decisão repetida é idempotente.", objectSchema({ candidate_ids:array(text("Title candidate ID"),"Até 100 IDs"), decisao:text("APPROVE, REJECT ou SELECT"), origem_decisao:text("MANUAL, SUPERVISOR ou AI"), observacao:text("Observação") }, ["candidate_ids","decisao"]), false),
  tool("exportar_projeto_completo_zip", "Exportar projeto completo ZIP", "Alias compatível de gerar_pacote_final. Enfileira o FULL_PROJECT_ZIP e retorna package_id/status; o arquivo nunca é anexado ao chat. Depois use listar_pacotes_prontos_para_download e obter_link_download_pacote.", objectSchema({ project_id:text("Projeto central"), validade_minutos:integer("Compatibilidade; o link fresco é solicitado depois") }, ["project_id"]), false),
  tool("gerar_pacote_final", "Gerar pacote final assíncrono", "Enfileira o FULL_PROJECT_ZIP no R2 e retorna package_id + operation_id + QUEUED. Se a mesma revisão já possui pacote, reutiliza o package_id em vez de regenerar.", objectSchema({ project_id:text("Projeto"), tipo:text("FULL_PROJECT_ZIP"), operation_id:text("Idempotência") }, ["project_id"]), false, false, false, { "corvo/linksOnly":true }),
  tool("listar_pacotes_prontos_para_download", "Listar pacotes prontos", "Polling JSON enxuto de pacotes READY_FOR_DOWNLOAD. Não retorna arquivo nem resource_link.", objectSchema({ project_id:text("Projeto opcional"), since:text("Data ISO ou timestamp opcional"), status:text("READY_FOR_DOWNLOAD, DOWNLOADED, FAILED ou ALL"), limit:integer("Até 200") }), true, false, false, { "corvo/linksOnly":true }),
  tool("obter_link_download_pacote", "Obter link direto do pacote", "Emite URL R2 assinada fresca para o agente baixar direto no PC, com filename, tamanho e SHA-256.", objectSchema({ package_id:text("Package ID"), validade_minutos:integer("1..60") }, ["package_id"]), true, false, false, { "corvo/linksOnly":true }),
  tool("confirmar_download_pacote", "Confirmar download do pacote", "Marca pacote como DOWNLOADED/DELIVERED após o agente local salvar e validar o hash. Evita polling baixar o mesmo pacote novamente.", objectSchema({ package_id:text("Package ID"), downloaded_at:text("ISO opcional"), sha256_verified:boolean("Hash conferido; padrão true"), machine_name:text("Nome opcional da máquina") }, ["package_id"]), false),
  tool("processar_importacao_zip", "Processar importação ZIP", "Processa ou reprocessa de forma idempotente um ZIP já recebido no R2: lê o manifesto, extrai imagens, GIFs e vídeos compatíveis, cataloga assets e registra usos iniciais.", objectSchema({ importacao_id: text("ID da importação, por exemplo IMP-...") }, ["importacao_id"]), false),
  tool("preparar_upload_zip", "Preparar upload de ZIP", "Gera um link HTTPS seguro para o usuário enviar diretamente um ZIP anexado à conversa ou salvo no dispositivo, sem precisar hospedá-lo publicamente. Use quando a origem começar com sandbox: ou não for uma URL HTTPS pública.", objectSchema({ nome_arquivo: text("Nome opcional do ZIP") }), true),
  tool("importar_zip_por_url", "Importar ZIP por URL", "Importa um ZIP quando ele possui URL HTTPS pública. Se a origem for sandbox: ou local, devolve automaticamente um link de upload direto em vez de falhar.", objectSchema({ url: text("URL HTTPS pública ou referência sandbox/local"), nome_arquivo: text("Nome do ZIP"), manifesto_txt: text("Conteúdo opcional do IMPORTACAO.txt") }, ["url", "nome_arquivo"]), false, false, true),
  tool("sincronizar_r2", "Sincronizar R2", "Examina objetos do bucket e cria pendências para arquivos ainda não catalogados.", objectSchema({ prefixo: text("Prefixo opcional"), limite: integer("Máximo, até 1000") }), false),
  tool("obter_link_download", "Obter link de download", "Gera uma URL temporária assinada para baixar o asset diretamente do R2, sem proxy de bytes pela aplicação.", objectSchema({ asset_id: text("ID"), validade_minutos: integer("Validade entre 1 e 60") }, ["asset_id"]), true),
  tool("obter_links_download_lote", "Obter links de download em lote", "Gera em paralelo URLs temporárias diretas do R2 para até 200 assets, preservando a ordem solicitada e informando IDs ausentes.", objectSchema({ asset_ids: array(text("Asset ID"), "IDs permanentes dos assets"), validade_minutos: integer("Validade entre 1 e 60") }, ["asset_ids"]), true),
  tool("exportar_assets_zip", "Exportar assets em ZIP", "Gera um ZIP multipart no R2, reutiliza seleções idênticas por 48 horas e devolve uma URL direta assinada.", objectSchema({ asset_ids: array(text("Asset ID"), "IDs permanentes dos assets"), nome_zip: text("Nome opcional do arquivo ZIP"), validade_minutos: integer("Validade entre 1 e 60") }, ["asset_ids"]), false),
  tool("materializar_url", "Materializar URL", "Baixa uma mídia pública, valida o arquivo real e faz ponte automática com o Supervisor quando o projeto/item puder ser resolvido. projeto_id + item_projeto_id podem ser informados para vínculo explícito.", objectSchema({ batch_id: text("ID idempotente opcional"), projeto: text("Nome do projeto/lote"), projeto_id: text("ID do projeto principal opcional"), item_id: text("ID do item de materialização"), item_projeto_id: text("ID/chave do item no projeto principal opcional"), arquivo_alvo: text("Nome final"), conceito: text("Conceito semântico"), referencia_visual: text("Referência visual"), universo: text("Universo"), fonte: text("Fonte"), url: text("URL pública HTTP(S)"), execution_id: executionField }, ["url"]), false, false, true),
  tool("materializar_lote", "Materializar lote", "Materializa de 1 a 40 itens com fallback inteligente de até cinco candidatas, concorrência global 8 e limite 2 por host.", objectSchema({ batch_id: text("ID idempotente opcional"), projeto: text("Projeto"), itens: array(materializationItemSchema, "Itens do lote"), execution_id: executionField }, ["projeto", "itens"]), false, false, true),
  tool("criar_fila_materializacao_continua", "Criar fila contínua", "Cria uma fila persistente que pode receber novos itens sem recriar o lote.", objectSchema({ batch_id: text("ID idempotente opcional"), projeto: text("Projeto") }, ["projeto"]), false),
  tool("adicionar_itens_fila_materializacao", "Adicionar itens à fila", "Adiciona até 40 itens idempotentes à fila contínua e inicia a execução com pontuação de host.", objectSchema({ batch_id: text("ID da fila"), itens: array(materializationItemSchema, "Itens novos"), execution_id: executionField }, ["batch_id", "itens"]), false, false, true),
  tool("obter_status_materializacao", "Obter status da materialização", "Retorna estado, candidatas, falhas e arquivo técnico de um item ou materialization_id.", objectSchema({ materialization_id: text("ID do arquivo materializado"), batch_id: text("ID do lote"), item_id: text("ID do item") }), true),
  tool("obter_status_lote_materializacao", "Obter status do lote de materialização", "Retorna totais e estados de todos os itens do lote.", objectSchema({ batch_id: text("ID do lote"), execution_id: executionField }, ["batch_id"]), true),
  tool("obter_assets_para_qa_lote", "Obter assets para QA", "Compatibilidade: em modo industrial OFF redireciona para LINKS_ONLY com URLs assinadas do R2; resource_link só existe quando o modo legado ON é explicitamente ativado.", objectSchema({ batch_id: text("ID do lote"), limite: integer("Até 20 arquivos por chamada"), execution_id: executionField }, ["batch_id"]), true),
  tool("registrar_qa_lote", "Registrar QA do lote", "Registra decisões visuais. Só APROVADO congela e cataloga permanentemente o asset.", objectSchema({ batch_id: text("ID do lote"), decisoes: array(qaDecisionSchema, "Decisões de QA"), execution_id: executionField }, ["batch_id", "decisoes"]), false),
  tool("retry_item_materializacao", "Repetir item", "Retoma um item preservando o estado e, opcionalmente, reinicia a ordem de candidatas.", objectSchema({ batch_id: text("ID do lote"), item_id: text("ID do item"), projeto_id: text("Projeto principal opcional; quando omitido a ponte tenta resolver pelo lote/item"), execution_id: executionField, reiniciar_candidatas: boolean("Tentar desde a primeira candidata"), forcar: boolean("Permitir ação excepcional em item congelado") }, ["batch_id", "item_id"]), false, false, true),
  tool("adicionar_candidatas_item", "Adicionar candidatas", "Acrescenta novas URLs ao item e retoma o fallback sem recriar o lote.", objectSchema({ batch_id: text("ID do lote"), item_id: text("ID do item"), projeto_id: text("Projeto principal opcional; quando omitido a ponte tenta resolver pelo lote/item"), execution_id: executionField, candidatas: array(candidateSchema, "Novas candidatas") }, ["batch_id", "item_id", "candidatas"]), false, false, true),
  tool("aplicar_correcao_tecnica", "Aplicar correção técnica", "Executa internamente correções técnicas permitidas em item ISOLATED e preserva a linhagem do arquivo original. url_resultado continua opcional para compatibilidade com corretores externos; nunca cria conteúdo semântico.", objectSchema({ batch_id: text("ID do lote"), item_id: text("ID do item"), projeto_id: text("Projeto principal opcional; quando omitido a ponte tenta resolver pelo lote/item"), execution_id: executionField, parent_materialization_id: text("Arquivo de origem opcional"), operacao: text("Operação única"), operacoes: array(text("REMOVER_FUNDO, ALPHA, HALO, FEATHER_LEVE, FRAGMENTOS, CROP, ENQUADRAMENTO, RESIZE, UPSCALE_TECNICO, FORMATO ou COMPRESSAO"), "Operações técnicas"), technical_fixes: array(text("Aliases do Supervisor IA, como REMOVE_BACKGROUND e TRIM_HALO"), "Operações do supervisor"), technical_parameters: { type: "object", description: "Parâmetros determinísticos como width, height, max_side, threshold, feather e quality", additionalProperties: true }, reavaliado_antes_terceira: boolean("Deve ser true antes da 3ª correção técnica no mesmo item"), url_resultado: text("URL pública opcional de um resultado técnico externo") }, ["batch_id", "item_id"]), false, false, true),
  tool("exportar_zip_arquivo", "Exportar ZIP final", "Monta no servidor o ZIP apenas com itens congelados, valida faltantes/extras e inclui IMPORTACAO.txt completo.", objectSchema({ batch_id: text("ID do lote"), nome_zip: text("Nome do ZIP"), arquivos: array(objectSchema({ item_id: text("Item"), arquivo_alvo: text("Nome final no ZIP") }, ["item_id", "arquivo_alvo"]), "Mapeamento opcional de nomes"), execution_id: executionField }, ["batch_id"]), false),
  tool("obter_log_materializacao", "Obter log de materialização", "Retorna a trilha operacional do lote ou de um item.", objectSchema({ batch_id: text("ID do lote"), item_id: text("ID opcional do item") }, ["batch_id"]), true),
  tool("cancelar_lote_materializacao", "Cancelar materialização", "Cancela o lote e impede novas tentativas automáticas sem excluir arquivos ou catálogo.", objectSchema({ batch_id: text("ID do lote"), execution_id: executionField }, ["batch_id"]), false),
  tool("obter_host_health", "Obter saúde dos hosts", "Mostra sucessos, falhas, circuit breaker e bloqueios dos hosts de origem.", objectSchema({ host: text("Host opcional") }), true),
  tool("probar_url_controlada", "Probe controlada de URL", "Testa explicitamente uma URL mesmo com circuit breaker aberto, registra telemetria e impede repetição dentro da janela sem forçar.", objectSchema({ url: text("URL pública HTTP(S)"), forcar: boolean("Ignorar a janela entre probes") }, ["url"]), false, false, true),
  tool("limpar_temporarios_lote", "Limpar temporários", "Remove do R2 os arquivos temporários de um lote já concluído ou cancelado.", objectSchema({ batch_id: text("ID do lote"), confirmar: boolean("Deve ser true") }, ["batch_id", "confirmar"]), false, true),
  tool("obter_estatisticas_materializacao", "Obter estatísticas", "Retorna métricas de lotes, arquivos, candidatas e concorrência.", objectSchema(), true),
  tool("procurar_duplicata_hash", "Procurar duplicata por hash", "Pesquisa SHA-256 no catálogo permanente e nos arquivos temporários.", objectSchema({ sha256: text("SHA-256 hexadecimal") }, ["sha256"]), true),
  tool("resolver_url", "Resolver URL", "Segue redirects públicos, aplica adapter e inspeciona o conteúdo real sem armazenar.", objectSchema({ url: text("URL pública HTTP(S)") }, ["url"]), true, false, true),
  tool("testar_url", "Testar URL", "Executa a materialização técnica completa de uma URL em lote de teste.", objectSchema({ url: text("URL pública HTTP(S)") }, ["url"]), false, false, true),
  tool("listar_adapters", "Listar adapters", "Lista adapters públicos suportados e suas capacidades.", objectSchema(), true),
  tool("obter_painel_estoque", "Obter painel de estoque", "Retorna estoque semântico, giro, maturidade, lacunas, saturação, hosts e telemetria do pipeline.", objectSchema({ conceito: text("Filtro opcional por conceito") }), true),
  tool("exportar_txt_estoque_giro", "Exportar TXT de estoque e giro", "Retorna em TXT exatamente os mesmos dados usados pela interface e pelo painel MCP para a aba estoque, hosts ou pipeline.", objectSchema({ aba: text("estoque, hosts ou pipeline"), conceito: text("Filtro opcional por conceito") }, ["aba"]), true),
  tool("configurar_politica_estoque", "Configurar política de estoque", "Define mínimo, ideal e máximo de variações para um conceito semântico.", objectSchema({ conceito: text("Conceito"), universo: text("Universo"), tipo: text("Tipo"), minimo: integer("Estoque mínimo"), ideal: integer("Estoque ideal"), maximo: integer("Estoque máximo"), ativa: boolean("Política ativa") }, ["conceito"]), false),
  tool("registrar_consulta_asset", "Registrar consulta de asset", "Registra que a IA consultou ou selecionou um asset para medir giro e taxa de reaproveitamento.", objectSchema({ asset_id: text("Asset opcional"), conceito: text("Conceito pesquisado"), projeto: text("Projeto"), consulta: text("Texto da consulta"), selecionado: boolean("Asset selecionado") }, ["conceito"]), false),
  tool("avaliar_necessidade_coleta", "Avaliar necessidade de coleta", "Aplica a política biblioteca-primeiro e informa se a coleta externa deve ocorrer.", objectSchema({ conceito: text("Conceito"), universo: text("Universo opcional"), tipo: text("Tipo opcional") }, ["conceito"]), true),
  tool("obter_ranking_hosts", "Obter ranking de hosts", "Classifica fontes por sucesso técnico, QA, velocidade, estabilidade, bytes e circuit breaker.", objectSchema(), true),
  tool("obter_telemetria_pipeline", "Obter telemetria do pipeline", "Retorna fila por estado, latência média/P95, espera de QA e parâmetros de orquestração.", objectSchema(), true),
  tool("obter_status_supervisor_ia", "Obter status do Supervisor IA", "Retorna o toggle do Supervisor ChatGPT via MCP. Ligar nunca chama Cloudflare/Llama/Qwen automaticamente.", objectSchema(), true),
  tool("configurar_supervisor_mcp", "Configurar Supervisor MCP", "Liga ou desliga a supervisão operacional via ChatGPT/MCP. A coleta determinística continua funcionando quando desligado.", objectSchema({ ligado: boolean("true=LIGADO; false=DESLIGADO"), motivo: text("Motivo opcional") }, ["ligado"]), false),
  tool("assumir_proximo_trabalho_supervisor", "Assumir próximo trabalho do Supervisor", "Operação de baixo risco, temporária e reversível: localiza um projeto elegível, expira leases vencidos, adquire um lease atômico idempotente, reconcilia o estado real e retorna execution_id + próxima ação. Não exclui arquivos, não aprova assets e não altera conteúdo semântico. Use no início de uma nova execução/agendamento; não use heartbeat artificial.", objectSchema({ projeto_id: text("Projeto específico opcional; vazio escolhe o próximo elegível"), execution_id: text("ID da execução atual opcional; vazio gera um novo EXEC-*"), ttl_minutos: integer("TTL entre 5 e 15 minutos; padrão persistido 10") }), false, false, false, { "corvo/reversible": true, "corvo/leaseOnly": true, "corvo/autoUseAllowed": true }),
  tool("backfill_projetos_legados", "Backfill de projetos legados", "Recalcula de forma idempotente active_version, contadores materializados, domínio e filas dos projetos antigos sem reabrir aprovados nem recriar assets. Use após upgrade de versões antigas ou quando counts.total=0 apesar de existirem itens.", objectSchema({ projeto_id: text("Projeto específico opcional; vazio corrige todos os legados elegíveis"), sincronizar_filas: boolean("Sincronizar filas derivadas após o backfill; padrão true") }), false, false, false, { "corvo/reversible": true, "corvo/autoUseAllowed": true }),
  tool("executar_watchdog_supervisor", "Executar watchdog de leases", "Varre leases expirados e marca apenas a execução como ABANDONADA e o pipeline como PRONTO_PARA_RETOMADA. Não apaga, cancela nem refaz trabalho.", objectSchema({ projeto_id: text("Projeto opcional para diagnóstico") }), false),
  tool("obter_telemetria_leases_supervisor", "Obter telemetria de leases", "Retorna supervisores ativos, leases expirados, projetos prontos para retomada, retomadas, colisões impedidas e configuração persistida do watchdog/TTL.", objectSchema({ horas: integer("Janela de telemetria; padrão 24h") }), true),
  tool("assumir_proximo_trabalho", "Assumir próximo trabalho FIFO", "Operação de baixo risco e reversível: worker especializado assume atomicamente uma unidade elegível por lease temporário. Aplica FIFO + skip locked, limites por função/projeto/nicho e lease granular; não exclui nem aprova conteúdo por si só. worker_domain deve combinar com project_domain, salvo MULTI/allowed_domains explícitos.", objectSchema({ worker_type: text("SCRIPT, COLLECTOR, MATERIALIZER, ANALYST, QA, RELINK, TECHNICAL_FIX, ORGANIZER, EXPORTER, ZIP ou SUPERVISOR"), worker_id: text("Identidade estável do worker, ex. COLLECTOR-ANIME-01"), worker_domain: text("ANIME, FOOTBALL, GAMES, GEEK, CARTOON, GENERAL ou MULTI"), execution_id: text("ID único desta execução; se omitido é gerado"), allowed_domains: array(text("Domínio permitido somente em política explícita"), "Fallback explícito opcional"), project_id: text("Projeto opcional para limitar a seleção") }, ["worker_type","worker_id","worker_domain"]), false, false, false, { "corvo/reversible": true, "corvo/leaseOnly": true, "corvo/autoUseAllowed": true }),
  tool("concluir_trabalho_worker", "Concluir trabalho do worker", "Valida o dono do lease granular, registra duração/métrica/evento, libera a unidade e sincroniza a próxima etapa sem recriar trabalho persistido.", objectSchema({ worker_id: text("Worker dono do lease"), execution_id: text("Execution ID dono do lease"), work_item_id: text("Unidade adquirida"), resultado: text("CONCLUIDO ou resultado resumido"), resultado_detalhado: text("Metadata/observação opcional") }, ["worker_id","execution_id","work_item_id"]), false),
  tool("registrar_falha_worker", "Registrar falha do worker", "Diferencia ERRO_REAL, RETRYABLE, RELINK_REQUIRED, WAITING_DEPENDENCY e ABANDONED_BY_LEASE. Requeue preserva a antiguidade original do FIFO.", objectSchema({ worker_id: text("Worker dono do lease"), execution_id: text("Execution ID dono"), work_item_id: text("Unidade"), tipo_falha: text("ERRO_REAL, RETRYABLE, RELINK_REQUIRED, WAITING_DEPENDENCY ou ABANDONED_BY_LEASE"), motivo: text("Motivo") }, ["worker_id","execution_id","work_item_id","tipo_falha"]), false),
  tool("executar_watchdog_workers", "Executar watchdog multi-worker", "Varre leases granulares expirados em todas as filas/nichos, marca apenas o worker como abandonado e devolve sua unidade ao FIFO preservando original_ready_at. Não apaga nem faz rollback.", objectSchema({ project_id: text("Projeto opcional") }), false),
  tool("executar_dispatcher_workers", "Executar dispatcher interno", "Acorda o Data Plane interno e consome filas READY em paralelo com leases granulares. É diagnóstico/recuperação manual; normalmente supervisor_exchange e as mutações MCP acordam o dispatcher automaticamente; agendamentos periódicos devem chamar o MCP externamente.", objectSchema({ project_id: text("Projeto opcional"), max_workers: integer("Máximo de workers internos neste disparo, 1..50"), max_cycles: integer("Ciclos internos, 1..10") }), false, false, false, { "corvo/reversible": true, "corvo/autoUseAllowed": true }),
  tool("obter_saude_dispatcher", "Obter saúde do dispatcher", "Leitura compacta do Data Plane: READY executável, workers internos ativos e detecção de READY sem consumidor.", objectSchema({ project_id: text("Projeto opcional") }), true),
  tool("obter_painel_operacional_producao", "Obter painel operacional", "Sala de controle em tempo real: workers ativos, nichos, projetos, etapas, itens, última ação, heartbeat, lease restante, filas, gargalos, throughput e utilização de capacidade.", objectSchema(), true),
  tool("obter_dashboard_gerencial", "Obter dashboard gerencial", "Visão diretoria por período com projetos, throughput, P50/P95/P99 por etapa, produtividade por worker/nicho, relinks, abandonos, retomadas e histórico de filas.", objectSchema({ dias: integer("Período de 1 a 365 dias; padrão 30") }), true),
  tool("configurar_limite_workers", "Configurar capacidade de workers", "Define capacidade por worker_type e domínio, incluindo limite simultâneo e limite por projeto. O valor 3 é apenas padrão e pode escalar.", objectSchema({ worker_type: text("Tipo do worker"), worker_domain: text("Domínio específico ou *"), max_workers: integer("Máximo simultâneo, 1..100"), max_per_project: integer("Máximo no mesmo projeto, 1..100"), enabled: boolean("Ativo") }, ["worker_type","max_workers"]), false),
  tool("configurar_dominio_projeto", "Configurar domínio do projeto", "Define project_domain e propaga para itens ainda herdando o domínio anterior. O domínio controla filas, compatibilidade de workers, perfis e métricas.", objectSchema({ projeto_id: text("Projeto"), project_domain: text("ANIME, FOOTBALL, GAMES, GEEK, CARTOON, GENERAL ou outro namespace operacional") }, ["projeto_id","project_domain"]), false),
  tool("sincronizar_filas_workers", "Sincronizar filas derivadas", "Reconcilia os estados canônicos do projeto/item com as filas multi-worker sem duplicar unidades; a fila é overlay operacional, não fonte de verdade.", objectSchema({ project_id: text("Projeto opcional") }), false),
  tool("exportar_txt_operacao", "Exportar TXT operacional", "Retorna em TXT/JSON estruturado os mesmos dados do painel operacional ou gerencial para auditoria e análise externa.", objectSchema({ visao: text("operational ou management") }), true),
  tool("obter_estado_supervisor", "Obter estado consolidado do Supervisor", "Retorna em uma chamada projeto, itens, lotes, candidatas materializadas, falhas, circuit breakers, perfis, métricas e decisões pendentes.", objectSchema({ projeto_id: text("Projeto opcional; sem ID retorna painel global"), execution_id: executionField }), true),
  tool("obter_painel_supervisor", "Obter painel do Supervisor", "Alias do estado consolidado global ou por projeto.", objectSchema({ projeto_id: text("Projeto opcional"), execution_id: executionField }), true),
  tool("obter_candidatas_qa_visual", "Obter candidatas reais para QA visual", "Compatibilidade: no modo industrial padrão redireciona para fast_visual_packet LINKS_ONLY, incluindo candidatas FAST PUSH já ligadas pela ponte canônica; em modo legado ON pode expor resource_link. Prefira fast_visual_packet.", objectSchema({ projeto_id: text("ID do projeto"), limite: integer("Até 50 candidatas"), execution_id: executionField }, ["projeto_id"]), true),
  tool("listar_decisoes_supervisor", "Listar decisões pendentes", "Lista SUPERVISOR_DECISION_QUEUE por prioridade.", objectSchema({ projeto_id: text("Projeto opcional"), limite: integer("Até 200") }), true),
  tool("resolver_decisao_supervisor", "Resolver decisão do Supervisor", "Marca uma decisão da fila como resolvida após a ação correspondente ter sido executada.", objectSchema({ decisao_id: text("ID SDEC"), decisao: text("Decisão tomada"), observacao: text("Motivo/evidência"), execution_id: executionField }, ["decisao_id","decisao"]), false),
  tool("continuar_processamento", "Continuar processamento", "Alias assíncrono de executar_ate_divergencia: cria/continua um plano, retorna ACK rápido e deixa o Data Plane consumir READY em background até decision boundary. Não espera coleta/materialização terminar.", objectSchema({ projeto_id: text("ID do projeto"), max_itens: integer("Máximo de itens incluídos no plano, 1..500; padrão 200"), max_etapas: integer("Alias legado; mantido por compatibilidade"), execution_id: executionField }, ["projeto_id"]), false, false, true),
  tool("pausar_processamento", "Pausar processamento", "Pausa um projeto preservando estado e fila.", objectSchema({ projeto_id: text("ID do projeto"), execution_id: executionField }, ["projeto_id"]), false),
  tool("cancelar_processamento", "Cancelar processamento", "Cancela a execução automática do projeto sem excluir dados; é uma mudança de estado reversível/reiniciável.", objectSchema({ projeto_id: text("ID do projeto"), execution_id: executionField }, ["projeto_id"]), false),
  tool("pausar_item", "Pausar item", "Pausa um item sem afetar aprovados congelados.", objectSchema({ projeto_id: text("ID do projeto"), item_id: text("ID/chave do item"), execution_id: executionField }, ["projeto_id","item_id"]), false),
  tool("retomar_item", "Retomar item", "Retoma um item não congelado.", objectSchema({ projeto_id: text("ID do projeto"), item_id: text("ID/chave do item"), execution_id: executionField }, ["projeto_id","item_id"]), false),
  tool("cancelar_item", "Cancelar item", "Cancela um item não congelado sem excluir arquivos nem assets do catálogo.", objectSchema({ projeto_id: text("ID do projeto"), item_id: text("ID/chave do item"), execution_id: executionField }, ["projeto_id","item_id"]), false),
  tool("aprovar_candidata", "Aprovar candidata", "Registra QA APROVADO via trilha oficial e congela o asset. Exige candidata materializada real.", objectSchema({ projeto_id: text("ID do projeto"), item_id: text("ID/chave do item"), observacao: text("Justificativa visual"), execution_id: executionField }, ["projeto_id","item_id"]), false),
  tool("rejeitar_candidata", "Rejeitar e continuar", "Operação lógica atômica: registra REJEITADO, descarta a candidata atual, promove a próxima candidata ou reenfileira/relinka o item, mantém os demais workers ativos e retorna project_state + next_work_packet sem GET de confirmação. Idempotente por operation_id; quando omitido o servidor gera um ID e o retorna.", objectSchema({ projeto_id: text("ID do projeto"), item_id: text("ID/chave do item"), observacao: text("Motivo visual"), candidate_id: text("ID da candidata recebida no work packet; recomendado para impedir decisão atrasada sobre a próxima candidata"), operation_id: text("Chave idempotente opcional; recomendada para retry após timeout"), limite_pacote: integer("Próximo pacote até 20; padrão 20"), execution_id: executionField }, ["projeto_id","item_id"]), false),
  tool("relinkar_item", "Relinkar item", "Marca RELINK_REQUIRED; não cria representação visual nem tenta salvar referência errada.", objectSchema({ projeto_id: text("ID do projeto"), item_id: text("ID/chave do item"), observacao: text("Motivo"), execution_id: executionField }, ["projeto_id","item_id"]), false),
  tool("relinkar_itens_lote", "Relinkar itens em lote", "Aplica referência/query/fonte a até 20 gaps numa única chamada idempotente, mantendo aprovados congelados e devolvendo snapshot atualizado.", objectSchema({ projeto_id:text("ID do projeto"), itens:array(objectSchema({ item_id:text("ID/chave"), referencia:text("Referência canônica opcional"), query:text("Query opcional"), fonte:text("Fonte opcional"), timeout_ms:integer("Timeout opcional"), motivo:text("Motivo") },["item_id"]),"Até 20 itens"), operation_id:text("Chave idempotente"), execution_id:executionField },["projeto_id","itens","operation_id"]), false),
  tool("alterar_referencia", "Alterar referência", "Troca a referência semântica de item não congelado.", objectSchema({ projeto_id: text("Projeto"), item_id: text("Item"), referencia: text("Nova referência conhecida"), motivo: text("Motivo"), execution_id: executionField }, ["projeto_id","item_id","referencia"]), false),
  tool("alterar_query", "Alterar query", "Troca a query de coleta e reinicia a rota sem repetir a anterior silenciosamente.", objectSchema({ projeto_id: text("Projeto"), item_id: text("Item"), query: text("Nova query"), motivo: text("Motivo"), execution_id: executionField }, ["projeto_id","item_id","query"]), false),
  tool("trocar_fonte", "Trocar fonte", "Prioriza uma fonte para o item e encaminha nova rota de coleta.", objectSchema({ projeto_id: text("Projeto"), item_id: text("Item"), fonte: text("Fonte conhecida"), motivo: text("Motivo"), execution_id: executionField }, ["projeto_id","item_id","fonte"]), false),
  tool("bloquear_host", "Bloquear host", "Abre circuit breaker manualmente por host.", objectSchema({ host: text("Hostname"), minutos: integer("Duração do bloqueio"), motivo: text("Motivo") }, ["host"]), false),
  tool("desbloquear_host", "Desbloquear host", "Fecha circuit breaker manualmente por host.", objectSchema({ host: text("Hostname"), motivo: text("Motivo") }, ["host"]), false),
  tool("alterar_timeout", "Alterar timeout", "Altera timeout global do coletor ou registra timeout específico na estratégia de um item.", objectSchema({ timeout_ms: integer("1000..120000"), projeto_id: text("Projeto opcional"), item_id: text("Item opcional"), motivo: text("Motivo"), execution_id: executionField }, ["timeout_ms"]), false),
  tool("alterar_configuracao_coleta", "Alterar configuração global da coleta", "Ajusta timeout e paralelismo persistentes usados pela coleta/materialização determinística.", objectSchema({ timeout_ms: integer("1000..120000"), paralelismo: integer("1..20; materializador limita ao teto técnico seguro"), motivo: text("Motivo") }), false),
  tool("alterar_prioridade_fonte", "Alterar prioridade de fonte", "Muda prioridade e opcionalmente ativa/desativa uma fonte persistente.", objectSchema({ fonte: text("ID ou nome"), prioridade: integer("1..100"), ativo: boolean("Ativa/desativa opcional"), motivo: text("Motivo") }, ["fonte","prioridade"]), false),
  tool("atualizar_fonte_coleta", "Atualizar fonte de coleta", "Altera endpoint, parâmetros, headers não secretos, user-agent, timeout e estado da fonte. Authorization/cookies/x-api-key são bloqueados; segredos continuam somente por variável de ambiente.", objectSchema({ fonte: text("ID ou nome"), endpoint: text("Novo endpoint HTTP(S)"), parametro_busca: text("Parâmetro de query"), parametro_limite: text("Parâmetro de limite"), caminho_imagem: text("Path JSON da URL"), caminho_thumbnail: text("Path thumbnail"), headers_permitidos: { type: "object", description: "Headers técnicos não secretos", additionalProperties: { type: "string" } }, user_agent: text("User-Agent técnico"), timeout_ms: integer("Timeout 1000..120000"), ativo: boolean("Ativar/desativar"), motivo: text("Motivo") }, ["fonte"]), false),
  tool("alterar_limites_coleta", "Alterar limites da coleta", "Altera limites persistidos de um lote em andamento.", objectSchema({ lote_id: text("Lote"), max_urls_por_termo: integer("Máximo URLs"), max_fontes_por_termo: integer("Máximo fontes"), max_rodadas: integer("Máximo rodadas"), max_minutos_por_termo: integer("Tempo por termo"), max_minutos_total: integer("Tempo total"), motivo: text("Motivo") }, ["lote_id"]), false),
  tool("materializar_candidata", "Materializar candidata", "Materializa uma candidata descoberta e só a coloca em PARA_ANALISE quando houver arquivo real tecnicamente válido.", objectSchema({ candidata_id: text("ID da candidata") }, ["candidata_id"]), false, false, true),
  tool("descartar_candidata", "Descartar candidata", "Descarta candidata de coleta sem retentá-la.", objectSchema({ candidata_id: text("ID da candidata"), motivo: text("Motivo") }, ["candidata_id"]), false),
  tool("salvar_perfil_coleta", "Salvar perfil de coleta", "Cria/atualiza SOURCE_PROFILE com fontes, hosts, query template, timeout, limites e métricas.", objectSchema({ id: text("ID opcional"), nome: text("Nome"), status: text("ATIVO/INATIVO"), tipo: text("isolated/contextual/qualquer"), domain: text("Nicho operacional: ANIME, FOOTBALL, GAMES, GEEK, CARTOON, GENERAL ou MULTI"), universos: array(text("Universo"), "Universos"), composition_class: text("ISOLATED/CONTEXTUAL"), semantic_class: text("Classe semântica"), hosts_prioritarios: array(text("Host"), "Hosts"), hosts_bloqueados: array(text("Host"), "Hosts"), fontes_prioritarias: array(text("Fonte"), "Fontes"), query_template: text("Template com {termo}/{personagem}/{universo}"), negative_terms: array(text("Termo"), "Negativos"), timeout_ms: integer("Timeout"), max_falhas_consecutivas: integer("Falhas"), max_urls_por_termo: integer("URLs"), max_fontes_por_termo: integer("Fontes"), max_rodadas: integer("Rodadas"), formatos_aceitos: array(text("Formato"), "Formatos"), materializacao: text("Modo"), conversoes_permitidas: array(text("Conversão"), "Conversões"), transparencia: text("Regra alpha"), largura_minima: integer("Largura"), altura_minima: integer("Altura"), prioridade: integer("Prioridade"), padrao: boolean("Salvar como padrão"), observacoes: text("Notas"), motivo: text("Motivo") }, ["nome"]), false),
  tool("atualizar_perfil_coleta", "Atualizar perfil de coleta", "Atualiza SOURCE_PROFILE existente.", objectSchema({ id: text("ID"), nome: text("Nome"), status: text("Status"), tipo: text("Tipo"), universos: array(text("Universo"), "Universos"), composition_class: text("Composição"), semantic_class: text("Semântica"), hosts_prioritarios: array(text("Host"), "Hosts"), hosts_bloqueados: array(text("Host"), "Hosts"), fontes_prioritarias: array(text("Fonte"), "Fontes"), query_template: text("Template"), negative_terms: array(text("Termo"), "Negativos"), timeout_ms: integer("Timeout"), max_falhas_consecutivas: integer("Falhas"), max_urls_por_termo: integer("URLs"), max_fontes_por_termo: integer("Fontes"), max_rodadas: integer("Rodadas"), formatos_aceitos: array(text("Formato"), "Formatos"), materializacao: text("Modo"), conversoes_permitidas: array(text("Conversão"), "Conversões"), transparencia: text("Alpha"), largura_minima: integer("Largura"), altura_minima: integer("Altura"), prioridade: integer("Prioridade"), padrao: boolean("Padrão"), observacoes: text("Notas"), motivo: text("Motivo") }, ["id"]), false),
  tool("listar_perfis_coleta", "Listar perfis de coleta", "Lista SOURCE_PROFILE e métricas determinísticas.", objectSchema({ status: text("Filtro opcional") }), true),
  tool("ativar_perfil_coleta", "Ativar perfil de coleta", "Ativa perfil persistente.", objectSchema({ perfil_id: text("ID"), motivo: text("Motivo") }, ["perfil_id"]), false),
  tool("desativar_perfil_coleta", "Desativar perfil de coleta", "Desativa perfil persistente.", objectSchema({ perfil_id: text("ID"), motivo: text("Motivo") }, ["perfil_id"]), false),
  tool("salvar_como_padrao", "Salvar como padrão", "Define um SOURCE_PROFILE como padrão para próximas coletas noturnas.", objectSchema({ perfil_id: text("ID"), motivo: text("Motivo") }, ["perfil_id"]), false),
  tool("obter_resumo_noturno", "Obter resumo noturno", "Resume conceitos, URLs, materializados, PARA_ANALISE, gaps, hosts bloqueados, fontes e decisões pendentes.", objectSchema({ horas: integer("Janela retroativa; padrão 12") }), true),
  tool("congelar_item", "Congelar item", "Congela o item pela trilha oficial de aprovação visual; exige materialização pronta para QA.", objectSchema({ projeto_id: text("Projeto"), item_id: text("Item"), observacao: text("Evidência"), execution_id: executionField }, ["projeto_id","item_id"]), false),
  tool("registrar_uso_asset", "Registrar uso de asset", "Alias explícito para registrar uso e manter histórico semântico.", objectSchema({ asset_id: text("ID permanente"), projeto: text("Projeto"), bloco: text("Bloco/cena"), preset: text("Preset"), slot: text("Slot"), funcao: text("Função"), referencia_roteiro: text("Contexto"), observacao: text("Observação") }, ["asset_id","projeto"]), false),
  tool("gerar_zip", "Gerar ZIP final", "Gera ZIP apenas com assets resolvidos/aprovados e nomes target do REQUIREMENTS.", objectSchema({ projeto_id: text("Projeto"), execution_id: executionField }, ["projeto_id"]), false),
  tool("validar_consistencia", "Validar consistência", "Executa o gate final antes do ZIP/conclusão.", objectSchema({ projeto_id: text("Projeto"), execution_id: executionField }, ["projeto_id"]), true),
  tool("listar_projetos_automaticos", "Listar projetos automáticos", "Lista resumida e paginada por cursor usando somente o estado materializado do D1; não reconcilia, não lê R2 e não varre itens.", objectSchema({ limite: integer("Máximo de projetos"), cursor: text("Cursor estável updated_at|id retornado pela página anterior") }), true),
  tool("criar_projeto_automatico", "Criar projeto automático", "Cria uma esteira persistente com processamento automático ligado por padrão.", objectSchema({ projeto_id: text("ID idempotente opcional"), nome: text("Nome do projeto"), project_domain: text("Nicho operacional; padrão GENERAL"), prioridade_fila: integer("Prioridade manual da fila; maior primeiro"), automatico: boolean("Ativar processamento automático"), biblioteca_primeiro: boolean("Consultar Biblioteca antes da internet"), busca_externa: boolean("Buscar faltantes externamente"), zip_automatico: boolean("Manter ZIP temporário"), excluir_zip_ao_concluir: boolean("Excluir ZIP temporário na conclusão") }, ["nome"]), false),
  tool("obter_projeto_automatico", "Obter projeto automático", "Retorna o resumo materializado e compacto do projeto. Não reconcilia, não lê R2 e não carrega todos os itens; use obter_detalhes_projeto_automatico quando precisar do dossiê completo.", objectSchema({ projeto_id: text("ID do projeto"), execution_id: executionField }, ["projeto_id"]), true),
  tool("obter_detalhes_projeto_automatico", "Obter detalhes do projeto", "Retorna arquivos, itens e eventos completos somente quando o Supervisor realmente precisa de detalhe. Continua sem reconciliação implícita.", objectSchema({ projeto_id: text("ID do projeto"), execution_id: executionField }, ["projeto_id"]), true),
  tool("obter_snapshot_operacional", "Obter snapshot operacional", "Control plane compacto e tolerante a ausência de telemetria opcional: counts + lease + next_actions + work_packet QA/relink/correção. Não retorna perfis completos nem lista de circuit breakers. since_version atual retorna changed=false.", objectSchema({ projeto_id: text("ID do projeto"), since_version: integer("Última state_version conhecida; opcional"), limite_pacote: integer("Até 20 itens por fila; padrão 20"), execution_id: executionField }, ["projeto_id"]), true),
  tool("obter_workspace_politicas", "Workspace de políticas operacionais", "Retorna visão consolidada dos gaps, políticas ativas/em teste, CORE_RULES e telemetria de aprendizado industrial.", objectSchema(), true),
  tool("detectar_gap_operacional", "Detectar gap operacional", "Registra/idempotentemente incrementa um gap por assinatura estável. Não bloqueia workers e não promove política automaticamente.", objectSchema({ signature:text("Assinatura opcional; se vazio é derivada"), category:text("Categoria do gap"), severity:text("LOW/MEDIUM/HIGH/CRITICAL"), project_id:text("Projeto"), item_id:text("Item"), domain:text("Domínio"), universe:text("Universo"), composition_class:text("Classe de composição"), semantic_class:text("Classe semântica"), preset:text("Preset"), source:text("Fonte"), host:text("Host"), tool:text("Ferramenta"), worker_type:text("Worker"), symptom:text("Sintoma"), root_cause:text("Causa raiz"), evidence:openPolicyJsonSchema }, ["category","symptom"]), false),
  tool("listar_gaps_operacionais", "Listar gaps operacionais", "Lista gaps por recorrência/última ocorrência para o Supervisor priorizar aprendizado.", objectSchema({ status:text("OPEN/RECURRED/RESOLVED"), category:text("Categoria"), project_id:text("Projeto"), limit:integer("Até 500") }), true),
  tool("obter_gap_operacional", "Obter gap operacional", "Obtém evidências e vínculo de política de um gap.", objectSchema({ gap_id:text("Gap") }, ["gap_id"]), true),
  tool("criar_politica_operacional", "Criar política operacional", "Cria LEARNED_POLICY versionada em DRAFT/TESTING. Não permite criar CORE_RULE por MCP.", operationalPolicySchema, false),
  tool("editar_politica_operacional", "Editar política operacional", "Cria nova versão imutável de uma política aprendida, preservando histórico e versão anterior.", objectSchema({ policy_id:text("Política/version ID"), name:text("Nome"), description:text("Descrição"), category:text("Categoria"), status:text("Status"), scope_level:text("Escopo"), propagation_level:integer("Propagação"), domain:text("Domínio"), universe:text("Universo"), work_type:text("Tipo"), composition_class:text("Composição"), semantic_class:text("Semântica"), preset:text("Preset"), project_id:text("Projeto"), item_id:text("Item"), condition:openPolicyJsonSchema, action:openPolicyJsonSchema, priority:integer("Prioridade"), confidence:integer("Confiança 0..100"), notes:text("Notas") }, ["policy_id"]), false),
  tool("testar_politica_operacional", "Testar política operacional", "Dry-run: mede quantos eventos/gaps seriam afetados, chamadas potencialmente evitadas, conflitos e risco sem alterar a produção.", objectSchema({ policy_id:text("Política"), lookback_days:integer("Janela 1..365") }, ["policy_id"]), true),
  tool("ativar_politica_operacional", "Ativar política operacional", "Ativa política aprendida reversível. CORE_RULE permanece imutável.", objectSchema({ policy_id:text("Política") }, ["policy_id"]), false),
  tool("promover_politica_operacional", "Promover política operacional", "Promove escopo ITEM→PROJECT→UNIVERSE→DOMAIN→GLOBAL. Promoção GLOBAL exige confirmar_alto_impacto=true; nunca ocorre silenciosamente.", objectSchema({ policy_id:text("Política"), scope_level:text("PROJECT/UNIVERSE/DOMAIN/GLOBAL"), confirmar_alto_impacto:boolean("Obrigatório para GLOBAL"), notes:text("Evidência da promoção") }, ["policy_id","scope_level"]), false),
  tool("suspender_politica_operacional", "Suspender política operacional", "Suspende reversivelmente uma política aprendida.", objectSchema({ policy_id:text("Política") }, ["policy_id"]), false),
  tool("rollback_politica_operacional", "Rollback de política operacional", "Reativa versão anterior e marca a versão atual como ROLLED_BACK, sem apagar histórico.", objectSchema({ policy_id:text("Versão atual"), target_version:integer("Versão alvo; padrão anterior") }, ["policy_id"]), false),
  tool("listar_politicas_operacionais", "Listar políticas operacionais", "Lista políticas por status/categoria/domínio/universo e inclui a lista fixa de CORE_RULES.", objectSchema({ status:text("Status"), category:text("Categoria"), domain:text("Domínio"), universe:text("Universo"), limit:integer("Até 500") }), true),
  tool("obter_politicas_aplicadas", "Resolver políticas aplicadas", "Executa o motor local de precedência para um contexto e mostra fontes bloqueadas/preferidas, timeout, retry e regras de pipeline. Não cria side effects.", operationalContextSchema, true),
  tool("vincular_gap_politica", "Vincular gap a política", "Marca um gap como resolvido pela política informada e registra auditoria.", objectSchema({ gap_id:text("Gap"), policy_id:text("Política") }, ["gap_id","policy_id"]), false),
  tool("obter_telemetria_politicas", "Telemetria das políticas", "Retorna repeated gap rate, policy hit rate, tempo/chamadas externas evitadas, falsos positivos e rollbacks.", objectSchema({ days:integer("Janela 1..365") }), true),
  tool("resolver_gap_e_aprender", "Resolver gap e aprender", "Operação composta: registra o gap, opcionalmente cria/ativa política local, vincula a resolução e devolve impacto sem bloquear outros workers.", objectSchema({ signature:text("Assinatura opcional"), category:text("Categoria"), severity:text("Severidade"), project_id:text("Projeto"), item_id:text("Item"), domain:text("Domínio"), universe:text("Universo"), composition_class:text("Composição"), source:text("Fonte"), host:text("Host"), tool:text("Ferramenta"), symptom:text("Sintoma"), root_cause:text("Causa"), evidence:openPolicyJsonSchema, policy:openPolicyJsonSchema, activate:boolean("Ativar política criada") }, ["category","symptom"]), false, false, false, {"corvo/reversible":true,"corvo/autoUseAllowed":true}),
  tool("supervisor_exchange", "Supervisor Exchange V61", "CAMINHO QUENTE V60: em uma única chamada aplica decisões/comandos do pacote anterior, aceita um plano de alto nível, cria N branches, sincroniza filas e devolve ACK + próximo work packet. Não espera downloads/buscas terminarem. Uma chamada externa pode gerar dezenas de ações internas paralelas.", objectSchema({ projeto_id:text("Projeto; opcional se quiser assumir o próximo elegível"), execution_id:executionField, operation_id:text("ID idempotente; recomendado"), intent:text("Intenção do plano; padrão EXECUTE_UNTIL_DIVERGENCE"), decisions:array(supervisorPlanCommandSchema,"Decisões do pacote anterior, até 50"), commands:array(supervisorPlanCommandSchema,"Comandos/ramificações adicionais, até 50"), scope:supervisorPlanScopeSchema, policies:supervisorPlanPoliciesSchema, max_parallelism:integer("Paralelismo máximo do plano"), packet_limit:integer("Até 50 decisões no próximo pacote"), ttl_minutos:integer("TTL do lease") }), false, false, false, {"corvo/reversible":true,"corvo/planFanout":true,"corvo/autoUseAllowed":true}),
  tool("executar_ate_divergencia", "Executar até divergência", "Cria/continua um SUPERVISOR_PLAN e libera o app para avançar deterministicamente até decision boundary, pacote pronto, conclusão ou erro real. ACK rápido; processamento pesado ocorre fora da chamada de controle.", objectSchema({ projeto_id:text("Projeto; opcional para assumir próximo"), execution_id:executionField, operation_id:text("ID idempotente"), scope:supervisorPlanScopeSchema, policies:supervisorPlanPoliciesSchema, max_parallelism:integer("Paralelismo máximo"), packet_limit:integer("Tamanho do pacote") }), false, false, false, {"corvo/reversible":true,"corvo/planFanout":true,"corvo/autoUseAllowed":true}),
  tool("obter_work_packet", "Obter work packet V60", "Retorna apenas decision boundaries prontos + counts + lease + plano ativo. Use quando o Supervisor precisa visionar/decidir; não retorna histórico/payload gigante.", objectSchema({ projeto_id:text("Projeto"), since_version:integer("Versão conhecida"), limite:integer("Até 50 por pacote"), execution_id:executionField },["projeto_id"]), true),
  tool("obter_status_plano", "Obter status do plano", "Retorna status agregado de um SUPERVISOR_PLAN e contagem de branches por estado.", objectSchema({ plan_id:text("PLAN-*" )},["plan_id"]), true),
  tool("obter_detalhes_plano", "Obter detalhes do plano", "Diagnóstico paginado/limitado das branches de um plano. Fora do caminho quente.", objectSchema({ plan_id:text("PLAN-*"), limite:integer("Até 500") },["plan_id"]), true),
  tool("obter_excecoes_plano", "Obter exceções do plano", "Lista apenas branches que chegaram a WAITING_SUPERVISOR, FAILED ou WAITING_DEPENDENCY.", objectSchema({ plan_id:text("PLAN-*"), limite:integer("Até 200") },["plan_id"]), true),
  tool("executar_tick_planos", "Executar tick de planos", "Executa deterministicamente planos/branches já aceitos fora do round trip de criação. Também é chamado pelo watchdog agendado do app.", objectSchema({ plan_id:text("Plano específico opcional"), projeto_id:text("Projeto opcional"), max_planos:integer("Até 20"), max_etapas:integer("1–5 passos internos") }), false, false, true, {"corvo/reversible":true,"corvo/autoUseAllowed":true}),
  tool("pausar_plano", "Pausar plano", "Pausa branches ainda não iniciadas sem apagar trabalho persistido.", objectSchema({ plan_id:text("PLAN-*"), execution_id:executionField },["plan_id"]), false),
  tool("retomar_plano", "Retomar plano", "Recoloca branches pausadas na fila sem recriar trabalho concluído.", objectSchema({ plan_id:text("PLAN-*"), execution_id:executionField },["plan_id"]), false),
  tool("cancelar_plano", "Cancelar plano", "Cancela apenas o plano/branches pendentes; não exclui assets, arquivos ou projeto.", objectSchema({ plan_id:text("PLAN-*"), execution_id:executionField },["plan_id"]), false),
  tool("obter_plano_roteamento_fonte", "Obter source routing plan", "Mostra o hard filter por domínio/universo/capabilities antes do fan-out: fontes elegíveis, excluídas e motivos. Use para diagnosticar ROUTING_CONFIGURATION_GAP/DISCOVERY_ADAPTER_MISSING.", objectSchema({ projeto_id:text("Projeto"), item_id:text("Item opcional"), reconstruir:boolean("Recalcular usando estado atual") },["projeto_id"]), true),
  tool("configurar_projeto_automatico", "Configurar projeto automático", "Atualiza as chaves da esteira sem interromper o lote atual.", objectSchema({ projeto_id: text("ID do projeto"), nome: text("Nome"), project_domain: text("Nicho operacional"), prioridade_fila: integer("Prioridade manual"), automatico: boolean("Automático"), biblioteca_primeiro: boolean("Biblioteca primeiro"), busca_externa: boolean("Busca externa"), materializacao_paralela: boolean("Materialização paralela"), qa_tecnico: boolean("QA técnico automático"), zip_automatico: boolean("ZIP automático"), excluir_zip_ao_concluir: boolean("Excluir ZIP ao concluir"), circuit_breaker: boolean("Circuit breaker") }, ["projeto_id"]), false),
  tool("anexar_arquivo_projeto", "Anexar arquivo ao projeto", "Salva e versiona SCRIPT ou REQUIREMENTS no R2. Para texto gerado pela IA, prefira conteudo_txt: isso evita depender de URL temporária. Também aceita arquivo anexado, download_url, url ou uri HTTPS. Quando o par fica completo, inicia a esteira automaticamente.", objectSchema({ projeto_id: text("ID do projeto"), tipo: text("SCRIPT ou REQUIREMENTS"), conteudo_txt: text("Conteúdo integral UTF-8 do TXT; opção preferida para arquivos gerados pela IA"), nome_arquivo: text("Nome do TXT, por exemplo ROTEIRO.txt ou IMAGENS_NECESSARIAS.txt"), arquivo: projectFileSchema }, ["projeto_id", "tipo"]), false, false, false, { "openai/fileParams": ["arquivo"] }),
  tool("obter_conteudo_arquivo_projeto", "Obter conteúdo de arquivo do projeto", "Lê SCRIPT ou REQUIREMENTS já versionado no R2 e devolve o conteúdo TXT real. Se arquivo_id não for informado, usa a versão mais recente que combinar com tipo/versão. Arquivos grandes podem ser lidos em blocos com inicio_caractere e limite_caracteres.", objectSchema({ projeto_id: text("ID do projeto"), arquivo_id: text("ID exato do arquivo, opcional"), tipo: text("SCRIPT ou REQUIREMENTS, opcional"), versao: integer("Versão exata, opcional"), inicio_caractere: integer("Posição inicial para leitura em blocos; padrão 0"), limite_caracteres: integer("Até 500000 caracteres por chamada; padrão 200000"), execution_id: executionField }, ["projeto_id"]), true),
  tool("baixar_arquivo_projeto", "Baixar arquivo do projeto", "Retorna um link temporário autenticado para baixar o SCRIPT ou REQUIREMENTS original diretamente do R2, preservando nome, versão, tamanho e hash.", objectSchema({ projeto_id: text("ID do projeto"), arquivo_id: text("ID exato do arquivo, opcional"), tipo: text("SCRIPT ou REQUIREMENTS, opcional"), versao: integer("Versão exata, opcional"), validade_minutos: integer("Validade do link, de 1 a 60 minutos; padrão 30"), execution_id: executionField }, ["projeto_id"]), true),
  tool("processar_projeto_automatico", "Processar projeto automático", "Executa um ciclo determinístico de biblioteca/coleta/materialização e reconciliação. QA visual, relink adaptativo e decisões semânticas ficam pendentes para o Supervisor ChatGPT via MCP.", objectSchema({ projeto_id: text("ID do projeto"), max_etapas: integer("De 1 a 20 ciclos nesta chamada; padrão 5"), execution_id: executionField }, ["projeto_id"]), false, false, true),
  tool("reconciliar_projeto_automatico", "Reconciliar projeto automático", "Recalcula o estado visível a partir de arquivos materializados, assets congelados e fan-out real, preservando o histórico.", objectSchema({ projeto_id: text("ID do projeto"), execution_id: executionField }, ["projeto_id"]), false),
  tool("validar_consistencia_projeto", "Validar consistência do projeto", "Executa o gate final: target files, assets, objetos R2, pendências, nomes duplicados e progresso reconciliado.", objectSchema({ projeto_id: text("ID do projeto"), execution_id: executionField }, ["projeto_id"]), true),
  tool("registrar_qa_projeto", "Registrar QA do projeto", "Registra QA do projeto no mesmo caminho canônico para Pendentes e FAST PUSH. Aprovação congela o arquivo real, cria/reutiliza asset e liga linkedAssetId ao PITEM; rejeição FAST PUSH promove a próxima candidata sem reexecutar o materializador pesado.", objectSchema({ projeto_id: text("ID do projeto"), decisoes: array(objectSchema({ item_id: text("ID interno ou chave do item"), status: text("APROVADO, REJEITADO, RELINK_REQUIRED ou CORRECAO_TECNICA_PERMITIDA"), observacao: text("Observação") }, ["item_id", "status"]), "Decisões"), execution_id: executionField }, ["projeto_id", "decisoes"]), false),
  tool("regenerar_zip_projeto", "Regenerar ZIP do projeto", "Atualiza o ZIP temporário somente com assets resolvidos e devolve o link de download.", objectSchema({ projeto_id: text("ID do projeto"), execution_id: executionField }, ["projeto_id"]), false),
  tool("reabrir_projeto_concluido", "Reabrir projeto concluído", "Reabre explicitamente um projeto concluído para o Supervisor MCP. Preserva APPROVED/FROZEN/LINKED, escolhe uma execução canônica do grupo e reabre somente gaps não resolvidos ou a lista explícita informada. Exige confirmar_reabertura=true no próprio argumento, mas não apaga dados.", objectSchema({ projeto_id: text("ID de qualquer execução do grupo lógico"), confirmar_reabertura: boolean("Deve ser true; autorização explícita"), gaps: array(text("item_id, item_key ou target filename a reabrir; vazio = todos os gaps reais não resolvidos"), "Gaps autorizados"), motivo: text("Motivo auditável da reabertura") }, ["projeto_id", "confirmar_reabertura"]), false),
  tool("verificar_disponibilidade_projeto", "Verificar projeto liberado para IA", "Verifica se um projeto ou grupo de mesmo nome está liberado para execução. Concluídos continuam bloqueados até uma reabertura explícita e auditada pelo proprietário/Supervisor.", objectSchema({ projeto_id: text("ID do projeto"), nome: text("Nome do projeto quando o ID ainda não é conhecido") }, []), true),
  tool("obter_log_projeto", "Obter log do projeto", "Retorna log TXT completo com métricas, estado por item e eventos cronológicos.", objectSchema({ projeto_id: text("ID do projeto"), execution_id: executionField }, ["projeto_id"]), true),
  tool("configurar_fontes_coleta", "Configurar fontes de coleta", "Importa ou atualiza fontes de pesquisa por TXT. Segredos nunca entram no texto: informe somente API_KEY_ENV e, opcionalmente, API_KEY_HEADER.", objectSchema({ fontes_texto: text("Configuração TXT das fontes"), arquivo_txt: openAiFileSchema }, []), false, false, true, { "openai/fileParams": ["arquivo_txt"] }),
  tool("listar_fontes_coleta", "Listar fontes de coleta", "Lista fontes, prioridade, estado e métricas acumuladas sem revelar segredos.", objectSchema(), true),
  tool("criar_lote_coleta_automatica", "Criar coleta automática", "Cria um lote persistente a partir de linhas TERMO | quantidade | tipo | universo opcional. Pode receber os termos e as fontes como TXT anexado.", objectSchema({ nome: text("Nome do lote"), termos_texto: text("Linhas de termos"), arquivo_termos_txt: openAiFileSchema, fontes_texto: text("Configuração opcional de fontes"), arquivo_fontes_txt: openAiFileSchema, max_urls_por_termo: integer("Máximo de URLs tentadas por termo"), max_fontes_por_termo: integer("Máximo de fontes por termo"), max_rodadas_por_termo: integer("Máximo de rodadas por termo"), max_minutos_por_termo: integer("Tempo máximo por termo"), max_minutos_total: integer("Tempo máximo total do lote") }, []), false, false, true, { "openai/fileParams": ["arquivo_termos_txt", "arquivo_fontes_txt"] }),
  tool("executar_coleta_automatica", "Executar coleta automática", "Executa de uma a cinco rodadas limitadas, persiste o progresso e pode ser chamada novamente pela IA até concluir. Para de consultar fontes assim que cada meta é atingida.", objectSchema({ lote_id: text("ID do lote"), max_rodadas: integer("De 1 a 5 rodadas nesta chamada"), execution_id: executionField }, ["lote_id"]), false, false, true),
  tool("obter_status_coleta_automatica", "Obter status da coleta", "Retorna lote, progresso, termos, contagens e possibilidade de retomada.", objectSchema({ lote_id: text("ID do lote"), execution_id: executionField }, ["lote_id"]), true),
  tool("listar_lotes_coleta_automatica", "Listar coletas automáticas", "Lista os lotes de coleta mais recentes e seus estados persistidos.", objectSchema({ limite: integer("Máximo de lotes") }), true),
  tool("controlar_lote_coleta", "Controlar coleta automática", "Pausa, retoma ou cancela um lote persistente sem apagar candidatas, arquivos ou catálogo.", objectSchema({ lote_id: text("ID do lote"), acao: text("pausar, retomar ou cancelar"), execution_id: executionField }, ["lote_id", "acao"]), false),
  tool("listar_para_analise_coleta", "Listar fila de QA da coleta", "Lista arquivos materializados em PARA_ANALISE com filtros por lote, termo, tipo, fonte e status.", objectSchema({ lote_id: text("Lote"), termo: text("Termo contém"), tipo: text("transparente, contextual ou qualquer"), fonte_id: text("ID da fonte"), status: text("PARA_ANALISE, DESCARTADO ou outro"), limite: integer("Até 100") }), true),
  tool("gerar_relatorio_coleta", "Gerar relatório da coleta", "Gera e persiste o TXT completo por termo e fonte, incluindo metas, materializados e razões de falha.", objectSchema({ lote_id: text("ID do lote"), execution_id: executionField }, ["lote_id"]), false),
  tool("obter_log_detalhado_coleta", "Obter log detalhado da coleta", "Gera o TXT técnico integral do lote com um gap por imagem faltante, consultas por fonte, cada URL candidata, HTTP, host, bytes, materialização, eventos e causa exata da falha.", objectSchema({ lote_id: text("ID do lote"), execution_id: executionField }, ["lote_id"]), true),
  tool("listar_configuracoes", "Listar configurações", "Retorna configurações operacionais sem revelar códigos ou segredos.", objectSchema(), true),
  tool("atualizar_configuracao", "Atualizar configuração", "Cria ou atualiza uma configuração operacional não secreta.", objectSchema({ chave: text("Chave; não pode começar com mcp_") , valor: text("Valor") }, ["chave", "valor"]), false),
  tool("obter_configuracao_cloudflare", "Obter configuração Cloudflare", "Retorna o estado persistido da conexão Cloudflare sem revelar a chave secreta.", objectSchema(), true),
  tool("configurar_cloudflare", "Configurar Cloudflare", "Salva R2 e D1 de forma protegida no banco remoto. Depois de salvo, qualquer PC reutiliza a configuração sem TXT ou variáveis Cloudflare. Segredos podem ser omitidos quando já estiverem salvos.", objectSchema({ account_id: text("Cloudflare Account ID"), bucket: text("Nome do bucket R2"), access_key_id: text("R2 Access Key ID"), secret_access_key: text("R2 Secret Access Key; opcional se já salva"), r2_endpoint: text("Endpoint S3 do R2; opcional"), d1_api_token: text("API Token com D1 Read; opcional se já salvo"), d1_database_id: text("Database ID do D1; opcional, detectado automaticamente"), d1_database_name: text("Nome do D1; opcional") }, ["account_id"]), false),
  tool("FAST_APPROVE_PROJECT_ITEMS", "FAST APPROVE — aprovar itens do projeto", "Rota super enxuta para aprovação rápida por projeto. Recebe até 100 pares item+candidata (item_id/project_item_id/pitem/target_file + candidate_id) e responde com ACK imediato + operation_id. O request não carrega o lote inteiro nem espera reconciliação síncrona: a finalização APPROVED -> frozen_asset_id -> contador do projeto segue no Data Plane e pode ser acompanhada via obter_resultado_operacao.", objectSchema({ projeto_id: text("ID do projeto"), itens: array(objectSchema({ item_id: text("ID do PITEM/item_key/target_file"), project_item_id: text("Alias de item_id"), pitem: text("Alias curto de item_id"), target_file: text("Alias de item_id pelo nome do arquivo"), candidate_id: text("ID da candidata do projeto"), supervisor_candidate_id: text("Alias de candidate_id"), fast_push_candidate_id: text("Alias de candidate_id via FAST PUSH"), observacao: text("Observação opcional") }, ["candidate_id"]), "Até 100 pares item+candidata"), operation_id: text("Chave idempotente da operação/recibo durável"), execution_id: executionField }, ["projeto_id","itens"]), false),
  tool("aplicar_decisoes_supervisor_lote", "Aplicar decisões do Supervisor em lote", "FAST ACK: persiste atomicamente até 200 decisões de QA/relink/correção e retorna imediatamente com operation_id. Congelamento, catalogação, R2, contadores e fan-out continuam no Data Plane. Consulte obter_resultado_operacao para progresso/resultado final.", objectSchema({ projeto_id: text("ID do projeto"), decisoes: array(objectSchema({ item_id: text("ID/chave do item"), status: text("APROVADO, REJEITADO, RELINK_REQUIRED ou CORRECAO_TECNICA_PERMITIDA"), observacao: text("Observação") }, ["item_id","status"]), "Até 200 decisões"), operation_id: text("Chave idempotente da operação/recibo durável"), execution_id: executionField }, ["projeto_id","decisoes"]), false),
  tool("materializar_urls_lote", "Materializar URLs em lote", "Materializa até 20 itens/URLs em uma única operação, com idempotência e sem exigir round trip por asset.", objectSchema({ batch_id: text("ID estável do lote"), projeto: text("Projeto"), itens: array(materializationItemSchema, "Até 20 itens"), operation_id: text("Chave idempotente"), execution_id: executionField }, ["batch_id","itens","operation_id"]), false, false, true),
  tool("obter_resultado_operacao", "Obter resultado de operação", "Recupera o resultado persistido de uma mutação idempotente após timeout, sem repetir o trabalho.", objectSchema({ operation_id: text("ID da operação") }, ["operation_id"]), true),
  tool("obter_ultima_operacao", "Obter última operação", "Fallback após timeout quando o operation_id não ficou visível: recupera a última operação persistida por projeto e ferramenta sem repetir a mutação.", objectSchema({ projeto_id: text("ID do projeto"), ferramenta: text("Nome da ferramenta, ex. rejeitar_candidata") }, ["projeto_id","ferramenta"]), true),
  tool("obter_performance_mcp", "Obter performance MCP", "Retorna P50/P95/P99, endpoints mais lentos, maiores payloads e ferramentas mais chamadas com base na instrumentação V56.", objectSchema({ horas: integer("Janela em horas; padrão 24") }), true),
  tool("obter_ranking_rotas_fontes", "Obter ranking de rotas/fontes", "Retorna score aprendido por universo + compositionClass + fonte + host para orientar roteamento determinístico.", objectSchema({ universo: text("Universo"), composition_class: text("CONTEXTUAL ou ISOLATED"), limite: integer("Até 200") }), true),
  tool("obter_politica_risco_mcp", "Obter política de risco MCP", "Audita as ferramentas publicadas e retorna classificação de baixo risco, destrutiva ou sensível, incluindo elegibilidade para uso contínuo.", objectSchema(), true),
  tool("obter_log_mcp", "Obter log MCP", "Retorna as últimas chamadas de ferramentas para auditoria.", objectSchema({ limite: integer("Máximo") }), true),
  tool("verificar_saude", "Verificar saúde", "Testa banco e armazenamento.", objectSchema(), true),
];

const id = (prefix: string) => `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
const limitOf = (value: unknown, max = 200) => Math.max(1, Math.min(max, Number(value) || 50));
const record = (input: unknown) => (input && typeof input === "object" ? input as Record<string, unknown> : {});
const string = (value: unknown) => typeof value === "string" ? value.trim() : "";
const optional = (value: unknown) => string(value) || null;
const list = (value: unknown) => Array.isArray(value) ? value.map(string).filter(Boolean) : [];

async function textFromInput(input: Record<string, unknown>, textKey: string, fileKey: string) {
  const direct = string(input[textKey]);
  if (direct) return direct;
  const file = record(input[fileKey]), url = string(file.download_url);
  if (!url) return "";
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`TXT_DOWNLOAD_FAILED:${response.status}`);
  if (Number(response.headers.get("content-length") || 0) > 2 * 1024 * 1024) throw new Error("TXT_LIMIT_2_MB");
  return response.text();
}
const MAX_ZIP_BYTES = 250 * 1024 * 1024;
const MULTIPART_CHUNK_BYTES = 5 * 1024 * 1024;
const ZIP_CACHE_TTL_MS = 48 * 60 * 60_000;
const activeZipExports = new Map<string, Promise<ZipExportResult>>();
let firstToolInvocation = true;
const collectionKeys: Record<string, string> = {
  buscar_assets: "assets",
  obter_historico_asset: "usos",
  listar_pendentes: "assets",
  listar_solicitacoes: "solicitacoes",
  listar_lotes: "lotes",
  listar_importacoes: "importacoes",
  listar_configuracoes: "configuracoes",
  obter_log_mcp: "chamadas",
};

function structuredResult(toolName: string, value: unknown) {
  if (!Array.isArray(value)) return value;
  return { [collectionKeys[toolName] || "itens"]: value, total: value.length };
}

function takeQueuedBytes(chunks: Uint8Array[], size: number) {
  const output = new Uint8Array(size);
  let offset = 0;
  while (offset < size) {
    const current = chunks[0];
    const take = Math.min(current.byteLength, size - offset);
    output.set(current.subarray(0, take), offset);
    offset += take;
    if (take === current.byteLength) chunks.shift();
    else chunks[0] = current.subarray(take);
  }
  return output;
}

type ZipExportEntry = { id: string; r2Key: string; name: string };
type ZipExportResult = { r2Key: string; sizeBytes: number; cacheHit: boolean; generationMs: number };

async function hashSelection(entries: ZipExportEntry[], manifest: string) {
  const input = JSON.stringify({ entries: entries.map(({ id, r2Key, name }) => ({ id, r2Key, name })), manifest });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function cleanupExpiredZipCache() {
  const listed = await env.BUCKET.list({ prefix: "exports/zips/", limit: 50 });
  const cutoff = Date.now() - ZIP_CACHE_TTL_MS;
  const expired = listed.objects.filter((object) => object.uploaded.getTime() < cutoff).map((object) => object.key);
  if (expired.length) await env.BUCKET.delete(expired);
  return expired.length;
}

async function generateStreamingZip(r2Key: string, entries: ZipExportEntry[], manifest: string, fileName: string): Promise<ZipExportResult> {
  const started = Date.now();
  const upload = await env.BUCKET.createMultipartUpload(r2Key, {
    httpMetadata: { contentType: "application/zip" },
    customMetadata: { fileName, createdAt: new Date().toISOString(), cacheTtlHours: "48" },
  });
  const queuedChunks: Uint8Array[] = [];
  const uploadedParts: Array<{ partNumber: number; etag: string }> = [];
  let queuedBytes = 0, totalBytes = 0, partNumber = 1;
  let uploadChain = Promise.resolve();
  let settle: (() => void) | null = null;
  let rejectZip: ((error: unknown) => void) | null = null;
  const completed = new Promise<void>((resolve, reject) => { settle = resolve; rejectZip = reject; });
  const schedulePart = (part: Uint8Array) => {
    const currentPart = partNumber++;
    uploadChain = uploadChain.then(async () => { uploadedParts.push(await upload.uploadPart(currentPart, part)); });
  };
  const archive = new Zip((error, chunk, final) => {
    if (error) { rejectZip?.(error); return; }
    if (chunk?.byteLength) {
      queuedChunks.push(chunk); queuedBytes += chunk.byteLength; totalBytes += chunk.byteLength;
      while (queuedBytes >= MULTIPART_CHUNK_BYTES) {
        schedulePart(takeQueuedBytes(queuedChunks, MULTIPART_CHUNK_BYTES));
        queuedBytes -= MULTIPART_CHUNK_BYTES;
      }
    }
    if (final) {
      if (queuedBytes > 0) schedulePart(takeQueuedBytes(queuedChunks, queuedBytes));
      uploadChain.then(async () => {
        if (!uploadedParts.length) throw new Error("ZIP_EMPTY");
        await upload.complete(uploadedParts);
      }).then(() => settle?.(), (reason) => rejectZip?.(reason));
    }
  });
  try {
    for (const entry of entries) {
      const object = await env.BUCKET.get(entry.r2Key);
      if (!object?.body) throw new Error(`R2_FILE_NOT_FOUND:${entry.id}`);
      const file = new ZipPassThrough(entry.name);
      archive.add(file);
      const reader = object.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        file.push(value instanceof Uint8Array ? value : new Uint8Array(value));
        await uploadChain;
      }
      file.push(new Uint8Array(0), true);
      await uploadChain;
    }
    const manifestFile = new ZipPassThrough("EXPORTACAO.txt");
    archive.add(manifestFile);
    manifestFile.push(strToU8(manifest), true);
    archive.end();
    await completed;
    return { r2Key, sizeBytes: totalBytes, cacheHit: false, generationMs: Date.now() - started };
  } catch (error) {
    archive.terminate();
    await upload.abort().catch(() => undefined);
    throw error;
  }
}

async function getOrCreateZip(entries: ZipExportEntry[], manifest: string, fileName: string) {
  const hash = await hashSelection(entries, manifest);
  const r2Key = `exports/zips/${hash}.zip`;
  const existing = await env.BUCKET.head(r2Key);
  if (existing && existing.uploaded.getTime() >= Date.now() - ZIP_CACHE_TTL_MS) {
    return { hash, result: { r2Key, sizeBytes: existing.size, cacheHit: true, generationMs: 0 } satisfies ZipExportResult };
  }
  let job = activeZipExports.get(hash);
  if (!job) {
    job = generateStreamingZip(r2Key, entries, manifest, fileName).finally(() => activeZipExports.delete(hash));
    activeZipExports.set(hash, job);
  }
  return { hash, result: await job };
}

async function persistZipResponse(response: Response, requestedName: string, manifestText: unknown) {
  if (!response.ok || !response.body) throw new Error(`Falha ao obter ZIP: HTTP ${response.status}`);
  const declaredSize = Number(response.headers.get("content-length")) || 0;
  if (declaredSize > MAX_ZIP_BYTES) throw new Error("O ZIP excede o limite de 250 MB.");
  const importId = id("IMP");
  const rawName = requestedName || `importacao-${importId}.zip`;
  if (!rawName.toLowerCase().endsWith(".zip")) throw new Error("O arquivo recebido não possui extensão .zip.");
  const fileName = rawName.replace(/[^a-zA-Z0-9._-]/g, "-");
  const r2Key = `incoming/${importId}/${fileName}`;
  const upload = await env.BUCKET.createMultipartUpload(r2Key, { httpMetadata: { contentType: "application/zip" } });
  const reader = response.body.getReader();
  const queuedChunks: Uint8Array[] = [];
  const uploadedParts: Array<{ partNumber: number; etag: string }> = [];
  let queuedBytes = 0, received = 0, partNumber = 1;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      received += chunk.byteLength;
      if (received > MAX_ZIP_BYTES) throw new Error("O ZIP excede o limite de 250 MB.");
      queuedChunks.push(chunk);
      queuedBytes += chunk.byteLength;
      while (queuedBytes >= MULTIPART_CHUNK_BYTES) {
        const part = takeQueuedBytes(queuedChunks, MULTIPART_CHUNK_BYTES);
        uploadedParts.push(await upload.uploadPart(partNumber, part));
        partNumber += 1;
        queuedBytes -= MULTIPART_CHUNK_BYTES;
      }
    }
    if (queuedBytes > 0) uploadedParts.push(await upload.uploadPart(partNumber, takeQueuedBytes(queuedChunks, queuedBytes)));
    if (!uploadedParts.length) throw new Error("O ZIP recebido está vazio.");
    await upload.complete(uploadedParts);
  } catch (error) {
    await upload.abort().catch(() => undefined);
    throw error;
  }
  const value = { id: importId, fileName, r2Key, sizeBytes: received, status: "Recebido", manifestText: optional(manifestText) };
  await getDb().insert(imports).values(value);
  return processZipImport(importId);
}

async function audit(toolName: string, success: boolean, summary: string, perf: { requestId?:string; startedAt?:Date; finishedAt?:Date; durationMs?:number; authMs?:number; parseMs?:number; responseBytes?:number; serializationMs?:number; coldStart?:boolean } = {}) {
  try { await getDb().insert(mcpAudit).values({ id: id("AUD"), requestId:perf.requestId||null, tool: toolName, success, summary: summary.slice(0, 500), startedAt:perf.startedAt||null, finishedAt:perf.finishedAt||null, durationMs:perf.durationMs??null, authMs:perf.authMs||0, parseMs:perf.parseMs||0, responseBytes:perf.responseBytes||0, serializationMs:perf.serializationMs||0, coldStart:perf.coldStart===true, createdAt:perf.finishedAt||new Date() }); } catch { /* audit must not mask tool result */ }
}

async function registerUsage(input: Record<string, unknown>) {
  const assetId = string(input.asset_id), project = string(input.projeto);
  const [asset] = await getDb().select().from(assets).where(eq(assets.id, assetId)).limit(1);
  if (!asset) throw new Error(`Asset ${assetId} não encontrado.`);
  const now = new Date();
  const usage = { id: id("USE"), assetId, project, block: optional(input.bloco), preset: optional(input.preset), slot: optional(input.slot), role: optional(input.funcao), scriptReference: optional(input.referencia_roteiro), note: optional(input.observacao), usedAt: now };
  await getDb().batch([
    getDb().insert(assetUsage).values(usage),
    getDb().update(assets).set({ useCount: sql`${assets.useCount} + 1`, lastUsedAt: now, updatedAt: now }).where(eq(assets.id, assetId)),
  ]);
  return usage;
}

async function importAttachedMedia(response: Response, requestedName: string, mimeHint: string, input: Record<string, unknown>) {
  if (!response.ok || !response.body) throw new Error(`Falha ao obter mídia: HTTP ${response.status}`);
  const hintedExtension = (requestedName.split(".").pop() || "").toLocaleLowerCase();
  const extension = SUPPORTED_MEDIA_MIME[hintedExtension] ? hintedExtension : Object.entries(SUPPORTED_MEDIA_MIME).find(([, mime]) => mime === mimeHint)?.[0] || "";
  if (!extension) throw new Error("Formato não aceito. Use PNG, JPG, JPEG, WebP, AVIF, SVG, GIF, MP4, WebM, MOV ou M4V.");
  if (input.registrar_uso_inicial === true && !string(input.projeto_origem)) throw new Error("Para registrar o uso inicial, informe projeto_origem.");
  const declaredSize = Number(response.headers.get("content-length")) || 0;
  if (declaredSize > MAX_ZIP_BYTES) throw new Error("A mídia excede o limite de 250 MB.");
  const assetId = id("AST");
  const baseName = requestedName.includes(".") ? requestedName : `${requestedName || assetId}.${extension}`;
  const fileName = baseName.replace(/[^a-zA-Z0-9._-]/g, "-");
  const r2Key = `assets/${assetId}/${fileName}`;
  const upload = await env.BUCKET.createMultipartUpload(r2Key, { httpMetadata: { contentType: SUPPORTED_MEDIA_MIME[extension] } });
  const reader = response.body.getReader();
  const queuedChunks: Uint8Array[] = [];
  const uploadedParts: Array<{ partNumber: number; etag: string }> = [];
  let queuedBytes = 0, received = 0, partNumber = 1;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      received += chunk.byteLength;
      if (received > MAX_ZIP_BYTES) throw new Error("A mídia excede o limite de 250 MB.");
      queuedChunks.push(chunk);
      queuedBytes += chunk.byteLength;
      while (queuedBytes >= MULTIPART_CHUNK_BYTES) {
        uploadedParts.push(await upload.uploadPart(partNumber, takeQueuedBytes(queuedChunks, MULTIPART_CHUNK_BYTES)));
        partNumber += 1;
        queuedBytes -= MULTIPART_CHUNK_BYTES;
      }
    }
    if (queuedBytes > 0) uploadedParts.push(await upload.uploadPart(partNumber, takeQueuedBytes(queuedChunks, queuedBytes)));
    if (!uploadedParts.length) throw new Error("A mídia recebida está vazia.");
    await upload.complete(uploadedParts);
  } catch (error) {
    await upload.abort().catch(() => undefined);
    throw error;
  }
  const qaStatus = string(input.status_qa).toLocaleUpperCase("pt-BR") || "NAO_AVALIADO";
  const defaultKind = extension === "gif" ? "GIF" : SUPPORTED_MEDIA_MIME[extension].startsWith("video/") ? "Vídeo" : "Imagem";
  const mediaTags = [...new Set([...list(input.tags), string(input.funcao_visual), string(input.movimento), string(input.orientacao), string(input.fundo), string(input.transparencia), string(input.audio), input.loop === true ? "loop" : ""].filter(Boolean))];
  const technicalContext = [
    string(input.funcao_visual) && `Função visual: ${string(input.funcao_visual)}`,
    string(input.movimento) && `Movimento: ${string(input.movimento)}`,
    "loop" in input && `Loop: ${input.loop === true ? "SIM" : "NAO"}`,
    string(input.audio) && `Áudio: ${string(input.audio)}`,
    string(input.duracao_segundos) && `Duração: ${string(input.duracao_segundos)} segundos`,
    string(input.orientacao) && `Orientação: ${string(input.orientacao)}`,
    string(input.resolucao) && `Resolução: ${string(input.resolucao)}`,
    string(input.fps) && `FPS: ${string(input.fps)}`,
    string(input.fundo) && `Fundo: ${string(input.fundo)}`,
    string(input.transparencia) && `Transparência: ${string(input.transparencia)}`,
  ].filter(Boolean).join("\n");
  const operationalNote = [string(input.nota_operacional), technicalContext].filter(Boolean).join("\n") || null;
  const asset = { id: assetId, name: string(input.nome), universe: string(input.universo) || "Sem universo", kind: string(input.tipo) || defaultKind, subject: optional(input.sujeito), status: qaStatus === "APROVADO" ? "Aprovado" : qaStatus === "RESSALVA" ? "Pendente revisão" : "Pendente", tags: JSON.stringify(mediaTags), r2Key, originalName: fileName, mimeType: SUPPORTED_MEDIA_MIME[extension], sizeBytes: received, projectOrigin: optional(input.projeto_origem), scriptReference: optional(input.referencia_roteiro), visualReference: optional(input.referencia_visual), sourceUrl: optional(input.fonte_url), operationalNote, qaStatus };
  try { await getDb().insert(assets).values(asset); } catch (error) { await env.BUCKET.delete(r2Key).catch(() => undefined); throw error; }
  const usage = input.registrar_uso_inicial === true ? await registerUsage({ asset_id: assetId, projeto: input.projeto_origem, bloco: input.bloco, preset: input.preset, slot: input.slot, funcao: input.usado_para, referencia_roteiro: input.referencia_roteiro, observacao: operationalNote }) : null;
  return { asset, uso_inicial: usage, formato: extension.toLocaleUpperCase("pt-BR") };
}

async function findAssetsInOrder(rawIds: unknown) {
  const requested = [...new Set(list(rawIds))].slice(0, 200);
  if (!requested.length) throw new Error("Informe ao menos um asset_id.");
  const found = [];
  for (let offset = 0; offset < requested.length; offset += 75) {
    found.push(...await getDb().select().from(assets).where(inArray(assets.id, requested.slice(offset, offset + 75))));
  }
  const byId = new Map(found.map((asset) => [asset.id, asset]));
  return { requested, found: requested.flatMap((assetId) => byId.has(assetId) ? [byId.get(assetId)!] : []), missing: requested.filter((assetId) => !byId.has(assetId)) };
}

async function projectIdFromMaterializationInput(input: Record<string, unknown>) {
  const explicit = string(input.projeto_id);
  if (explicit) return explicit;
  const batchId = string(input.batch_id), itemId = string(input.item_id);
  if (!batchId || !itemId) return "";
  const [item] = await getDb().select({ projectId: automaticProjectItems.projectId }).from(automaticProjectItems)
    .where(and(eq(automaticProjectItems.materializationBatchId, batchId), or(eq(automaticProjectItems.materializationItemId, itemId), eq(automaticProjectItems.id, itemId), eq(automaticProjectItems.itemKey, itemId))))
    .limit(1);
  return item?.projectId || "";
}

async function projectIdFromMaterializationBatch(batchId: string) {
  if (!batchId) return "";
  const [item] = await getDb().select({ projectId: automaticProjectItems.projectId }).from(automaticProjectItems)
    .where(eq(automaticProjectItems.materializationBatchId, batchId)).limit(1);
  return item?.projectId || "";
}

async function projectIdFromCollectionBatch(batchId: string) {
  if (!batchId) return "";
  const [project] = await getDb().select({ id: automaticProjects.id }).from(automaticProjects)
    .where(eq(automaticProjects.collectionBatchId, batchId)).limit(1);
  return project?.id || "";
}

async function withProjectLease<T>(projectId: string, input: Record<string, unknown>, action: string, work: () => Promise<T>): Promise<T> {
  const executionId = string(input.execution_id);
  const workerLease = await requireWorkerLeaseForWrite(projectId, executionId || undefined, action).catch((error) => { throw error; });
  if (!workerLease.matched) await requireSupervisorLeaseForWrite(projectId, executionId || undefined, action);
  const result = await work();
  await deriveProjectPipelineState(projectId, true).catch(() => undefined);
  await syncWorkerQueue(projectId).catch(() => undefined);
  if (workerLease.matched) await renewWorkerLeaseByActivity(executionId, projectId, `${action}_COMPLETED`).catch(() => undefined);
  else await renewSupervisorLease(projectId, executionId, `${action}_COMPLETED`).catch(() => undefined);
  return result;
}

async function touchProjectRead(projectId: string, input: Record<string, unknown>, action: string) {
  if (!projectId) return { renovado: false, motivo: "NO_PROJECT" };
  const executionId = string(input.execution_id);
  const worker = await renewWorkerLeaseByActivity(executionId, projectId, action).catch((error) => { const message = error instanceof Error ? error.message : String(error); if (["WORK_ITEM_REASSIGNED"].includes(message)) return { matched: true, renewed: false, reason: message }; throw error; });
  if (worker.matched) return worker;
  return touchSupervisorLeaseForRead(projectId, executionId || undefined, action);
}

function uniqueExportName(originalName: string, assetId: string, used: Set<string>) {
  const safe = originalName.replace(/[\\/]/g, "-").replace(/[^a-zA-Z0-9À-ÿ._ -]/g, "-") || `${assetId}.bin`;
  if (!used.has(safe.toLocaleLowerCase("pt-BR"))) { used.add(safe.toLocaleLowerCase("pt-BR")); return safe; }
  const dot = safe.lastIndexOf(".");
  const unique = dot > 0 ? `${safe.slice(0, dot)}-${assetId}${safe.slice(dot)}` : `${safe}-${assetId}`;
  used.add(unique.toLocaleLowerCase("pt-BR"));
  return unique;
}

export async function executeTool(name: string, rawInput: unknown, origin: string, code: string, transportPerf: { authMs?:number; parseMs?:number } = {}) {
  const input = record(rawInput), db = getDb();
  const perfStartedAt = new Date(), perfStart = Date.now(), requestId = id("REQ"), coldStart = firstToolInvocation;
  firstToolInvocation = false;
  try {
    let result: unknown;
    switch (name) {
      case "obter_contexto_biblioteca": {
        const catalogStats = await getCatalogStats();
        const recentImports = await db.select().from(imports).orderBy(desc(imports.createdAt)).limit(5);
        const universeRows = await db.select({ universe: assets.universe, count: sql<number>`count(*)` }).from(assets).where(eq(assets.status, "Aprovado")).groupBy(assets.universe).orderBy(desc(sql<number>`count(*)`)).limit(30);
        result = { assets: { total: catalogStats.totalAssets, catalogo: catalogStats.catalogAssets, pending: catalogStats.pending, rejected: catalogStats.rejected, reutilizados: catalogStats.reused, uses: catalogStats.totalUses }, universes: universeRows, catalog_stats: catalogStats, recent_imports: recentImports, mcp: "ativo", storage: "R2", database: "D1" }; break;
      }
      case "buscar_assets": {
        const conditions = [];
        const query = string(input.texto);
        if (query) conditions.push(or(like(assets.name, `%${query}%`), like(assets.tags, `%${query}%`), like(assets.subject, `%${query}%`), like(assets.id, `%${query}%`))!);
        if (string(input.universo)) conditions.push(eq(assets.universe, string(input.universo)));
        if (string(input.tipo)) conditions.push(eq(assets.kind, string(input.tipo)));
        if (string(input.status)) conditions.push(eq(assets.status, string(input.status)));
        if (input.nunca_usado === true) conditions.push(eq(assets.useCount, 0));
        const matches = await db.select().from(assets).where(conditions.length ? and(...conditions) : undefined).orderBy(desc(assets.updatedAt)).limit(limitOf(input.limite));
        result = { assets: matches, total: matches.length }; break;
      }
      case "obter_asset": { const [asset] = await db.select().from(assets).where(eq(assets.id, string(input.asset_id))).limit(1); if (!asset) throw new Error("Asset não encontrado."); result = asset; break; }
      case "obter_historico_asset": result = await db.select().from(assetUsage).where(eq(assetUsage.assetId, string(input.asset_id))).orderBy(desc(assetUsage.usedAt)).limit(500); break;
      case "listar_pendentes": result = await db.select().from(assets).where(like(assets.status, "Pendente%")).orderBy(desc(assets.updatedAt)).limit(limitOf(input.limite)); break;
      case "obter_pendentes_para_qa_catalogo": {
        if (!(await isMcpFileResourceDeliveryEnabled())) { result = await getPendingCatalogQaLinks(input.asset_ids, input.limite); break; }
        const requested = list(input.asset_ids).slice(0, 20);
        const max = Math.max(1, Math.min(20, limitOf(input.limite, 20)));
        const conditions = [like(assets.status, "Pendente%")];
        if (requested.length) conditions.push(inArray(assets.id, requested));
        const rows = await db.select().from(assets).where(and(...conditions)).orderBy(desc(assets.updatedAt)).limit(max);
        const expires = Date.now() + 30 * 60_000;
        const arquivos = rows.map((asset) => { const mimeType = resolveMediaMime(asset.mimeType, asset.originalName, asset.r2Key); return { asset_id:asset.id, nome:asset.name, universo:asset.universe, tipo:asset.kind, status:asset.status, qa_status:asset.qaStatus, arquivo:asset.originalName, mime_type:mimeType, tamanho_bytes:asset.sizeBytes, projeto_origem:asset.projectOrigin, referencia_roteiro:asset.scriptReference, referencia_visual:asset.visualReference, fonte_url:asset.sourceUrl, uri:signedDownloadUrl(origin, "/api/files/" + encodeURIComponent(asset.id) + "?preview=1", expires) }; });
        result = { total:arquivos.length, arquivos, __resources:arquivos.map((asset) => ({ name:asset.arquivo, uri:asset.uri, mimeType:asset.mime_type, description:`Pendente ${asset.asset_id} · ${asset.nome} · ${asset.universo}` })) };
        break;
      }
      case "catalogar_asset": {
        const assetId = string(input.asset_id) || id("AST");
        const value = { id: assetId, name: string(input.nome), r2Key: string(input.r2_key), originalName: string(input.arquivo_original), mimeType: string(input.mime_type), universe: string(input.universo) || "Sem universo", kind: string(input.tipo) || "Imagem", subject: optional(input.sujeito), tags: JSON.stringify(list(input.tags)), projectOrigin: optional(input.projeto_origem), scriptReference: optional(input.referencia_roteiro), visualReference: optional(input.referencia_visual), sourceUrl: optional(input.fonte_url), operationalNote: optional(input.nota_operacional), qaStatus: string(input.status_qa) || "NAO_AVALIADO", status: string(input.status_qa) === "APROVADO" ? "Aprovado" : "Pendente" };
        await db.insert(assets).values(value); result = value; break;
      }
      case "editar_metadados": {
        const assetId = string(input.asset_id), update: Record<string, unknown> = { updatedAt: new Date() };
        const map: Record<string, string> = { nome: "name", universo: "universe", tipo: "kind", sujeito: "subject", projeto_origem: "projectOrigin", referencia_roteiro: "scriptReference", referencia_visual: "visualReference", fonte_url: "sourceUrl", nota_operacional: "operationalNote", status_qa: "qaStatus" };
        for (const [source, target] of Object.entries(map)) if (source in input) update[target] = optional(input[source]);
        if ("tags" in input) update.tags = JSON.stringify(list(input.tags));
        const [updated] = await db.update(assets).set(update).where(eq(assets.id, assetId)).returning(); if (!updated) throw new Error("Asset não encontrado."); result = updated; break;
      }
      case "registrar_uso": result = await registerUsage(input); break;
      case "registrar_uso_lote": { const outputs = []; for (const usage of Array.isArray(input.usos) ? input.usos : []) outputs.push(await registerUsage(record(usage))); result = { registrados: outputs.length, usos: outputs }; break; }
      case "marcar_rejeitado": { const assetId = string(input.asset_id); const [current] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1); if (!current) throw new Error("Asset não encontrado."); const [updated] = await db.update(assets).set({ previousStatus: current.status, status: "Rejeitado", operationalNote: [current.operationalNote, `Rejeitado: ${string(input.motivo)}`].filter(Boolean).join("\n"), updatedAt: new Date() }).where(eq(assets.id, assetId)).returning(); result = updated; break; }
      case "restaurar_asset": { const assetId = string(input.asset_id); const [current] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1); if (!current) throw new Error("Asset não encontrado."); const [updated] = await db.update(assets).set({ status: current.previousStatus || "Pendente", previousStatus: null, updatedAt: new Date() }).where(eq(assets.id, assetId)).returning(); result = updated; break; }
      case "excluir_asset_permanentemente": { if (input.confirmar !== true) throw new Error("Defina confirmar=true para excluir permanentemente."); const assetId = string(input.asset_id); const deletion = await deleteAssetsPermanently([assetId]); if (!deletion.deleted) throw new Error("Asset não encontrado."); result = { excluido: assetId, arquivo_removido: deletion.files[0] || null }; break; }
      case "aprovar_pendentes_em_lote": { result = await approvePendingAssets(input.asset_ids, string(input.observacao) || "Aprovado pelo Supervisor via MCP"); break; }
      case "excluir_pendentes_permanentemente_em_lote": { if (input.confirmar !== true) throw new Error("Defina confirmar=true para excluir permanentemente."); result = await deleteAssetsPermanently(input.asset_ids, { pendingOnly: true }); break; }
      case "listar_solicitacoes": result = await db.select().from(requests).orderBy(desc(requests.createdAt)).limit(limitOf(input.limite)); break;
      case "criar_solicitacao": { const value = { id: id("SOL"), project: string(input.projeto), rawItems: string(input.itens), itemCount: string(input.itens).split("\n").filter(Boolean).length, status: "Validando" }; await db.insert(requests).values(value); result = value; break; }
      case "atualizar_solicitacao": { const requestId = string(input.solicitacao_id), update: Record<string, unknown> = {}; if (input.projeto) update.project = string(input.projeto); if (input.itens) { update.rawItems = string(input.itens); update.itemCount = string(input.itens).split("\n").filter(Boolean).length; } if (input.status) update.status = string(input.status); const [updated] = await db.update(requests).set(update).where(eq(requests.id, requestId)).returning(); if (!updated) throw new Error("Solicitação não encontrada."); result = updated; break; }
      case "listar_lotes": result = await db.select().from(batches).orderBy(desc(batches.updatedAt)).limit(limitOf(input.limite)); break;
      case "criar_lote": { const batchId = id("LOT"), value = { id: batchId, name: string(input.nome), project: optional(input.projeto) }; await db.insert(batches).values(value); const assetIds = list(input.asset_ids); if (assetIds.length) await db.insert(batchAssets).values(assetIds.map((assetId, index) => ({ id: id("BA"), batchId, assetId, position: index }))); result = { ...value, asset_ids: assetIds }; break; }
      case "obter_lote": { const batchId = string(input.lote_id); const [batch] = await db.select().from(batches).where(eq(batches.id, batchId)).limit(1); if (!batch) throw new Error("Lote não encontrado."); const items = await db.select({ link: batchAssets, asset: assets }).from(batchAssets).innerJoin(assets, eq(batchAssets.assetId, assets.id)).where(eq(batchAssets.batchId, batchId)).orderBy(batchAssets.position); result = { ...batch, assets: items }; break; }
      case "adicionar_assets_ao_lote": { const batchId = string(input.lote_id), assetIds = list(input.asset_ids); const [count] = await db.select({ count: sql<number>`count(*)` }).from(batchAssets).where(eq(batchAssets.batchId, batchId)); if (assetIds.length) await db.insert(batchAssets).values(assetIds.map((assetId, index) => ({ id: id("BA"), batchId, assetId, position: Number(count?.count ?? 0) + index }))); await db.update(batches).set({ updatedAt: new Date() }).where(eq(batches.id, batchId)); result = { lote_id: batchId, adicionados: assetIds }; break; }
      case "remover_assets_do_lote": { const batchId = string(input.lote_id), assetIds = list(input.asset_ids); for (const assetId of assetIds) await db.delete(batchAssets).where(and(eq(batchAssets.batchId, batchId), eq(batchAssets.assetId, assetId))); await db.update(batches).set({ updatedAt: new Date() }).where(eq(batches.id, batchId)); result = { lote_id: batchId, removidos: assetIds }; break; }
      case "atualizar_status_lote": { const [updated] = await db.update(batches).set({ status: string(input.status), updatedAt: new Date() }).where(eq(batches.id, string(input.lote_id))).returning(); if (!updated) throw new Error("Lote não encontrado."); result = updated; break; }
      case "gerar_manifesto_lote": { const batchId = string(input.lote_id); const [batch] = await db.select().from(batches).where(eq(batches.id, batchId)).limit(1); if (!batch) throw new Error("Lote não encontrado."); const items = await db.select({ asset: assets, link: batchAssets }).from(batchAssets).innerJoin(assets, eq(batchAssets.assetId, assets.id)).where(eq(batchAssets.batchId, batchId)).orderBy(batchAssets.position); const manifest = [`LOTE: ${batch.name}`, `PROJETO: ${batch.project ?? ""}`, `DATA: ${new Date().toISOString()}`, "", ...items.flatMap(({ asset, link }) => [`[${asset.originalName}]`, `ASSET_ID: ${asset.id}`, `NOME_SEMANTICO: ${asset.name}`, `UNIVERSO: ${asset.universe}`, `TIPO: ${asset.kind}`, `SLOT: ${link.slot ?? ""}`, `REFERENCIA_ROTEIRO: ${asset.scriptReference ?? ""}`, ""] )].join("\n"); await env.BUCKET.put(`batches/${batchId}/manifest.txt`, manifest, { httpMetadata: { contentType: "text/plain; charset=utf-8" } }); await db.update(batches).set({ manifestText: manifest, updatedAt: new Date() }).where(eq(batches.id, batchId)); result = { lote_id: batchId, manifesto: manifest }; break; }
      case "listar_importacoes": result = await db.select().from(imports).orderBy(desc(imports.createdAt)).limit(limitOf(input.limite)); break;
      case "processar_importacao_zip": result = await processZipImport(string(input.importacao_id)); break;
      case "importar_zip_arquivo": {
        const file = record(input.arquivo), downloadUrl = string(file.download_url), fileId = string(file.file_id), mimeType = string(file.mime_type).toLowerCase(), fileName = string(file.file_name) || `${fileId}.zip`;
        if (!fileId || !downloadUrl.startsWith("https://")) throw new Error("O ChatGPT não forneceu uma referência de arquivo válida.");
        if (!fileName.toLowerCase().endsWith(".zip") && !mimeType.includes("zip")) throw new Error("O arquivo anexado não foi reconhecido como ZIP.");
        result = await persistZipResponse(await fetch(downloadUrl), fileName.toLowerCase().endsWith(".zip") ? fileName : `${fileName}.zip`, input.manifesto_txt);
        break;
      }
      case "importar_midia_arquivo": {
        const file = record(input.arquivo), downloadUrl = string(file.download_url), fileId = string(file.file_id), mimeType = string(file.mime_type).toLowerCase(), fileName = string(file.file_name) || fileId;
        if (!fileId || !downloadUrl.startsWith("https://")) throw new Error("O ChatGPT não forneceu uma referência de arquivo válida.");
        result = await importAttachedMedia(await fetch(downloadUrl), fileName, mimeType, input);
        break;
      }
      case "obter_modo_entrega_chat": { result = await getChatDeliveryMode(); break; }
      case "configurar_modo_entrega_chat": { result = await configureChatDeliveryMode(input.modo); break; }
      case "fast_visual_packet": { result = await getFastVisualPacket({project_id:input.project_id,limit:input.limit,item_ids:input.item_ids,target_files:input.target_files,only_waiting_qa:input.only_waiting_qa,include_original_url:input.include_original_url}); break; }
      case "obter_candidatas_qa_links": { result = await getFastVisualPacket({project_id:input.project_id,limit:input.limit,item_ids:input.item_ids,target_files:input.target_files,only_waiting_qa:true,include_original_url:true}); break; }
      case "obter_work_packet_lite": { result = await getWorkPacketLite(input.project_id,input.limit); break; }
      case "obter_resumo_operacional_curto": { result = await getOperationalSummaryShort(input.project_id); break; }
      case "exportar_pacote_qa_json": { result = await exportQaPacketJson({project_id:input.project_id,limit:input.limit,item_ids:input.item_ids,target_files:input.target_files,only_waiting_qa:true,include_original_url:true}); break; }
      case "gerar_grid_candidatas": { result = await generateCandidateContactSheet({project_id:input.project_id,limit:input.limit,columns:input.columns,item_ids:input.item_ids,target_files:input.target_files,only_waiting_qa:true}); break; }
      case "fast_decidir_candidatas_lote": {
        const projectId=string(input.project_id),operationId=string(input.operation_id)||`FAST-DECIDE-${projectId}-${Date.now().toString(36)}`,decisions=(Array.isArray(input.decisions)?input.decisions:[]).slice(0,200).map(record);
        const thumbDecisions=decisions.filter((row)=>string(row.kind).toUpperCase()==="THUMBNAIL" || Boolean(string(row.asset_id)));
        if(thumbDecisions.length){
          if(thumbDecisions.length!==decisions.length) throw new Error("MIXED_THUMB_AND_PITEM_DECISIONS_NOT_ALLOWED");
          const grouped=new Map<string,string[]>();
          for(const row of thumbDecisions){const action=string(row.action).toUpperCase(),id=string(row.asset_id)||string(row.candidate_id);if(!id)throw new Error("THUMB_ID_REQUIRED");if(!["APPROVE","REJECT","SELECT"].includes(action))throw new Error("THUMB_DECISION_INVALID");grouped.set(action,[...(grouped.get(action)||[]),id]);}
          const outputs=[];for(const [action,ids] of grouped)outputs.push(await decideThumbnailBatch({project_id:projectId,asset_ids:ids,action,operation_id:operationId,source:"SUPERVISOR"}));
          result={operation_id:operationId,project_id:projectId,accepted_count:thumbDecisions.length,status:"COMPLETED",kind:"THUMBNAIL",results:outputs}; break;
        }
        result=await withProjectLease(projectId,input,"FAST_DECIDIR_CANDIDATAS_LOTE",()=>enqueueFastCandidateDecisionBatch({operationId,projectId,decisions,executionId:string(input.execution_id)||null,source:"SUPERVISOR_MCP"})); break;
      }
      case "aprovar_itens_lote":
      case "aprovar_target_files_lote": {
        const projectId=string(input.project_id),operationId=string(input.operation_id)||`FAST-APPROVE-ITEMS-${projectId}-${Date.now().toString(36)}`,reason=string(input.reason);
        const selectors=[...list(input.item_ids),...list(input.target_files)].slice(0,200),decisions=selectors.map((selector)=>({item_id:selector,action:"APPROVE",reason}));
        if(!decisions.length) throw new Error("ITEM_IDS_OR_TARGET_FILES_REQUIRED");
        result=await withProjectLease(projectId,input,"FAST_APPROVE_ITEMS_LOTE",()=>enqueueFastCandidateDecisionBatch({operationId,projectId,decisions,executionId:string(input.execution_id)||null,source:"SUPERVISOR_MCP"})); break;
      }
      case "relink_itens_lote": {
        const projectId=string(input.project_id),operationId=string(input.operation_id)||`FAST-RELINK-${projectId}-${Date.now().toString(36)}`,reason=string(input.reason);
        const selectors=[...list(input.item_ids),...list(input.target_files)].slice(0,200),decisions=selectors.map((selector)=>({item_id:selector,action:"RELINK",reason}));
        if(!decisions.length) throw new Error("ITEM_IDS_OR_TARGET_FILES_REQUIRED");
        result=await withProjectLease(projectId,input,"FAST_RELINK_ITEMS_LOTE",()=>enqueueFastCandidateDecisionBatch({operationId,projectId,decisions,executionId:string(input.execution_id)||null,source:"SUPERVISOR_MCP"})); break;
      }
      case "listar_destinos_fast_push_projeto": { result = await listFastPushProjectTargets(input.project_id, input.limite); break; }
      case "importar_candidatas_url_lote": {
        result = await ingestFastPushBatch((Array.isArray(input.itens) ? input.itens : []).map((item) => record(item)), optional(input.batch_id) || undefined);
        break;
      }
      case "fast_push_urls_lote": { result = await ingestFastPushBatch((Array.isArray(input.itens) ? input.itens : []).map((item) => record(item)), optional(input.batch_id) || undefined); break; }
      case "importar_candidata_arquivo_fast_push": {
        const file = record(input.arquivo), context = record(input.contexto), downloadUrl = string(file.download_url), fileId = string(file.file_id), mimeType = string(file.mime_type).toLowerCase(), fileName = string(file.file_name) || fileId;
        if (!fileId || !downloadUrl.startsWith("https://")) throw new Error("O ChatGPT não forneceu uma referência de arquivo válida.");
        const transport = await fetch(downloadUrl);
        if (!transport.ok) throw new Error(`CHAT_FILE_TRANSPORT_HTTP_${transport.status}`);
        const previousSearchMetadata = record(context.search_metadata);
        result = await ingestFastPushFileBytes(new Uint8Array(await transport.arrayBuffer()), fileName, mimeType, {
          ...context,
          source_type:"CHAT_FILE",
          search_metadata:{ ...previousSearchMetadata, chat_file_id:fileId, input_mode:"CHAT_FILE", transport:"OPENAI_FILE_PARAM" },
        });
        break;
      }
      case "vincular_candidatas_fast_push_ao_projeto": { result = await linkFastPushCandidatesToProject(input.vinculos); break; }
      case "listar_inbox_candidatas": { result = await listFastPushCandidates(input); break; }
      case "aprovar_candidatas_fast_push_lote": {
        const source = ["MANUAL","SUPERVISOR","AI"].includes(string(input.origem_decisao).toUpperCase()) ? string(input.origem_decisao).toUpperCase() : "SUPERVISOR";
        result = await decideFastPushCandidates(input.candidate_ids, "APPROVE", source as "MANUAL"|"SUPERVISOR"|"AI", string(input.observacao)); break;
      }
      case "rejeitar_candidatas_fast_push_lote": {
        const source = ["MANUAL","SUPERVISOR","AI"].includes(string(input.origem_decisao).toUpperCase()) ? string(input.origem_decisao).toUpperCase() : "SUPERVISOR";
        result = await decideFastPushCandidates(input.candidate_ids, "REJECT", source as "MANUAL"|"SUPERVISOR"|"AI", string(input.observacao)); break;
      }
      case "decidir_candidatas_lote": {
        result = await decideFastPushBatch({ project_id:input.project_id, candidate_ids:input.candidate_ids, item_ids:input.item_ids, target_files:input.target_files, action:input.acao, source:input.origem_decisao, note:input.motivo }); break;
      }
      case "aprovar_candidatas_lote": {
        const projectId=string(input.project_id),operationId=string(input.operation_id)||`FAST-APPROVE-CAND-${projectId}-${Date.now().toString(36)}`,reason=string(input.motivo),decisions=list(input.candidate_ids).slice(0,200).map((candidate_id)=>({candidate_id,action:"APPROVE",reason}));
        result=await withProjectLease(projectId,input,"FAST_APPROVE_CANDIDATAS_LOTE",()=>enqueueFastCandidateDecisionBatch({operationId,projectId,decisions,source:"SUPERVISOR_MCP"})); break;
      }
      case "rejeitar_candidatas_lote": {
        const projectId=string(input.project_id),operationId=string(input.operation_id)||`FAST-REJECT-CAND-${projectId}-${Date.now().toString(36)}`,reason=string(input.motivo),decisions=list(input.candidate_ids).slice(0,200).map((candidate_id)=>({candidate_id,action:"REJECT",reason}));
        result=await withProjectLease(projectId,input,"FAST_REJECT_CANDIDATAS_LOTE",()=>enqueueFastCandidateDecisionBatch({operationId,projectId,decisions,source:"SUPERVISOR_MCP"})); break;
      }
      case "rejeitar_itens_lote": {
        const projectId=string(input.project_id),operationId=string(input.operation_id)||`FAST-REJECT-ITEMS-${projectId}-${Date.now().toString(36)}`,reason=string(input.motivo),selectors=[...list(input.item_ids),...list(input.target_files)].slice(0,200),decisions=selectors.map((item_id)=>({item_id,action:"REJECT",reason,reject_all:true}));
        if(!decisions.length) throw new Error("ITEM_IDS_OR_TARGET_FILES_REQUIRED");
        result=await withProjectLease(projectId,input,"FAST_REJECT_ITEMS_LOTE",()=>enqueueFastCandidateDecisionBatch({operationId,projectId,decisions,source:"SUPERVISOR_MCP"})); break;
      }
      case "excluir_candidatas_lote": {
        result = await deleteFastPushCandidatesBatch({ project_id:input.project_id, candidate_ids:input.candidate_ids, confirmar:input.confirmar, apagar_materializacao:input.apagar_materializacao, apagar_bytes:input.apagar_bytes, permitir_promovidas:input.permitir_promovidas, motivo:input.motivo }); break;
      }
      case "fast_push_thumbs_url_lote": {
        const projectId = string(input.project_id), items = (Array.isArray(input.itens) ? input.itens : []).map((raw) => { const item = record(raw); return { operation_id:string(item.operation_id), project_id:projectId, source_url:string(item.source_url), name:string(item.name), variant:string(item.variant), agent_origin:string(item.agente_origem), observation:string(item.observacao), source_type:string(item.source_type) || "WEB" }; });
        result = await pushProjectThumbnailUrlBatch(projectId, items); break;
      }
      case "fast_push_generated_media":
      case "importar_midia_por_url": { result = await fastPushGeneratedMedia(record(input)); break; }
      case "preparar_upload_midia": { result = await prepareMediaUpload(record(input)); break; }
      case "confirmar_upload_midia": { result = await confirmMediaUpload(record(input)); break; }
      case "obter_thumbs_links": { result = await getProjectThumbnailLinks(record(input)); break; }
      case "fast_decidir_thumbs_lote": { result = await decideThumbnailBatch(record(input)); break; }
      case "fast_push_titulos": {
        result = await pushProjectTitles(string(input.project_id), (Array.isArray(input.titulos) ? input.titulos : []).map((raw) => { const item = record(raw); return { operation_id:string(item.operation_id), texto:string(item.texto), variante:string(item.variante), agente_origem:string(item.agente_origem), observacao:string(item.observacao), score:Number(item.score) }; })); break;
      }
      case "listar_pacote_producao_projeto": { result = await getProjectProductionPackage(string(input.project_id)); break; }
      case "decidir_thumbs_projeto": { result = await decideProjectThumbnails(input.candidate_ids, string(input.decisao), string(input.origem_decisao) || "SUPERVISOR", string(input.observacao)); break; }
      case "decidir_titulos_projeto": { result = await decideProjectTitles(input.candidate_ids, string(input.decisao), string(input.origem_decisao) || "SUPERVISOR", string(input.observacao)); break; }
      case "exportar_projeto_completo_zip": { result = { deprecated_alias:true, ...(await queueFinalPackage({ project_id:string(input.project_id), tipo:"FULL_PROJECT_ZIP" })) }; break; }
      case "gerar_pacote_final": { result = await queueFinalPackage(record(input)); break; }
      case "listar_pacotes_prontos_para_download": { result = await listReadyDownloadPackages(record(input)); break; }
      case "obter_link_download_pacote": { result = await getDownloadPackageLink(record(input)); break; }
      case "confirmar_download_pacote": { result = await confirmDownloadPackage(record(input)); break; }
      case "preparar_upload_zip": {
        if (!code) throw new Error("Não foi possível gerar o link: código MCP ausente.");
        result = { requer_upload_direto: true, nome_arquivo: optional(input.nome_arquivo), upload_url: `${origin}/importar?code=${encodeURIComponent(code)}`, instrucao: "Abra o link e selecione o ZIP. O envio vai direto ao R2 da Corvo Library; não é necessário criar uma URL pública." };
        break;
      }
      case "importar_zip_por_url": {
        const url = string(input.url);
        if (!url.startsWith("https://")) {
          if (!code) throw new Error("Não foi possível gerar o link: código MCP ausente.");
          result = { requer_upload_direto: true, motivo: url.startsWith("sandbox:") ? "Arquivos sandbox pertencem à conversa e não podem ser baixados pelo servidor remoto." : "A origem não é uma URL HTTPS pública.", nome_arquivo: string(input.nome_arquivo), upload_url: `${origin}/importar?code=${encodeURIComponent(code)}`, instrucao: "Abra o link e selecione o mesmo ZIP. O arquivo será enviado diretamente ao R2, sem hospedagem intermediária." };
          break;
        }
        result = await persistZipResponse(await fetch(url), string(input.nome_arquivo), input.manifesto_txt);
        break;
      }
      case "sincronizar_r2": {
        const pendingImports = await db.select({ id: imports.id }).from(imports).where(or(eq(imports.status, "Recebido"), eq(imports.status, "Processando"), like(imports.status, "Parcial%"))).orderBy(imports.createdAt).limit(20);
        const processedImports = [];
        for (const pendingImport of pendingImports) processedImports.push(await processZipImport(pendingImport.id));
        const prefix = string(input.prefixo), listed = await env.BUCKET.list({ prefix, limit: limitOf(input.limite, 1000) });
        let created = 0;
        for (const object of listed.objects) {
          const [known] = await db.select({ id: assets.id }).from(assets).where(eq(assets.r2Key, object.key)).limit(1);
          if (!known && !object.key.startsWith("incoming/") && !object.key.startsWith("batches/") && !object.key.startsWith("assets/")) {
            const originalName = object.key.split("/").pop() || object.key;
            const mimeType = resolveMediaMime("application/octet-stream", originalName, object.key);
            await db.insert(assets).values({ id: id("AST"), name: originalName, r2Key: object.key, originalName, mimeType, sizeBytes: object.size, status: "Pendente", universe: "Sem universo", kind: kindFromMediaMime(mimeType) });
            created += 1;
          }
        }
        result = { importacoes_processadas: processedImports, objetos_examinados: listed.objects.length, pendencias_criadas: created, truncado: listed.truncated };
        break;
      }
      case "obter_link_download": {
        const started = Date.now(), assetId = string(input.asset_id);
        const [asset] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
        if (!asset) throw new Error("Asset não encontrado.");
        const minutes = Math.max(1, Math.min(60, Number(input.validade_minutos) || 10));
        const url = await createSignedR2GetUrl(asset.r2Key, minutes, asset.originalName, asset.mimeType);
        result = { asset_id: assetId, nome: asset.name, arquivo: asset.originalName, mime_type: asset.mimeType, tamanho_bytes: asset.sizeBytes, url, entrega: "R2_DIRETO", validade_minutos: minutes, signed_url_generation_ms: Date.now() - started };
        break;
      }
      case "obter_links_download_lote": {
        const started = Date.now();
        const selection = await findAssetsInOrder(input.asset_ids);
        const minutes = Math.max(1, Math.min(60, Number(input.validade_minutos) || 10));
        const links = await Promise.all(selection.found.map(async (asset) => ({
          asset_id: asset.id, nome: asset.name, arquivo: asset.originalName, mime_type: asset.mimeType,
          tamanho_bytes: asset.sizeBytes, url: await createSignedR2GetUrl(asset.r2Key, minutes, asset.originalName, asset.mimeType),
        })));
        result = { links, ausentes: selection.missing, total: links.length, entrega: "R2_DIRETO", validade_minutos: minutes, signed_url_generation_ms: Date.now() - started };
        break;
      }
      case "exportar_assets_zip": {
        const exportStarted = Date.now();
        const selection = await findAssetsInOrder(input.asset_ids);
        const physicallyMissing: string[] = [];
        const usedNames = new Set<string>();
        const heads = await Promise.all(selection.found.map(async (asset) => ({ asset, object: await env.BUCKET.head(asset.r2Key) })));
        for (const entry of heads) if (!entry.object) physicallyMissing.push(entry.asset.id);
        const included = selection.found.filter((asset) => !physicallyMissing.includes(asset.id));
        if (!included.length) throw new Error("Nenhum arquivo físico da seleção foi encontrado no R2.");
        const entries = included.map((asset) => ({ id: asset.id, r2Key: asset.r2Key, name: uniqueExportName(asset.originalName, asset.id, usedNames) }));
        const manifest = [
          "EXPORTACAO CORVO LIBRARY",
          `TOTAL: ${included.length}`,
          "",
          ...included.flatMap((asset) => [`[${asset.originalName}]`, `ASSET_ID: ${asset.id}`, `NOME: ${asset.name}`, `UNIVERSO: ${asset.universe}`, `TIPO: ${asset.kind}`, `SUJEITO: ${asset.subject || ""}`, ""]),
        ].join("\n");
        const rawName = string(input.nome_zip) || "corvo-assets.zip";
        const fileName = `${rawName.replace(/\.zip$/i, "").replace(/[^a-zA-Z0-9._-]/g, "-")}.zip`;
        const { hash, result: zipResult } = await getOrCreateZip(entries, manifest, fileName);
        const exportId = `EXP-${hash.toUpperCase()}`;
        const minutes = Math.max(1, Math.min(60, Number(input.validade_minutos) || 30));
        const signedStarted = Date.now();
        const url = await createSignedR2GetUrl(zipResult.r2Key, minutes, fileName, "application/zip");
        const metrics = {
          zip_generation_ms: zipResult.generationMs, signed_url_generation_ms: Date.now() - signedStarted,
          asset_count: included.length, total_bytes: zipResult.sizeBytes, cache_hit: zipResult.cacheHit,
          export_status: "READY", tempo_total_ms: Date.now() - exportStarted,
        };
        await audit("exportar_assets_zip_metrics", true, JSON.stringify(metrics));
        if (Math.random() < 0.1) cleanupExpiredZipCache().catch(() => undefined);
        result = { exportacao_id: exportId, arquivo: fileName, assets_solicitados: selection.requested.length, assets_incluidos: included.length, ausentes_catalogo: selection.missing, ausentes_r2: physicallyMissing, tamanho_bytes: zipResult.sizeBytes, url, entrega: "R2_DIRETO", validade_minutos: minutes, metricas: metrics };
        break;
      }
      case "materializar_url": { const projectId = await projectIdFromMaterializationInput(input); result = projectId ? await withProjectLease(projectId, input, "MATERIALIZAR_URL", () => materializeUrl(input)) : await materializeUrl(input); break; }
      case "materializar_lote": { const projectId = await projectIdFromMaterializationBatch(string(input.batch_id)); result = projectId ? await withProjectLease(projectId, input, "MATERIALIZAR_LOTE", () => materializeBatch(input)) : await materializeBatch(input); break; }
      case "criar_fila_materializacao_continua": result = await createMaterializationQueue(input); break;
      case "adicionar_itens_fila_materializacao": { const projectId = await projectIdFromMaterializationBatch(string(input.batch_id)); result = projectId ? await withProjectLease(projectId, input, "ADICIONAR_ITENS_FILA_MATERIALIZACAO", () => enqueueMaterializationItems(input)) : await enqueueMaterializationItems(input); break; }
      case "obter_status_materializacao": result = await getMaterializationStatus(input); break;
      case "obter_status_lote_materializacao": { const projectId = await projectIdFromMaterializationBatch(string(input.batch_id)); if (projectId) await touchProjectRead(projectId, input, "OBTER_STATUS_LOTE_MATERIALIZACAO"); result = await getBatchStatus(string(input.batch_id)); break; }
      case "obter_assets_para_qa_lote": { const projectId = await projectIdFromMaterializationBatch(string(input.batch_id)); if (projectId) await touchProjectRead(projectId, input, "OBTER_ASSETS_PARA_QA_LOTE"); result = (await isMcpFileResourceDeliveryEnabled()) ? await qaFiles(string(input.batch_id), origin, code, limitOf(input.limite, 20)) : await getMaterializationQaLinks(input.batch_id,input.limite); break; }
      case "registrar_qa_lote": { const projectId = await projectIdFromMaterializationBatch(string(input.batch_id)); result = projectId ? await withProjectLease(projectId, input, "REGISTRAR_QA_LOTE", () => registerQaBatch(input)) : await registerQaBatch(input); break; }
      case "retry_item_materializacao": { const projectId = await projectIdFromMaterializationInput(input); result = projectId ? await withProjectLease(projectId, input, "RETRY_ITEM_MATERIALIZACAO", () => retryItem(input)) : await retryItem(input); break; }
      case "adicionar_candidatas_item": { const projectId = await projectIdFromMaterializationInput(input); result = projectId ? await withProjectLease(projectId, input, "ADICIONAR_CANDIDATAS_ITEM", () => addCandidates(input)) : await addCandidates(input); break; }
      case "aplicar_correcao_tecnica": { const projectId = await projectIdFromMaterializationInput(input); result = projectId ? await withProjectLease(projectId, input, "APLICAR_CORRECAO_TECNICA", () => applyTechnicalCorrection(input)) : await applyTechnicalCorrection(input); break; }
      case "exportar_zip_arquivo": { const projectId = await projectIdFromMaterializationBatch(string(input.batch_id)); result = projectId ? await withProjectLease(projectId, input, "EXPORTAR_ZIP_ARQUIVO", () => exportBatchZip(input, origin, code)) : await exportBatchZip(input, origin, code); break; }
      case "obter_log_materializacao": result = await getMaterializationLog(input); break;
      case "cancelar_lote_materializacao": { const projectId = await projectIdFromMaterializationBatch(string(input.batch_id)); result = projectId ? await withProjectLease(projectId, input, "CANCELAR_LOTE_MATERIALIZACAO", () => cancelMaterializationBatch(string(input.batch_id))) : await cancelMaterializationBatch(string(input.batch_id)); break; }
      case "obter_host_health": result = await getHostHealth(string(input.host) || undefined); break;
      case "probar_url_controlada": result = await probeMaterializationUrl(input); break;
      case "limpar_temporarios_lote": result = await cleanupBatchTemps(string(input.batch_id), input.confirmar === true); break;
      case "obter_estatisticas_materializacao": result = await materializationStats(); break;
      case "procurar_duplicata_hash": result = await findDuplicateHash(string(input.sha256).toLowerCase()); break;
      case "resolver_url": result = await resolveOrTestUrl(string(input.url)); break;
      case "testar_url": result = await resolveOrTestUrl(string(input.url), true); break;
      case "listar_adapters": result = listAdapters(); break;
      case "obter_painel_estoque": result = await getInventoryDashboard(input); break;
      case "exportar_txt_estoque_giro": result = await exportInventoryTabText(input); break;
      case "configurar_politica_estoque": result = await setStockPolicy(input); break;
      case "registrar_consulta_asset": result = await registerAssetConsultation(input); break;
      case "avaliar_necessidade_coleta": result = await evaluateCollectionNeed(input); break;
      case "obter_ranking_hosts": result = await getHostRanking(); break;
      case "obter_telemetria_pipeline": result = await getPipelineTelemetry(); break;
      case "obter_status_supervisor_ia": result = await getSupervisorMode(); break;
      case "configurar_supervisor_mcp": result = await setSupervisorMode(input.ligado === true, string(input.motivo)); break;
      case "assumir_proximo_trabalho_supervisor": {
        // V59: caminho crítico do lease deve ser curtíssimo; manutenção pesada fica fora desta chamada.
        const lease = await acquireNextSupervisorWork({ projectId: string(input.projeto_id) || undefined, executionId: string(input.execution_id) || undefined, ttlMinutes: Number(input.ttl_minutos) || undefined });
        if (lease.projeto_id && lease.execution_id) {
          const [projectHint] = await db.select({ stateVersion: automaticProjects.stateVersion, totalItems: automaticProjects.totalItems, pendingCount: automaticProjects.pendingCount, waitingQaCount: automaticProjects.waitingQaCount, relinkCount: automaticProjects.relinkCount, nextAction: automaticProjects.nextAction, pipelineStatus: automaticProjects.pipelineStatus, projectDomain: automaticProjects.projectDomain }).from(automaticProjects).where(eq(automaticProjects.id, String(lease.projeto_id))).limit(1);
          result = { ...lease, project_version: projectHint?.stateVersion || 1, project_domain: projectHint?.projectDomain || "GENERAL", pipeline_status: projectHint?.pipelineStatus || "EM_PROCESSAMENTO", next_action: projectHint?.nextAction || (projectHint?.waitingQaCount ? "QA_VISUAL" : projectHint?.relinkCount ? "RELINK" : "COLETAR"), pending_items: projectHint?.pendingCount || 0, counts: projectHint ? { total: projectHint.totalItems, pending: projectHint.pendingCount, waiting_qa: projectHint.waitingQaCount, relink: projectHint.relinkCount } : null, reconciliation_required: false, lease_fast_path: true };
        } else result = lease;
        break;
      }
      case "backfill_projetos_legados": { const projectId = string(input.projeto_id) || undefined; const itemBackfill = projectId ? await backfillAutomaticProjectItemsFromFiles(projectId) : null; const bf = await backfillLegacyProjects(projectId); if (input.sincronizar_filas !== false) await syncWorkerQueue(projectId); result = { item_backfill: itemBackfill, ...bf }; break; }
      case "executar_watchdog_supervisor": result = await runSupervisorWatchdog({ projectId: string(input.projeto_id) || undefined, source: "MCP_MANUAL_WATCHDOG" }); break;
      case "obter_telemetria_leases_supervisor": result = await getSupervisorLeaseTelemetry(Number(input.horas) || 24); break;
      case "assumir_proximo_trabalho": result = await acquireNextWorkerWork(input); break;
      case "concluir_trabalho_worker": result = await completeWorkerWork(input); break;
      case "registrar_falha_worker": result = await failWorkerWork(input); break;
      case "executar_watchdog_workers": result = await runWorkerWatchdog({ projectId: string(input.project_id) || undefined, source: "MCP_WORKER_WATCHDOG" }); break;
      case "executar_dispatcher_workers": result = await runInternalWorkerDispatcher({ projectId: string(input.project_id) || undefined, maxWorkers: Number(input.max_workers) || undefined, maxCycles: Number(input.max_cycles) || undefined, source: "MCP_MANUAL_DISPATCH" }); break;
      case "obter_saude_dispatcher": result = await getInternalDispatcherHealth(string(input.project_id) || undefined); break;
      case "obter_painel_operacional_producao": result = await getOperationalDashboard(); break;
      case "obter_dashboard_gerencial": result = await getManagementDashboard(Number(input.dias) || 30); break;
      case "configurar_limite_workers": result = await configureWorkerCapacity(input); break;
      case "configurar_dominio_projeto": result = await setProjectDomain(input); break;
      case "sincronizar_filas_workers": result = await syncWorkerQueue(string(input.project_id) || undefined); break;
      case "exportar_txt_operacao": result = await exportOperationsText(string(input.visao).toLowerCase() === "management" ? "management" : "operational"); break;
      case "obter_estado_supervisor": { const projectId = string(input.projeto_id); if (projectId) await touchProjectRead(projectId, input, "OBTER_ESTADO_SUPERVISOR"); result = await getSupervisorState(projectId || undefined); break; }
      case "obter_painel_supervisor": { const projectId = string(input.projeto_id); if (projectId) await touchProjectRead(projectId, input, "OBTER_PAINEL_SUPERVISOR"); result = await getSupervisorState(projectId || undefined); break; }
      case "obter_candidatas_qa_visual": { const projectId = string(input.projeto_id); await touchProjectRead(projectId, input, "OBTER_CANDIDATAS_QA_VISUAL"); result = (await isMcpFileResourceDeliveryEnabled()) ? await getVisualQaEvidence(projectId, limitOf(input.limite, 50), origin, code) : await getFastVisualPacket({project_id:projectId,limit:input.limite,only_waiting_qa:true,include_original_url:true}); break; }
      case "listar_decisoes_supervisor": result = await listPendingDecisions(string(input.projeto_id) || undefined, limitOf(input.limite, 200)); break;
      case "resolver_decisao_supervisor": result = await resolveDecision(string(input.decisao_id), string(input.decisao), string(input.observacao), string(input.execution_id) || undefined); break;
      case "continuar_processamento": { const projectId = string(input.projeto_id); await controlProject(projectId, "continuar"); result = await executeUntilDivergence({ ...input, projeto_id: projectId, intent: "CONTINUE_UNTIL_DIVERGENCE", scope: { max_items: Math.max(1, Math.min(500, Number(input.max_itens) || 200)) } }); break; }
      case "pausar_processamento": { const projectId = string(input.projeto_id); result = await withProjectLease(projectId, input, "PAUSAR_PROCESSAMENTO", () => controlProject(projectId, "pausar")); break; }
      case "cancelar_processamento": { const projectId = string(input.projeto_id); result = await withProjectLease(projectId, input, "CANCELAR_PROCESSAMENTO", async () => { const controlled = await controlProject(projectId, "cancelar"); await completeSupervisorExecution(projectId, string(input.execution_id) || undefined, "CANCELADA"); return controlled; }); break; }
      case "pausar_item": { const projectId = string(input.projeto_id); result = await withProjectLease(projectId, input, "PAUSAR_ITEM", () => controlItem(projectId, string(input.item_id), "pausar")); break; }
      case "retomar_item": { const projectId = string(input.projeto_id); result = await withProjectLease(projectId, input, "RETOMAR_ITEM", () => controlItem(projectId, string(input.item_id), "retomar")); break; }
      case "cancelar_item": { const projectId = string(input.projeto_id); result = await withProjectLease(projectId, input, "CANCELAR_ITEM", () => controlItem(projectId, string(input.item_id), "cancelar")); break; }
      case "aprovar_candidata": { const projectId = string(input.projeto_id); result = await withProjectLease(projectId, input, "APROVAR_CANDIDATA", () => qaAutomaticProject({ projeto_id: projectId, decisoes: [{ item_id: string(input.item_id), status: "APROVADO", observacao: string(input.observacao) }] })); break; }
      case "rejeitar_candidata": {
        const projectId = string(input.projeto_id), itemId = string(input.item_id), requestedCandidateId=string(input.candidate_id);
        const [projectItem] = await db.select({id:automaticProjectItems.id,itemKey:automaticProjectItems.itemKey}).from(automaticProjectItems).where(and(eq(automaticProjectItems.projectId,projectId),or(eq(automaticProjectItems.id,itemId),eq(automaticProjectItems.itemKey,itemId)))).limit(1);
        if (!projectItem) throw new Error("ITEM_NOT_FOUND");
        const [activeCandidate] = await db.select({id:supervisorProjectCandidates.id}).from(supervisorProjectCandidates).where(and(eq(supervisorProjectCandidates.projectId,projectId),eq(supervisorProjectCandidates.itemId,projectItem.id),eq(supervisorProjectCandidates.status,"PARA_QA_VISUAL"))).limit(1);
        if (requestedCandidateId && activeCandidate?.id && requestedCandidateId !== activeCandidate.id) {
          const snapshot=await getOperationalSnapshot(projectId,0,Number(input.limite_pacote)||20);
          result={success:true,changed:false,decision:"STALE_CANDIDATE_IGNORED",item_id:itemId,requested_candidate_id:requestedCandidateId,current_candidate_id:activeCandidate.id,project_state:snapshot.pipeline_status,next_work_packet:snapshot.work_packet,next_actions:snapshot.next_actions,lease:snapshot.lease};
          break;
        }
        const candidateKey=requestedCandidateId||activeCandidate?.id||"NO_ACTIVE_CANDIDATE";
        const operationId = string(input.operation_id) || `REJECT-${projectId}-${projectItem.id}-${candidateKey}`;
        const existing = await beginOperation(operationId, name, projectId);
        if (existing?.status === "COMPLETED") { result = await getOperationResult(operationId); break; }
        let persisted = false;
        try {
          const applied = await withProjectLease(projectId, input, "REJEITAR_CANDIDATA", () => qaAutomaticProject({ projeto_id: projectId, decisoes: [{ item_id: itemId, status: "REJEITADO", observacao: string(input.observacao) }], processar_apos: false }));
          const appliedRecord = applied && typeof applied === "object" ? applied as Record<string,unknown> : {};
          const changed = Array.isArray(appliedRecord.resultados) ? appliedRecord.resultados : [];
          const first = changed.length ? changed[0] as Record<string,unknown> : null;
          const counts = appliedRecord.project_counts && typeof appliedRecord.project_counts === "object" ? appliedRecord.project_counts as Record<string,unknown> : {};
          const itemState = first?.next_state === "RELINK_QUEUE" || first?.status === "RELINK_REQUIRED" ? "RELINK_QUEUE" : "NEXT_CANDIDATE";
          const coreResult = { success:true, operation_id:operationId, decision:"REJEITADO", item_id:itemId, candidate_id:candidateKey, observation:string(input.observacao)||null, item_state:itemState, persisted_item_status:first?.status || null, project_state:"PROCESSING", project_version:Number(appliedRecord.project_version)||0, project_counts:counts, next_work_packet:{qa:[],relink:[],technical:[],source_decisions:[]}, next_actions:itemState === "RELINK_QUEUE" ? ["RELINK"] : ["COLETAR"] };
          // V59: a prova de persistência fica recuperável imediatamente. Se o cliente expirar
          // durante o enriquecimento do pacote, obter_resultado_operacao/obter_ultima_operacao
          // já consegue confirmar a rejeição sem repetir a mutação.
          await completeOperation(operationId, coreResult);
          persisted = true;
          // Reabastece somente a unidade afetada; os demais workers não são tocados.
          await syncWorkerItemsQueue(projectId,[itemId]).catch(() => undefined);
          const snapshot = await getOperationalSnapshot(projectId, 0, Number(input.limite_pacote) || 20).catch(() => null);
          result = { ...coreResult, project_state:snapshot?.pipeline_status || coreResult.project_state, next_work_packet:snapshot?.work_packet || coreResult.next_work_packet, next_actions:snapshot?.next_actions || coreResult.next_actions, lease:snapshot?.lease || null };
          await completeOperation(operationId, result);
        } catch (error) { if (!persisted) await failOperation(operationId,error); throw error; }
        break;
      }
      case "relinkar_item": { const projectId = string(input.projeto_id); result = await withProjectLease(projectId, input, "RELINKAR_ITEM", () => markItemRelink(projectId, string(input.item_id), string(input.observacao))); break; }
      case "relinkar_itens_lote": {
        const projectId=string(input.projeto_id), operationId=string(input.operation_id);
        const existing=await beginOperation(operationId,name,projectId); if (existing?.status==="COMPLETED") { result=await getOperationResult(operationId); break; }
        try {
          const itens=Array.isArray(input.itens)?(input.itens as Array<Record<string,unknown>>).slice(0,20):[];
          const applied=await withProjectLease(projectId,input,"RELINKAR_ITENS_LOTE",()=>alterItemsStrategiesBatch(projectId,itens));
          const summary=await refreshProjectSummary(projectId,{lastAction:"RELINK_BATCH_APPLIED"});
          const snapshot=await getOperationalSnapshot(projectId,0,20);
          result={success:true,resultado:applied,project_version:summary.project_version,project_counts:summary.counts,snapshot}; await completeOperation(operationId,result);
        } catch (error) { await failOperation(operationId,error); throw error; }
        break;
      }
      case "alterar_referencia": { const projectId = string(input.projeto_id); result = await withProjectLease(projectId, input, "ALTERAR_REFERENCIA", () => alterItemStrategy(input)); break; }
      case "alterar_query": { const projectId = string(input.projeto_id); result = await withProjectLease(projectId, input, "ALTERAR_QUERY", () => alterItemStrategy(input)); break; }
      case "trocar_fonte": { const projectId = string(input.projeto_id); result = await withProjectLease(projectId, input, "TROCAR_FONTE", () => alterItemStrategy(input)); break; }
      case "bloquear_host": result = await blockHost(string(input.host), true, string(input.motivo), Number(input.minutos) || 120); break;
      case "desbloquear_host": result = await blockHost(string(input.host), false, string(input.motivo), 0); break;
      case "alterar_timeout": { const projectId = string(input.projeto_id); result = projectId && string(input.item_id) ? await withProjectLease(projectId, input, "ALTERAR_TIMEOUT_ITEM", () => alterItemStrategy(input)) : await updateGlobalCollectorConfig(input); break; }
      case "alterar_configuracao_coleta": result = await updateGlobalCollectorConfig(input); break;
      case "alterar_prioridade_fonte": result = await changeSourcePriority(string(input.fonte), Number(input.prioridade), typeof input.ativo === "boolean" ? input.ativo : undefined, string(input.motivo)); break;
      case "atualizar_fonte_coleta": result = await updateCollectionSource(input); break;
      case "alterar_limites_coleta": result = await changeCollectionLimits(input); break;
      case "materializar_candidata": result = await materializeCollectionCandidate(string(input.candidata_id)); break;
      case "descartar_candidata": result = await discardCollectionCandidate(string(input.candidata_id), string(input.motivo)); break;
      case "salvar_perfil_coleta": result = await saveSourceProfile(input); break;
      case "atualizar_perfil_coleta": result = await saveSourceProfile(input); break;
      case "listar_perfis_coleta": result = await listSourceProfiles(string(input.status) || undefined); break;
      case "ativar_perfil_coleta": result = await setSourceProfileState(string(input.perfil_id), true, string(input.motivo)); break;
      case "desativar_perfil_coleta": result = await setSourceProfileState(string(input.perfil_id), false, string(input.motivo)); break;
      case "salvar_como_padrao": result = await saveProfileAsDefault(string(input.perfil_id), string(input.motivo)); break;
      case "obter_resumo_noturno": result = await getNightlySummary(Number(input.horas) || 12); break;
      case "congelar_item": { const projectId = string(input.projeto_id); result = await withProjectLease(projectId, input, "CONGELAR_ITEM", () => qaAutomaticProject({ projeto_id: projectId, decisoes: [{ item_id: string(input.item_id), status: "APROVADO", observacao: string(input.observacao) || "Congelado pelo Supervisor MCP" }] })); break; }
      case "registrar_uso_asset": result = await registerUsage(input); break;
      case "gerar_zip": { const projectId = string(input.projeto_id); result = await withProjectLease(projectId, input, "GERAR_ZIP", async () => { const zip = await regenerateProjectZip(projectId); const expires = Date.now() + 60 * 60_000; return { ...zip, url: signedDownloadUrl(origin, `/api/projects/${encodeURIComponent(projectId)}/zip`, expires), validade_minutos: 60 }; }); break; }
      case "validar_consistencia": { const projectId = string(input.projeto_id); await touchProjectRead(projectId, input, "VALIDAR_CONSISTENCIA"); result = await getProjectConsistencyGate(projectId); break; }
      case "listar_projetos_automaticos": result = await listAutomaticProjectsFast(limitOf(input.limite, 100), string(input.cursor) || undefined); break;
      case "criar_projeto_automatico": result = await createAutomaticProject(input); break;
      case "obter_projeto_automatico": { const projectId = string(input.projeto_id); await touchProjectRead(projectId, input, "OBTER_PROJETO_AUTOMATICO"); result = await getAutomaticProjectSummary(projectId); break; }
      case "obter_detalhes_projeto_automatico": { const projectId = string(input.projeto_id); await touchProjectRead(projectId, input, "OBTER_DETALHES_PROJETO_AUTOMATICO"); result = await getAutomaticProject(projectId); break; }
      case "obter_snapshot_operacional": { const projectId = string(input.projeto_id); await touchProjectRead(projectId, input, "OBTER_SNAPSHOT_OPERACIONAL"); result = await getOperationalSnapshot(projectId, Number(input.since_version)||0, Number(input.limite_pacote)||20); break; }
      case "configurar_projeto_automatico": result = await updateAutomaticProject(input); break;
      case "anexar_arquivo_projeto": result = await attachAutomaticProjectFileFromUrl(input); break;
      case "obter_conteudo_arquivo_projeto": { const projectId = string(input.projeto_id); await touchProjectRead(projectId, input, "OBTER_CONTEUDO_ARQUIVO_PROJETO"); result = await getAutomaticProjectFile(input, true); break; }
      case "baixar_arquivo_projeto": {
        const projectId = string(input.projeto_id); await touchProjectRead(projectId, input, "BAIXAR_ARQUIVO_PROJETO");
        const file = await getAutomaticProjectFile(input, false);
        const minutes = Math.max(1, Math.min(60, Number(input.validade_minutos) || 30));
        const expires = Date.now() + minutes * 60_000;
        result = { ...file, url: signedDownloadUrl(origin, `/api/projects/${encodeURIComponent(string(input.projeto_id))}/files?file_id=${encodeURIComponent(String((file as Record<string, unknown>).arquivo_id || ""))}`, expires), validade_minutos: minutes };
        break;
      }
      case "processar_projeto_automatico": { const projectId = string(input.projeto_id); result = await withProjectLease(projectId, input, "PROCESSAR_PROJETO_AUTOMATICO", () => processAutomaticProject(input)); break; }
      case "reconciliar_projeto_automatico": { const projectId = string(input.projeto_id); result = await withProjectLease(projectId, input, "RECONCILIAR_PROJETO_AUTOMATICO", async () => { const reconciled = await reconcileAutomaticProject(projectId); await recordSupervisorProjectReconciled(projectId, string(input.execution_id), { source: "MCP", result: reconciled }); return reconciled; }); break; }
      case "validar_consistencia_projeto": { const projectId = string(input.projeto_id); await touchProjectRead(projectId, input, "VALIDAR_CONSISTENCIA_PROJETO"); result = await getProjectConsistencyGate(projectId); break; }
      case "registrar_qa_projeto": { const projectId = string(input.projeto_id); result = await withProjectLease(projectId, input, "REGISTRAR_QA_PROJETO", () => qaAutomaticProject(input)); break; }
      case "regenerar_zip_projeto": { const projectId = string(input.projeto_id); result = await withProjectLease(projectId, input, "REGENERAR_ZIP_PROJETO", async () => { const zip = await regenerateProjectZip(projectId); const expires = Date.now() + 60 * 60_000; return { ...zip, url: signedDownloadUrl(origin, `/api/projects/${encodeURIComponent(projectId)}/zip`, expires), validade_minutos: 60 }; }); break; }
      case "reabrir_projeto_concluido": result = await reopenAutomaticProject(input); break;
      case "verificar_disponibilidade_projeto": result = await getProjectAutomationAvailability(input); break;
      case "obter_log_projeto": { const projectId = string(input.projeto_id); await touchProjectRead(projectId, input, "OBTER_LOG_PROJETO"); result = await getAutomaticProjectLog(projectId); break; }
      case "configurar_fontes_coleta": result = await configureCollectionSources(await textFromInput(input, "fontes_texto", "arquivo_txt")); break;
      case "listar_fontes_coleta": result = await listCollectionSources(); break;
      case "criar_lote_coleta_automatica": result = await createCollectionBatch({ ...input, termos_texto: await textFromInput(input, "termos_texto", "arquivo_termos_txt"), fontes_texto: await textFromInput(input, "fontes_texto", "arquivo_fontes_txt") }); break;
      case "executar_coleta_automatica": { const projectId = await projectIdFromCollectionBatch(string(input.lote_id)); result = projectId ? await withProjectLease(projectId, input, "EXECUTAR_COLETA_AUTOMATICA", () => executeCollection(input)) : await executeCollection(input); break; }
      case "obter_status_coleta_automatica": { const projectId = await projectIdFromCollectionBatch(string(input.lote_id)); if (projectId) await touchProjectRead(projectId, input, "OBTER_STATUS_COLETA_AUTOMATICA"); result = await getCollectionBatch(string(input.lote_id)); break; }
      case "listar_lotes_coleta_automatica": result = await listCollectionBatches(limitOf(input.limite, 100)); break;
      case "controlar_lote_coleta": { const action = string(input.acao).toLowerCase(); if (!["pausar", "retomar", "cancelar"].includes(action)) throw new Error("ACAO_INVALIDA"); const projectId = await projectIdFromCollectionBatch(string(input.lote_id)); result = projectId ? await withProjectLease(projectId, input, "CONTROLAR_LOTE_COLETA", () => setCollectionBatchState(string(input.lote_id), action as "pausar" | "retomar" | "cancelar")) : await setCollectionBatchState(string(input.lote_id), action as "pausar" | "retomar" | "cancelar"); break; }
      case "listar_para_analise_coleta": result = await listCollectionQa(input); break;
      case "gerar_relatorio_coleta": { const projectId = await projectIdFromCollectionBatch(string(input.lote_id)); result = projectId ? await withProjectLease(projectId, input, "GERAR_RELATORIO_COLETA", () => getCollectionReport(string(input.lote_id))) : await getCollectionReport(string(input.lote_id)); break; }
      case "obter_log_detalhado_coleta": { const projectId = await projectIdFromCollectionBatch(string(input.lote_id)); if (projectId) await touchProjectRead(projectId, input, "OBTER_LOG_DETALHADO_COLETA"); result = await getDetailedCollectionLog(string(input.lote_id)); break; }
      case "listar_configuracoes": result = (await db.select().from(settings)).filter((item) => !item.key.startsWith("mcp_") && !item.key.startsWith("secret_")); break;
      case "atualizar_configuracao": { const key = string(input.chave); if (!key || key.startsWith("mcp_") || key.startsWith("secret_") || key.startsWith("cloudflare_")) throw new Error("Chave reservada."); const value = string(input.valor); await db.insert(settings).values({ key, value, updatedAt: new Date() }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } }); result = { chave: key, valor: value }; break; }
      case "obter_configuracao_cloudflare": result = safeCloudflareConnection(await getCloudflareConnection()); break;
      case "configurar_cloudflare": {
        const current = await getCloudflareConnection();
        const saved = current?.connection || null;
        const connection = {
          accountId: string(input.account_id) || saved?.accountId || "",
          bucket: string(input.bucket) || saved?.bucket || "",
          accessKeyId: string(input.access_key_id) || saved?.accessKeyId || "",
          secretAccessKey: string(input.secret_access_key) || saved?.secretAccessKey || "",
          endpoint: string(input.r2_endpoint) || saved?.endpoint || "",
          d1ApiToken: string(input.d1_api_token) || saved?.d1ApiToken || "",
          d1DatabaseId: string(input.d1_database_id) || saved?.d1DatabaseId || "",
          d1DatabaseName: string(input.d1_database_name) || saved?.d1DatabaseName || "",
        };
        const hasR2 = Boolean(connection.bucket || connection.accessKeyId || connection.secretAccessKey || connection.endpoint);
        if (hasR2) {
          if (!connection.accountId || !connection.bucket || !connection.accessKeyId || !connection.secretAccessKey) throw new Error("R2_INCOMPLETO");
          await testR2Connection({ endpoint: connection.endpoint || `https://${connection.accountId}.r2.cloudflarestorage.com`, bucket: connection.bucket, accessKeyId: connection.accessKeyId, secretAccessKey: connection.secretAccessKey });
        }
        if (connection.d1ApiToken) {
          const database = await resolveCorvoD1Database(connection.accountId, connection.d1ApiToken, connection.d1DatabaseId, connection.d1DatabaseName);
          connection.d1DatabaseId = database.id;
          connection.d1DatabaseName = database.name;
        }
        if (!hasR2 && !connection.d1ApiToken) throw new Error("CLOUDFLARE_CONFIG_VAZIA");
        result = { ...safeCloudflareConnection(await saveCloudflareConnection(connection)), bindingActive: hasR2 };
        break;
      }
      case "obter_workspace_politicas": result = await getOperationalPolicyWorkspaceDashboard(); break;
      case "detectar_gap_operacional": result = await detectOperationalGap(input); break;
      case "listar_gaps_operacionais": result = await listOperationalGaps(input); break;
      case "obter_gap_operacional": result = await getOperationalGap(string(input.gap_id)); break;
      case "criar_politica_operacional": result = await createOperationalPolicy(input); break;
      case "editar_politica_operacional": result = await editOperationalPolicy(input); break;
      case "testar_politica_operacional": result = await testOperationalPolicy(input); break;
      case "ativar_politica_operacional": result = await activateOperationalPolicy(string(input.policy_id)); break;
      case "promover_politica_operacional": result = await promoteOperationalPolicy(input); break;
      case "suspender_politica_operacional": result = await suspendOperationalPolicy(string(input.policy_id)); break;
      case "rollback_politica_operacional": result = await rollbackOperationalPolicy(input); break;
      case "listar_politicas_operacionais": result = await listOperationalPolicies(input); break;
      case "obter_politicas_aplicadas": result = await getAppliedOperationalPolicies(input); break;
      case "vincular_gap_politica": result = await linkGapPolicy(string(input.gap_id),string(input.policy_id)); break;
      case "obter_telemetria_politicas": result = await getOperationalPolicyTelemetry(input); break;
      case "resolver_gap_e_aprender": result = await resolveGapAndLearn(input); break;
      case "supervisor_exchange": result = await supervisorExchange(input); break;
      case "executar_ate_divergencia": result = await executeUntilDivergence(input); break;
      case "obter_work_packet": { const projectId=string(input.projeto_id); await touchProjectRead(projectId,input,"OBTER_WORK_PACKET_V60"); result=await getWorkPacket(projectId,Number(input.limite)||20,Number(input.since_version)||0); break; }
      case "obter_status_plano": result = await getPlanStatus(string(input.plan_id)); break;
      case "obter_detalhes_plano": result = await getPlanDetails(string(input.plan_id),limitOf(input.limite,500)); break;
      case "obter_excecoes_plano": result = await getPlanExceptions(string(input.plan_id),limitOf(input.limite,200)); break;
      case "executar_tick_planos": result = await runSupervisorPlansTick({planId:string(input.plan_id)||undefined,projectId:string(input.projeto_id)||undefined,maxPlans:Number(input.max_planos)||5,maxSteps:Number(input.max_etapas)||2,source:"MCP_EXPLICIT_TICK"}); break;
      case "pausar_plano": { const status=await getPlanStatus(string(input.plan_id)); const projectId=status.found&&status.plan&&typeof status.plan==="object"?string((status.plan as Record<string,unknown>).projectId):""; if(projectId) await requireSupervisorLeaseForWrite(projectId,string(input.execution_id)||undefined,"PAUSAR_PLANO"); result=await controlPlan(string(input.plan_id),"pause"); break; }
      case "retomar_plano": { const status=await getPlanStatus(string(input.plan_id)); const projectId=status.found&&status.plan&&typeof status.plan==="object"?string((status.plan as Record<string,unknown>).projectId):""; if(projectId) await requireSupervisorLeaseForWrite(projectId,string(input.execution_id)||undefined,"RETOMAR_PLANO"); result=await controlPlan(string(input.plan_id),"resume"); break; }
      case "cancelar_plano": { const status=await getPlanStatus(string(input.plan_id)); const projectId=status.found&&status.plan&&typeof status.plan==="object"?string((status.plan as Record<string,unknown>).projectId):""; if(projectId) await requireSupervisorLeaseForWrite(projectId,string(input.execution_id)||undefined,"CANCELAR_PLANO"); result=await controlPlan(string(input.plan_id),"cancel"); break; }
      case "obter_plano_roteamento_fonte": {
        const projectId=string(input.projeto_id),itemId=string(input.item_id);
        if(input.reconstruir===true&&itemId) result=await buildSourceRoutingPlan({projectId,itemId,persist:true});
        else result=await getLatestSourceRoutingPlan(projectId,itemId||undefined);
        break;
      }
      case "FAST_APPROVE_PROJECT_ITEMS": {
        const projectId = string(input.projeto_id), operationId = string(input.operation_id) || `FAST-APPROVE-${projectId}-${Date.now().toString(36)}`;
        const items = (Array.isArray(input.itens) ? input.itens : []).filter((row): row is Record<string,unknown> => Boolean(row && typeof row === "object" && !Array.isArray(row))).slice(0,100);
        if (!items.length) throw new Error("ITENS_REQUIRED");
        result = await withProjectLease(projectId, input, "FAST_APPROVE_PROJECT_ITEMS", () => enqueueFastApproveProjectItems({
          operationId, projectId, items, executionId:string(input.execution_id) || null, source:"SUPERVISOR_MCP",
        }));
        break;
      }
      case "aplicar_decisoes_supervisor_lote": {
        const projectId = string(input.projeto_id), operationId = string(input.operation_id) || `BATCH-${projectId}-${Date.now().toString(36)}`;
        const decisions = (Array.isArray(input.decisoes) ? input.decisoes : []).filter((row): row is Record<string,unknown> => Boolean(row && typeof row === "object" && !Array.isArray(row))).slice(0,200);
        if (!decisions.length) throw new Error("DECISOES_REQUIRED");
        // V61.6: apenas autorização + persistência do job ficam no caminho quente.
        // qaAutomaticProject({ processar_apos:false }) roda depois no Data Plane via fast-supervisor-decisions.
        const ack = await withProjectLease(projectId, input, "APLICAR_DECISOES_SUPERVISOR_LOTE_FAST_ACK", () => enqueueSupervisorDecisionBatch({
          operationId, projectId, decisions, executionId:string(input.execution_id) || null, source:"SUPERVISOR_MCP",
        }));
        const ackRecord = ack && typeof ack === "object" ? ack as Record<string,unknown> : {};
        result = { ...ackRecord, next_work_packet: ackRecord.next_work_packet || {qa:[],relink:[],technical:[],source_decisions:[]}, next_actions: ackRecord.next_actions || [] };
        break;
      }
      case "materializar_urls_lote": {
        const operationId = string(input.operation_id), projectId = string(input.projeto_id) || "";
        const existing = await beginOperation(operationId, name, projectId || null);
        if (existing?.status === "COMPLETED") { result = await getOperationResult(operationId); break; }
        try {
          const items = Array.isArray(input.itens) ? (input.itens as Array<Record<string,unknown>>).slice(0,20) : [];
          const work = () => materializeBatch({ batch_id:string(input.batch_id), projeto:string(input.projeto), itens:items });
          result = projectId ? await withProjectLease(projectId,input,"MATERIALIZAR_URLS_LOTE",work) : await work();
          await completeOperation(operationId,result);
        } catch (error) { await failOperation(operationId,error); throw error; }
        break;
      }
      case "obter_resultado_operacao": result = await getOperationResult(string(input.operation_id)); break;
      case "obter_ultima_operacao": result = await getLatestOperationResult(string(input.projeto_id), string(input.ferramenta)); break;
      case "obter_performance_mcp": result = await getMcpPerformanceSummary(Number(input.horas)||24); break;
      case "obter_ranking_rotas_fontes": result = await getRouteRanking(string(input.universo)||undefined,string(input.composition_class)||undefined,limitOf(input.limite,200)); break;
      case "obter_politica_risco_mcp": {
        const detalhes = tools.map((entry) => ({
          nome: entry.name,
          readOnlyHint: entry.annotations.readOnlyHint,
          destructiveHint: entry.annotations.destructiveHint,
          idempotentHint: entry.annotations.idempotentHint,
          openWorldHint: entry.annotations.openWorldHint,
          riskLevel: entry._meta?.["corvo/riskLevel"],
          continuousEligible: entry._meta?.["corvo/continuousEligible"],
          requiresExplicitConfirmation: entry._meta?.["corvo/requiresExplicitConfirmation"],
        }));
        result = {
          ...getMcpRiskPolicySummary(tools.map((entry) => entry.name)),
          baixo_risco: detalhes.filter((entry) => entry.riskLevel === "low").length,
          destrutivas: detalhes.filter((entry) => entry.riskLevel === "destructive").map((entry) => entry.nome),
          sensiveis: detalhes.filter((entry) => entry.riskLevel === "sensitive").map((entry) => entry.nome),
          ferramentas: detalhes,
        };
        break;
      }
      case "obter_log_mcp": result = await db.select().from(mcpAudit).orderBy(desc(mcpAudit.createdAt)).limit(limitOf(input.limite)); break;
      case "verificar_saude": { await db.select({ id: assets.id }).from(assets).limit(1); const bucket = await env.BUCKET.list({ limit: 1 }); result = { ok: true, banco: "conectado", armazenamento: "conectado", objetos_amostrados: bucket.objects.length }; break; }
      default: throw new Error(`Ferramenta desconhecida: ${name}`);
    }
    const serializationStarted = Date.now();
    const structured = structuredResult(name, result);
    let responseBytes = 0;
    try { responseBytes = new TextEncoder().encode(JSON.stringify(structured)).byteLength; } catch { responseBytes = 0; }
    const serializationMs = Date.now() - serializationStarted, finishedAt = new Date(), durationMs = Date.now() - perfStart;
    await audit(name, true, `Sucesso: ${name}`, { requestId, startedAt:perfStartedAt, finishedAt, durationMs, authMs:transportPerf.authMs, parseMs:transportPerf.parseMs, responseBytes, serializationMs, coldStart });
    return structured;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha inesperada";
    const finishedAt = new Date(), durationMs = Date.now() - perfStart;
    await audit(name, false, message, { requestId, startedAt:perfStartedAt, finishedAt, durationMs, authMs:transportPerf.authMs, parseMs:transportPerf.parseMs, coldStart });
    throw error;
  }
}
