export type McpRiskLevel = "low" | "destructive" | "sensitive";

export type McpRiskPolicy = {
  riskLevel: McpRiskLevel;
  continuousEligible: boolean;
  requiresExplicitConfirmation: boolean;
  idempotentHint: boolean;
  rationale: string;
};

// These tools physically delete persisted data/files. They stay explicitly destructive.
// This is intentionally small: stopping/pausing/relinking a pipeline is reversible state,
// not permanent data destruction.
const DESTRUCTIVE_TOOLS = new Set([
  "excluir_asset_permanentemente",
  "excluir_pendentes_permanentemente_em_lote",
  "limpar_temporarios_lote",
  "excluir_candidatas_lote",
]);

// Credential-bearing connection changes are not part of the continuous production loop.
// They are not destructive, but they remain outside the low-risk auto-use class.
const SENSITIVE_TOOLS = new Set([
  "configurar_cloudflare",
]);

// Tools where repeating the same arguments is expected to converge on the same persisted
// state (or the implementation already deduplicates by stable IDs/hash/content).
const IDEMPOTENT_WRITE_TOOLS = new Set([
  "editar_metadados",
  "marcar_rejeitado",
  "restaurar_asset",
  "aprovar_pendentes_em_lote",
  "atualizar_solicitacao",
  "adicionar_assets_ao_lote",
  "remover_assets_do_lote",
  "atualizar_status_lote",
  "processar_importacao_zip",
  "sincronizar_r2",
  "criar_fila_materializacao_continua",
  "adicionar_itens_fila_materializacao",
  "registrar_qa_lote",
  "retry_item_materializacao",
  "adicionar_candidatas_item",
  "cancelar_lote_materializacao",
  "configurar_politica_estoque",
  "configurar_supervisor_mcp",
  "executar_watchdog_supervisor",
  "assumir_proximo_trabalho_supervisor",
  "backfill_projetos_legados",
  "executar_watchdog_workers",
  "executar_dispatcher_workers",
  "assumir_proximo_trabalho",
  "concluir_trabalho_worker",
  "registrar_falha_worker",
  "configurar_limite_workers",
  "configurar_dominio_projeto",
  "sincronizar_filas_workers",
  "resolver_decisao_supervisor",
  "pausar_processamento",
  "cancelar_processamento",
  "pausar_item",
  "retomar_item",
  "cancelar_item",
  "aprovar_candidata",
  "rejeitar_candidata",
  "relinkar_item",
  "relinkar_itens_lote",
  "FAST_APPROVE_PROJECT_ITEMS",
  "configurar_modo_entrega_chat",
  "fast_decidir_candidatas_lote",
  "aprovar_itens_lote",
  "aprovar_target_files_lote",
  "relink_itens_lote",
  "fast_push_urls_lote",
  "gerar_grid_candidatas",
  "exportar_pacote_qa_json",
  "aplicar_decisoes_supervisor_lote",
  "materializar_urls_lote",
  "alterar_referencia",
  "alterar_query",
  "trocar_fonte",
  "bloquear_host",
  "desbloquear_host",
  "alterar_timeout",
  "alterar_configuracao_coleta",
  "alterar_prioridade_fonte",
  "atualizar_fonte_coleta",
  "alterar_limites_coleta",
  "descartar_candidata",
  "salvar_perfil_coleta",
  "atualizar_perfil_coleta",
  "ativar_perfil_coleta",
  "desativar_perfil_coleta",
  "salvar_como_padrao",
  "congelar_item",
  "configurar_projeto_automatico",
  "anexar_arquivo_projeto",
  "reconciliar_projeto_automatico",
  "registrar_qa_projeto",
  "reabrir_projeto_concluido",
  "configurar_fontes_coleta",
  "controlar_lote_coleta",
  "atualizar_configuracao",
  "supervisor_exchange",
  "executar_ate_divergencia",
  "executar_tick_planos",
  "pausar_plano",
  "retomar_plano",
  "cancelar_plano",
  "detectar_gap_operacional",
  "criar_politica_operacional",
  "editar_politica_operacional",
  "ativar_politica_operacional",
  "promover_politica_operacional",
  "suspender_politica_operacional",
  "rollback_politica_operacional",
  "vincular_gap_politica",
  "resolver_gap_e_aprender",
  "rejeitar_candidatas_fast_push_lote",
  "aprovar_candidatas_fast_push_lote",
  "decidir_candidatas_lote",
  "aprovar_candidatas_lote",
  "rejeitar_candidatas_lote",
  "rejeitar_itens_lote",
  "importar_candidata_arquivo_fast_push",
  "importar_candidatas_url_lote",
  "vincular_candidatas_fast_push_ao_projeto",
  "fast_push_thumbs_url_lote",
  "fast_push_generated_media",
  "importar_midia_por_url",
  "preparar_upload_midia",
  "confirmar_upload_midia",
  "fast_decidir_thumbs_lote",
  "gerar_pacote_final",
  "confirmar_download_pacote",
  "fast_push_titulos",
  "decidir_thumbs_projeto",
  "decidir_titulos_projeto",
  "exportar_projeto_completo_zip",
]);

export function getMcpRiskPolicy(name: string, readOnlyHint: boolean, destructiveHint: boolean): McpRiskPolicy {
  const destructive = destructiveHint || DESTRUCTIVE_TOOLS.has(name);
  if (destructive) {
    return {
      riskLevel: "destructive",
      continuousEligible: false,
      requiresExplicitConfirmation: true,
      idempotentHint: false,
      rationale: "Operação remove dados/arquivos persistidos e permanece fora do modo contínuo.",
    };
  }
  if (SENSITIVE_TOOLS.has(name)) {
    return {
      riskLevel: "sensitive",
      continuousEligible: false,
      requiresExplicitConfirmation: true,
      idempotentHint: true,
      rationale: "Operação altera credenciais/conexão de infraestrutura e não faz parte do pipeline rotineiro.",
    };
  }
  return {
    riskLevel: "low",
    continuousEligible: true,
    requiresExplicitConfirmation: false,
    idempotentHint: readOnlyHint || IDEMPOTENT_WRITE_TOOLS.has(name),
    rationale: readOnlyHint
      ? "Leitura/inspeção sem alteração persistente."
      : "Operação rotineira, aditiva ou reversível do pipeline Corvo.",
  };
}

export function getMcpRiskPolicySummary(toolNames: string[]) {
  const unique = [...new Set(toolNames)];
  const destructive = unique.filter((name) => DESTRUCTIVE_TOOLS.has(name));
  const sensitive = unique.filter((name) => SENSITIVE_TOOLS.has(name));
  return {
    total: unique.length,
    destructive,
    sensitive,
    lowRiskExpected: unique.length - destructive.length - sensitive.length,
    policyVersion: "V61",
  };
}
