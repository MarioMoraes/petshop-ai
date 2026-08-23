# PRD Detalhado — Agenda e Operação (Banho, Tosa e Serviços)

**Módulo:** MOD-AGENDA
**Arquivo:** 06/15
**Prioridade:** P0
**Fase de Implementação:** 3 — Agenda e Operação
**Serviço Backend:** scheduling-service (porta 3006)
**Tabelas Principais:** services, service_pricing, professionals, professional_schedules, professional_services, calendar_blocks, appointments, appointment_items, appointment_recurrences, appointment_status_log
**Data:** 2026-08-23
**Status:** Draft

---

## 1. Visão Geral

**Contexto de negócio.** A agenda é o coração operacional do petshop e o único módulo que a equipe olha o dia inteiro. Hoje ela é um caderno ou uma planilha compartilhada, e os três defeitos são sempre os mesmos: **conflito** (dois pets grandes marcados para o mesmo banhista às 9h), **subutilização** (o banhista fica ocioso porque ninguém sabia que havia buraco às 14h) e **esquecimento** (o tutor não aparece porque ninguém lembrou). Cada um desses defeitos custa dinheiro de forma direta e mensurável. Este módulo transforma a agenda em estrutura: serviço com duração e preço por porte, profissional com jornada e capacidade, e um agendamento que sabe dizer se cabe.

**Recorte deliberado da v1.** A agenda **não vira PDV nem controle de estoque**. Ela agenda, executa e conclui — e a conclusão vira um débito na conta corrente do tutor (MOD-LEDGER), não uma venda com carrinho. O Taxi Dog fica no MOD-TAXI, como serviço complementar pendurado no agendamento (§7.6 do PRD-mãe), e o lembrete por WhatsApp fica no MOD-CRM, disparado pelos eventos daqui. A recorrência gera ocorrências reais, não uma "regra viva" que precise ser interpretada em toda leitura.

**Integração sistêmica.** Upstream: MOD-IDENT (papéis, jornada do tenant em `tenant_settings.business_hours`, profissionais criados a partir de membership com papel operacional — RN-06 de identidade_tenancy_01), MOD-PET (pet, porte e pelagem definem duração e preço; `alerts[]` do prontuário bloqueia de forma suave), MOD-TUTOR (titular e saldo), MOD-LEDGER (`billing_settings.credit_limit_cents` decide se o débito bloqueia). Downstream: **MOD-LEDGER** (`atendimento.concluido` é o gatilho de 90% dos débitos), **MOD-PRONT** (o atendimento concluído é o registro clínico do MOD-PRONT-01), MOD-TAXI, MOD-CRM (lembrete, confirmação e campanha de retorno), MOD-PORTAL (agendamento online), MOD-NOTIF, MOD-ADMIN, MOD-AI (a tool "tem horário na quinta?" é este serviço).

---

## 2. Sub-Features

| ID | Nome | Descrição | Must/Should/Nice |
|---|---|---|---|
| MOD-AGENDA-01 | Catálogo de Serviços | Serviço com duração e preço **por porte**, categoria e profissionais habilitados | Must Have |
| MOD-AGENDA-02 | Profissionais e Jornada | Agenda por profissional, jornada semanal e capacidade simultânea | Must Have |
| MOD-AGENDA-03 | Bloqueios e Folgas | Indisponibilidade pontual ou recorrente por profissional ou por todo o tenant | Must Have |
| MOD-AGENDA-04 | Agendamento | Criação com cálculo de duração, detecção de conflito e alertas do pet | Must Have |
| MOD-AGENDA-05 | Recorrência | "Banho toda terça" via RRULE, com ocorrências materializadas | Must Have |
| MOD-AGENDA-06 | Agendamento Online | Tutor agenda pelo Portal respeitando disponibilidade real e antecedência | Must Have |
| MOD-AGENDA-07 | Check-in e Check-out | Chegada, execução e entrega do pet, com o débito nascendo na conclusão | Must Have |
| MOD-AGENDA-08 | Cancelamento, Reagendamento e No-show | Política de 24h, taxa configurável e crédito de reposição | Must Have |
| MOD-AGENDA-09 | Visão do Dia | Painel consolidado e por profissional, em tempo real | Must Have |
| MOD-AGENDA-10 | Gates de Agendamento | Alerta clínico crítico e inadimplência acima do limite exigem override auditado | Must Have |
| MOD-AGENDA-11 | Disponibilidade Consultável | `GET /v1/availability` como operação atômica — a tool que o agente de IA usa | Should Have |
| MOD-AGENDA-12 | Encaixe e Lista de Espera | Fila FIFO por dia; vaga liberada notifica o próximo | Nice to Have |

---

## 3. Critérios de Aceite

### [MOD-AGENDA-01] — Catálogo de Serviços

**AC-01 (Happy Path)**
- **Dado** um `TENANT_ADMIN` configurando "Banho"
- **Quando** cria o serviço com duração base de 60 min, categoria `BATH`, preço por porte (P R$ 50,00 / M R$ 70,00 / G R$ 90,00 / GG R$ 120,00) e habilita a banhista Ana e o tosador Carlos
- **Então** retorna **201** com o serviço e as quatro linhas de `service_pricing`, e ele passa a aparecer no seletor de agendamento

**AC-02 (Validação / Erro)**
- **Dado** um serviço sem preço definido para o porte GIANT
- **Quando** um pet de porte GIANT é agendado nele
- **Então** retorna **422** `ERR_AGENDA_002` "Este serviço não tem preço definido para o porte Gigante" — o sistema **não** inventa preço por interpolação, porque preço errado no fechamento é briga no balcão

**AC-03 (Edge Case — serviço em uso)**
- **Dado** um serviço com 40 agendamentos futuros
- **Quando** o admin tenta excluí-lo
- **Então** retorna **409** `ERR_AGENDA_011` com a contagem; a desativação (`active = false`) é permitida e some do seletor sem tocar nos agendamentos existentes

**AC-04 (Edge Case — alteração de preço)**
- **Dado** um agendamento futuro criado quando o banho custava R$ 70,00
- **Quando** o admin sobe o preço para R$ 80,00
- **Então** o agendamento **mantém** `price_cents = 7000` (o preço é congelado na criação, RN-04); o novo valor vale só para agendamentos criados dali em diante

---

### [MOD-AGENDA-02] — Profissionais e Jornada

**AC-01 (Happy Path)**
- **Dado** um membro com papel `BATHER` (MOD-IDENT-06)
- **Quando** o admin define a jornada — seg a sex 08:00–18:00, sábado 08:00–13:00, almoço 12:00–13:00 — e `max_concurrent_pets = 3`
- **Então** retorna **200** e a agenda dele passa a aceitar agendamentos apenas dentro da jornada

**AC-02 (Validação / Erro)**
- **Dado** uma jornada que começa 18:00 e termina 08:00
- **Quando** é salva
- **Então** retorna **422** `ERR_AGENDA_002` "O horário de término deve ser depois do início"

**AC-03 (Edge Case — jornada além do horário do tenant)**
- **Dado** que `tenant_settings.business_hours` fecha o petshop às 18:00
- **Quando** a jornada do profissional vai até 20:00
- **Então** a jornada é aceita e **avisa** (não bloqueia): o veterinário que atende emergência depois do fechamento existe, e a agenda não pode negar a realidade da operação

**AC-04 (Edge Case — desligamento)**
- **Dado** um profissional com 12 agendamentos futuros
- **Quando** o admin o desativa
- **Então** retorna **409** `ERR_AGENDA_012` listando os agendamentos e oferecendo **reatribuição em lote** para outro profissional habilitado; sem reatribuir, a desativação não conclui

---

### [MOD-AGENDA-03] — Bloqueios e Folgas

**AC-01 (Happy Path)**
- **Dado** que a Ana pediu folga na sexta
- **Quando** o admin cria um bloqueio de dia inteiro para ela
- **Então** retorna **201**, a agenda dela recusa agendamentos naquele dia e a visão consolidada mostra a ausência

**AC-02 (Edge Case — bloqueio sobre agendamento existente)**
- **Dado** que a sexta da Ana já tem 4 agendamentos
- **Quando** o bloqueio é criado
- **Então** retorna **409** `ERR_AGENDA_012` com os agendamentos afetados e as opções de **reatribuir** ou **cancelar em lote** (cancelamento em lote por bloqueio não gera taxa de no-show, RN-12)

**AC-03 (Edge Case — feriado do tenant)**
- **Dado** um bloqueio de tenant inteiro (feriado)
- **Quando** o Portal calcula disponibilidade
- **Então** o dia inteiro some da oferta para todos os profissionais, sem precisar de um bloqueio por pessoa

---

### [MOD-AGENDA-04] — Agendamento

**AC-01 (Happy Path)**
- **Dado** o pet Thor (porte GRANDE, pelagem DUPLA) e o serviço "Banho e Tosa" (base 90 min)
- **Quando** a recepção agenda para quinta às 09:00 com a Ana
- **Então** a duração é calculada (90 × 1,35 = 122 → arredondado para **135 min**, na grade de 15 min), `ends_at` sai 11:15, o preço do porte GRANDE é congelado, retorna **201** com status `CONFIRMED` e publica `agendamento.criado`

**AC-02 (Validação / Erro — conflito de capacidade)**
- **Dado** que a Ana tem `max_concurrent_pets = 3` e já tem 3 atendimentos sobrepostos às 09:30
- **Quando** um quarto pet é agendado nessa faixa
- **Então** retorna **409** `ERR_AGENDA_004` "Ana já tem 3 pets neste horário", com `suggestions[]` — os três horários livres mais próximos do pedido

**AC-03 (Validação / Erro — profissional não habilitado)**
- **Dado** que o Carlos não está habilitado no serviço "Vacinação"
- **Quando** o agendamento é tentado com ele
- **Então** retorna **409** `ERR_AGENDA_005` "Carlos não executa este serviço"

**AC-04 (Edge Case — fora da jornada ou em bloqueio)**
- **Dado** um agendamento às 12:30, dentro do almoço da Ana
- **Quando** é submetido
- **Então** retorna **409** `ERR_AGENDA_005` "Ana não atende neste horário", também com `suggestions[]`

**AC-05 (Edge Case — concorrência)**
- **Dado** dois atendentes salvando o último lugar das 09:00 no mesmo instante
- **Quando** ambos submetem
- **Então** um recebe **201** e o outro **409** `ERR_AGENDA_004`. A garantia é do banco, não do serviço: a checagem de capacidade roda dentro de uma transação `SERIALIZABLE` sobre a janela do profissional (RN-13) — comparar antes e inserir depois, sem trava, deixa a corrida passar

**AC-06 (Edge Case — pet ou tutor indisponível)**
- **Dado** um pet com status `DECEASED` ou `TRANSFERRED_OUT`, ou um tutor anonimizado
- **Quando** o agendamento é tentado
- **Então** retorna **409** `ERR_AGENDA_010` com o motivo — a agenda é o último lugar onde um óbito não registrado pode virar constrangimento

---

### [MOD-AGENDA-05] — Recorrência

**AC-01 (Happy Path)**
- **Dado** "banho toda terça às 09:00 com a Ana"
- **Quando** a recepção cria a recorrência com `RRULE:FREQ=WEEKLY;BYDAY=TU` e sem data-fim
- **Então** as ocorrências das **próximas 12 semanas** são materializadas como agendamentos reais, retorna **201** com `recurrenceId` e a contagem gerada

**AC-02 (Validação / Erro)**
- **Dado** uma RRULE malformada ou com `FREQ=MINUTELY`
- **Quando** é submetida
- **Então** retorna **422** `ERR_AGENDA_002` — só `DAILY`, `WEEKLY` e `MONTHLY` são aceitas

**AC-03 (Edge Case — ocorrência em conflito)**
- **Dado** que a terça da semana 5 cai em feriado bloqueado
- **Quando** a série é gerada
- **Então** as demais ocorrências são criadas normalmente e a conflitante entra em `skipped[]` na resposta, com o motivo. **A série não falha por causa de uma ocorrência** — recusar as doze porque uma esbarrou em feriado obrigaria a recepção a agendar tudo à mão

**AC-04 (Edge Case — editar a série)**
- **Dado** uma série ativa
- **Quando** o tutor pede para mudar o horário
- **Então** a API exige `scope`: `THIS_ONE` (destaca a ocorrência da série), `THIS_AND_FUTURE` (encerra a regra atual e cria outra) ou `ALL`. Ocorrências **já concluídas nunca são alteradas**, em nenhum escopo

---

### [MOD-AGENDA-06] — Agendamento Online (Portal do Tutor)

**AC-01 (Happy Path)**
- **Dado** um tutor logado no Portal com o pet Mel
- **Quando** consulta a disponibilidade de "Banho" para quinta e escolhe 14:00
- **Então** o agendamento entra **CONFIRMED** (padrão do tenant), retorna **201** e dispara `agendamento.criado` — o WhatsApp de confirmação sai pelo MOD-CRM

**AC-02 (Validação / Erro — antecedência mínima)**
- **Dado** `tenant_settings.min_booking_lead_hours = 2` e agora são 09:00
- **Quando** o tutor tenta agendar 10:30
- **Então** retorna **422** `ERR_AGENDA_007` "Agendamentos pelo site precisam de 2 horas de antecedência. O próximo horário disponível é 11:00." — a mensagem **sempre** traz a alternativa

**AC-03 (Edge Case — aprovação ligada)**
- **Dado** `tenant_settings.online_booking_requires_approval = true`
- **Quando** o tutor agenda
- **Então** entra **PENDING**, o horário fica **reservado por 24h**, a recepção vê a fila e aprova ou recusa. Sem decisão em 24h, expira automaticamente (job `booking-approval-expiry`) e o tutor é avisado

**AC-04 (Edge Case — tutor inadimplente)**
- **Dado** um tutor com débito acima de `billing_settings.credit_limit_cents`
- **Quando** tenta agendar pelo Portal
- **Então** retorna **409** `ERR_AGENDA_008` com o saldo e o convite a falar com o petshop. **O override do RN-11 não existe no Portal** — quem libera exceção é a equipe, não o devedor

**AC-05 (Edge Case — pet sem responsável)**
- **Dado** um pet cujo único responsável foi anonimizado (LGPD)
- **Quando** aparece na lista do Portal
- **Então** ele não aparece: o Portal lista por vínculo ativo, e sem tutor não há quem agende

---

### [MOD-AGENDA-07] — Check-in e Check-out

**AC-01 (Happy Path)**
- **Dado** o Thor agendado para 09:00
- **Quando** o tutor chega e a recepção faz check-in às 09:05
- **Então** o status vai para `CHECKED_IN`, `checkin_at` é gravado, publica `atendimento.iniciado` e os alertas clínicos do pet aparecem na tela do profissional (RN-09 de pets_03)

**AC-02 (Happy Path — conclusão)**
- **Dado** o Thor em atendimento
- **Quando** o profissional faz check-out às 11:20, opcionalmente com peso aferido, observação e fotos do resultado
- **Então** o status vai para `COMPLETED`, publica **`atendimento.concluido`** — que vira o débito no MOD-LEDGER, o registro clínico no MOD-PRONT, o `last_attendance_at` do pet e a foto `GROOMING_RESULT` no álbum (MOD-PET-04)

**AC-03 (Validação / Erro — ordem dos estados)**
- **Dado** um agendamento ainda `CONFIRMED`
- **Quando** o check-out é tentado sem check-in
- **Então** retorna **409** `ERR_AGENDA_006` "Faça o check-in antes de concluir o atendimento"

**AC-04 (Edge Case — idempotência do dinheiro)**
- **Dado** um check-out reenviado por duplo clique ou retry do cliente
- **Quando** chega o segundo `POST /v1/appointments/:id/checkout` com o mesmo `idempotencyKey`
- **Então** retorna **200** com o mesmo resultado do primeiro e **não** gera segundo débito. Sem a chave, retorna 422 — a convenção vale para todo POST que move dinheiro (ver financeiro_tutor_05 §5)

**AC-05 (Edge Case — check-in muito antes)**
- **Dado** um agendamento para as 15:00 e o tutor que chegou às 09:00
- **Quando** a recepção faz check-in
- **Então** é permitido e registrado: o pet **está** ali. `checkin_at` guarda a hora real e a métrica de pontualidade compara com `starts_at`, sem inventar bloqueio que a recepção teria de contornar

**AC-06 (Edge Case — serviço adicional durante a execução)**
- **Dado** que o tosador percebeu que o Thor precisa de hidratação
- **Quando** acrescenta o item ao atendimento antes do check-out
- **Então** o item entra em `appointment_items` com seu preço congelado, a duração estimada é atualizada e o débito final soma os dois — sem precisar de um segundo agendamento

---

### [MOD-AGENDA-08] — Cancelamento, Reagendamento e No-show

**AC-01 (Happy Path)**
- **Dado** um agendamento para quinta às 09:00 e hoje é terça
- **Quando** o tutor cancela pelo Portal
- **Então** status vai para `CANCELLED`, sem taxa (acima da janela de 24h), publica `agendamento.cancelado` e o horário volta a ficar disponível

**AC-02 (Edge Case — cancelamento tardio)**
- **Dado** um agendamento em menos de 24h
- **Quando** é cancelado
- **Então** o cancelamento **acontece** (o pet não vem de qualquer jeito), status `CANCELLED` com `late = true`, e um débito de `tenant_settings.no_show_fee_percent` sobre o valor é lançado no MOD-LEDGER. Com o percentual em 0 ou nulo, nenhuma taxa é gerada — o padrão do sistema não é punir

**AC-03 (Edge Case — no-show)**
- **Dado** um agendamento cujo horário passou sem check-in
- **Quando** o job `no-show-sweeper` roda (a cada 30 min, tolerância de 60 min após `starts_at`)
- **Então** status vai para `NO_SHOW`, publica `agendamento.no_show`, aplica a mesma taxa do AC-02 e alimenta a tag de comportamento do tutor no MOD-CRM

**AC-04 (Edge Case — reagendamento)**
- **Dado** um agendamento confirmado
- **Quando** é reagendado para outro horário
- **Então** o registro original vai para `RESCHEDULED` (terminal) apontando `rescheduled_to_id`, e um novo agendamento nasce. **A cadeia é preservada** porque "quantas vezes este tutor remarcou" é dado de negócio, não ruído — e um UPDATE no lugar destruiria essa informação

**AC-05 (Edge Case — reagendamento tardio repetido)**
- **Dado** um tutor que remarcou a mesma ocorrência três vezes dentro da janela de 24h
- **Quando** tenta a quarta
- **Então** o reagendamento é aceito, e o evento carrega `rescheduleCount` para o MOD-CRM decidir o que fazer. A agenda **relata**; a política comercial é de outro módulo

---

### [MOD-AGENDA-09] — Visão do Dia

**AC-01 (Happy Path)**
- **Dado** a recepção abrindo o painel do dia
- **Quando** carrega `GET /v1/agenda/day?date=2026-08-24`
- **Então** retorna as faixas de todos os profissionais com pet, tutor, serviço, status, alertas e ocupação — em **até 300 ms** (§10)

**AC-02 (Edge Case — profissional sem jornada no dia)**
- **Dado** a Ana de folga
- **Quando** o painel carrega
- **Então** a coluna dela aparece marcada como ausente, e não some: uma coluna que desaparece faz a equipe achar que o sistema perdeu a pessoa

---

### [MOD-AGENDA-10] — Gates de Agendamento

**AC-01 (Happy Path — alerta clínico)**
- **Dado** um pet com alergia `CRITICAL` a um produto usado no serviço
- **Quando** a recepção agenda
- **Então** retorna **409** `ERR_AGENDA_009` com `alerts[]` e `overrideToken`; **repetir o POST com `acknowledgedAlerts: true` conclui o agendamento** e grava quem reconheceu o risco. É bloqueio suave: informa, exige confirmação consciente e não impede o atendimento

**AC-02 (Happy Path — inadimplência)**
- **Dado** um tutor com débito acima do limite e `billing_settings.credit_limit_cents` definido
- **Quando** a recepção agenda no balcão
- **Então** retorna **409** `ERR_AGENDA_008`; um `TENANT_ADMIN` pode repetir com `override: { reason }`, que é auditado como `appointment.credit_override`. Recepção não tem esse poder

**AC-03 (Edge Case — limite nulo)**
- **Dado** `credit_limit_cents = null`
- **Quando** qualquer tutor devedor agenda
- **Então** o agendamento passa, e o saldo devedor aparece na tela como **alerta**. Este é o padrão do sistema: alertar sempre, bloquear só por opt-in (decisão de negócio 6)

---

### [MOD-AGENDA-11] — Disponibilidade Consultável

**AC-01 (Happy Path)**
- **Dado** o serviço "Banho", o pet Mel e a semana de 24/08
- **Quando** chama `GET /v1/availability?serviceId=&petId=&from=&to=`
- **Então** retorna os horários livres já com a duração calculada para **aquele pet** — porte e pelagem mudam o tamanho do buraco necessário, então disponibilidade sem pet é aproximação

**AC-02 (Edge Case — nenhum horário)**
- **Dado** a semana lotada
- **Quando** a consulta roda
- **Então** retorna lista vazia **mais** `nextAvailable` — a data do próximo horário livre. Uma resposta vazia sozinha obriga o tutor a adivinhar a próxima consulta

---

## 4. Modelo de Dados

### Tabelas Envolvidas

| Tabela | Campo | Tipo | Obrigatório | Descrição |
|---|---|---|---|---|
| services | id / tenant_id | UUID | ✓ | PK e isolamento (RLS) |
| services | name | String(80) | ✓ | "Banho e Tosa" |
| services | category | Enum | ✓ | BATH, GROOMING, VET, VACCINE, OTHER |
| services | base_duration_min | SmallInt | ✓ | Duração do porte de referência |
| services | requires_vet | Boolean | ✓ | Restringe execução ao papel VET |
| services | active / created_at / updated_at / deleted_at | — | ✓ | Ciclo de vida e soft delete |
| service_pricing | id / tenant_id / service_id / size_id | UUID | ✓ | Preço e duração **por porte** |
| service_pricing | price_cents | BigInt | ✓ | Dinheiro é inteiro em centavos |
| service_pricing | duration_min | SmallInt | — | Sobrescreve o cálculo; nulo usa o fator |
| professionals | id / tenant_id | UUID | ✓ | PK e isolamento |
| professionals | user_id | UUID | — | Membership de origem; nulo = sem login |
| professionals | display_name | String(60) | ✓ | Nome na coluna da agenda |
| professionals | role_key | String(30) | ✓ | GROOMER, BATHER, VET, DRIVER |
| professionals | max_concurrent_pets | SmallInt | ✓ | **Capacidade simultânea**, padrão 1 |
| professionals | color | String(7) | — | Cor da coluna no painel |
| professionals | active | Boolean | ✓ | Desligamento exige reatribuição (AC-04) |
| professional_services | professional_id / service_id | UUID | ✓ | Habilitação N:N |
| professional_schedules | professional_id / weekday | — | ✓ | 0–6; várias faixas por dia (almoço parte o dia) |
| professional_schedules | starts_at_min / ends_at_min | SmallInt | ✓ | Minutos desde meia-noite, fuso do tenant |
| calendar_blocks | id / tenant_id | UUID | ✓ | PK e isolamento |
| calendar_blocks | professional_id | UUID | — | **Nulo = bloqueio do tenant inteiro** (feriado) |
| calendar_blocks | starts_at / ends_at | Timestamptz | ✓ | Janela bloqueada |
| calendar_blocks | reason | String(120) | — | "Folga", "Feriado", "Manutenção" |
| appointments | id / tenant_id | UUID | ✓ | PK e isolamento |
| appointments | pet_id / tutor_id / professional_id | UUID | ✓ | Partes do atendimento |
| appointments | starts_at / ends_at | Timestamptz | ✓ | Janela ocupada; `ends_at` é calculado |
| appointments | status | Enum | ✓ | Ver §6 |
| appointments | source | Enum | ✓ | STAFF, PORTAL, RECURRENCE, AI_AGENT |
| appointments | recurrence_id | UUID | — | Ocorrência de uma série |
| appointments | total_cents | BigInt | ✓ | Soma dos itens, congelada na criação (RN-04) |
| appointments | checkin_at / checkout_at | Timestamptz | — | Horas reais, não as agendadas |
| appointments | cancelled_at / cancel_reason / cancelled_late | — | — | Base da taxa do AC-02 |
| appointments | rescheduled_to_id | UUID | — | Cadeia de remarcações (AC-04) |
| appointments | acknowledged_alerts_by | UUID | — | Quem assumiu o risco clínico (MOD-AGENDA-10) |
| appointments | credit_override_by / credit_override_reason | — | — | Quem liberou o inadimplente e por quê |
| appointments | notes_encrypted | Text | — | Campo livre: pode conter dado pessoal |
| appointments | created_by / created_at / updated_at | — | ✓ | Auditoria |
| appointment_items | id / appointment_id / service_id | UUID | ✓ | Um atendimento pode ter banho + hidratação |
| appointment_items | price_cents / duration_min | — | ✓ | Congelados por item |
| appointment_recurrences | id / tenant_id | UUID | ✓ | PK e isolamento |
| appointment_recurrences | rrule | String(200) | ✓ | iCal RRULE (FREQ DAILY/WEEKLY/MONTHLY) |
| appointment_recurrences | until / materialized_until | Timestamptz | — | Fim da série e horizonte já gerado |
| appointment_status_log | appointment_id / from / to / at / by | — | ✓ | Trilha da máquina de estado, append-only |

### Campos com Criptografia AES-256-GCM (em repouso)

| Campo | Tabela | Justificativa LGPD/PCI |
|---|---|---|
| notes_encrypted | appointments | Campo livre — costuma receber dado do tutor ("tocar o interfone 2, a sogra abre") |
| cancel_reason | appointments | Motivo pode conter dado sensível (doença do tutor, do pet) |

### Índices Necessários

```sql
-- A consulta mais frequente do sistema: "o que tem hoje, por profissional".
CREATE INDEX idx_appointments_day ON appointments(tenant_id, professional_id, starts_at)
  WHERE status NOT IN ('CANCELLED','RESCHEDULED');

-- Detecção de conflito e cálculo de capacidade (RN-13): sobreposição de janelas.
CREATE INDEX idx_appointments_window ON appointments
  USING GIST (professional_id, tstzrange(starts_at, ends_at))
  WHERE status IN ('PENDING','CONFIRMED','CHECKED_IN','IN_PROGRESS');

CREATE INDEX idx_appointments_pet ON appointments(pet_id, starts_at DESC);
CREATE INDEX idx_appointments_tutor ON appointments(tenant_id, tutor_id, starts_at DESC);

-- O varredor de no-show procura por janela vencida sem check-in.
CREATE INDEX idx_appointments_noshow ON appointments(tenant_id, starts_at)
  WHERE status = 'CONFIRMED' AND checkin_at IS NULL;

-- Expiração da reserva de aprovação (AC-03 de MOD-AGENDA-06).
CREATE INDEX idx_appointments_pending ON appointments(tenant_id, created_at)
  WHERE status = 'PENDING';

CREATE INDEX idx_blocks_window ON calendar_blocks(tenant_id, starts_at, ends_at);
CREATE UNIQUE INDEX idx_service_pricing_unique ON service_pricing(service_id, size_id);
CREATE UNIQUE INDEX idx_professional_service ON professional_services(professional_id, service_id);
```

> A exclusão por `EXCLUDE USING GIST` **não** serve aqui: ela proíbe qualquer sobreposição, e a capacidade paralela permite até `max_concurrent_pets`. A garantia vem da transação `SERIALIZABLE` do RN-13, com o índice GIST servindo à velocidade da contagem.

---

## 5. Contratos de API

Todo endpoint exige o contexto assinado pelo gateway (`@petshop/service-auth`) e infere `tenant_id` dele. Erros em `application/problem+json`. Paginação `?page=1&limit=20`.

### Endpoints

| Método | Path | Roles Permitidos | Descrição |
|---|---|---|---|
| GET | /v1/services | Todos os operacionais | Catálogo de serviços |
| POST | /v1/services | ADMIN | Criar serviço |
| PATCH | /v1/services/:id | ADMIN | Editar / desativar |
| PUT | /v1/services/:id/pricing | ADMIN | Preço e duração por porte |
| GET | /v1/professionals | ADMIN, RECEPÇÃO | Profissionais e jornadas |
| POST | /v1/professionals | ADMIN | Criar a partir de um membership |
| PATCH | /v1/professionals/:id | ADMIN | Capacidade, cor, habilitações |
| PUT | /v1/professionals/:id/schedule | ADMIN | Jornada semanal |
| GET | /v1/calendar-blocks | ADMIN, RECEPÇÃO | Bloqueios do período |
| POST | /v1/calendar-blocks | ADMIN | Folga / feriado |
| DELETE | /v1/calendar-blocks/:id | ADMIN | Remover bloqueio |
| GET | /v1/availability | Todos + TUTOR (próprio) | **Horários livres** para um pet e serviço |
| GET | /v1/agenda/day | ADMIN, RECEPÇÃO, PROFISSIONAIS | Visão do dia |
| GET | /v1/appointments | ADMIN, RECEPÇÃO, VET; profissional (próprios); TUTOR (próprios) | Listar com filtros |
| POST | /v1/appointments | ADMIN, RECEPÇÃO, VET; TUTOR (próprio, via Portal) | Agendar |
| GET | /v1/appointments/:id | Conforme acima | Detalhe |
| PATCH | /v1/appointments/:id | ADMIN, RECEPÇÃO | Observação, itens, profissional |
| POST | /v1/appointments/:id/reschedule | ADMIN, RECEPÇÃO; TUTOR (próprio) | Remarcar |
| POST | /v1/appointments/:id/cancel | ADMIN, RECEPÇÃO; TUTOR (próprio) | Cancelar |
| POST | /v1/appointments/:id/checkin | ADMIN, RECEPÇÃO, PROFISSIONAIS | Chegada do pet |
| POST | /v1/appointments/:id/checkout | ADMIN, RECEPÇÃO, PROFISSIONAIS | Conclusão — **exige `idempotencyKey`** |
| POST | /v1/appointments/:id/approve | ADMIN, RECEPÇÃO | Aprovar solicitação do Portal |
| POST | /v1/recurrences | ADMIN, RECEPÇÃO | Criar série |
| PATCH | /v1/recurrences/:id | ADMIN, RECEPÇÃO | Editar com `scope` |
| DELETE | /v1/recurrences/:id | ADMIN, RECEPÇÃO | Encerrar série (futuras) |

### Schema Zod — pacote `packages/shared-types`

```typescript
import { z } from 'zod'

export const AppointmentStatusSchema = z.enum([
  'PENDING', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS',
  'COMPLETED', 'CANCELLED', 'NO_SHOW', 'RESCHEDULED',
])
export type AppointmentStatus = z.infer<typeof AppointmentStatusSchema>

export const AppointmentSourceSchema = z.enum(['STAFF', 'PORTAL', 'RECURRENCE', 'AI_AGENT'])

export const CreateAppointmentSchema = z.object({
  petId: z.uuid(),
  professionalId: z.uuid(),
  startsAt: z.iso.datetime(),
  items: z.array(z.object({ serviceId: z.uuid() })).min(1),
  notes: z.string().max(1000).optional(),
  /** MOD-AGENDA-10: reconhecimento consciente do alerta clínico crítico. */
  acknowledgedAlerts: z.boolean().default(false),
  /** Só TENANT_ADMIN; libera o gate de inadimplência com justificativa auditada. */
  override: z.object({ reason: z.string().min(10).max(300) }).optional(),
})
export type CreateAppointmentInput = z.output<typeof CreateAppointmentSchema>

export const CheckoutSchema = z.object({
  /** Convenção do MOD-LEDGER: todo POST que move dinheiro é idempotente. */
  idempotencyKey: z.uuid(),
  weightKg: z.number().min(0.05).max(120).optional(),
  notes: z.string().max(1000).optional(),
  extraItems: z.array(z.object({ serviceId: z.uuid() })).default([]),
})

export const CancelAppointmentSchema = z.object({
  reason: z.string().max(300).optional(),
  /** O Portal não envia; a recepção pode isentar a taxa do cancelamento tardio. */
  waiveFee: z.boolean().default(false),
})

export const RecurrenceScopeSchema = z.enum(['THIS_ONE', 'THIS_AND_FUTURE', 'ALL'])

export const CreateRecurrenceSchema = z.object({
  petId: z.uuid(),
  professionalId: z.uuid(),
  serviceIds: z.array(z.uuid()).min(1),
  startsAt: z.iso.datetime(),
  rrule: z.string().max(200),
  until: z.iso.datetime().optional(),
})

export const AvailabilityQuerySchema = z.object({
  serviceId: z.uuid(),
  /** Porte e pelagem mudam a duração — disponibilidade sem pet é aproximação. */
  petId: z.uuid(),
  professionalId: z.uuid().optional(),
  from: z.iso.date(),
  to: z.iso.date(),
})

export const AvailabilitySlotSchema = z.object({
  professionalId: z.uuid(),
  professionalName: z.string(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  durationMin: z.number().int(),
  priceCents: z.number().int(),
})

export const AppointmentResponseSchema = z.object({
  id: z.uuid(),
  status: AppointmentStatusSchema,
  source: AppointmentSourceSchema,
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  pet: z.object({ id: z.uuid(), name: z.string(), coverPhotoUrl: z.string().nullable() }),
  tutor: z.object({ id: z.uuid(), fullName: z.string(), phoneMasked: z.string() }),
  professional: z.object({ id: z.uuid(), displayName: z.string() }),
  items: z.array(z.object({
    serviceId: z.uuid(), label: z.string(),
    priceCents: z.number().int(), durationMin: z.number().int(),
  })),
  totalCents: z.number().int(),
  /** Agregado do prontuário — a equipe vê antes de encostar no pet (RN-09 de pets_03). */
  alerts: z.array(z.object({
    type: z.enum(['ALLERGY', 'TEMPERAMENT', 'MEDICAL']),
    severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
    label: z.string(),
  })),
  /** Saldo devedor do tutor, para o alerta do RN-11. */
  tutorBalanceCents: z.number().int(),
  checkinAt: z.iso.datetime().nullable(),
  checkoutAt: z.iso.datetime().nullable(),
  recurrenceId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
})
```

### Códigos de Erro Padronizados

| Código | HTTP | Cenário |
|---|---|---|
| ERR_AGENDA_001 | 404 | Agendamento não encontrado neste tenant |
| ERR_AGENDA_002 | 422 | Dados inválidos (RRULE, jornada, preço ausente para o porte) |
| ERR_AGENDA_003 | 403 | Papel insuficiente para a operação |
| ERR_AGENDA_004 | 409 | Capacidade do profissional esgotada no horário — traz `suggestions[]` |
| ERR_AGENDA_005 | 409 | Profissional não habilitado, fora da jornada ou bloqueado |
| ERR_AGENDA_006 | 409 | Transição inválida para o status atual |
| ERR_AGENDA_007 | 422 | Antecedência mínima não respeitada — traz `nextAvailable` |
| ERR_AGENDA_008 | 409 | Débito acima do limite; exige override de TENANT_ADMIN |
| ERR_AGENDA_009 | 409 | Alerta clínico CRÍTICO; exige `acknowledgedAlerts` |
| ERR_AGENDA_010 | 409 | Pet ou tutor indisponível (óbito, transferência, anonimização) |
| ERR_AGENDA_011 | 409 | Serviço em uso não pode ser excluído |
| ERR_AGENDA_012 | 409 | Profissional com agendamentos futuros — exige reatribuição |

---

## 6. Máquinas de Estado

### Agendamento — Status

```
        (Portal com aprovação ligada)
PENDING ──(aprovação da recepção)──────────► CONFIRMED
   │                                            │
   └──(recusa / 24h sem decisão)──► CANCELLED   │
                                                │
(balcão, Portal sem aprovação, recorrência) ────┤
                                                │
CONFIRMED ──(check-in)──► CHECKED_IN ──(início da execução)──► IN_PROGRESS
   │                          │                                     │
   │                          │                                     │
   │                          └────────(check-out)──────────────────┴──► COMPLETED
   │                                                                       (terminal)
   ├──(cancelamento)──────────► CANCELLED (late = starts_at − now < 24h)
   │                              (terminal)
   ├──(remarcação)────────────► RESCHEDULED ──► aponta rescheduled_to_id
   │                              (terminal)
   └──(horário venceu sem check-in + 60min)──► NO_SHOW
                                                (terminal)
```

**Efeitos colaterais por transição:**

| De | Para | Evento RabbitMQ | Notificações | Audit Log |
|---|---|---|---|---|
| — | PENDING | `agendamento.solicitado` | Aviso à recepção (fila) | ✓ |
| — / PENDING | CONFIRMED | `agendamento.criado` | Confirmação + lembrete agendado (WhatsApp) | ✓ |
| CONFIRMED | CHECKED_IN | `atendimento.iniciado` | — | ✓ |
| CHECKED_IN / IN_PROGRESS | COMPLETED | **`atendimento.concluido`** | "Seu pet está pronto" | ✓ |
| CONFIRMED | CANCELLED | `agendamento.cancelado` | Aviso ao tutor; taxa se `late` | ✓ |
| CONFIRMED | RESCHEDULED | `agendamento.reagendado` | Nova confirmação | ✓ |
| CONFIRMED | NO_SHOW | `agendamento.no_show` | Aviso ao tutor; taxa | ✓ |

> `COMPLETED` é terminal e **não** volta atrás. Erro no fechamento se corrige por estorno no MOD-LEDGER e adendo no MOD-PRONT (MOD-PRONT-09), nunca reabrindo o atendimento — reabrir desfaria um débito que o tutor talvez já tenha pago.

---

## 7. Regras de Negócio & Edge Cases

| # | Cenário | Comportamento Esperado | Módulos Afetados |
|---|---|---|---|
| RN-01 | Duração é calculada, não digitada | `duration = service_pricing.duration_min` do porte, ou `base_duration_min × coats.grooming_time_factor`, arredondado para cima na grade de 15 min | MOD-AGENDA, MOD-PET |
| RN-02 | Capacidade paralela por profissional | Conflito é `count(sobreposições) >= max_concurrent_pets`, não "existe sobreposição". Padrão 1 preserva o AC do PRD-mãe; o petshop que seca em paralelo aumenta | MOD-AGENDA |
| RN-03 | Preço por porte, sem interpolação | Porte sem preço cadastrado recusa o agendamento (422). Inventar valor vira discussão no balcão | MOD-AGENDA, MOD-LEDGER |
| RN-04 | Preço congela na criação | `total_cents` é fotografia do momento; reajuste não retroage a agendamento existente | MOD-AGENDA, MOD-LEDGER |
| RN-05 | O débito nasce na conclusão | Nem no agendamento nem no check-in. Serviço não executado não gera dívida | MOD-LEDGER |
| RN-06 | Janela de cancelamento de 24h | Abaixo dela, `cancelled_late = true` e taxa de `no_show_fee_percent`; a recepção pode isentar com `waiveFee` | MOD-AGENDA, MOD-LEDGER |
| RN-07 | Antecedência mínima só vale para o Portal | 2h por padrão (`min_booking_lead_hours`). No balcão não existe: o tutor está na frente do atendente | MOD-AGENDA, MOD-PORTAL |
| RN-08 | Agendamento online entra confirmado | Salvo `online_booking_requires_approval`; nesse caso PENDING com reserva de 24h | MOD-AGENDA, MOD-PORTAL |
| RN-09 | Alerta CRÍTICO é bloqueio suave | Exige `acknowledgedAlerts` e grava quem reconheceu. Nunca impede o atendimento | MOD-AGENDA, MOD-PRONT |
| RN-10 | Óbito cancela os futuros | `pet.obito` cancela agendamentos futuros **sem taxa** e suprime notificação ao tutor | MOD-AGENDA, MOD-PET, MOD-CRM |
| RN-11 | Inadimplência alerta; bloqueia por opt-in | Acima de `credit_limit_cents`, override de TENANT_ADMIN com justificativa auditada. Limite nulo nunca bloqueia | MOD-AGENDA, MOD-LEDGER |
| RN-12 | Cancelamento em lote por bloqueio não gera taxa | A falta é do petshop, não do tutor | MOD-AGENDA, MOD-LEDGER |
| RN-13 | Corrida pelo último lugar | Checagem e inserção na mesma transação `SERIALIZABLE` sobre a janela do profissional; conflito de serialização vira 409, não 500 | MOD-AGENDA |
| RN-14 | Recorrência é materializada | Ocorrências reais até 12 semanas à frente, estendidas por job semanal. Regra viva exigiria interpretar RRULE em toda leitura de agenda | MOD-AGENDA, MOD-CRON |
| RN-15 | Uma ocorrência conflitante não derruba a série | Entra em `skipped[]` com o motivo | MOD-AGENDA |
| RN-16 | Remarcação preserva a cadeia | `RESCHEDULED` + `rescheduled_to_id`. "Quantas vezes remarcou" é dado de negócio | MOD-AGENDA, MOD-CRM |
| RN-17 | Check-in fora do horário é permitido | O pet está ali. A hora real vai para `checkin_at` e a métrica compara com `starts_at` | MOD-AGENDA |
| RN-18 | Serviço adicionado durante a execução | Entra como item com preço próprio; não exige novo agendamento | MOD-AGENDA, MOD-LEDGER |
| RN-19 | Fuso é o do tenant | `tenant_settings.timezone` decide o que é "hoje". Horário de verão muda a duração real do dia, e a agenda usa `timestamptz` para não deslocar | MOD-AGENDA, MOD-IDENT |
| RN-20 | Transferência de titularidade com agendamento futuro | Bloqueia com `ERR_PET_005` até cancelar ou reatribuir (AC-02 de MOD-PET-05, já implementado atrás de porta) | MOD-PET, MOD-AGENDA |

---

## 8. Eventos RabbitMQ (Mensageria Assíncrona)

Exchange: `petshop.events` (topic) | DLX habilitado com backoff exponencial (1s, 5s, 30s, 5min)

| Evento (routing key) | Publisher | Consumers | Payload Mínimo |
|---|---|---|---|
| `agendamento.solicitado` | scheduling | crm-automation, notification, audit | `{ tenantId, appointmentId, petId, tutorId, startsAt, timestamp }` |
| `agendamento.criado` | scheduling | crm-automation (lembrete), taxidog, portal-bff, audit | `{ tenantId, appointmentId, petId, tutorId, professionalId, startsAt, totalCents, source, timestamp }` |
| `agendamento.reagendado` | scheduling | crm-automation, taxidog, audit | `{ tenantId, appointmentId, newAppointmentId, startsAt, rescheduleCount, timestamp }` |
| `agendamento.cancelado` | scheduling | billing-ledger (taxa), crm-automation, taxidog, audit | `{ tenantId, appointmentId, late, feeCents, cancelledBy, timestamp }` |
| `agendamento.no_show` | scheduling | billing-ledger, crm-automation, audit | `{ tenantId, appointmentId, tutorId, feeCents, timestamp }` |
| `atendimento.iniciado` | scheduling | medical-record, portal-bff, audit | `{ tenantId, appointmentId, petId, professionalId, timestamp }` |
| **`atendimento.concluido`** | scheduling | **billing-ledger** (débito), **medical-record** (registro), pet-service (`last_attendance_at`, peso), crm-automation, notification, audit | `{ tenantId, appointmentId, petId, tutorId, professionalId, items[], totalCents, weightKg, timestamp }` |
| `agenda.bloqueio.criado` | scheduling | crm-automation, audit | `{ tenantId, blockId, professionalId, startsAt, endsAt, timestamp }` |

Consome: `pet.obito` (cancela futuros sem taxa, RN-10), `pet.transferido` (reatribui o tutor dos futuros), `tutor.anonimizado` e `tutor.mesclado` (revincula), `lancamento.criado` (atualiza o saldo denormalizado usado no gate do RN-11).

---

## 9. Segurança & LGPD

### Controle de Acesso por Operação

| Operação | Super Admin | Tenant Admin | Recepção | Banhista/Tosador | Veterinário | Motorista | Tutor |
|---|---|---|---|---|---|---|---|
| Ver agenda do dia | ✓¹ | ✓ | ✓ | própria | ✓ | corridas | — |
| Ver agendamento | ✓¹ | ✓ | ✓ | próprios | ✓ | corridas | próprios |
| Criar | — | ✓ | ✓ | — | ✓ | — | próprios² |
| Editar | — | ✓ | ✓ | observação | ✓ | — | — |
| Cancelar / remarcar | — | ✓ | ✓ | — | ✓ | — | próprios² |
| Check-in / check-out | — | ✓ | ✓ | ✓ | ✓ | — | — |
| Override de inadimplência | — | ✓ | — | — | — | — | — |
| Reconhecer alerta clínico | — | ✓ | ✓ | — | ✓ | — | — |
| Gerir serviços e jornadas | — | ✓ | — | — | — | — | — |

¹ Somente com grant de suporte ativo e auditoria por leitura.
² Respeitando antecedência mínima, janela de cancelamento e o gate de inadimplência sem override.

### Audit Log — ações que DEVEM gerar registro imutável

- `appointment.created`, `appointment.rescheduled`, `appointment.cancelled` (com `late` e taxa), `appointment.no_show`
- `appointment.checked_in`, `appointment.completed` (com itens e total)
- `appointment.alerts_acknowledged` — **quem assumiu o risco clínico**, e quando
- `appointment.credit_override` — quem liberou o inadimplente, com justificativa
- `service.created/updated/deactivated`, `professional.schedule_updated`, `professional.deactivated`
- `calendar_block.created` com cancelamento em lote

### Dados Pessoais (LGPD)

| Campo | Categoria | Base Legal | Retenção | Exportável | Deletável |
|---|---|---|---|---|---|
| Agendamento (data, serviço, profissional) | Dado pessoal por associação | Execução de contrato | Relação ativa + 5 anos | ✓ | — (base fiscal e clínica) |
| notes_encrypted | Risco de dado sensível | Legítimo interesse | Relação ativa | ✓ | ✓ |
| cancel_reason | Risco de dado sensível | Legítimo interesse | Relação ativa | ✓ | ✓ |
| checkin_at / checkout_at | Dado de comportamento | Execução de contrato | Relação ativa + 5 anos | ✓ | — |

> Anonimização do tutor (MOD-TUTOR-08) **não apaga o agendamento**: o histórico de execução sustenta a contabilidade e o prontuário do pet. O que se apaga é o vínculo identificável — `tutor_id` passa a apontar para o cadastro anonimizado.

---

## 10. Performance & Observabilidade

### Cache Redis

| Dado | TTL | Chave | Invalida quando |
|---|---|---|---|
| Catálogo de serviços | 3600s | `services:{tenantId}` | Criação/edição/desativação de serviço |
| Profissionais e jornadas | 3600s | `professionals:{tenantId}` | Jornada, capacidade ou habilitação alterada |
| Visão do dia | 30s | `agenda:day:{tenantId}:{date}` | Qualquer transição de status naquele dia |
| Disponibilidade calculada | 60s | `avail:{tenantId}:{serviceId}:{sizeId}:{date}` | `agendamento.criado`, `.cancelado`, bloqueio |

> A disponibilidade é cacheada por **porte**, não por pet: dois pets de porte igual e mesma pelagem ocupam o mesmo buraco. O TTL curto existe porque disponibilidade velha vira 409 na cara do tutor.

### Métricas de Negócio (Pino structured log)

```json
{ "metric": "appointment_occupancy_rate", "tenantId": "...", "value": 0.72, "unit": "ratio" }
```

- `appointment_created_total`: por origem (balcão × Portal × recorrência × IA) — contínuo
- `appointment_occupancy_rate`: horas agendadas ÷ horas de jornada disponível — diário, por profissional
- `appointment_no_show_rate`: no-shows ÷ agendamentos do período — semanal (insumo da régua do MOD-CRM)
- `appointment_late_cancel_rate`: cancelamentos dentro da janela de 24h — semanal
- `appointment_lead_time_hours`: distância entre criação e execução — mensal (mede maturidade da agenda)
- `appointment_conflict_total`: 409 de capacidade — contínuo (excesso indica capacidade mal configurada, não demanda alta)
- `checkin_punctuality_min`: `checkin_at − starts_at` — diário
- `service_duration_accuracy`: `(checkout − checkin) ÷ duração estimada` — semanal; desvio persistente significa que a duração base está errada e a agenda inteira está mentindo

### SLOs

| Endpoint | p95 | Observação |
|---|---|---|
| `GET /v1/agenda/day` | 300ms | Painel aberto o dia inteiro, recarregado a cada minuto |
| `GET /v1/availability` | 400ms | Varre jornada, bloqueios e ocupação de vários profissionais |
| `POST /v1/appointments` | 500ms | Inclui a transação SERIALIZABLE do RN-13 |
| `POST /v1/appointments/:id/checkout` | 600ms | Fecha itens, publica o evento que vira dinheiro |

---

## 11. Questões em Aberto

| # | Questão | Impacto | Decisor | Prazo |
|---|---|---|---|---|
| 1 | Duração por porte é tabela (`service_pricing.duration_min`) ou multiplicador sobre a base? O PRD de pets (RN-03) descreve multiplicador; aqui a tabela é a fonte e o multiplicador é fallback | MOD-AGENDA, MOD-PET, precisão da agenda | Tech Lead + PM | Antes da Fase 3 |
| 2 | Encaixe/lista de espera (MOD-AGENDA-12) entra na v1 ou fica para depois do primeiro mês de uso real? | Escopo da Fase 3 | PM | Início da Fase 3 |
| 3 | O horizonte de 12 semanas de materialização da recorrência é suficiente, ou o petshop vende pacote anual de banho? | MOD-AGENDA, MOD-LEDGER (pacotes), volume de linhas | PM comercial | Fase 3 |
| 4 | Profissional pode ver a agenda dos colegas? Hoje a matriz diz "própria" para banhista/tosador | Privacidade interna, usabilidade do painel | PM + cliente-piloto | Fase 3 |
| 5 | `no_show_fee_percent` tem padrão sugerido diferente de zero, ou nasce desligado em todo tenant novo? | MOD-AGENDA, MOD-LEDGER, relação com o cliente | PM comercial | Antes da Fase 3 |
| 6 | Agendamento sem profissional definido ("qualquer um disponível") é aceito, com atribuição no check-in? | MOD-AGENDA, MOD-PORTAL, complexidade do algoritmo | PM | Fase 3 |
