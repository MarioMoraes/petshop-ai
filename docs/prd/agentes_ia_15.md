# PRD Detalhado — Agentes de IA

**Módulo:** MOD-AI
**Arquivo:** 15/15
**Prioridade:** P2
**Fase de Implementação:** Fase 8 — Agentes de IA
**Serviço Backend:** nenhum serviço novo. `backend/app/src/modules/agent` (módulo do backend único)
**Tabelas Principais:** `agent_conversations`, `agent_turns`, `agent_tool_calls`, `agent_settings` (novas). `messages` (alterada: o `INBOUND` que nunca foi escrito)
**Data:** 2026-09-09
**Status:** Draft

---

## 1. Visão Geral

**Contexto de negócio.** A recepção de um petshop gasta a manhã respondendo três perguntas:
*que horas é o banho do Thor*, *quanto eu devo* e *dá pra remarcar pra quinta*. As três têm
resposta exata no sistema, e nenhuma exige julgamento. Este módulo põe um agente no WhatsApp
para respondê-las — e para marcar, cancelar e remarcar quando o tutor confirmar.

**Ele é o último dos quinze, e o único cuja fundação já estava pronta antes de começar.**
O §292 do SPEC dizia que manter a regra de negócio nos serviços de domínio — e não nos BFFs —
permitiria a um orquestrador de agentes reutilizar exatamente as mesmas validações que o
Admin e o Portal usam. A fatia 11 da consolidação provou isso na prática: as cinco portas do
MOD-PORTAL chamam `createBooking`, `cancel`, `reschedule`, `getStatement` e `enqueueMessage`
por função, com os mesmos schemas Zod das rotas, e nenhuma regra foi reescrita. **As tools
deste módulo são a sexta porta**, com o mesmo desenho.

O que **já está no ar** e que este PRD **não** reespecifica:

| O que | Onde | Desde |
|---|---|---|
| Canal WhatsApp por tenant, com pareamento e estado de conexão | `modules/messaging/whatsapp.ts` | MOD-CRM-01 |
| Envio pelo motor, com fila, cascata de canal e teto de vazão | `modules/messaging/dispatch.ts` | MOD-NOTIF |
| Consentimento por canal e finalidade, append-only | `modules/consents` | MOD-TUTOR-04 |
| Janela de silêncio e teto diário de marketing | `modules/messaging/window.ts`, `frequency.ts` | MOD-CRM |
| Resolução telefone → tutor, com hash de busca | `CACHE_KEYS.phone`, `modules/tutors` | MOD-TUTOR |
| Disponibilidade, gates e criação de agendamento | `modules/scheduling` | MOD-AGENDA |
| Saldo, extrato e recibo | `modules/ledger` | MOD-LEDGER |
| Alertas do pet (alergia, temperamento) | `modules/records` | MOD-PRONT |
| Trilha de auditoria em toda escrita, com ator | `packages/service-kit/src/audit.ts` | MOD-IDENT-09 |

**As três descobertas que dão a forma do módulo.**

A primeira, e a que muda o tamanho da fase: **o produto não sabe receber mensagem.**
`MessageDirection` declara `INBOUND` desde o MOD-NOTIF, `modules/messaging/queries.ts` o
tipa e `modules/portal/messages.ts` comenta que ele é "a resposta que o próprio tutor
mandou" — e **nenhuma linha do sistema escreve uma**. O webhook da Evolution
(`/internal/v1/whatsapp/webhook`) trata dois grupos de evento, `QRCODE_*` e `CONNECTION_*`, e
descarta o resto. Não há inbox, não há conversa, não há resposta. Metade deste módulo é
construir a porta de entrada que o canal nunca teve.

A segunda: **as tools não precisam ser escritas, precisam ser escolhidas.** Toda função que
o agente chamaria já existe, já valida, já publica evento e já grava trilha. O trabalho é o
recorte — quais delas ele alcança, com que ator, e o que acontece quando ele erra. É o mesmo
exercício da `tutor-port.ts` do Portal, e o comentário de lá vale inteiro aqui: a elevação
de permissão é real, e o que a contém é o `tutorId` vir da sessão e nunca do corpo.

A terceira: **o agente herda um problema que o Portal já resolveu.** O papel `TUTOR` tem
nove permissões `_own`; o agente age em nome de um tutor que se identificou pelo telefone,
que é uma prova bem mais fraca que um login no Clerk. O desenho abaixo trata o telefone
como identificação e **não** como autenticação — e é por isso que saldo e extrato saem em
faixas, não em valor exato, até haver sessão no Portal.

**Escopo desta fase.** Entra o **agente de atendimento no WhatsApp**: lê agenda, pets,
próximo horário e situação financeira; marca, cancela e remarca mediante confirmação
explícita; e passa a conversa para a recepção nos três gatilhos do §7. **Não** entram os
outros dois agentes previstos no PRD §7.14 — a triagem clínica (que escreve prontuário, e
prontuário escrito por modelo é outra conversa) e o de relacionamento (que dispara campanha,
e o MOD-CRM já tem o motor e o teto).

---

## 2. Sub-Features

| ID | Nome | Descrição | Must/Should/Nice |
|---|---|---|---|
| MOD-AI-01 | Recepção de Mensagem | O webhook da Evolution passa a tratar mensagem recebida, gravando `INBOUND` e resolvendo o tutor pelo telefone | Must Have |
| MOD-AI-02 | Conversa e Contexto | Sessão por tutor com histórico, expiração por inatividade e cache de prefixo | Must Have |
| MOD-AI-03 | Tools de Leitura | Sete funções que o agente consulta livremente, todas no escopo do tutor | Must Have |
| MOD-AI-04 | Tools de Escrita com Confirmação | Marcar, cancelar e remarcar em duas etapas: proposta e confirmação | Must Have |
| MOD-AI-05 | Handoff para Humano | Três gatilhos que tiram o agente da conversa e enfileiram para a recepção | Must Have |
| MOD-AI-06 | Fila de Atendimento | A tela onde a recepção vê as conversas em espera, com o histórico anexado | Must Have |
| MOD-AI-07 | Configuração por Tenant | Ligar/desligar, horário de operação do agente e teto de gasto mensal | Must Have |
| MOD-AI-08 | Guardas de Custo | Teto por conversa e por tenant, com degradação para handoff em vez de silêncio | Should Have |
| MOD-AI-09 | Painel de Qualidade | Taxa de resolução, handoff por motivo e custo por conversa | Should Have |

---

## 3. Critérios de Aceite

### [MOD-AI-01] — Recepção de Mensagem

**AC-01 (Happy Path)**
- **Dado** um tenant com WhatsApp conectado e o agente ligado
- **Quando** a Evolution entrega `MESSAGES_UPSERT` com uma mensagem de texto de um número
  que casa com `tutors.phone_hash`
- **Então** nasce uma linha em `messages` com `direction = 'INBOUND'`, `channel = 'WHATSAPP'`
  e `tutor_id` resolvido; a conversa é criada ou reaproveitada; e o turno entra na fila do
  agente

**AC-02 (Validação / Erro — número desconhecido)**
- **Dado** uma mensagem de um número sem ficha neste tenant
- **Quando** ela chega
- **Então** a linha `INBOUND` é gravada com `tutor_id = NULL`, **o agente não responde**, e a
  conversa entra direto na fila da recepção. Quem não é cliente não é atendido por robô que
  fala do sistema — e um "não te encontrei" já diria que o número não está na base

**AC-03 (Edge Case — o mesmo telefone em duas fichas)**
- **Dado** dois tutores com o mesmo telefone (marido e esposa, caso que o MOD-TUTOR permite)
- **Quando** a mensagem chega
- **Então** o agente **não** escolhe: a conversa vai para a recepção com as duas fichas
  anexadas. É a mesma decisão do AC-06 de MOD-PORTAL-01, pela mesma razão — escolher uma
  daria a um deles o extrato do outro

**AC-04 (Edge Case — reentrega)**
- **Dado** que a Evolution reentrega o mesmo `providerMessageId`
- **Quando** o webhook processa
- **Então** o índice único sobre `(tenant_id, provider_message_id)` barra a duplicata, o
  handler responde 200, e o agente não é acionado duas vezes

**AC-05 (Mídia)**
- **Dado** uma mensagem que é áudio, imagem ou documento
- **Quando** ela chega
- **Então** a linha `INBOUND` guarda o tipo e **não** o conteúdo, o agente responde uma vez
  dizendo que não entende aquele formato, e a conversa vai para a recepção. Transcrição de
  áudio fica para a triagem clínica, que é outro agente

**AC-06 (Consentimento)**
- **Dado** um tutor que revogou o consentimento de WhatsApp
- **Quando** ele **manda** uma mensagem
- **Então** o agente responde. Revogar opt-in impede o petshop de **iniciar** contato; não
  impede o cliente de falar e ser respondido — tratar o contrário seria ignorar um cliente
  que está tentando falar com o estabelecimento

### [MOD-AI-02] — Conversa e Contexto

**AC-01 (Happy Path)**
- **Dado** um tutor com conversa aberta
- **Quando** manda a segunda mensagem
- **Então** o turno entra na mesma `agent_conversation`, e o histórico anterior vai na
  requisição ao modelo

**AC-02 (Expiração)**
- **Dado** uma conversa sem mensagem há mais de `AGENT_SESSION_TTL_MIN` (padrão 120 minutos)
- **Quando** o tutor volta a escrever
- **Então** nasce uma conversa nova. A anterior fica `CLOSED` — duas horas depois, "sim"
  não se refere mais a coisa nenhuma

**AC-03 (Edge Case — a conversa que cresce demais)**
- **Dado** uma conversa que passou de `AGENT_MAX_TURNS` (padrão 20)
- **Quando** o tutor manda o turno seguinte
- **Então** ela vai para handoff com motivo `TOO_LONG`. Vinte turnos sem resolver é o
  próprio sinal de que o agente não vai resolver

**AC-04 (Cache de prefixo)**
- **Dado** o prompt de sistema, a definição das tools e o contexto do tenant
- **Quando** o segundo turno da mesma conversa é enviado
- **Então** `usage.cache_read_input_tokens` é maior que zero. **A ordem de renderização é
  `tools` → `system` → `messages`**, e o que varia por turno (a mensagem do tutor, o
  horário) fica depois do último `cache_control` — nada de `new Date()` no prompt de sistema

### [MOD-AI-03] — Tools de Leitura

**AC-01 (Happy Path)**
- **Dado** um tutor identificado
- **Quando** pergunta "que horas é o banho do Thor?"
- **Então** o agente chama `listarProximosAgendamentos`, recebe a lista já recortada ao
  `tutorId` da conversa, e responde com data, hora, serviço e profissional

**AC-02 (Escopo)**
- **Dado** um tutor
- **Quando** o modelo tenta chamar uma tool com um `petId` que não é dele
- **Então** a tool devolve "não encontrado" — porque a implementação **ignora qualquer id de
  tutor vindo dos argumentos** e usa o da conversa, exatamente como `requireOwnScope` faz no
  Portal. Um argumento de escopo que o modelo pudesse preencher seria a falha inteira do
  módulo

**AC-03 (Edge Case — o que o saldo mostra)**
- **Dado** um tutor com débito de R$ 340,00
- **Quando** pergunta "quanto eu devo?"
- **Então** o agente responde a **faixa** ("há valores em aberto na sua conta") e oferece o
  link do Portal para ver o extrato. **O telefone identifica, não autentica**: um número
  clonado não pode render o valor exato da dívida de alguém

**AC-04 (Alerta clínico)**
- **Dado** um pet com alergia registrada
- **Quando** o agente lista os pets
- **Então** a alergia **não** aparece. Dado de saúde não sai por um canal cuja prova de
  identidade é o número de telefone

**AC-05 (Edge Case — a tool que falha)**
- **Dado** que o banco está indisponível
- **Quando** a tool é chamada
- **Então** ela devolve `tool_result` com `is_error: true` e uma frase legível; o agente diz
  que não conseguiu consultar agora e a conversa vai para handoff. **A tool nunca inventa
  resposta** — e o `tool_result` de erro é devolvido, nunca omitido

### [MOD-AI-04] — Tools de Escrita com Confirmação

**AC-01 (Happy Path)**
- **Dado** um tutor que pediu "dá pra remarcar o banho do Thor pra quinta de manhã?"
- **Quando** o agente consulta a disponibilidade e propõe "quinta, 22/09, às 09:00 com a
  Ana — confirma?"
- **Então** nenhuma escrita acontece ainda: a proposta é gravada em `agent_tool_calls` com
  `status = PROPOSED` e um `confirmation_token`

**AC-02 (Confirmação)**
- **Dado** uma proposta `PROPOSED` no turno anterior
- **Quando** o tutor responde afirmativamente
- **Então** o agente chama `confirmarProposta` com o token, a escrita acontece pela mesma
  função que o Portal usa, e a resposta traz o agendamento criado

**AC-03 (Validação / Erro — a proposta que envelheceu)**
- **Dado** uma proposta com mais de `AGENT_PROPOSAL_TTL_MIN` (padrão 15 minutos)
- **Quando** o tutor confirma
- **Então** a confirmação é recusada, o agente refaz a consulta de disponibilidade e propõe
  de novo. **O horário pode ter sido tomado no meio** — confirmar sobre uma proposta velha
  criaria conflito que o gate do MOD-AGENDA recusaria, com uma mensagem que o tutor não
  entenderia

**AC-04 (Edge Case — uma proposta viva por conversa)**
- **Dado** uma proposta `PROPOSED`
- **Quando** o tutor pede outra coisa antes de confirmar
- **Então** a anterior vai a `SUPERSEDED`. "Sim" precisa ter um antecedente só

**AC-05 (Edge Case — o gate que recusa depois da confirmação)**
- **Dado** um tutor inadimplente e um tenant com bloqueio por crédito ligado
- **Quando** ele confirma o agendamento
- **Então** `createBooking` recusa com `ERR_AGENDA_007`, o agente **não** insiste nem
  contorna, responde em linguagem de cliente e vai para handoff. `canOverrideCredit` é
  **sempre falso** para o agente, como é para o Portal — o devedor não libera a própria
  exceção, e o robô tampouco

**AC-06 (O que o agente nunca escreve)**
- **Dado** qualquer conversa
- **Quando** o modelo tenta qualquer coisa fora das três escritas nomeadas
- **Então** não há tool para isso. Não existe tool de lançamento financeiro, de registro
  clínico, de alteração de ficha nem de envio de campanha — **a lista de tools é a fronteira
  do que o agente pode fazer**, e ela é curta de propósito

**AC-07 (Trilha)**
- **Dado** uma escrita confirmada
- **Quando** ela acontece
- **Então** a linha de `audit_logs` traz `actor_user_id` do tutor e, no `after`, a
  `conversation_id` e o `turn`. Meses depois, "quem marcou isso" tem resposta que inclui a
  conversa inteira

### [MOD-AI-05] — Handoff para Humano

**AC-01 (Pedido explícito)**
- **Dado** uma conversa ativa
- **Quando** o tutor escreve algo como "quero falar com alguém"
- **Então** a conversa vai a `HANDOFF` com motivo `REQUESTED`, o agente confirma em uma
  frase, e a fila da recepção recebe

**AC-02 (Sentimento)**
- **Dado** um turno cuja classificação de sentimento é negativa
- **Então** handoff com motivo `SENTIMENT`. **A classificação sai da mesma chamada** que
  gera a resposta, como campo de saída estruturada — uma segunda chamada ao modelo por turno
  dobraria o custo do módulo para medir irritação

**AC-03 (Impasse)**
- **Dado** três turnos seguidos sem que nenhuma tool tenha sido chamada com sucesso
- **Então** handoff com motivo `UNRESOLVED`

**AC-04 (Fora do horário)**
- **Dado** um handoff disparado às 23h, com o agente configurado até as 19h
- **Então** o tutor recebe a mensagem de que a recepção retorna no próximo horário
  comercial, e a conversa entra na fila com a marca de fora de expediente

**AC-05 (Edge Case — o handoff não pode ser um beco)**
- **Dado** uma conversa em `HANDOFF`
- **Quando** o tutor manda mais mensagens
- **Então** elas são gravadas e anexadas à conversa, **e o agente não volta a responder**.
  Um agente que retoma depois do handoff desfaz a promessa que acabou de fazer

### [MOD-AI-06] — Fila de Atendimento

**AC-01 (Happy Path)**
- **Dado** conversas em `HANDOFF`
- **Quando** a recepção abre `GET /v1/agent/conversations?status=HANDOFF`
- **Então** vê a lista com tutor, motivo, tempo de espera e a última mensagem

**AC-02 (Assumir)**
- **Dado** uma conversa na fila
- **Quando** alguém a assume
- **Então** ela vai a `ASSIGNED` com `assigned_to`, e some da fila dos outros. Duas pessoas
  respondendo o mesmo cliente é pior que ninguém responder

**AC-03 (Responder)**
- **Dado** uma conversa `ASSIGNED`
- **Quando** a recepção responde pela tela
- **Então** a mensagem sai pelo motor do MOD-NOTIF, como `OUTBOUND` com
  `origin_type = 'AGENT_HANDOFF'`, e entra no mesmo histórico

**AC-04 (Edge Case — sino)**
- **Dado** conversas em `HANDOFF` há mais de `AGENT_SLA_MIN` (padrão 10 minutos)
- **Então** o contador entra no sino de pendências da topbar, ao lado dos que já existem

### [MOD-AI-07] — Configuração por Tenant

**AC-01 (Happy Path)**
- **Dado** um `TENANT_ADMIN`
- **Quando** salva a configuração com `enabled`, janela de horário e teto mensal
- **Então** vale a partir da próxima mensagem recebida

**AC-02 (Desligado)**
- **Dado** o agente desligado
- **Quando** uma mensagem chega
- **Então** ela é gravada como `INBOUND` e a conversa vai direto para a fila da recepção. **O
  inbox continua funcionando** — receber mensagem é do canal, responder com modelo é do
  agente

**AC-03 (Fora da janela)**
- **Dado** uma mensagem às 22h com o agente configurado das 8h às 19h
- **Então** o tutor recebe uma resposta automática de horário e a conversa entra na fila.
  Sem chamada ao modelo

### [MOD-AI-08] — Guardas de Custo

**AC-01 (Teto por conversa)**
- **Dado** uma conversa que passou de `AGENT_MAX_COST_CENTS_PER_CONVERSATION`
- **Então** handoff com motivo `BUDGET`. O tutor não vê diferença; a recepção assume

**AC-02 (Teto por tenant)**
- **Dado** um tenant que atingiu o teto mensal
- **Então** o agente para de responder até a virada do mês, todas as conversas vão para a
  fila, e o `TENANT_ADMIN` é avisado **antes**, aos 80%

**AC-03 (Edge Case — degradar, nunca silenciar)**
- **Dado** qualquer teto atingido
- **Então** o caminho é sempre handoff, nunca ignorar a mensagem. Um cliente sem resposta é
  pior que um cliente atendido por gente

### [MOD-AI-09] — Painel de Qualidade

**AC-01 (Happy Path)**
- **Dado** conversas encerradas
- **Quando** o `TENANT_ADMIN` abre o painel
- **Então** vê taxa de resolução sem handoff, handoff por motivo, tempo médio de resposta e
  custo por conversa, no período

**AC-02 (Edge Case — a métrica que importa)**
- **Então** a taxa de resolução conta como resolvida a conversa que **terminou sem
  handoff**, e não a que o modelo achou que resolveu. A avaliação é do desfecho observável

---

## 4. Modelo de Dados

### Tabelas Envolvidas

| Tabela | Campo | Tipo | Obrigatório | Descrição |
|---|---|---|---|---|
| `agent_conversations` | `tenant_id` | `String @db.Uuid` | ✓ | Isolamento multi-tenant (RLS) |
| `agent_conversations` | `id` | `String @db.Uuid` | ✓ | PK |
| `agent_conversations` | `tutor_id` | `String? @db.Uuid` | — | Nulo é número não reconhecido — vai direto para a fila |
| `agent_conversations` | `channel` | `MessageChannel` | ✓ | Hoje só `WHATSAPP` |
| `agent_conversations` | `status` | `AgentConversationStatus` | ✓ | `ACTIVE` / `HANDOFF` / `ASSIGNED` / `CLOSED` |
| `agent_conversations` | `handoff_reason` | `AgentHandoffReason?` | — | `REQUESTED` / `SENTIMENT` / `UNRESOLVED` / `TOO_LONG` / `BUDGET` / `ERROR` |
| `agent_conversations` | `assigned_to` | `String? @db.Uuid` | — | Quem da equipe assumiu |
| `agent_conversations` | `cost_cents` | `Int` | ✓ | Acumulado, para o teto do MOD-AI-08 |
| `agent_conversations` | `last_turn_at` | `DateTime` | ✓ | Base da expiração |
| `agent_turns` | `conversation_id`, `role`, `message_id` | — | ✓ | Um turno por mensagem; `message_id` liga à linha de `messages` |
| `agent_turns` | `content_encrypted` | `String` | ✓ | **Cifrado** — o corpo da conversa |
| `agent_turns` | `input_tokens`, `output_tokens`, `cache_read_tokens` | `Int` | ✓ | De `response.usage`, para o custo real |
| `agent_turns` | `sentiment` | `AgentSentiment?` | — | Saída estruturada do mesmo turno |
| `agent_tool_calls` | `turn_id`, `tool`, `arguments`, `result_summary` | — | ✓ | O que o agente fez, e com que argumentos |
| `agent_tool_calls` | `status` | `AgentToolCallStatus` | ✓ | `EXECUTED` / `PROPOSED` / `CONFIRMED` / `SUPERSEDED` / `EXPIRED` / `FAILED` |
| `agent_tool_calls` | `confirmation_token` | `String?` | — | Só nas propostas |
| `agent_settings` | `tenant_id` | `String @db.Uuid` | ✓ | PK, 1:1 com o tenant |
| `agent_settings` | `enabled`, `opens_at`, `closes_at`, `monthly_cap_cents` | — | ✓ | |
| `messages` | `provider_message_id` | `String?` | — | **Campo novo.** Idempotência da reentrega |

### Campos com Criptografia AES-256-GCM (em repouso)

| Campo | Tabela | Justificativa LGPD/PCI |
|---|---|---|
| `agent_turns.content_encrypted` | `agent_turns` | É a conversa do cliente com o estabelecimento. Pode conter qualquer coisa que ele resolva escrever — inclusive o que o produto cifra em toda outra tabela |
| `agent_tool_calls.arguments` | `agent_tool_calls` | Carrega nome de pet, data e valor: os mesmos dados das tabelas de origem, e sem motivo para estarem em claro aqui |

### Índices Necessários

```sql
CREATE INDEX idx_agent_conv_tenant_status ON agent_conversations(tenant_id, status);
-- A fila da recepção, ordenada por espera.
CREATE INDEX idx_agent_conv_fila ON agent_conversations(tenant_id, last_turn_at)
  WHERE status = 'HANDOFF';
-- "Existe conversa viva deste tutor?" — uma vez por mensagem recebida.
CREATE INDEX idx_agent_conv_tutor_viva ON agent_conversations(tenant_id, tutor_id, last_turn_at)
  WHERE status IN ('ACTIVE', 'HANDOFF', 'ASSIGNED');

CREATE INDEX idx_agent_turns_conv ON agent_turns(conversation_id, created_at);
CREATE UNIQUE INDEX idx_agent_proposta_viva ON agent_tool_calls(conversation_id)
  WHERE status = 'PROPOSED';

-- AC-04 de MOD-AI-01: a reentrega da Evolution.
CREATE UNIQUE INDEX idx_messages_provider ON messages(tenant_id, provider_message_id)
  WHERE provider_message_id IS NOT NULL;
```

**O índice único parcial sobre `PROPOSED` é o que implementa o AC-04 de MOD-AI-04 no banco**,
e não só no código: uma proposta viva por conversa, garantido pela constraint.

---

## 5. Contratos de API

O agente **não tem superfície pública**: quem o aciona é o webhook da Evolution, que já
existe sob `/internal/` e se autentica com o token da instância. As rotas abaixo são da
**equipe**, no Admin.

### Endpoints

| Método | Path | Permissão | Descrição |
|---|---|---|---|
| GET | `/v1/agent/conversations` | `crm:read` | Fila e histórico, com filtro por status |
| GET | `/v1/agent/conversations/:id` | `crm:read` | A conversa inteira, com tools e propostas |
| POST | `/v1/agent/conversations/:id/assign` | `crm:manage` | Assume |
| POST | `/v1/agent/conversations/:id/reply` | `crm:send` | Responde pela tela |
| POST | `/v1/agent/conversations/:id/close` | `crm:manage` | Encerra |
| GET | `/v1/agent/settings` | `crm:read` | Configuração |
| PATCH | `/v1/agent/settings` | `crm:configure` | Liga, desliga, janela e teto |
| GET | `/v1/agent/stats` | `crm:read` | O painel do MOD-AI-09 |

### As Tools

**Leitura (sete, sempre disponíveis):**

| Tool | Função de domínio | Módulo |
|---|---|---|
| `listarMeusPets` | `listOwnPets` | `modules/portal/pets.ts` |
| `listarProximosAgendamentos` | `listOwnAppointments` | `modules/portal/appointments.ts` |
| `consultarDisponibilidade` | `resolveAvailability` | `modules/scheduling/availability.ts` |
| `listarServicos` | `listBookableServices` | `modules/portal/booking.ts` |
| `situacaoFinanceira` | `readOwnFinance` (**em faixa**) | `modules/portal/finance.ts` |
| `horarioDoEstabelecimento` | `readPortalTenant` | `modules/portal/me.ts` |
| `statusDoTaxi` | `readTaxiOffer` | `modules/portal/taxi.ts` |

**Escrita (três, sempre em duas etapas):** `proporAgendamento`, `proporCancelamento`,
`proporRemarcacao` — e a quarta, `confirmarProposta`, que é a única que escreve, chamando
`createBooking`, `cancel` ou `reschedule` com `canOverrideCredit: false`.

**Sete das dez reusam funções que o MOD-PORTAL já chama por porta.** Não é economia de
código: é a garantia de que o agente e a tela do tutor respondem a mesma coisa. Duas
implementações da mesma pergunta divergem no dia em que uma das duas mudar.

### Schema Zod — pacote `@petshop/shared-types`

```typescript
import { z } from 'zod'

/**
 * Nenhuma tool recebe `tutorId`, e a ausência é a decisão de segurança do módulo.
 * O escopo vem da conversa, como no `requireOwnScope` do Portal — um argumento que o
 * modelo pudesse preencher seria a falha inteira.
 */
export const ConsultarDisponibilidadeArgsSchema = z.strictObject({
  petId: z.uuid(),
  serviceIds: z.array(z.uuid()).min(1).max(10),
  /** Dia civil no fuso do tenant, resolvido pelo agente a partir de "quinta". */
  from: z.iso.date(),
  to: z.iso.date(),
})

export const ProporAgendamentoArgsSchema = z.strictObject({
  petId: z.uuid(),
  serviceIds: z.array(z.uuid()).min(1).max(10),
  professionalId: z.uuid(),
  startsAt: z.iso.datetime(),
})

export const ConfirmarPropostaArgsSchema = z.strictObject({
  confirmationToken: z.string().min(20).max(64),
})

export const AgentSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  opensAt: z.string().regex(/^\d{2}:\d{2}$/).default('08:00'),
  closesAt: z.string().regex(/^\d{2}:\d{2}$/).default('19:00'),
  monthlyCapCents: z.coerce.number().int().min(0).default(50_000),
})

/** A saída estruturada de cada turno, ao lado da resposta em texto. */
export const AgentTurnOutputSchema = z.object({
  reply: z.string().min(1).max(1200),
  sentiment: z.enum(['POSITIVE', 'NEUTRAL', 'NEGATIVE']),
  handoff: z.boolean(),
})
```

Toda tool é declarada com `strict: true`, `additionalProperties: false` e `required` — o que
garante que `tool_use.input` valide exatamente contra o schema, e é o que permite passar o
argumento direto ao `parseInput` do módulo de domínio sem uma segunda tradução.

### Códigos de Erro Padronizados

| Código | HTTP | Cenário |
|---|---|---|
| `ERR_AI_001` | 404 | Conversa não encontrada neste tenant |
| `ERR_AI_002` | 422 | Entrada inválida |
| `ERR_AI_003` | 403 | Permissão insuficiente |
| `ERR_AI_004` | 409 | Conversa em estado que não permite a transição (assumir a já assumida) |
| `ERR_AI_005` | 409 | Proposta expirada ou superada — o agente refaz a consulta |
| `ERR_AI_006` | 503 | Provedor de modelo indisponível. **Vira handoff, nunca silêncio** |

---

## 6. Máquinas de Estado

### `agent_conversations` — Status

```
ACTIVE
  │
  ├─(gatilho de handoff: pedido, sentimento, impasse, teto, erro)──► HANDOFF
  │                                                                    │
  │                                                                    ├─(recepção assume)──► ASSIGNED
  │                                                                    │                         │
  │                                                                    │                         └─(encerra)──► CLOSED
  │                                                                    │
  │                                                                    └─(encerra sem assumir)──► CLOSED
  │
  └─(sem mensagem por AGENT_SESSION_TTL_MIN)───────────────────────► CLOSED
```

**Não há transição de `HANDOFF` de volta para `ACTIVE`** (AC-05 de MOD-AI-05): o agente não
retoma uma conversa que prometeu passar para uma pessoa.

**Efeitos colaterais por transição:**

| De | Para | Evento RabbitMQ | Notificações | Audit Log |
|---|---|---|---|---|
| `ACTIVE` | `HANDOFF` | `agente.handoff` | sino da topbar | ✓ |
| `HANDOFF` | `ASSIGNED` | — | — | ✓ |
| `ACTIVE` | `CLOSED` | `agente.conversa.encerrada` | — | ✓ |

### `agent_tool_calls` — Status das propostas

```
PROPOSED
  ├─(tutor confirma dentro do TTL)──────► CONFIRMED  → a escrita acontece
  ├─(tutor pede outra coisa)────────────► SUPERSEDED
  └─(TTL vence)─────────────────────────► EXPIRED
```

---

## 7. Regras de Negócio & Edge Cases

| # | Cenário | Comportamento Esperado | Módulos Afetados |
|---|---|---|---|
| RN-01 | Telefone identifica, não autentica | Saldo em faixa, alerta clínico nunca, endereço nunca. O valor exato exige sessão no Portal | MOD-AI, MOD-LEDGER, MOD-PRONT |
| RN-02 | Escopo nunca vem dos argumentos | Toda tool usa o `tutorId` da conversa; `tutorId` sequer existe no schema | MOD-AI, MOD-PORTAL |
| RN-03 | Escrita sempre em duas etapas | Proposta e confirmação, com token e TTL de 15 min | MOD-AI, MOD-AGENDA |
| RN-04 | Uma proposta viva por conversa | Garantido por índice único parcial, não só por código | MOD-AI |
| RN-05 | O agente nunca contorna gate de domínio | `canOverrideCredit: false` e `canOverridePrice: false`, como no Portal | MOD-AI, MOD-AGENDA, MOD-TAXI |
| RN-06 | A lista de tools é a fronteira | Não há tool de escrita financeira, clínica, de ficha nem de campanha | MOD-AI |
| RN-07 | Handoff é terminal | Depois dele o agente não volta a responder na mesma conversa | MOD-AI |
| RN-08 | Teto degrada para gente, nunca para silêncio | Todo limite atingido vira handoff | MOD-AI |
| RN-09 | Modelo fora do ar vira handoff | `ERR_AI_006` não chega ao tutor como erro: chega como "vou chamar alguém" | MOD-AI |
| RN-10 | Número desconhecido não conversa | Sem ficha, sem agente. Responder já diria que o número não está na base | MOD-AI, MOD-TUTOR |
| RN-11 | Telefone ambíguo vai para gente | Duas fichas com o mesmo número, a recepção decide (AC-06 de MOD-PORTAL-01) | MOD-AI, MOD-TUTOR |
| RN-12 | Revogar opt-in não silencia resposta | Consentimento rege o contato **iniciado** pelo petshop, não a resposta a quem escreveu | MOD-AI, MOD-TUTOR |
| RN-13 | Custo é medido do `usage`, não estimado | `input_tokens`, `output_tokens` e `cache_read_input_tokens` da resposta, por turno | MOD-AI |
| RN-14 | Reentrega do provedor é barrada no banco | Índice único sobre `(tenant_id, provider_message_id)` | MOD-AI, MOD-NOTIF |
| RN-15 | A resposta do agente sai pelo motor do MOD-NOTIF | Mesma fila, mesmo histórico, mesmo teto de vazão. O agente não fala com a Evolution direto | MOD-AI, MOD-NOTIF |

---

## 8. Eventos RabbitMQ (Mensageria Assíncrona)

Exchange `petshop.events` (topic), DLX com backoff 1s/5s/30s/5min.

| Evento (routing key) | Publisher | Consumers | Payload Mínimo |
|---|---|---|---|
| `agente.mensagem.recebida` | `modules/agent` | — | `{ tenantId, conversationId, tutorId, timestamp }` |
| `agente.handoff` | `modules/agent` | `messaging` | `{ tenantId, conversationId, reason, timestamp }` |
| `agente.conversa.encerrada` | `modules/agent` | — | `{ tenantId, conversationId, turns, costCents, resolved }` |
| `agente.agendamento.criado` | `modules/agent` | — | `{ tenantId, conversationId, appointmentId }` |

**Consumidos:** nenhum. O agente é acionado pelo webhook e pela fila interna de turnos — um
consumidor de evento de domínio o faria reagir a coisas que ninguém pediu.

---

## 9. Segurança & LGPD

### Controle de Acesso por Operação

| Operação | TENANT_ADMIN | RECEPTIONIST | GROOMER / BATHER / VET | DRIVER | TUTOR |
|---|---|---|---|---|---|
| Ver a fila e o histórico | ✓ | ✓ | — | — | — |
| Assumir e responder | ✓ | ✓ | — | — | — |
| Configurar o agente | ✓ | — | — | — | — |
| Ver o painel de qualidade | ✓ | ✓ | — | — | — |
| **Conversar com o agente** | — | — | — | — | ✓ (pelo WhatsApp) |

Reusa `crm:read`, `crm:manage`, `crm:send` e `crm:configure` — **nenhuma permissão nova**. O
agente é uma forma de o CRM falar, e o recorte de quem opera CRM já está na matriz.

### Audit Log

- `agent.booking_created` / `agent.booking_cancelled` / `agent.booking_rescheduled` → com
  `conversation_id` e `turn` no `after`
- `agent.handoff` → com o motivo
- `agent.settings_changed` → antes e depois, inclusive o teto
- `agent.conversation_read` → **não**. A recepção lê a fila o dia inteiro, e auditar leitura
  de tela de trabalho encheria a trilha do ruído que o MOD-SEC-08 depois teria de expurgar

### Dados Pessoais (LGPD)

| Campo | Categoria | Base Legal | Retenção | Exportável | Deletável |
|---|---|---|---|---|---|
| `agent_turns.content_encrypted` | Dado pessoal | Execução de contrato (art. 7º, V) | 24 meses | ✓ (art. 18) | ✓ na anonimização |
| `agent_tool_calls.arguments` | Dado pessoal | Execução de contrato | 24 meses | ✓ | ✓ |
| `agent_conversations.tutor_id` | Dado pessoal | Execução de contrato | 24 meses | ✓ | Vira `NULL` |

**O conteúdo da conversa sai do produto** — vai para o provedor do modelo, que é operador
subsequente. Três consequências que o módulo assume:

1. **Zero data retention é requisito de contrato**, não configuração de código. Sem ela, a
   conversa de um cliente do petshop fica em infraestrutura de terceiro além do turno.
2. **A política de privacidade do tenant precisa dizer** que o atendimento pode ser
   automatizado. O texto entra no termo do MOD-DOC-06, versionado como os outros.
3. **O tutor precisa saber que fala com um robô.** A primeira mensagem de toda conversa o
   diz, e o `AGENT_DISCLOSURE` não é configurável pelo tenant.

Na anonimização do titular (MOD-TUTOR-08), `content_encrypted` e `arguments` são apagados e
`tutor_id` vira nulo — a conversa deixa de existir como dado pessoal e sobra a contagem, que
é o que o painel de qualidade precisa.

---

## 10. Performance & Observabilidade

### O provedor do modelo

`claude-opus-5` pela API da Anthropic, com o SDK oficial (`@anthropic-ai/sdk`), atrás de uma
porta com dublê injetável — o mesmo desenho do `ClerkPort` e do `MailerPort`, e pela mesma
razão: a suíte inteira roda sem chave de provedor e sem gastar dinheiro.

| Decisão | Escolha | Por quê |
|---|---|---|
| Modelo | `claude-opus-5` | $5/$25 por milhão de tokens. A conversa é curta e o custo por turno é dominado pelo prefixo em cache, não pela saída |
| Thinking | `{ type: 'adaptive' }` com `effort: 'low'` | Atendimento é classificação e consulta, não raciocínio longo. `low` é onde a qualidade se mantém e o custo cai |
| Tools | `strict: true` em todas | O argumento chega válido, e vai direto ao `parseInput` do módulo |
| Saída | `output_config.format` com `AgentTurnOutputSchema` | Resposta, sentimento e handoff num turno só — a alternativa é uma segunda chamada por mensagem |
| Streaming | não | A resposta vai para o WhatsApp inteira; não há tela onde ela apareça sendo escrita |

**Prompt caching é o que torna o módulo viável.** O prefixo é `tools` → `system` → o contexto
do tenant (nome, horário, serviços) → o histórico da conversa, com `cache_control` depois do
contexto. O que varia por turno — a mensagem, o instante — fica depois. Sem isso, cada turno
paga o prompt inteiro de novo, e o custo por conversa multiplica pelo número de turnos.

**A verificação é `usage.cache_read_input_tokens > 0` a partir do segundo turno**, e ela é
um teste da suíte: um `new Date()` no prompt de sistema, uma lista de serviços em ordem não
determinística ou um conjunto de tools que muda por tenant invalidam o prefixo em silêncio —
o módulo continua funcionando e a conta triplica.

### Cache Redis

| Dado | TTL | Chave | Invalida quando |
|---|---|---|---|
| Configuração do agente | 300s | `agent:settings:{tenantId}` | `PATCH /v1/agent/settings` |
| Conversa viva do tutor | 120s | `agent:conv:{tenantId}:{tutorId}` | Handoff ou encerramento |
| Gasto do mês | 60s | `agent:spend:{tenantId}:{yyyymm}` | Só por TTL |

### Métricas de Negócio

```json
{ "metric": "agent_turn_cost_cents", "tenantId": "...", "value": 3, "unit": "cents" }
```

- `agent_conversation_started_total`, `agent_conversation_resolved_total` — a razão é a taxa
  de resolução, e é a métrica que decide se o módulo se paga
- `agent_handoff_total` por motivo — `UNRESOLVED` alto é problema de prompt; `SENTIMENT` alto
  é problema de produto
- `agent_turn_cost_cents` e `agent_cache_hit_ratio` — o segundo é o que denuncia prefixo
  quebrado antes de a fatura chegar
- `agent_tool_error_total` por tool
- `agent_proposal_expired_total` — proposta que vence é tutor que demorou a confirmar, e
  muitas delas dizem que o TTL de 15 minutos é curto demais

---

## 11. Questões em Aberto

| # | Questão | Impacto | Decisor | Prazo |
|---|---|---|---|---|
| 1 | Zero data retention com a Anthropic está contratada? | Sem ela, o §9 deste PRD não fecha e o módulo não pode ir a produção | PM / Jurídico | **Antes da implementação** |
| 2 | O texto de aviso de automação entra em qual termo do MOD-DOC-06? | Termo novo exige aceite de toda a base; cláusula no existente exige versão nova | PM / Jurídico | Antes da implementação |
| 3 | O teto padrão de R$ 500/mês por tenant é adequado? | Muito baixo trava o piloto; muito alto vira surpresa na fatura | PM | Antes da implementação |
| 4 | A faixa do saldo é "há valores em aberto" ou uma faixa numérica? | A segunda ajuda o tutor e vaza mais para um número clonado | PM | Antes da implementação |
| 5 | O agente responde fora do horário dizendo o horário, ou fica mudo? | O AC-03 de MOD-AI-07 assume a primeira; a segunda é mais barata e pior | PM | Antes da implementação |
| 6 | Piloto em quantos tenants antes de abrir a configuração para todos? | O custo e a qualidade só se medem com tráfego real | PM | Antes da implementação |
| 7 | A triagem clínica e o agente de relacionamento entram em que fase? | São os outros dois do §7.14 do PRD, e cada um tem risco próprio | PM | Fase própria |
