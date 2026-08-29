# V61.9 — Configuração herdada e persistente

A V61.9 não exige que o operador copie manualmente as configurações antigas quando os dados puderem ser herdados.

## Referência interna

O aplicativo mantém uma referência não secreta em `lib/legacy-config-reference.ts` para identificar a origem da migração e o perfil lógico usado no banco.

- aplicação de origem: Corvo Library publicada no ChatGPT Sites;
- chave histórica do perfil Cloudflare: `secret_cloudflare_connection`;
- manifesto recuperável: `cloudflare_connection_manifest_v1`;
- bucket conhecido: `corvo-library`.

Nenhuma Secret Access Key, API Token ou chave de criptografia é escrita nesse documento.

## Migração D1 → Turso

A tabela `settings` do D1 é importada inteira. O valor criptografado de `secret_cloudflare_connection` é preservado byte a byte.

Se a configuração puder ser descriptografada, a V61.9 passa a utilizá-la automaticamente e cria/atualiza o manifesto não secreto com os campos recuperáveis.

Se a configuração antiga estiver bloqueada por uma chave de criptografia indisponível, ela não é apagada. A tela usa o manifesto/referência para pré-preencher o que estiver disponível e solicita somente o segredo/token faltante.

## Atualizações futuras

A aba Configurações grava sempre no mesmo perfil persistente. Salvar uma nova conexão:

1. valida a conexão;
2. sobrescreve `secret_cloudflare_connection` com o novo valor criptografado;
3. sobrescreve `cloudflare_connection_manifest_v1` com os metadados recuperáveis;
4. passa a valer para qualquer computador que use a mesma Library.

Não é necessário editar `.env`, TXT ou código para trocar Cloudflare/R2/D1 depois que o app estiver conectado ao Turso.
