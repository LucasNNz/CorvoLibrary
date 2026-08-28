-- V59 — REJECT + CONTINUE ATOMIC CONTROL PLANE
-- Normaliza domains de perfis, limpa breakers expirados e indexa recuperação de operações.

-- Perfis realmente específicos de anime deixam de aparecer como GENERAL.
UPDATE source_profiles
SET domain = 'ANIME', updated_at = CAST(strftime('%s','now') AS INTEGER)*1000
WHERE COALESCE(domain,'GENERAL') = 'GENERAL'
  AND (
    id IN ('SPROF-FANDOM-WIKIA-ANIME','SPROF-ZEROCHAN-ANIME')
    OR (LOWER(COALESCE(universes,'')) LIKE '%anime%' AND LOWER(COALESCE(universes,'')) NOT LIKE '%cartoon%' AND LOWER(COALESCE(universes,'')) NOT LIKE '%geek%')
  );

-- Perfis compartilhados por anime/cartoon/geek não devem continuar GENERAL nem ser
-- artificialmente presos a ANIME: MULTI mantém o roteamento multi-nicho explícito.
UPDATE source_profiles
SET domain = 'MULTI', updated_at = CAST(strftime('%s','now') AS INTEGER)*1000
WHERE COALESCE(domain,'GENERAL') = 'GENERAL'
  AND id IN ('SPROF-YOUTUBE-CONTEXTUAL','SPROF-PINTEREST-DISCOVERY');

-- Breakers expirados são histórico de saúde, não bloqueios ativos de roteamento.
UPDATE materialization_host_health
SET circuit_state='CLOSED', blocked_until=NULL, recent_failure_count=0,
    updated_at=CAST(strftime('%s','now') AS INTEGER)*1000
WHERE circuit_state IN ('OPEN','HALF_OPEN')
  AND (blocked_until IS NULL OR blocked_until <= CAST(strftime('%s','now') AS INTEGER)*1000);

CREATE INDEX IF NOT EXISTS idx_operation_results_project_tool_updated
  ON operation_results(project_id, tool, updated_at DESC);
