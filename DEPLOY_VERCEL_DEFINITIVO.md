# Corvo Library definitiva na Vercel

Este pacote une a aplicação V61.9/FIX14 à fotografia integral validada do D1 do Sites. O resultado usa Next.js na Vercel, Turso como SQLite persistente e o mesmo Cloudflare R2. Não há cópia dos bytes do R2 nem dependência posterior do D1.

## O que está preservado

- 47 tabelas e 39.294 registros do dump integral;
- 929 assets e seus IDs originais;
- 1.176 usos, 37 projetos e todas as entidades operacionais;
- 2.321 chaves R2 referenciadas, sem alterar nenhuma chave;
- schema, índices, triggers, migrations, inventário R2 e manifesto;
- configurações não secretas; valores sensíveis permanecem redactados.

O dump de origem contém 11.505 referências órfãs históricas. Elas são preservadas exatamente, sem reconciliação ou backfill, e assinadas em `migration/full-backup/foreign-key-baseline.json`. Depois da importação, a fiscalização de foreign keys volta a ficar ligada para gravações novas.

## 1. Preparar o Turso

Crie um banco Turso vazio e obtenha `TURSO_DATABASE_URL` e `TURSO_AUTH_TOKEN`. Não aponte o migrador para um banco em uso: ele recusa um destino não vazio que não tenha sido iniciado pelo próprio processo retomável.

Copie `.env.example` para `.env.local` e preencha pelo menos:

```dotenv
TURSO_DATABASE_URL=libsql://SEU-BANCO.turso.io
TURSO_AUTH_TOKEN=...
R2_ACCOUNT_ID=...
R2_ENDPOINT=https://SEU_ACCOUNT_ID.r2.cloudflarestorage.com
R2_BUCKET=corvoquiz-prod
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
CRON_SECRET=gere-um-valor-longo-aleatorio
DOWNLOAD_SIGNING_SECRET=gere-outro-valor-longo-aleatorio
```

O nome e os dados públicos confirmados do bucket estão em `migration/full-backup/cloudflare-config-public.json`.

Criar uma nova chave de API R2 não apaga nem recria o bucket. Gere uma chave restrita ao bucket existente, com leitura e gravação se a Library continuar materializando novos arquivos. Não altere os objetos nem os prefixos.

## 2. Restaurar e validar

Com Node.js 24:

```powershell
npm ci
npm run db:migrate:vercel
npm run db:verify:vercel
npm run verify:vercel
npm run build
```

O migrador:

- lê `migration/full-backup/database.sql`;
- grava em lotes pequenos e salva o progresso em `corvo_migration_state`;
- pode ser executado novamente após interrupção;
- preserva IDs, timestamps e `r2_key`;
- confere todas as contagens e os 929 pares `asset_id → r2_key`;
- aplica apenas as migrations Vercel 0018–0024 depois da validação integral;
- nunca se conecta ao D1 e nunca grava no R2.

Só continue se aparecerem `tables=47/47`, `records=39294/39294`, `assets=929`, `R2_MODIFIED=NO` e `D1_SOURCE_MODIFIED=NO`.

## 3. Configurar a Vercel uma única vez

Cadastre no projeto Vercel as mesmas variáveis de produção do `.env.local`: Turso, R2, `CRON_SECRET` e `DOWNLOAD_SIGNING_SECRET`. Não envie `.env.local` ao Git e não coloque tokens dentro do código.

Use o mesmo conjunto nas novas versões de produção. Deploys futuros herdam as variáveis do projeto; não é necessário configurar novamente pela tela da Library. As variáveis R2 da Vercel têm precedência sobre qualquer configuração histórica armazenada no banco.

Para Preview, prefira outro banco Turso e outro prefixo/bucket de teste. Não conecte previews descartáveis ao banco de produção.

## 4. Publicar

Importe este diretório para um repositório Git ou use a CLI da Vercel. O projeto já contém `vercel.json`, com a função do data plane e o cron autenticado por `CRON_SECRET`.

No primeiro acesso, crie o login proprietário com senha de pelo menos 12 caracteres. A criação é atômica e o login possui limitação persistente de tentativas. A conexão MCP gera um código próprio; valores redactados do backup nunca são reaproveitados como credenciais.

## Imagens e downloads

As imagens não dependem de URL pública fixa. `/api/files/[id]` consulta o registro no Turso e transmite o objeto existente do R2, com MIME inferido, ETag, cache e suporte a Range. Links temporários usam assinatura HMAC específica; o código global do MCP não é exposto em links de arquivo.

Se uma imagem não aparecer, confira nesta ordem: `R2_ACCOUNT_ID`, endpoint, nome exato do bucket, permissão da nova chave e existência da `r2_key` listada no inventário. Não renomeie objetos para “corrigir” a aplicação.

## Segurança e recuperação

- Rotas de migração integral/parcial pelo navegador retornam 410 e não apagam tabelas.
- Status de autenticação é somente leitura.
- Operações e data plane exigem autenticação de proprietário ou `CRON_SECRET`.
- O dump contém `[REDACTED_SECRET]`; redefina somente os nomes de segredo listados em `secrets-required.json`.
- Antes de qualquer mudança futura de schema, faça um backup do Turso. O D1 e o R2 originais não são mecanismo de rollback deste deploy.
