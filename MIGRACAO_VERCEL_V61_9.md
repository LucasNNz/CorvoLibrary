# PHASE 2 — CONFIGURAÇÃO PERSISTENTE R2 + D1

# Corvo Library V61.9 — Vercel Native (migração em andamento)

## Arquitetura alvo
- Next.js 16 App Router nativo na Vercel.
- Turso/libSQL preservando o schema SQLite atual.
- Cloudflare R2 preservado, acessado pela API S3.
- Vercel `waitUntil()` para acordar o Data Plane depois do ACK.
- Sem Vercel Cron. O processamento normal acorda por `waitUntil()` e o agendamento periódico fica no ChatGPT chamando o MCP.
- Sharp para processamento de imagens no runtime Node.

## Dados
O ZIP não contém os dados vivos do D1. Para preservar a Library, exporte o D1 atual para SQL e importe no Turso com:

`npm run db:migrate:vercel -- ./d1-export.sql`

A V61.9 não depende mais da chave antiga para continuar a migração. Se a configuração importada do D1 estiver criptografada com uma chave desconhecida, o app marca **precisa reconfigurar** e permite salvar novas credenciais pela aba Configurações. R2 + D1 ficam criptografados no Turso e reaparecem em qualquer PC.

## Variáveis mínimas
- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`

As credenciais Cloudflare **não precisam ser configuradas manualmente na Vercel**. O caminho principal é Configurações → Cloudflare → Salvar. `R2_*`, `CLOUDFLARE_API_TOKEN` e `CORVO_CONFIG_ENCRYPTION_KEY` ficam apenas como fallback/compatibilidade técnica. A criptografia persistente usa uma master key própria da Library. Ela é protegida pelo token Turso para funcionamento automático e pela senha do administrador para recuperação após rotação do token.

## Alterações já feitas
- removido Vinext/Vite/Wrangler/Cloudflare Vite Plugin;
- scripts `next dev`, `next build`, `next start`;
- D1 Drizzle -> libSQL Drizzle;
- compatibilidade dos 11 usos `env.DB.prepare()` sobre libSQL;
- R2 binding -> adapter S3 compatível com get/put/head/list/delete/multipart;
- `cloudflare:workers` removido do código da aplicação;
- Worker de fetch/scheduled removido;
- Data Plane movido para `lib/data-plane.ts`;
- wake por `@vercel/functions.waitUntil()`;
- watchdog em `/api/internal/data-plane`;
- nenhum Cron em `vercel.json`; agendamento periódico externo via ChatGPT → MCP;
- Photon/Workerd e JSquash removidos;
- conversão/contact sheet migradas para Sharp;
- `withProjectLease` exportado corretamente para as rotas industriais;
- compatibilidade R2 adicionada para `httpEtag` e `writeHttpMetadata`;
- componentes ausentes `AssetDrawer` e `BulkModal` adicionados à UI principal;
- Configurações Cloudflare ampliadas para R2 + D1 persistentes;
- token D1 e Secret R2 nunca são devolvidos ao navegador;
- D1 pode ser localizado automaticamente pela assinatura de tabelas da Corvo Library;
- configuração antiga indecifrável não derruba a UI: pode ser substituída por credenciais novas;
- validador estrutural `scripts/validate-vercel-migration.mjs` criado e passando.

## Ainda precisa de validação antes de produção
1. `npm install` + `next build` real (não executado neste ambiente porque a instalação de dependências externas não concluiu);
2. migração dos dados D1 vivos para Turso;
3. validação de contagens e IDs;
4. smoke test do mesmo R2;
5. teste MCP, FAST PUSH, visual packet, decide/approve, ZIP;
6. validar login nome/senha e “lembrar neste aparelho” no Preview;
7. o agendamento periódico oficial fica fora da Vercel: ChatGPT Scheduler → MCP. O endpoint interno de Data Plane é somente recuperação/manual e exige login do painel.

## Perfil de configuração herdado

A migração preserva integralmente os registros da tabela `settings`, inclusive `secret_cloudflare_connection`. A aplicação referencia esse mesmo perfil no Turso e não exige que o operador copie os valores para TXT ou `.env`. Um manifesto não secreto separado preserva os metadados recuperáveis. Se o segredo legado puder ser aberto, nada precisa ser redigitado; se a chave antiga estiver indisponível, somente o segredo/token faltante precisa ser renovado, e o botão Salvar sobrescreve o mesmo perfil para todos os PCs.

---

## FINALIZAÇÃO V61.9 — UI DE MIGRAÇÃO D1 → TURSO

A revisão final remove a última dependência operacional de terminal para a transferência dos dados reais:

- Turso vazio faz bootstrap automático somente de `settings`;
- Configurações persistentes R2 + D1 podem ser salvas antes do restante do schema existir;
- `/api/migration/d1-to-turso` faz preflight, export oficial D1, import libSQL, overlay da conexão Cloudflare válida e comparação de contagens;
- a UI **Configurações → Migração da Library — D1 → Turso** executa o processo;
- destino com dados de aplicação não é substituído silenciosamente;
- R2 permanece no bucket atual e não entra na migração de banco;
- metadata pública usa a URL do próprio deployment Vercel;
- Node fixado em 24.x;
- Vercel Cron permanece ausente.

Validação desta revisão: 129/129 regressões PASS, auditoria estrutural Vercel PASS e 42 Route Handlers detectados e validador estrutural Vercel PASS. O `next build` real fica como gate do primeiro Preview porque o ambiente de empacotamento não concluiu acesso ao registry npm.


## FECHAMENTO DE SEGURANÇA / IMPLEMENTAÇÃO
- Login simples nome + senha gravado no Turso; senha somente em hash PBKDF2.
- Sessão HttpOnly/SameSite com opção “lembrar neste aparelho”.
- APIs administrativas não usam mais fallback same-origin ou cabeçalho do Sites.
- Login pode ser alterado pela própria aba Configurações.
- Master key V2 estável para segredos persistentes, com wrapper Turso + recuperação pela senha.
- Substituição D1 → Turso cria snapshot lógico no R2 antes de apagar o destino.
- Falha durante substituição aciona rollback automático; backup anterior também pode ser restaurado manualmente pela interface.
- Login/sessão/master key do Turso são preservados durante a importação do D1.


## THUMB + ZIP LINKS-ONLY FINAL

A V61.9 consolida THUMB e pacote final sem transporte de arquivos pelo chat. THUMB entra por `fast_push_generated_media` (HTTPS) ou `preparar_upload_midia` + PUT direto R2 + `confirmar_upload_midia`; QA usa `obter_thumbs_links`. O ZIP final usa fila idempotente `download_packages`: `gerar_pacote_final` → `listar_pacotes_prontos_para_download` → `obter_link_download_pacote` → download direto no PC → `confirmar_download_pacote`. A conclusão do projeto também enfileira o pacote automaticamente. `MCP_FILE_RESOURCE_DELIVERY` permanece estruturalmente desabilitado. Veja `IMPLEMENTACAO_THUMB_ZIP_LINKS_ONLY_V61_9.txt`.


## FIX5 — Drizzle Type Sweep

Corrige o lote de erros de type-check Drizzle revelado pelo build real da Vercel: campos QA vindos de `materialization_files`, batches heterogêneos, narrowing de SHA no FAST PUSH e batches dinâmicos do Supervisor.

## FIX6 — FAST PUSH / DRIZZLE NARROWING

- `bridgeFastPushToCanonicalPending` congela `r2Key`, `sha256` e `mimeType` em strings não-nulas após o guard.
- `materialization_files` usa um registro explicitamente tipado como `typeof materializationFiles.$inferInsert` antes de `.values()`.
- Isso elimina o widening `string | null` e o fallback incorreto para o overload array do Drizzle.
- Regressão específica adicionada; suíte local: 143/143.
