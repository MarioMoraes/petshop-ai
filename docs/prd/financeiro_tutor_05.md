# PRD Detalhado — Financeiro do Tutor (Conta Corrente)

**Módulo:** MOD-LEDGER
**Arquivo:** 05/15
**Prioridade:** P0
**Fase de Implementação:** 2 — Prontuário e Financeiro
**Serviço Backend:** billing-ledger-service (porta 3005)
**Tabelas Principais:** ledger_accounts, ledger_entries, payments, payment_allocations, service_packages, package_purchases, package_credit_usages, receipts, billing_settings
**Data:** 2026-08-21
**Status:** Draft

---

## 1. Visão Geral

**Contexto de negócio.** O petshop brasileiro típico opera em regime de confiança: o pet é entregue, o serviço é executado e o pagamento acontece no balcão — ou "fica para o fim do mês", em caderneta. Essa caderneta é o buraco financeiro do setor. Ela não sabe dizer quanto cada tutor deve, não sobrevive à saída do funcionário que a mantinha, e não permite cobrar sem constrangimento. O módulo financeiro substitui a caderneta por uma **conta corrente por tutor**: débitos entram automaticamente quando o serviço é concluído, créditos entram quando o pagamento é registrado, e o saldo é uma verdade única, auditável e consultável pelo próprio tutor no Portal.

**Recorte deliberado da v1.** Este módulo **não é um ERP financeiro** e não processa dinheiro. Ele registra a relação tutor↔petshop: o pagamento acontece fora do sistema (dinheiro, PIX na chave do petshop, maquininha) e é **lançado** aqui, gerando recibo em PDF. A decisão é explícita — integrar gateway na Fase 2 acrescentaria conciliação, webhooks idempotentes, onboarding de conta no PSP e superfície PCI a um módulo que ainda precisa acertar o básico. O gateway entra como módulo próprio depois, e o modelo de dados aqui já é desenhado para recebê-lo sem migração destrutiva (ver RN-19 e Questão 1).

**Integração sistêmica.** Upstream: MOD-PRONT (`atendimento.concluido` é o gatilho de 90% dos débitos), MOD-AGENDA (no-show e cancelamento tardio geram taxa; consulta de saldo bloqueia/alerta no agendamento), MOD-TUTOR (titular da conta), MOD-IDENT (papéis e `billing_settings` do tenant). Downstream: MOD-DOC (recibo e extrato em PDF via Gotenberg), MOD-CRM (régua de cobrança e tag "inadimplente"), MOD-PORTAL (extrato self-service), MOD-NOTIF (recibo por e-mail), MOD-ADMIN (auditoria de todo lançamento), MOD-AI (agente responde "quanto eu devo?" e envia o extrato).

**Escopo desta fase.** Inclui: conta corrente com saldo consolidado, lançamento imutável de débito e crédito, estorno por contrapartida, registro de pagamento com alocação a débitos específicos, pacotes pré-pagos com crédito em quantidade de serviços, extrato paginado com filtro por período, recibo em PDF, limite de crédito por tenant com override auditado, e expiração automática de pacotes. Fica de fora: gateway de pagamento e conciliação bancária, emissão de NFS-e, contas a pagar, DRE e fluxo de caixa do tenant, comissionamento de profissionais, e controle de estoque de produtos vendidos.

## 2. Sub-Features

| ID | Nome | Descrição | Must/Should/Nice |
|---|---|---|---|
| MOD-LEDGER-01 | Conta Corrente do Tutor | Uma conta por tutor por tenant, com saldo consolidado e versionado | Must Have |
| MOD-LEDGER-02 | Lançamento de Débito | Débito automático na conclusão do atendimento; débito manual (produto, taxa) | Must Have |
| MOD-LEDGER-03 | Registro de Pagamento | Crédito por pagamento feito fora do sistema, com forma e comprovante | Must Have |
| MOD-LEDGER-04 | Alocação Pagamento↔Débito | Quitação de débitos específicos (FIFO por padrão, manual quando necessário) | Must Have |
| MOD-LEDGER-05 | Estorno por Contrapartida | Nenhuma edição retroativa: erro gera lançamento inverso vinculado | Must Have |
| MOD-LEDGER-06 | Extrato | Listagem cronológica com saldo corrido, filtro por período e exportação | Must Have |
| MOD-LEDGER-07 | Pacotes Pré-Pagos | Compra de N serviços com validade de 90 dias, consumo automático na execução | Must Have |
| MOD-LEDGER-08 | Recibo em PDF | Comprovante de pagamento e extrato em PDF via MOD-DOC | Should Have |
| MOD-LEDGER-09 | Limite de Crédito e Inadimplência | Alerta na agenda; acima do limite exige override de admin com justificativa | Must Have |
| MOD-LEDGER-10 | Taxa de No-Show e Cancelamento Tardio | Débito percentual configurável quando o cancelamento fura a janela de 24h | Must Have |
| MOD-LEDGER-11 | Fechamento e Consistência | Job diário de reconciliação entre soma dos lançamentos e saldo materializado | Must Have |
| MOD-LEDGER-12 | Resumo Financeiro para IA/CRM | Contrato estruturado com saldo, atraso e histórico para consumo por agentes | Should Have |

## 3. Critérios de Aceite

### [MOD-LEDGER-02] — Lançamento de Débito

**AC-01 (Happy Path — débito automático)**
- **Dado** um atendimento concluído no MOD-PRONT com `items[]` totalizando R$ 120,00
- **Quando** o `billing-ledger-service` consome o evento `atendimento.concluido`
- **Então** cria-se um `ledger_entry` com `direction = DEBIT`, `amount_cents = 12000`, `source_type = ATTENDANCE`, `source_id = attendanceId`, `status = POSTED`; o saldo da conta é decrementado na mesma transação; grava-se `balance_after_cents` no lançamento; e publica-se `lancamento.criado` + `saldo.alterado`

**AC-02 (Idempotência — evento reentregue)**
- **Dado** que o broker reentrega `atendimento.concluido` para o mesmo `attendanceId` (retry após timeout)
- **Quando** o consumidor processa a segunda vez
- **Então** o índice único `(tenant_id, source_type, source_id, direction)` rejeita a inserção, o serviço trata como sucesso (ACK), **não** duplica o débito e registra `ledger_duplicate_event_total` — a conta nunca é corrompida por reentrega

**AC-03 (Happy Path — débito manual)**
- **Dado** a recepção vendendo um produto de balcão (ração, brinquedo)
- **Quando** cria `POST /v1/ledger/entries` com `{ tutorId, direction: "DEBIT", amountCents: 8990, category: "PRODUCT", description: "Ração X 3kg", occurredAt }`
- **Então** o lançamento é criado, exige `description` não vazia, e retorna **201** com o saldo atualizado

**AC-04 (Validação / Erro)**
- **Dado** `amountCents <= 0` ou `amountCents > 100000000` (R$ 1.000.000, teto de sanidade)
- **Quando** submetido
- **Então** retorna **422** `ERR_LEDGER_002` "Valor inválido para lançamento"

**AC-05 (Edge Case — atendimento coberto por pacote)**
- **Dado** um atendimento cujo serviço tem crédito de pacote ativo e não expirado para aquele pet
- **Quando** o evento é consumido
- **Então** **não** se gera débito em dinheiro: consome-se 1 crédito do pacote (`package_credit_usages`), cria-se um lançamento informativo `direction = DEBIT, category = PACKAGE_REDEMPTION, amount_cents = 0` para manter a rastreabilidade no extrato, e publica-se `pacote.credito.consumido`

### [MOD-LEDGER-03] — Registro de Pagamento

**AC-01 (Happy Path)**
- **Dado** um tutor com saldo `-15000` (deve R$ 150,00) pagando R$ 150,00 em PIX no balcão
- **Quando** a recepção registra `POST /v1/payments` com `{ tutorId, amountCents: 15000, method: "PIX_MANUAL", receivedAt, notes }`
- **Então** cria-se o `payment` com `status = RECORDED`, um `ledger_entry` de `CREDIT` vinculado, a alocação automática FIFO quita os débitos mais antigos, o saldo vai a `0`, publica-se `pagamento.registrado` e retorna **201** com `receiptId` já enfileirado no MOD-DOC

**AC-02 (Pagamento parcial)**
- **Dado** um tutor devendo R$ 300,00 em três débitos de R$ 100,00
- **Quando** paga R$ 150,00
- **Então** o primeiro débito é quitado integralmente, o segundo fica `PARTIALLY_SETTLED` com `settled_cents = 5000`, o terceiro permanece aberto, e o extrato mostra o resíduo por lançamento

**AC-03 (Pagamento maior que a dívida)**
- **Dado** um tutor devendo R$ 100,00 que paga R$ 200,00
- **Quando** registrado
- **Então** os débitos são quitados e o excedente permanece como **crédito disponível** (saldo `+10000`), consumido automaticamente no próximo débito — sem devolução em dinheiro pelo sistema (v1)

**AC-04 (Validação / Erro — forma de pagamento não habilitada)**
- **Dado** um tenant que desabilitou `CARD_MACHINE_CREDIT` em `billing_settings.enabled_payment_methods`
- **Quando** a recepção tenta registrar com esse método
- **Então** retorna **422** `ERR_LEDGER_003` "Forma de pagamento não habilitada para este estabelecimento"

**AC-05 (Edge Case — pagamento registrado por engano)**
- **Dado** um pagamento lançado no tutor errado, percebido 10 minutos depois
- **Quando** o admin chama `POST /v1/payments/:id/reverse` com `{ reason }`
- **Então** o pagamento vai a `REVERSED`, gera-se lançamento de contrapartida (`DEBIT` de mesmo valor, `category = PAYMENT_REVERSAL`), as alocações são desfeitas, os débitos voltam a aberto, o recibo já emitido é marcado `CANCELLED` — e **nada é apagado**

### [MOD-LEDGER-07] — Pacotes Pré-Pagos

**AC-01 (Happy Path — compra)**
- **Dado** o tenant com o pacote "4 Banhos Porte Médio" cadastrado (`credits: 4`, `priceCents: 32000`, `serviceIds: [...]`)
- **Quando** a recepção registra `POST /v1/packages/:packageId/purchases` com `{ tutorId, petId, paymentMethod: "PIX_MANUAL" }`
- **Então** cria-se `package_purchase` com `status = ACTIVE`, `credits_total = 4`, `credits_used = 0`, `expires_at = now() + 90 dias`, um `payment` e um `ledger_entry` de `CREDIT` de R$ 320,00 marcado `category = PACKAGE_PURCHASE`, publica-se `pacote.comprado` e retorna **201**

**AC-02 (Consumo do crédito)**
- **Dado** um pacote `ACTIVE` com 2 créditos restantes, vinculado ao pet Thor
- **Quando** um atendimento de banho do Thor é concluído
- **Então** consome-se 1 crédito (`credits_used = 3`), grava-se `package_credit_usages` com `attendance_id`, o atendimento **não** gera débito em dinheiro, e o Portal do Tutor passa a mostrar "1 banho restante — expira em 12/11/2026"

**AC-03 (Expiração — 90 dias, sem reembolso)**
- **Dado** um pacote comprado em 21/08/2026 com 2 créditos não usados
- **Quando** o job diário roda em 20/11/2026 (dia seguinte ao vencimento)
- **Então** o pacote vai a `EXPIRED`, os créditos remanescentes são perdidos, **nenhum valor é devolvido nem vira crédito em conta**, publica-se `pacote.expirado`, e o MOD-CRM dispara aviso ao tutor. O tenant configura em `billing_settings.package_expiry_warning_days` (padrão `[15, 3]`) os avisos prévios — a expiração nunca pode ser surpresa

**AC-04 (Validação / Erro — serviço fora do pacote)**
- **Dado** um pacote que cobre apenas "Banho", e um atendimento de "Tosa Completa"
- **Quando** o débito é processado
- **Então** o crédito **não** é consumido e o débito em dinheiro é gerado normalmente — o casamento é por `service_id`, nunca por valor

**AC-05 (Edge Case — pacote de pet transferido ou falecido)**
- **Dado** um pacote vinculado a um pet que foi transferido de tutor (MOD-PET) ou faleceu
- **Quando** o evento `pet.transferido` / `pet.obito` chega
- **Então** o pacote **permanece com o tutor comprador** (quem pagou), fica `SUSPENDED` com motivo, e o admin decide: reatribuir a outro pet do mesmo tutor (`PATCH .../purchases/:id { petId }`, auditado) ou deixar expirar. Nunca há reembolso automático

**AC-06 (Edge Case — corrida de consumo)**
- **Dado** dois atendimentos do mesmo pet concluídos simultaneamente com 1 crédito restante
- **Quando** os dois consumidores tentam debitar o crédito
- **Então** o `SELECT ... FOR UPDATE` sobre `package_purchases` serializa: um consome o crédito, o outro gera débito em dinheiro. Nunca resulta em `credits_used > credits_total`

### [MOD-LEDGER-09] — Limite de Crédito e Inadimplência

**AC-01 (Happy Path — dentro do limite)**
- **Dado** `billing_settings.credit_limit_cents = 30000` e um tutor com saldo `-12000`
- **Quando** a agenda consulta `GET /v1/ledger/accounts/:tutorId/credit-check?amountCents=8000`
- **Então** retorna **200** `{ allowed: true, warning: true, balanceCents: -12000, projectedCents: -20000, limitCents: 30000, message: "Tutor possui débito de R$ 120,00" }` — a agenda exibe o alerta e permite o agendamento

**AC-02 (Acima do limite — override obrigatório)**
- **Dado** o mesmo tenant e um tutor com saldo `-28000` agendando R$ 90,00
- **Quando** a agenda consulta o `credit-check`
- **Então** retorna `{ allowed: false, requiresOverride: true, code: "ERR_LEDGER_006" }`; o agendamento só é aceito com `override: { authorizedBy, justification }` de `TENANT_ADMIN`, que gera `audit_log` `ledger.credit_limit_overridden` e a métrica `credit_override_total`

**AC-03 (Edge Case — limite zero ou nulo)**
- **Dado** `credit_limit_cents = null` (tenant que não quer bloqueio nenhum)
- **Quando** o `credit-check` é chamado
- **Então** retorna sempre `allowed: true`, mantendo apenas o `warning` informativo — a política de bloqueio é opt-in por tenant

**AC-04 (Edge Case — tag de inadimplente)**
- **Dado** um tutor com débito vencido há mais de `billing_settings.overdue_days` (padrão 30)
- **Quando** o job diário de inadimplência roda
- **Então** publica-se `inadimplencia.detectada`, o MOD-TUTOR aplica a tag `inadimplente` (PRD §7.1) e o MOD-CRM inicia a régua de cobrança. Quitado o débito, publica-se `inadimplencia.resolvida` e a tag é removida automaticamente — tag suja é pior que tag ausente

### [MOD-LEDGER-10] — Taxa de No-Show e Cancelamento Tardio

**AC-01 (Happy Path)**
- **Dado** `billing_settings.no_show_fee_percent = 50` e um agendamento de R$ 100,00 cancelado com 6h de antecedência (janela mínima: 24h)
- **Quando** o MOD-AGENDA publica `agendamento.cancelado` com `lateCancellation: true`
- **Então** gera-se `ledger_entry` `DEBIT` de R$ 50,00, `category = NO_SHOW_FEE`, com `description` citando o agendamento e a política aplicada, e o MOD-CRM notifica o tutor com a justificativa

**AC-02 (Percentual zero — tenant sem multa)**
- **Dado** `no_show_fee_percent = 0` (padrão de instalação, para não criar atrito antes do tenant decidir)
- **Quando** o evento chega
- **Então** nenhum lançamento é criado; registra-se apenas a métrica `no_show_total` para o tenant enxergar o prejuízo e decidir ligar a política

**AC-03 (Edge Case — no-show de agendamento coberto por pacote)**
- **Dado** um no-show em atendimento que seria pago com crédito de pacote
- **Quando** a taxa é aplicada
- **Então** o comportamento segue `billing_settings.no_show_consumes_package_credit` (padrão `false`): por padrão **o crédito não é queimado** e a taxa é lançada em dinheiro

**AC-04 (Edge Case — perdão da taxa)**
- **Dado** uma taxa lançada para um tutor que justificou emergência
- **Quando** o admin chama `POST /v1/ledger/entries/:id/reverse` com `{ reason: "Emergência médica comprovada" }`
- **Então** gera-se contrapartida `CREDIT` de mesmo valor, `category = FEE_WAIVER`, e o par (taxa + perdão) permanece visível no extrato — o gesto comercial fica registrado, não escondido

### [MOD-LEDGER-06] — Extrato

**AC-01 (Happy Path)**
- **Dado** um tutor com 180 lançamentos em 2 anos
- **Quando** chama `GET /v1/ledger/accounts/:tutorId/statement?from=2026-01-01&to=2026-08-21&limit=50`
- **Então** retorna os lançamentos do período em ordem cronológica **decrescente**, cada um com `balanceAfterCents`, mais um bloco `summary` com `openingBalanceCents`, `totalDebitsCents`, `totalCreditsCents`, `closingBalanceCents`, em menos de 400ms

**AC-02 (Consistência do saldo de abertura)**
- **Dado** um recorte que começa no meio do histórico
- **Quando** o extrato é gerado
- **Então** o `openingBalanceCents` é calculado a partir do último `balance_after_cents` anterior ao `from` — nunca por soma completa da tabela, que degradaria com o volume

**AC-03 (Visão do tutor no Portal)**
- **Dado** um tutor autenticado no Portal
- **Quando** consulta o próprio extrato
- **Então** vê valores, datas, descrições e recibos, mas **não** vê `internal_notes` dos lançamentos nem o custo interno de serviços; a filtragem é no servidor

**AC-04 (Edge Case — tutor sem movimentação)**
- **Dado** um tutor recém-cadastrado sem lançamentos
- **Quando** o extrato é consultado
- **Então** retorna **200** com lista vazia e saldo `0` — a conta é criada preguiçosamente no primeiro acesso ou lançamento, jamais retorna 404

### [MOD-LEDGER-11] — Fechamento e Consistência

**AC-01 (Happy Path)**
- **Dado** o job noturno de reconciliação
- **Quando** roda para cada conta com movimentação nas últimas 24h
- **Então** compara `SUM(signed_amount_cents)` dos lançamentos `POSTED` com `ledger_accounts.balance_cents`; se baterem, registra `ledger_reconciliation_ok_total`

**AC-02 (Divergência detectada)**
- **Dado** uma divergência de qualquer valor
- **Quando** o job identifica
- **Então** a conta é marcada `needs_review = true`, dispara-se alerta `P1` para o time de plataforma via MOD-ADMIN, o saldo **não** é corrigido automaticamente (correção silenciosa esconde o bug de origem), e novos lançamentos continuam sendo aceitos — a conta não trava para o tenant

## 4. Modelo de Dados

### Decisão de representação monetária

Todo valor neste módulo é **inteiro em centavos** (`BIGINT`), nunca `Decimal` ou `Float`. Os módulos upstream (MOD-PRONT, MOD-AGENDA) trabalham com `Decimal(10,2)` para preço de tabela; a conversão para centavos acontece **na borda de entrada** do ledger (consumidor de evento e handler HTTP), com arredondamento *half-up* explícito e teste de propriedade. Motivo: soma de saldo corrido é a operação mais executada do módulo e a única em que erro de arredondamento é irreversível e visível para o cliente final. A moeda é fixa em `BRL` na v1, mas a coluna `currency` existe desde já para não exigir migração destrutiva depois.

### Tabelas Envolvidas

| Tabela | Campo | Tipo | Obrigatório | Descrição |
|---|---|---|---|---|
| ledger_accounts | id | UUID | ✓ | PK |
| ledger_accounts | tenant_id | UUID | ✓ | Isolamento multi-tenant (RLS) |
| ledger_accounts | tutor_id | UUID | ✓ | FK tutors — única por tenant |
| ledger_accounts | balance_cents | BIGINT | ✓ | Saldo materializado; negativo = inadimplência |
| ledger_accounts | currency | Char(3) | ✓ | `BRL` (fixo na v1) |
| ledger_accounts | version | Int | ✓ | Optimistic locking / detecção de corrida |
| ledger_accounts | last_entry_at | Timestamptz | — | Última movimentação |
| ledger_accounts | overdue_since | Timestamptz | — | Início do atraso vigente; nulo se em dia |
| ledger_accounts | needs_review | Boolean | ✓ | Marcado pelo job de reconciliação |
| ledger_accounts | created_at / updated_at | Timestamptz | ✓ | Auditoria |
| ledger_entries | id | UUID | ✓ | PK |
| ledger_entries | tenant_id / account_id / tutor_id | UUID | ✓ | Isolamento e FKs |
| ledger_entries | direction | Enum | ✓ | DEBIT, CREDIT |
| ledger_entries | amount_cents | BIGINT | ✓ | Sempre positivo; o sinal vem de `direction` |
| ledger_entries | signed_amount_cents | BIGINT | ✓ | Coluna gerada: `CREDIT ? +amount : -amount` |
| ledger_entries | balance_after_cents | BIGINT | ✓ | Saldo corrido no instante do lançamento |
| ledger_entries | category | Enum | ✓ | SERVICE, PRODUCT, NO_SHOW_FEE, PACKAGE_PURCHASE, PACKAGE_REDEMPTION, PAYMENT, PAYMENT_REVERSAL, ADJUSTMENT, FEE_WAIVER, DISCOUNT |
| ledger_entries | description | String(200) | ✓ | Texto visível ao tutor no extrato |
| ledger_entries | internal_notes | Text | — | Nunca exposto ao tutor |
| ledger_entries | source_type | Enum | ✓ | ATTENDANCE, APPOINTMENT, PAYMENT, PACKAGE, MANUAL, SYSTEM |
| ledger_entries | source_id | UUID | — | Idempotência com `source_type` |
| ledger_entries | pet_id | UUID | — | Rastreio por pet quando aplicável |
| ledger_entries | occurred_at | Timestamptz | ✓ | Data do fato gerador (pode ser retroativa) |
| ledger_entries | posted_at | Timestamptz | ✓ | Data do registro no sistema (nunca retroativa) |
| ledger_entries | status | Enum | ✓ | POSTED, REVERSED |
| ledger_entries | reversed_by_entry_id | UUID | — | Aponta para a contrapartida |
| ledger_entries | reverses_entry_id | UUID | — | Se este lançamento É a contrapartida |
| ledger_entries | settled_cents | BIGINT | ✓ | Quanto do débito já foi quitado (default 0) |
| ledger_entries | created_by | UUID | ✓ | Usuário ou `SYSTEM` |
| payments | id / tenant_id / account_id / tutor_id | UUID | ✓ | PK e FKs |
| payments | amount_cents | BIGINT | ✓ | Valor recebido |
| payments | method | Enum | ✓ | CASH, PIX_MANUAL, CARD_MACHINE_DEBIT, CARD_MACHINE_CREDIT, BANK_TRANSFER, PACKAGE_CREDIT, OTHER |
| payments | received_at | Timestamptz | ✓ | Quando o dinheiro entrou de fato |
| payments | received_by | UUID | ✓ | Quem recebeu no balcão — responsabilização |
| payments | entry_id | UUID | ✓ | Lançamento de crédito correspondente |
| payments | status | Enum | ✓ | RECORDED, REVERSED |
| payments | reversal_reason | Text | — | Obrigatório se REVERSED |
| payments | proof_url | String | — | Foto/print do comprovante (R2) |
| payments | notes | Text | — | Observação do balcão |
| payments | external_ref | String(120) | — | Reservado para `txid` do PSP na fase de gateway |
| payment_allocations | id / tenant_id | UUID | ✓ | PK |
| payment_allocations | payment_id / debit_entry_id | UUID | ✓ | Quitação N:N |
| payment_allocations | amount_cents | BIGINT | ✓ | Parcela alocada a este débito |
| payment_allocations | allocated_by | Enum | ✓ | AUTO_FIFO, MANUAL |
| payment_allocations | created_at | Timestamptz | ✓ | Auditoria |
| service_packages | id / tenant_id | UUID | ✓ | Catálogo de pacotes do tenant |
| service_packages | name | String(120) | ✓ | "4 Banhos Porte Médio" |
| service_packages | service_ids | UUID[] | ✓ | Serviços que o crédito cobre |
| service_packages | credits | Int | ✓ | Quantidade de execuções |
| service_packages | price_cents | BIGINT | ✓ | Preço à vista do pacote |
| service_packages | validity_days | Int | ✓ | Default 90 (política do produto) |
| service_packages | active | Boolean | ✓ | Descontinuar não apaga compras existentes |
| package_purchases | id / tenant_id / tutor_id | UUID | ✓ | PK e FKs |
| package_purchases | package_id | UUID | ✓ | FK service_packages |
| package_purchases | pet_id | UUID | — | Vinculação opcional a um pet |
| package_purchases | snapshot | JSONB | ✓ | Nome, serviços, créditos e preço no ato da compra |
| package_purchases | credits_total / credits_used | Int | ✓ | Controle de consumo |
| package_purchases | purchased_at / expires_at | Timestamptz | ✓ | `purchased_at + validity_days` |
| package_purchases | status | Enum | ✓ | ACTIVE, CONSUMED, EXPIRED, SUSPENDED, CANCELLED |
| package_purchases | suspension_reason | Text | — | Motivo quando SUSPENDED |
| package_purchases | payment_id / entry_id | UUID | ✓ | Rastro financeiro da compra |
| package_credit_usages | id / tenant_id / purchase_id | UUID | ✓ | PK e FKs |
| package_credit_usages | attendance_id / appointment_id | UUID | ✓/— | O que consumiu o crédito |
| package_credit_usages | service_id / pet_id | UUID | ✓ | Rastreabilidade |
| package_credit_usages | entry_id | UUID | ✓ | Lançamento informativo de valor zero |
| package_credit_usages | used_at / reverted_at | Timestamptz | ✓/— | Devolução do crédito em anulação |
| receipts | id / tenant_id / tutor_id | UUID | ✓ | PK e FKs |
| receipts | payment_id | UUID | ✓ | Pagamento comprovado |
| receipts | number | String(20) | ✓ | Sequencial por tenant e ano: `2026/000123` |
| receipts | document_id | UUID | — | PDF gerado pelo MOD-DOC |
| receipts | status | Enum | ✓ | PENDING, ISSUED, SENT, CANCELLED |
| receipts | issued_at / sent_at | Timestamptz | — | Emissão e envio |
| billing_settings | tenant_id | UUID | ✓ | PK — uma linha por tenant |
| billing_settings | credit_limit_cents | BIGINT | — | Nulo = sem bloqueio |
| billing_settings | no_show_fee_percent | Int | ✓ | 0–100; default 0 |
| billing_settings | cancellation_window_hours | Int | ✓ | Default 24 (decisão de produto) |
| billing_settings | overdue_days | Int | ✓ | Default 30 |
| billing_settings | enabled_payment_methods | Text[] | ✓ | Subconjunto do enum `method` |
| billing_settings | default_package_validity_days | Int | ✓ | Default 90 |
| billing_settings | package_expiry_warning_days | Int[] | ✓ | Default `{15,3}` |
| billing_settings | no_show_consumes_package_credit | Boolean | ✓ | Default false |
| billing_settings | receipt_footer_text | Text | — | Texto livre impresso no recibo |

### Campos com Criptografia AES-256-GCM (em repouso)

| Campo | Tabela | Justificativa LGPD/PCI |
|---|---|---|
| internal_notes | ledger_entries | Pode conter juízo de valor sobre o tutor ("cliente sempre atrasa") |
| notes | payments | Contexto do recebimento, com potencial dado pessoal |
| suspension_reason | package_purchases | Pode citar óbito do pet ou situação familiar |
| proof_url | payments | Comprovante pode exibir dados bancários de terceiro |

> Não há dado de cartão neste módulo — e não deve haver. `method = CARD_MACHINE_*` registra apenas que a maquininha foi usada; **PAN, CVV e dados de portador nunca são coletados nem armazenados**, o que mantém o sistema fora do escopo PCI-DSS na v1. Quando o gateway entrar (Questão 1), a tokenização fica no PSP e este módulo continua guardando apenas `external_ref`.

### Índices Necessários

```sql
CREATE UNIQUE INDEX idx_ledger_accounts_tutor ON ledger_accounts(tenant_id, tutor_id);
CREATE INDEX idx_ledger_accounts_debtors ON ledger_accounts(tenant_id, balance_cents)
  WHERE balance_cents < 0;
CREATE INDEX idx_ledger_accounts_review ON ledger_accounts(tenant_id) WHERE needs_review;

-- Extrato: o acesso dominante do módulo
CREATE INDEX idx_entries_account_time ON ledger_entries(tenant_id, account_id, occurred_at DESC, id DESC);

-- Idempotência de consumo de evento: a garantia mais importante da tabela
CREATE UNIQUE INDEX idx_entries_source ON ledger_entries(tenant_id, source_type, source_id, direction)
  WHERE source_id IS NOT NULL AND source_type <> 'MANUAL';

-- Alocação FIFO: débitos abertos mais antigos primeiro
CREATE INDEX idx_entries_open_debits ON ledger_entries(tenant_id, account_id, occurred_at)
  WHERE direction = 'DEBIT' AND status = 'POSTED' AND settled_cents < amount_cents;

CREATE INDEX idx_payments_account ON payments(tenant_id, account_id, received_at DESC);
CREATE INDEX idx_allocations_debit ON payment_allocations(debit_entry_id);

CREATE INDEX idx_purchases_active ON package_purchases(tenant_id, tutor_id, status)
  WHERE status = 'ACTIVE';
CREATE INDEX idx_purchases_expiring ON package_purchases(tenant_id, expires_at)
  WHERE status = 'ACTIVE';
CREATE INDEX idx_purchases_pet_service ON package_purchases USING GIN ((snapshot -> 'serviceIds'))
  WHERE status = 'ACTIVE';

CREATE UNIQUE INDEX idx_receipts_number ON receipts(tenant_id, number);
```

Invariantes garantidas no banco — o ledger não confia apenas na aplicação:

```sql
ALTER TABLE ledger_entries
  ADD CONSTRAINT chk_amount_positive CHECK (amount_cents > 0 OR category = 'PACKAGE_REDEMPTION'),
  ADD CONSTRAINT chk_settled_bounds  CHECK (settled_cents >= 0 AND settled_cents <= amount_cents);

ALTER TABLE package_purchases
  ADD CONSTRAINT chk_credits_bounds CHECK (credits_used >= 0 AND credits_used <= credits_total);

-- Lançamento é append-only: só metadados de estorno podem mudar
CREATE OR REPLACE FUNCTION prevent_ledger_entry_mutation() RETURNS trigger AS $$
BEGIN
  IF NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
     OR NEW.direction  IS DISTINCT FROM OLD.direction
     OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
     OR NEW.balance_after_cents IS DISTINCT FROM OLD.balance_after_cents THEN
    RAISE EXCEPTION 'ERR_LEDGER_005: lançamento é imutável — use estorno por contrapartida';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ledger_entry_immutable
  BEFORE UPDATE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION prevent_ledger_entry_mutation();

CREATE RULE no_delete_ledger_entries AS ON DELETE TO ledger_entries DO INSTEAD NOTHING;
```

## 5. Contratos de API

### Endpoints

| Método | Path | Roles Permitidos | Descrição |
|---|---|---|---|
| GET | /v1/ledger/accounts/:tutorId | ADMIN, RECEPTIONIST, TUTOR (próprio) | Saldo e resumo da conta |
| GET | /v1/ledger/accounts/:tutorId/statement | ADMIN, RECEPTIONIST, TUTOR (próprio) | Extrato paginado com saldo corrido |
| GET | /v1/ledger/accounts/:tutorId/statement.pdf | ADMIN, RECEPTIONIST, TUTOR (próprio) | Extrato em PDF (MOD-DOC) |
| GET | /v1/ledger/accounts/:tutorId/credit-check | Interno (scheduling), ADMIN, RECEPTIONIST | Avalia limite antes de agendar |
| GET | /v1/ledger/accounts/:tutorId/summary | Interno, ADMIN, agente IA | Resumo estruturado para CRM/IA |
| POST | /v1/ledger/entries | ADMIN, RECEPTIONIST | Lançamento manual (débito/crédito) |
| GET | /v1/ledger/entries/:id | ADMIN, RECEPTIONIST, TUTOR (próprio) | Detalhe do lançamento |
| POST | /v1/ledger/entries/:id/reverse | ADMIN | Estorno por contrapartida |
| POST | /v1/payments | ADMIN, RECEPTIONIST | Registrar pagamento recebido |
| GET | /v1/payments | ADMIN, RECEPTIONIST | Listar (filtros: `tutorId`, `from`, `to`, `method`) |
| POST | /v1/payments/:id/reverse | ADMIN | Estornar pagamento com motivo |
| GET | /v1/payments/:id/receipt | ADMIN, RECEPTIONIST, TUTOR (próprio) | Recibo em PDF |
| POST | /v1/payments/:id/receipt/send | ADMIN, RECEPTIONIST | Reenviar recibo por e-mail/WhatsApp |
| GET/POST | /v1/packages | ADMIN (POST) / ADMIN, RECEPTIONIST (GET) | Catálogo de pacotes do tenant |
| PATCH | /v1/packages/:id | ADMIN | Editar/desativar pacote (não afeta compras feitas) |
| POST | /v1/packages/:id/purchases | ADMIN, RECEPTIONIST | Vender pacote a um tutor |
| GET | /v1/tutors/:tutorId/packages | ADMIN, RECEPTIONIST, TUTOR (próprio) | Pacotes e créditos restantes |
| PATCH | /v1/packages/purchases/:id | ADMIN | Reatribuir pet, suspender, cancelar |
| POST | /v1/packages/purchases/:id/redeem | Interno (medical-record) | Consumir crédito (idempotente) |
| GET | /v1/ledger/reports/receivables | ADMIN | Contas a receber por faixa de atraso |
| GET | /v1/ledger/reports/cashflow | ADMIN | Entradas por período e forma de pagamento |
| GET/PATCH | /v1/billing-settings | ADMIN | Políticas financeiras do tenant |

### Schema Zod — pacote `packages/shared-types`

```typescript
import { z } from 'zod'

export const MoneyCentsSchema = z.number().int().min(1).max(100_000_000)

export const PaymentMethodSchema = z.enum([
  'CASH','PIX_MANUAL','CARD_MACHINE_DEBIT','CARD_MACHINE_CREDIT',
  'BANK_TRANSFER','PACKAGE_CREDIT','OTHER',
])

export const EntryCategorySchema = z.enum([
  'SERVICE','PRODUCT','NO_SHOW_FEE','PACKAGE_PURCHASE','PACKAGE_REDEMPTION',
  'PAYMENT','PAYMENT_REVERSAL','ADJUSTMENT','FEE_WAIVER','DISCOUNT',
])

export const CreateLedgerEntrySchema = z.object({
  tutorId: z.string().uuid(),
  direction: z.enum(['DEBIT','CREDIT']),
  amountCents: MoneyCentsSchema,
  category: EntryCategorySchema,
  description: z.string().min(3).max(200),
  internalNotes: z.string().max(1000).optional(),
  petId: z.string().uuid().optional(),
  occurredAt: z.string().datetime().optional(),   // default: now()
  idempotencyKey: z.string().uuid(),              // exigido em POST manual
}).refine(d => !d.occurredAt || new Date(d.occurredAt) <= new Date(), {
  message: 'Lançamento não pode ter data futura', path: ['occurredAt'],
})

export const CreatePaymentSchema = z.object({
  tutorId: z.string().uuid(),
  amountCents: MoneyCentsSchema,
  method: PaymentMethodSchema,
  receivedAt: z.string().datetime(),
  notes: z.string().max(1000).optional(),
  proofUrl: z.string().url().optional(),
  // Vazio = alocação automática FIFO
  allocations: z.array(z.object({
    debitEntryId: z.string().uuid(),
    amountCents: MoneyCentsSchema,
  })).optional(),
  idempotencyKey: z.string().uuid(),
}).superRefine((d, ctx) => {
  if (d.allocations?.length) {
    const sum = d.allocations.reduce((a, x) => a + x.amountCents, 0)
    if (sum > d.amountCents) {
      ctx.addIssue({ code: 'custom', path: ['allocations'],
        message: 'Soma das alocações excede o valor pago' })
    }
  }
})

export const CreatePackagePurchaseSchema = z.object({
  tutorId: z.string().uuid(),
  petId: z.string().uuid().optional(),
  paymentMethod: PaymentMethodSchema,
  priceOverrideCents: MoneyCentsSchema.optional(),  // desconto exige role ADMIN
  idempotencyKey: z.string().uuid(),
})

export const CreditCheckResponseSchema = z.object({
  allowed: z.boolean(),
  warning: z.boolean(),
  requiresOverride: z.boolean(),
  balanceCents: z.number().int(),
  projectedCents: z.number().int(),
  limitCents: z.number().int().nullable(),
  overdueDays: z.number().int(),
  message: z.string(),
})

// Contrato consumido pelo CRM e pelo agente de IA
export const TutorFinancialSummarySchema = z.object({
  tutorId: z.string().uuid(),
  balanceCents: z.number().int(),
  status: z.enum(['CREDIT','SETTLED','DEBT','OVERDUE']),
  oldestOpenDebitAt: z.string().datetime().nullable(),
  overdueDays: z.number().int(),
  openDebitsCount: z.number().int(),
  activePackages: z.array(z.object({
    purchaseId: z.string().uuid(),
    name: z.string(),
    creditsRemaining: z.number().int(),
    expiresAt: z.string().datetime(),
  })),
  lastPaymentAt: z.string().datetime().nullable(),
  totalSpent12mCents: z.number().int(),
})
```

### Códigos de Erro Padronizados

| Código | HTTP | Cenário |
|---|---|---|
| ERR_LEDGER_001 | 404 | Conta, lançamento, pagamento ou pacote não encontrado neste tenant |
| ERR_LEDGER_002 | 422 | Valor inválido (≤ 0, acima do teto, data futura) |
| ERR_LEDGER_003 | 422 | Forma de pagamento não habilitada para o tenant |
| ERR_LEDGER_004 | 409 | Lançamento já estornado / pagamento já revertido |
| ERR_LEDGER_005 | 409 | Tentativa de alterar lançamento imutável |
| ERR_LEDGER_006 | 409 | Limite de crédito excedido — exige override de admin |
| ERR_LEDGER_007 | 409 | Pacote expirado, suspenso ou sem créditos disponíveis |
| ERR_LEDGER_008 | 422 | Serviço não coberto pelo pacote |
| ERR_LEDGER_009 | 409 | Alocação inválida (excede valor pago ou débito já quitado) |
| ERR_LEDGER_010 | 403 | Papel sem permissão financeira para a operação |
| ERR_LEDGER_011 | 409 | Conta em revisão de consistência — operação sensível bloqueada |
| ERR_LEDGER_012 | 409 | `idempotencyKey` reutilizada com payload divergente |

## 6. Máquinas de Estado

### Lançamento (ledger_entry)

```
(criação) ──► POSTED ──(estorno por ADMIN com motivo)──► REVERSED (terminal)
                 │
                 └─(quitação parcial/total via alocação)──► POSTED (settled_cents cresce)
```

> Não existe estado `DRAFT` nem `DELETED`. Um lançamento nasce definitivo. Correção é sempre um **novo** lançamento inverso, vinculado por `reverses_entry_id`.

### Pagamento

```
RECORDED ──(alocação automática ou manual)──► RECORDED (allocated_cents cresce)
    │
    └─(reversão por ADMIN + motivo)──► REVERSED (terminal)
                                          │
                                          └─► recibo associado vai a CANCELLED
```

### Compra de Pacote

```
                 ┌─(último crédito consumido)──► CONSUMED (terminal)
ACTIVE ──────────┤
                 ├─(expires_at atingido, job diário)──► EXPIRED (terminal, sem reembolso)
                 │
                 └─(pet transferido/óbito ou decisão do admin)──► SUSPENDED
                                                                     │
                                          ┌──(reatribuição de pet)───┘
                                          ▼
                                       ACTIVE
                                          │
                    (cancelamento excepcional por ADMIN + justificativa)
                                          ▼
                                     CANCELLED (terminal — gera crédito em conta, não dinheiro)
```

### Recibo

```
PENDING ──(PDF gerado pelo MOD-DOC)──► ISSUED ──(e-mail/WhatsApp entregue)──► SENT
   │                                       │
   └───────────(pagamento revertido)───────┴──► CANCELLED (terminal)
```

**Efeitos colaterais por transição:**

| De | Para | Evento RabbitMQ | Notificações | Audit Log |
|---|---|---|---|---|
| — | Entry POSTED (DEBIT) | `lancamento.criado`, `saldo.alterado` | Alerta na agenda se cruzar o limite | ✓ |
| — | Payment RECORDED | `pagamento.registrado`, `saldo.alterado` | Recibo em PDF; e-mail ao tutor; tag de inadimplente removida se quitado | ✓ |
| POSTED | REVERSED | `lancamento.estornado` | Notifica tutor se o lançamento era visível no Portal | ✓ |
| RECORDED | REVERSED | `pagamento.estornado` | Recibo cancelado; débitos reabertos; alerta ao admin | ✓ |
| — | Purchase ACTIVE | `pacote.comprado` | Confirmação ao tutor com validade explícita | ✓ |
| ACTIVE | CONSUMED | `pacote.consumido` | Oferta de renovação pelo MOD-CRM | ✓ |
| ACTIVE | EXPIRED | `pacote.expirado` | Aviso ao tutor; oportunidade de recompra | ✓ |
| — | Conta em atraso | `inadimplencia.detectada` | Tag no MOD-TUTOR; régua de cobrança no MOD-CRM | ✓ |
| Atraso | Quitado | `inadimplencia.resolvida` | Remoção da tag; encerramento da régua | ✓ |

## 7. Regras de Negócio & Edge Cases

| # | Cenário | Comportamento Esperado | Módulos Afetados |
|---|---|---|---|
| RN-01 | Imutabilidade absoluta | Lançamento nunca é editado nem excluído; erro vira contrapartida vinculada — exigência do PRD §7.4 | MOD-ADMIN |
| RN-02 | Sinal do saldo | Positivo = crédito do tutor; negativo = inadimplência. Convenção única em toda a plataforma | MOD-PORTAL, MOD-CRM, MOD-AI |
| RN-03 | Idempotência de evento | `(tenant_id, source_type, source_id, direction)` único; reentrega nunca duplica débito | MOD-PRONT, MOD-AGENDA |
| RN-04 | Idempotência de API | Todo POST que move dinheiro exige `idempotencyKey`; repetição com mesmo payload devolve o mesmo recurso (**200**), com payload diferente retorna `ERR_LEDGER_012` | Frontend, MOD-AI |
| RN-05 | Preço é snapshot | O ledger recebe o valor já praticado no atendimento; alteração futura da tabela de preços nunca altera lançamento existente | MOD-PRONT, MOD-AGENDA |
| RN-06 | Alocação FIFO por padrão | Pagamento quita os débitos mais antigos primeiro; alocação manual só por `ADMIN`/`RECEPTIONIST`, auditada | — |
| RN-07 | Crédito excedente fica em conta | Sistema não devolve dinheiro; sobra vira saldo positivo consumido no próximo débito | MOD-PORTAL |
| RN-08 | Pacote: 90 dias, sem reembolso | Validade padrão de 90 dias; crédito não usado expira e **nada é devolvido** — decisão de produto, configurável por pacote | MOD-AGENDA, MOD-PORTAL |
| RN-09 | Aviso antes da expiração | Avisos em D-15 e D-3 por padrão; expiração sem aviso prévio é falha de produto, não regra de negócio | MOD-CRM, MOD-NOTIF |
| RN-10 | Casamento de pacote por serviço | Crédito só cobre `service_id` listado no pacote; nunca por equivalência de valor | MOD-AGENDA |
| RN-11 | Consumo de crédito é serializado | `SELECT ... FOR UPDATE` na compra impede `credits_used > credits_total` em corrida | MOD-PRONT |
| RN-12 | Anulação de atendimento devolve crédito | `atendimento.anulado` reverte o `package_credit_usages` (`reverted_at`) e devolve o crédito, respeitando a validade original | MOD-PRONT |
| RN-13 | Cancelamento tardio = 24h | Abaixo de `cancellation_window_hours` (padrão 24) aplica-se `no_show_fee_percent` sobre o valor do serviço | MOD-AGENDA, MOD-CRM |
| RN-14 | Multa começa desligada | `no_show_fee_percent = 0` na instalação; o tenant liga conscientemente após ver a métrica de prejuízo | MOD-IDENT |
| RN-15 | Limite de crédito é opt-in | `credit_limit_cents = null` não bloqueia nada; com limite, o excedente exige override de `TENANT_ADMIN` com justificativa auditada | MOD-AGENDA, MOD-SEC |
| RN-16 | Tag de inadimplente é automática nos dois sentidos | Aplicada após `overdue_days` e **removida na quitação**, sem intervenção manual | MOD-TUTOR, MOD-CRM |
| RN-17 | Conta criada preguiçosamente | Não se cria conta no cadastro do tutor; a primeira consulta ou lançamento cria com saldo zero | MOD-TUTOR |
| RN-18 | Divergência não se autocorrige | Job de reconciliação marca `needs_review` e alerta; nunca ajusta saldo silenciosamente | MOD-ADMIN |
| RN-19 | Preparado para gateway | `payments.external_ref` e `method` extensível permitem plugar PSP sem migração destrutiva; a v1 não processa dinheiro | Fase futura |
| RN-20 | Sem NFS-e na v1 | O sistema emite **recibo**, não nota fiscal; o texto do PDF deixa isso explícito para não induzir o tenant a erro fiscal | MOD-DOC, jurídico |
| RN-21 | Numeração de recibo | Sequencial por tenant e ano (`2026/000123`), gerado por sequence dedicada; recibo cancelado **não** reaproveita número | MOD-DOC |
| RN-22 | Anonimização do tutor preserva o ledger | Lançamentos e pagamentos sobrevivem à anonimização (obrigação fiscal/contábil); o vínculo aponta para o tutor anonimizado e campos livres são varridos | MOD-TUTOR, MOD-SEC |
| RN-23 | Data do fato ≠ data do registro | `occurred_at` pode ser retroativa (serviço de ontem lançado hoje); `posted_at` nunca. O extrato ordena por `occurred_at`, a auditoria por `posted_at` | MOD-ADMIN |
| RN-24 | Desconto é lançamento, não edição | Desconto concedido vira `CREDIT` com `category = DISCOUNT` e justificativa — o valor cheio do serviço permanece visível | MOD-PRONT |
| RN-25 | Recepção não estorna | Estorno de lançamento e reversão de pagamento são exclusivos de `TENANT_ADMIN`; o balcão registra, o gestor corrige | MOD-IDENT |

## 8. Eventos RabbitMQ (Mensageria Assíncrona)

Exchange: `petshop.events` (topic) | DLX habilitado com backoff exponencial (1s, 5s, 30s, 5min)

| Evento (routing key) | Publisher | Consumers | Payload Mínimo |
|---|---|---|---|
| `lancamento.criado` | billing-ledger-service | crm-automation, portal-bff, audit | `{ tenantId, entryId, tutorId, direction, amountCents, category, balanceAfterCents, occurredAt }` |
| `lancamento.estornado` | billing-ledger-service | crm-automation, portal-bff, audit | `{ tenantId, entryId, reversalEntryId, reason, reversedBy, timestamp }` |
| `saldo.alterado` | billing-ledger-service | tutor-service (cache/tag), scheduling (credit-check), portal-bff | `{ tenantId, tutorId, balanceCents, previousBalanceCents, timestamp }` |
| `pagamento.registrado` | billing-ledger-service | document-service (recibo), notification, crm-automation, audit | `{ tenantId, paymentId, tutorId, amountCents, method, receivedAt, receiptId }` |
| `pagamento.estornado` | billing-ledger-service | document-service (cancela recibo), notification, audit | `{ tenantId, paymentId, reason, reversedBy, timestamp }` |
| `pacote.comprado` | billing-ledger-service | notification, crm-automation, portal-bff, audit | `{ tenantId, purchaseId, tutorId, petId, packageName, creditsTotal, expiresAt }` |
| `pacote.credito.consumido` | billing-ledger-service | portal-bff, crm-automation, audit | `{ tenantId, purchaseId, attendanceId, creditsRemaining, expiresAt }` |
| `pacote.expirado` | billing-ledger-service | crm-automation (recompra), notification, audit | `{ tenantId, purchaseId, tutorId, creditsLost, expiredAt }` |
| `pacote.consumido` | billing-ledger-service | crm-automation (renovação), audit | `{ tenantId, purchaseId, tutorId, consumedAt }` |
| `inadimplencia.detectada` | billing-ledger-service | tutor-service (tag), crm-automation (régua), audit | `{ tenantId, tutorId, balanceCents, overdueDays, oldestOpenDebitAt }` |
| `inadimplencia.resolvida` | billing-ledger-service | tutor-service (remove tag), crm-automation, audit | `{ tenantId, tutorId, settledAt }` |
| `recibo.emitido` | billing-ledger-service | notification, portal-bff, audit | `{ tenantId, receiptId, paymentId, tutorId, documentId, number }` |

**Consome:** `atendimento.concluido` (gera débito ou consome crédito de pacote), `atendimento.anulado` (estorno e devolução de crédito), `agendamento.cancelado` / `agendamento.noshow` (taxa quando fura a janela de 24h), `tutor.anonimizado` (varredura de campos livres), `pet.transferido` / `pet.obito` (suspende pacote vinculado), `servico.preco.alterado` (apenas log — nunca reprecifica histórico).

## 9. Segurança & LGPD

### Controle de Acesso por Operação

| Operação | Super Admin | Tenant Admin | Recepção | Banhista/Tosador | Veterinário | Motorista | Tutor |
|---|---|---|---|---|---|---|---|
| Ver saldo do tutor | — | ✓ | ✓ | — | ✓ (só indicador) | — | ✓ (próprio) |
| Ver extrato completo | — | ✓ | ✓ | — | — | — | ✓ (próprio, sem notas internas) |
| Lançar débito manual | — | ✓ | ✓ | — | — | — | — |
| Lançar crédito manual / desconto | — | ✓ | — | — | — | — | — |
| Registrar pagamento | — | ✓ | ✓ | — | — | — | — |
| Estornar lançamento | — | ✓ | — | — | — | — | — |
| Reverter pagamento | — | ✓ | — | — | — | — | — |
| Alocação manual de pagamento | — | ✓ | ✓ | — | — | — | — |
| Vender pacote | — | ✓ | ✓ | — | — | — | — |
| Cancelar/suspender pacote | — | ✓ | — | — | — | — | — |
| Override de limite de crédito | — | ✓ | — | — | — | — | — |
| Configurar `billing_settings` | — | ✓ | — | — | — | — | — |
| Relatórios financeiros do tenant | — | ✓ | — | — | — | — | — |
| Emitir/reenviar recibo | — | ✓ | ✓ | — | — | — | ✓ (baixar o próprio) |

> Super Admin **não** acessa valores nem extrato de tutor — mesma restrição do PRD §5 aplicada ao prontuário. O que o Super Admin enxerga (MOD-ADMIN) é telemetria agregada e anonimizada do tenant: volume de lançamentos, latência, taxa de erro. Suporte a incidente financeiro se dá por `entryId` e log estruturado, nunca pela leitura do extrato.

### Audit Log — ações que DEVEM gerar registro imutável

- `ledger.entry_created` (manual — com valor, categoria e autor), `ledger.entry_reversed` (motivo obrigatório)
- `ledger.payment_recorded` (valor, método, quem recebeu), `ledger.payment_reversed` (motivo obrigatório)
- `ledger.allocation_manual` — **quitação manual fora do FIFO é o vetor clássico de desvio no balcão**
- `ledger.discount_granted` — desconto concedido, por quem e com qual justificativa
- `ledger.credit_limit_overridden` — quem autorizou agendar acima do limite
- `ledger.package_cancelled`, `ledger.package_reassigned`, `ledger.package_price_overridden`
- `ledger.settings_updated` (diff de `billing_settings` — mudar multa ou limite é decisão sensível)
- `ledger.statement_exported` — exportação de extrato em massa
- `ledger.reconciliation_divergence` — divergência detectada, com valores comparados

### Dados Pessoais (LGPD)

| Campo | Categoria | Base Legal | Retenção | Exportável | Deletável |
|---|---|---|---|---|---|
| Lançamentos e saldo | Dado pessoal financeiro | Execução de contrato + obrigação legal (guarda contábil) | 5 anos após o exercício | ✓ | — (retenção legal) |
| Pagamentos e recibos | Dado pessoal financeiro | Obrigação legal (fiscal/contábil) | 5 anos | ✓ | — |
| `internal_notes` | Juízo de valor sobre o titular | Legítimo interesse | 5 anos | ✓ (direito de acesso) | ✓ (redação do trecho) |
| `proof_url` (comprovante) | Pode conter dado bancário de terceiro | Legítimo interesse | 12 meses | ✓ | ✓ após 12 meses |
| Pacotes e consumo | Dado pessoal de consumo | Execução de contrato | 5 anos | ✓ | — |

> **Anonimização do tutor não apaga o ledger.** A obrigação de guarda contábil (Código Civil art. 1.194; prazo decadencial fiscal de 5 anos) prevalece sobre o pedido de exclusão — art. 16, I da LGPD. Na anonimização, `ledger_entries.tutor_id` passa a apontar para o registro anonimizado, `internal_notes` e `notes` são varridos e redigidos, `proof_url` é destruído, e o `description` mantém apenas a natureza do serviço. O direito de acesso é atendido pelo extrato exportável; o direito de exclusão é atendido **após** o prazo de retenção, e a recusa temporária deve ser comunicada ao titular com a base legal — não silenciosamente.

## 10. Performance & Observabilidade

### Cache Redis

| Dado | TTL | Chave | Invalida quando |
|---|---|---|---|
| Saldo da conta | 60s | `ledger:balance:{tenantId}:{tutorId}` | `saldo.alterado` (invalidação ativa, não só TTL) |
| Resultado do credit-check | 30s | `ledger:creditcheck:{tenantId}:{tutorId}` | `saldo.alterado`, alteração de `billing_settings` |
| Pacotes ativos do tutor | 300s | `ledger:packages:{tenantId}:{tutorId}` | `pacote.*` |
| Resumo financeiro (CRM/IA) | 120s | `ledger:summary:{tenantId}:{tutorId}` | `saldo.alterado`, `pagamento.registrado` |
| `billing_settings` do tenant | 900s | `ledger:settings:{tenantId}` | PATCH em settings |

> O saldo **nunca** é servido do cache em operação de escrita. Lançamento, pagamento e consumo de crédito leem a conta com `SELECT ... FOR UPDATE` direto no Postgres. O cache existe para leitura de tela e para o `credit-check` da agenda, onde 30s de defasagem custam menos que a latência somada em cada abertura de calendário.

### Métricas de Negócio (Pino structured log)

```json
{ "metric": "receivables_overdue_cents", "tenantId": "...", "value": 184500, "unit": "cents", "bucket": "30_60d" }
```

- `ledger_entry_created_total`: lançamentos por categoria e origem — contínuo
- `receivables_total_cents` e `receivables_overdue_cents`: contas a receber por faixa (0–30, 30–60, 60+ dias) — diário; é o indicador que o dono do petshop abre primeiro
- `payment_recorded_total` por `method`: revela a realidade do balcão (quanto ainda é dinheiro vivo) — semanal
- `days_sales_outstanding`: prazo médio de recebimento por tenant — mensal
- `package_attach_rate`: % de tutores com pacote ativo — mensal; é a métrica de recorrência do produto
- `package_expiry_waste_cents`: valor de crédito expirado sem uso — **mensal, e é uma métrica de alerta, não de receita**: expiração alta significa cliente frustrado e churn adiante
- `no_show_total` e `no_show_fee_charged_cents`: prejuízo de no-show e quanto foi efetivamente cobrado
- `credit_override_total`: overrides de limite por autorizador — revisão semanal; concentração num único usuário é sinal
- `manual_allocation_total`: quitações fora do FIFO — auditoria contínua
- `ledger_duplicate_event_total`: reentregas barradas pela idempotência — saúde do broker
- `ledger_reconciliation_divergence_total`: divergências de saldo — **qualquer valor acima de zero é incidente P1**
- `payment_reversal_total`: reversões de pagamento; pico indica erro de treinamento no balcão ou fraude

### SLOs

| Endpoint | p95 | Observação |
|---|---|---|
| `GET /v1/ledger/accounts/:tutorId` | 100ms | Exibido no cabeçalho da ficha do tutor |
| `GET .../credit-check` | 80ms | Chamado a cada tentativa de agendamento — não pode custar UX |
| `GET .../statement` | 400ms | Paginação por cursor; saldo de abertura por lookup, não por soma |
| `POST /v1/payments` | 500ms | Transação com alocação FIFO + publicação de evento |
| `POST /v1/ledger/entries` | 300ms | Lock de conta + gravação + evento |
| Consumo de `atendimento.concluido` | 1s (p99) | Da publicação ao débito visível no extrato |
| Job diário de expiração/inadimplência | 10min | Por tenant, em janela de baixa (03:00 BRT) |

## 11. Questões em Aberto

| # | Questão | Impacto | Decisor | Prazo |
|---|---|---|---|---|
| 1 | Gateway de pagamento (PIX com baixa automática): qual PSP e em que fase? Decidido **fora da v1**; o modelo já reserva `external_ref` e método extensível | MOD-LEDGER, MOD-PORTAL, custo transacional | PM + Tech Lead | Pós-Fase 6 |
| 2 | Emissão de NFS-e: o tenant vai cobrar isso cedo (é obrigação municipal dele). Integrar (ex.: Focus/eNotas) ou manter fora do escopo? | MOD-DOC, jurídico, posicionamento | PM + jurídico | Fase 6 |
| 3 | Numeração de recibo por tenant e ano — validar com contador se o formato atende a exigência de sequencialidade | MOD-DOC | PM + contador | Fase 2 |
| 4 | Pacote cancelado por decisão do admin vira crédito em conta (não dinheiro). Confirmar com jurídico se resiste ao CDC quando o cancelamento parte do consumidor | MOD-LEDGER, CDC | Jurídico | Fase 2 |
| 5 | Validade de 90 dias e ausência de reembolso precisam constar do **termo de adesão** assinado no ato da compra — cláusula não informada é cláusula inválida (CDC art. 46) | MOD-DOC, jurídico | Jurídico + PM | Fase 2 |
| 6 | Multa de no-show: percentual sobre o serviço é o modelo certo, ou valor fixo por tenant seria mais previsível para o tutor? | MOD-AGENDA, UX | PM | Fase 3 |
| 7 | Comissionamento de profissional a partir dos lançamentos — demanda recorrente do setor, hoje fora de escopo. Vira módulo próprio ou extensão daqui? | MOD-LEDGER, MOD-IDENT | PM | Pós-MVP |
| 8 | Fechamento de caixa por turno/operador (conferência do balcão) — não previsto no PRD, mas é a primeira coisa que a recepção pede | MOD-LEDGER, operação | PM | Fase 3 |
| 9 | Retenção de 5 anos vs. custo: extratos antigos vão para armazenamento frio ou permanecem quentes no Postgres? | MOD-SEC, infra | Tech Lead + DPO | Fase 7 |
| 10 | O agente de IA pode **registrar** pagamento (ex.: tutor diz "já paguei no PIX") ou apenas consultar saldo e enviar extrato? Assumido: **apenas consulta** | MOD-AI, risco de fraude | PM + Tech Lead | Fase 8 |
