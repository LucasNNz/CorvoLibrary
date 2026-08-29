Perfeito. Abaixo está a lista **objetiva e priorizada** do que precisa ser implementado para a operação ficar **100% sem pedir permissão** e ao mesmo tempo permitir **push rápido em lote com qualidade**.

---

# OBJETIVO CENTRAL

Garantir que o fluxo inteiro funcione assim:

**coleta → push → visualização → aprovação/rejeição → continuidade**

sem nunca:

- anexar arquivo automaticamente no chat;
- entregar recurso MCP de arquivo;
- pedir autorização de materialização ao usuário.

A regra deve ser:

> **o chat opera com IDs, metadados e URLs assinadas.**
> **os arquivos ficam no R2.**

---

# PRIORIDADE 1 — MODO GLOBAL “SEM ENTREGA DE ARQUIVO AO CHAT”

## O que implementar

Uma configuração global do modo Supervisor/industrial, algo como:

- `MCP_FILE_RESOURCE_DELIVERY = DISABLED`
  ou
- `CHAT_FILE_DELIVERY_MODE = OFF`

## Efeito

Quando esse modo estiver ativo, a Biblioteca:

- **nunca** retorna arquivos físicos como recurso MCP;
- **nunca** anexa imagem ao chat;
- **nunca** usa rotas visuais que disparem materialização no chat;
- só responde com:
  - IDs
  - metadados
  - contadores
  - URLs assinadas do R2

## Por que é prioridade 1

Porque isso resolve o problema de forma estrutural, e não por memória operacional.

---

# PRIORIDADE 2 — FAST VISUAL PACKET

Hoje o maior gap funcional é a visualização **sem pedir permissão**.

## O que implementar

Uma rota nova, por exemplo:

- `obter_candidatas_qa_links`
  ou
- `fast_visual_packet`

## Entrada

- `project_id`
- `limit`
- opcional `item_ids`
- opcional `target_files`
- opcional `only_waiting_qa=true`

## Saída

Para cada candidata:

- `project_id`
- `item_id` / `pitem_id`
- `target_file`
- `candidate_id`
- `materialization_candidate_id`
- `matfile_id`
- `context`
- `semantic_reference`
- `visual_reference`
- `source`
- `host`
- `width`
- `height`
- `mime_type`
- `size_bytes`
- `technical_status`
- `signed_preview_url`
- opcional `signed_original_url`

## Regra importante

As URLs devem ser do **R2/cópia interna**, não da fonte original.

## Por que

A fonte original pode cair, expirar ou bloquear.
O QA precisa olhar o arquivo **canônico já salvo**.

## Meta de desempenho

- **10 candidatas:** < 500 ms de resposta backend
- **50 candidatas:** < 1,5 s

## Benefício

Permite “ver” lotes sem anexar nada ao chat.

---

# PRIORIDADE 3 — FAST DECIDE / APPROVE-REJECT LOTE

A aprovação e rejeição atuais funcionam, mas estão lentas.

## O que implementar

Uma rota única e curta, por exemplo:

- `decidir_candidatas_lote`
  ou
- `fast_decidir_candidatas_lote`

## Entrada

- `project_id`
- lista de decisões:
  - `candidate_id` ou `item_id` ou `target_file`
  - `action = APPROVE | REJECT | RELINK`
  - `reason` opcional

## Exemplo conceitual

- aprovar 20 itens
- rejeitar 15 itens
- marcar 3 como relink

tudo em uma única chamada.

## Comportamento correto

### Se `APPROVE`

- vincula asset/frozen\_asset\_id
- resolve o PITEM
- atualiza contadores do projeto
- deduplica asset quando aplicável

### Se `REJECT`

- marca candidata como rejeitada
- tenta próxima candidata elegível do item
- se não houver próxima → `RELINK_REQUIRED`

### Se `RELINK`

- fecha a candidata atual
- move item para relink

## Resposta ideal

Resposta curta:

- `operation_id`
- `accepted_count`
- `approved_count`
- `rejected_count`
- `relink_count`
- `failed_count`
- `project_version`
- `updated_counts`

**Sem** retornar pacotes enormes.

## Processamento ideal

### ACK rápido + persistência interna

O ideal é:

1. validar lote;
2. persistir decisão essencial;
3. retornar ACK;
4. fan-out/reconciliação interna continuar depois.

## Meta de desempenho

- **20 decisões:** < 2 s
- **50 decisões:** < 5 s

---

# PRIORIDADE 4 — REJEIÇÃO RÁPIDA EM LOTE POR ITEM OU TARGET\_FILE

Operacionalmente, rejeição precisa ser muito simples.

## O que implementar

Aliases claros sobre a rota central:

- `rejeitar_candidatas_lote`
- `rejeitar_itens_lote`

## Entrada

- `project_id`
- `candidate_ids[]`
  ou
- `item_ids[]`
  ou
- `target_files[]`
- `reason`

## Por que isso é importante

Porque no uso real eu muitas vezes quero dizer:

> rejeite rapidamente esses 17 target\_files

sem precisar descobrir todos os candidate\_ids antes.

## Observação

Isso não precisa ser hard delete.
O padrão deve ser **rejeição lógica**, não exclusão permanente.

---

# PRIORIDADE 5 — APROVAÇÃO RÁPIDA EM LOTE POR TARGET\_FILE / ITEM\_ID

Mesma ideia da rejeição.

## O que implementar

Aliases como:

- `aprovar_itens_lote`
- `aprovar_target_files_lote`

## Regra segura

- se houver **uma única candidata elegível** no item → aprova;
- se houver **mais de uma candidata elegível** → retorna:
  - `AMBIGUOUS_REQUIRES_CANDIDATE_ID`

Isso mantém velocidade sem risco de aprovar várias opções erradas.

---

# PRIORIDADE 6 — WORK PACKET LITE

Hoje o work packet já é útil, mas ainda pode ficar mais enxuto.

## O que implementar

Uma versão leve:

- `obter_work_packet_lite`

## Saída

Só o essencial:

- contadores
- próximos itens
- item\_id / target\_file
- status
- referência semântica
- contexto
- prioridade
- se há candidata pronta
- candidate\_id / matfile\_id / preview\_url quando existir

## Meta

Ser o payload padrão para operação contínua.

## Benefício

Permite navegar o trabalho sem chamar QA visual pesado.

---

# PRIORIDADE 7 — CANDIDATE BUFFER POR PITEM

Para manter qualidade em lote sem travar fluxo, cada PITEM precisa poder ter várias opções.

## O que implementar / reforçar

No FAST PUSH, permitir:

- várias candidatas por item;
- status inicial `PENDING_ANALYSIS` ou `READY_FOR_VISUAL_QA`;
- histórico por item.

## Ideal

Cada item poder receber rapidamente:

- 2 a 5 candidatas fortes

e depois o QA escolhe.

## Benefício

Aumenta qualidade sem exigir perfeição na borda.

---

# PRIORIDADE 8 — FAST PUSH URL LOTE COMO ROTA PRINCIPAL

Essa já está próxima do ideal, então é mais consolidação do que invenção.

## O que consolidar

A rota principal de ingestão deve ser:

- `materializar_urls_lote`
  ou
- `fast_push_urls_lote`

## Entrada

Para cada item:

- `project_id`
- `item_id` ou `target_file`
- `source_url`
- `semantic_reference`
- `visual_reference`
- `universe`
- tags

## Comportamento

- baixa direto no servidor
- salva no R2
- cria candidata do PITEM
- não entrega arquivo ao chat
- não pede autorização

## Meta

Essa deve ser a rota padrão da industrialização.

---

# PRIORIDADE 9 — VISUALIZAÇÃO POR GRID / CONTACT SHEET OPCIONAL

Isso pode ajudar muito a qualidade de lote.

## O que implementar

Uma rota opcional:

- `gerar_grid_candidatas`
  ou
- `obter_contact_sheet_lote`

## Como funciona

O backend monta internamente uma imagem-grid com 9, 12, 20 candidatas e devolve:

- apenas a **URL assinada da grid**
- mais o mapeamento posição → candidate\_id

## Exemplo

- grid 4x5
- posição 01 = candidate\_id A
- posição 02 = candidate\_id B

## Benefício

Permite QA muito mais rápido em lote.

## Importante

Mesmo aqui:

- **não anexar grid ao chat como arquivo MCP**
- devolver só URL assinada

---

# PRIORIDADE 10 — EXPORTAÇÃO DE LINKS, NÃO DE ARQUIVOS, PARA QA

## O que implementar

Uma rota como:

- `exportar_pacote_qa_json`

## Conteúdo

JSON com:

- lista de candidatas
- preview\_url
- original\_r2\_url
- referência
- contexto
- target\_file
- candidate\_id
- status

## Benefício

Se um agente externo, painel web ou operador humano quiser decidir,
já recebe tudo sem envolver chat file delivery.

---

# PRIORIDADE 11 — MODO DE DECISÃO ASSÍNCRONA

Muito importante para velocidade percebida.

## O que implementar

Nas rotas de approve/reject:

- `async=true`

## Comportamento

A resposta volta imediatamente com:

- `operation_id`
- `queued=true`

Depois consultamos:

- `obter_resultado_operacao(operation_id)`

## Por que

Hoje a lentidão maior está em esperar toda a mutação síncrona.
Com async, o chat não fica bloqueado.

---

# PRIORIDADE 12 — SEPARAR CLARAMENTE 3 CAMADAS

Isso evita confusão operacional.

## Camada A — Candidata do projeto

- aprovar/rejeitar aqui é o fluxo normal

## Camada B — Materialização interna

- byte no R2, MATFILE, MATCAND
- não deve vazar para o chat

## Camada C — Asset catalogado

- só entra quando aprovado/congelado

## Por que isso importa

Porque “excluir”, “rejeitar”, “aprovar” e “ver” ficam previsíveis.

---

# PRIORIDADE 13 — BANIR ROTAS QUE ENTREGAM RECURSOS MCP NO MODO ESCALA

## Rotas que devem ser evitadas nesse modo

- `obter_candidatas_qa_visual`
- `obter_assets_para_qa_lote`
- `obter_pendentes_para_qa_catalogo`

## Regra

No modo industrial, essas rotas:

- ou ficam bloqueadas;
- ou redirecionam internamente para versão `LINKS_ONLY`.

---

# PRIORIDADE 14 — RELINK EM LOTE RÁPIDO

Quando um lote estiver semanticamente ruim, precisa relinkar sem fricção.

## O que implementar

- `relink_itens_lote`

## Entrada

- `project_id`
- `item_ids[]` ou `target_files[]`
- `reason`
- opcional:
  - `new_semantic_reference`
  - `new_query_seed`
  - `preferred_sources`

## Benefício

Fecha rapidamente gaps sem insistir em imagem ruim.

---

# PRIORIDADE 15 — RESUMO OPERACIONAL ULTRA ENXUTO

## O que implementar

- `obter_resumo_operacional_curto`

## Saída

- total
- approved
- waiting\_qa
- relink
- collecting
- failed
- last\_operation\_ms
- next\_recommended\_action

## Benefício

Evita payload grande para acompanhar progresso.

---

# PRIORIZAÇÃO FINAL

## Implementar primeiro

### 1. Modo global sem entrega de arquivo ao chat

Essencial e estrutural.

### 2. `fast_visual_packet`

Maior gap funcional real.

### 3. `fast_decidir_candidatas_lote`

Maior gargalo de desempenho real.

### 4. aliases rápidos:

- `aprovar_itens_lote`
- `rejeitar_itens_lote`

### 5. `work_packet_lite`

---

# FLUXO IDEAL DEPOIS DISSO

## Coleta

`fast_push_urls_lote`

## Visão

`fast_visual_packet`

## Decisão

`fast_decidir_candidatas_lote`

## Acompanhamento

`obter_resultado_operacao`
ou
`obter_resumo_operacional_curto`

---

# RESULTADO ESPERADO

Depois dessas implementações, o pipeline fica assim:

- **sem pedir permissão**
- sem anexar arquivo no chat
- com QA em lote
- com visualização real por URL
- com aprovação/rejeição rápida
- mantendo qualidade via múltiplas candidatas por item

---

Se você quiser, no próximo passo eu posso transformar isso em um **TXT de especificação pronto para implementar**, no mesmo estilo dos documentos anteriores, com:

- nome das rotas,
- payload sugerido,
- comportamento,
- regras de segurança,
- metas de performance.