# Corvo Library V61.9 — Vercel Native FINAL

Esta é a variante final preparada para migrar a Corvo Library do runtime Sites/Cloudflare Worker para **Next.js nativo na Vercel**, mantendo o **Cloudflare R2 atual** e migrando o banco **Cloudflare D1 → Turso/libSQL**.

## Arquitetura final

- Next.js 16 App Router na Vercel.
- Vercel Functions / Node.js para APIs e MCP.
- Turso/libSQL como banco SQLite remoto.
- Cloudflare R2 mantido como storage canônico via API S3.
- `@vercel/functions.waitUntil()` para acordar o Data Plane depois de mutações.
- Agendamento periódico: ChatGPT Automation → MCP. **Nenhum Vercel Cron**.
- Sharp no lugar de Photon/Workerd/JSquash para processamento de imagem.
- LINKS_ONLY preservado: chat opera por IDs, metadados e URLs assinadas; arquivos permanecem no R2.

## Primeiro deploy — sem terminal para Cloudflare/D1

O único bootstrap externo necessário é conectar um banco Turso ao projeto Vercel, fornecendo automaticamente:

- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`

Depois:

1. Abra **Configurações → Cloudflare — R2 + D1**.
2. A Library reaproveita o perfil herdado quando ele estiver disponível.
3. Se alguma credencial antiga não puder ser descriptografada, informe apenas a nova chave/token necessária e clique **Salvar e cravar configuração**.
4. Abra **Migração da Library — D1 → Turso**.
5. Clique **Migrar D1 → Turso**.
6. O app localiza o D1 da Corvo Library, exporta o SQL pela API oficial da Cloudflare, importa no Turso e compara contagens de todas as tabelas (exceto `settings`, que recebe os novos marcadores/credenciais válidos da V61.9).
7. O R2 não é copiado nem alterado: os mesmos `r2_key` continuam apontando para o mesmo bucket.

Um Turso totalmente vazio é suportado: a aplicação cria automaticamente somente a tabela mínima `settings` para permitir configurar e executar a migração pela interface.

## Proteções da migração

- Um destino Turso com dados de aplicação não é sobrescrito silenciosamente.
- Reimportação exige confirmação explícita na UI/API.
- A configuração Cloudflare atualmente válida fica em memória durante a importação e sobrescreve somente o segredo legado correspondente depois do dump.
- MCP code, projetos, PITEMs, candidatos, decisões, políticas, telemetria e demais settings do D1 são herdados.
- A migração falha se as contagens das tabelas importadas divergirem do D1.

## Configuração persistente

R2 e D1 são salvos criptografados no próprio banco remoto. Depois de salvos, qualquer computador que abra a mesma Library reutiliza a configuração. Os segredos nunca são devolvidos para o navegador.

As variáveis `R2_*` e `CLOUDFLARE_*` existentes em `.env.example` são apenas fallbacks técnicos/CLI; não fazem parte do fluxo normal.

## Scripts úteis

```bash
npm run dev
npm run build
npm test
npm run db:export:d1
npm run db:migrate:vercel -- ./d1-export.sql
npm run db:verify:vercel
npm run verify:vercel
```

Os scripts D1/Turso continuam disponíveis como recuperação técnica, mas a migração normal é feita pela interface.

## Validações desta revisão

- regressões: `129/129` passando;
- parser TypeScript: `80` arquivos TS/TSX, `0` erros sintáticos;
- validador estrutural Vercel: PASS;
- Vercel Cron: ausente;
- imports de `cloudflare:workers`/Vinext/Workerd no runtime: ausentes.

O `next build` completo deve ser executado no primeiro Preview Vercel. O ambiente usado para preparar este ZIP não conseguiu concluir acesso ao registry npm, portanto nenhum sucesso de build foi inventado.

## Documentação histórica

As especificações e relatórios das versões V39–V61.8 permanecem em `docs/`. O documento principal da migração é `MIGRACAO_VERCEL_V61_9.md`.


## THUMB + ZIP LINKS-ONLY FINAL

A V61.9 consolida THUMB e pacote final sem transporte de arquivos pelo chat. THUMB entra por `fast_push_generated_media` (HTTPS) ou `preparar_upload_midia` + PUT direto R2 + `confirmar_upload_midia`; QA usa `obter_thumbs_links`. O ZIP final usa fila idempotente `download_packages`: `gerar_pacote_final` → `listar_pacotes_prontos_para_download` → `obter_link_download_pacote` → download direto no PC → `confirmar_download_pacote`. A conclusão do projeto também enfileira o pacote automaticamente. `MCP_FILE_RESOURCE_DELIVERY` permanece estruturalmente desabilitado. Veja `IMPLEMENTACAO_THUMB_ZIP_LINKS_ONLY_V61_9.txt`.


## FIX5 — Drizzle Type Sweep

Corrige o lote de erros de type-check Drizzle revelado pelo build real da Vercel: campos QA vindos de `materialization_files`, batches heterogêneos, narrowing de SHA no FAST PUSH e batches dinâmicos do Supervisor.

## MCP público na Vercel (FIX8)
O painel da Corvo Library continua protegido pelo login interno, mas o endpoint MCP usa `Authentication = None` no ChatGPT. O endpoint é uma capability URL revogável em `/c/<codigo>/mcp` e não depende de cookie, OAuth ou Bearer. Para que o scanner do ChatGPT alcance esse endpoint, **Vercel Authentication / Deployment Protection deve estar desativado para Production**. A proteção da interface humana continua sendo feita pela própria Library.


FIX11 — RETOMADA RÁPIDA / MIGRAÇÃO LIMPA DO ACERVO
---------------------------------------------------
Quando o D1 antigo não estiver acessível administrativamente, a tela de primeiro uso aceita `corvo-library-assets.json` e restaura o catálogo no Turso sem copiar o R2. O schema atual completo é criado, defaults operacionais são semeados e os IDs/r2_key originais são preservados. Histórico experimental de filas/leases/execuções antigas não é carregado. Veja `IMPLEMENTACAO_FIX11_MIGRACAO_LIMPA_ACERVO.txt`.
