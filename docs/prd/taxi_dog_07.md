# PRD Detalhado — Taxi Dog (Leva-e-Traz)

**Módulo:** MOD-TAXI
**Arquivo:** 07/15
**Prioridade:** P1
**Fase de Implementação:** 3 — Agenda e Operação
**Serviço Backend:** taxidog-service (porta **3008**)
**Tabelas Principais:** taxi_rides, taxi_ride_status_log, taxi_vehicles, taxi_zones, taxi_settings
**Data:** 2026-08-27
**Status:** Draft

---

## 1. Visão Geral

**Contexto de negócio.** O leva-e-traz é o serviço que faz o tutor sem carro, sem tempo ou sem paciência virar cliente recorrente — e é também o serviço que mais dá errado quando é gerido por WhatsApp e memória. Os três defeitos são conhecidos: **a corrida esquecida** (o pet ficou esperando na calçada porque ninguém passou a lista para o motorista), **a janela mentirosa** ("passo entre 8 e 9" vira 10h30 e o tutor perde a manhã) e **a cobrança perdida** (o motorista rodou, e o valor nunca chegou à conta corrente). Este módulo transforma o leva-e-traz em corridas com dono, janela prometida, status rastreável e preço que vira débito sozinho.

**Recorte deliberado da v1.** O Taxi Dog **não é uma agenda paralela** e **não é um sistema de logística**. Ele é um complemento pendurado no agendamento (§7.6 do PRD-mãe): não existe corrida sem `appointment_id`. Não há roteirização otimizada, rastreamento por GPS em tempo real, nem cálculo de rota por API de mapas na v1 — a ordenação é pela janela prometida, e a posição do motorista é o status que ele mesmo marca. As coordenadas já existem em `tutor_addresses.latitude/longitude` e ficam guardadas para quando a otimização entrar (MOD-TAXI-10).

**Duas coisas que este módulo deliberadamente não constrói de novo.** A **capacidade do motorista** é a mesma máquina do MOD-AGENDA: o motorista é um `professionals` com `role_key = 'DRIVER'`, tem jornada em `professional_schedules`, folga em `calendar_blocks` e `max_concurrent_pets` significando quantos pets cabem na van ao mesmo tempo. E a **cobrança** não inventa fluxo de dinheiro: a corrida entra como `appointment_items` do agendamento que ela serve, com preço congelado e duração zero, de modo que o débito nasce do `atendimento.concluido` que o MOD-LEDGER já consome. **Nenhuma linha nova de código de dinheiro.**

**Integração sistêmica.** Upstream: **MOD-AGENDA** (o agendamento é o dono da corrida; profissionais, jornadas e bloqueios são lidos de lá), **MOD-TUTOR** (endereço, `is_primary`, `access_notes`, telefone), **MOD-PET** (porte, para saber se cabe na van; alertas do prontuário que o motorista precisa ver antes de pôr a mão no pet), MOD-IDENT (papel DRIVER, fuso do tenant). Downstream: **MOD-LEDGER** (via o item do agendamento), **MOD-CRM** (cada mudança de status vira mensagem no WhatsApp), MOD-NOTIF, MOD-PORTAL (o tutor acompanha a corrida), MOD-ADMIN, MOD-AI (a tool "que horas o motorista passa aqui?").

---

## 2. Sub-Features

| ID | Nome | Descrição | Must/Should/Nice |
|---|---|---|---|
| MOD-TAXI-01 | Solicitação e Pernas | Corrida de ida, de volta ou ambas, sempre presa a um agendamento | Must Have |
| MOD-TAXI-02 | Endereço e Ponto de Coleta | Herdado do tutor ou informado na hora, congelado na corrida | Must Have |
| MOD-TAXI-03 | Motorista e Veículo | Atribuição respeitando jornada, folga e capacidade da van | Must Have |
| MOD-TAXI-04 | Execução e Máquina de Status | A caminho, chegou, coletado, entregue — pela mão do motorista | Must Have |
| MOD-TAXI-05 | Cobrança da Corrida | Preço congelado como item do agendamento; débito nasce na conclusão | Must Have |
| MOD-TAXI-06 | Zonas e Tabela de Preço | Preço por região a partir do CEP, com valor padrão de fallback | Should Have |
| MOD-TAXI-07 | Painel do Dia e Rota do Motorista | Corridas do dia por motorista, ordenadas por janela | Must Have |
| MOD-TAXI-08 | Aviso ao Tutor | Cada transição relevante publica evento; o envio é do MOD-CRM | Must Have |
| MOD-TAXI-09 | Cancelamento e Coleta Frustrada | Ninguém em casa, endereço errado, pet que não entra na van | Must Have |
| MOD-TAXI-10 | Roteirização Otimizada | Ordem de parada por distância e janela, com estimativa de chegada | Nice to Have |

---

## 3. Critérios de Aceite

### [MOD-TAXI-01] — Solicitação e Pernas

**AC-01 (Happy Path)**
- **Dado** um agendamento do Thor para quinta às 10:00
- **Quando** a recepção marca "leva-e-traz: ida e volta" com janela de coleta 08:30–09:30 e de entrega 12:00–13:00
- **Então** retorna **201** com **duas** corridas (`leg = PICKUP` e `leg = DROPOFF`) compartilhando o `appointment_id`, ambas em `REQUESTED`, e publica `taxi.solicitado` para cada uma

**AC-02 (Validação / Erro — sem agendamento)**
- **Dado** um `POST /v1/taxi/rides` sem `appointmentId`
- **Quando** é submetido
- **Então** retorna **422** `ERR_TAXI_002`. Taxi Dog é serviço complementar (AC de alto nível do §7.6): corrida solta viraria uma segunda agenda para conciliar, e é exatamente isso que este módulo não faz

**AC-03 (Edge Case — janela incoerente com o serviço)**
- **Dado** um agendamento que começa às 10:00
- **Quando** a janela de coleta é informada como 10:30–11:00
- **Então** retorna **422** `ERR_TAXI_003` "A coleta precisa terminar antes do início do atendimento". A janela de entrega, simetricamente, não pode começar antes de `ends_at`

**AC-04 (Edge Case — duplicidade de perna)**
- **Dado** um agendamento que já tem corrida de ida
- **Quando** é pedida uma segunda ida
- **Então** retorna **409** `ERR_TAXI_004` com a corrida existente. Uma perna por agendamento, exceto quando a anterior está `CANCELLED` ou `FAILED` — aí a nova é permitida e a antiga fica no histórico

**AC-05 (Edge Case — só a volta)**
- **Dado** o tutor que traz o pet mas não pode buscar
- **Quando** pede apenas `DROPOFF`
- **Então** é aceito e cobrado como uma perna. Ida e volta **não** é pacote indivisível: a assimetria é o caso comum, não a exceção

---

### [MOD-TAXI-02] — Endereço e Ponto de Coleta

**AC-01 (Happy Path)**
- **Dado** um tutor com endereço primário cadastrado
- **Quando** a corrida é criada sem informar endereço
- **Então** o endereço primário é resolvido, **copiado cifrado para a corrida** e `address_id` guarda a origem. Alterar o cadastro do tutor depois não reescreve onde o motorista foi

**AC-02 (Happy Path — endereço da vez)**
- **Dado** que hoje o pet está na casa da mãe do tutor
- **Quando** a recepção informa CEP, número, complemento e ponto de referência na própria corrida
- **Então** a corrida grava esse endereço sem tocar no cadastro do tutor, e `address_id` fica nulo

**AC-03 (Validação / Erro — tutor sem endereço)**
- **Dado** um tutor com `data_completeness = PARTIAL` e nenhum endereço
- **Quando** a corrida é criada sem endereço explícito
- **Então** retorna **422** `ERR_TAXI_005` "Informe o endereço de coleta ou cadastre o endereço do tutor"

**AC-04 (Edge Case — instruções de acesso)**
- **Dado** um endereço com `access_notes` ("portão azul, interfone 12, o cachorro late mas não morde")
- **Quando** o motorista abre a corrida
- **Então** o texto aparece em destaque, decifrado, junto com o telefone do tutor. É a informação que decide entre entregar e voltar de mãos vazias

---

### [MOD-TAXI-03] — Motorista e Veículo

**AC-01 (Happy Path)**
- **Dado** o motorista João, jornada de terça a sábado 08:00–18:00, van com capacidade 4
- **Quando** a corrida das 08:30 é atribuída a ele
- **Então** status vai para `ASSIGNED`, publica `taxi.atribuido`, e a corrida entra na rota do dia dele

**AC-02 (Validação / Erro — fora da jornada ou em folga)**
- **Dado** o João com folga cadastrada em `calendar_blocks` na quinta
- **Quando** uma corrida de quinta é atribuída a ele
- **Então** retorna **409** `ERR_TAXI_006` com o motivo (`OUT_OF_SCHEDULE` ou `BLOCKED`) e a lista de motoristas disponíveis naquela janela

**AC-03 (Edge Case — van cheia)**
- **Dado** o João com 4 pets já embarcados em janelas sobrepostas e capacidade efetiva 4
- **Quando** a quinta corrida sobreposta é atribuída
- **Então** retorna **409** `ERR_TAXI_007` "A van do João já está com 4 pets nesse horário", com `suggestions[]` de outras janelas ou motoristas. A checagem e a gravação acontecem na **mesma transação `SERIALIZABLE`** (RN-09), como no RN-13 do MOD-AGENDA

**AC-04 (Edge Case — capacidade efetiva)**
- **Dado** o João com `max_concurrent_pets = 4` dirigindo hoje a van pequena, de capacidade 2
- **Quando** a corrida é atribuída com esse veículo
- **Então** o limite aplicado é **2** — `min(motorista, veículo)`. Sem veículo informado, vale só o do motorista

**AC-05 (Edge Case — atribuição adiada)**
- **Dado** que a escala de amanhã ainda não está fechada
- **Quando** a corrida é criada sem motorista
- **Então** ela fica em `REQUESTED` e aparece na fila "sem motorista" do painel do dia. O job `taxi-unassigned-alert` avisa a recepção quando faltam menos de 12h para a janela e a corrida ainda não tem dono

---

### [MOD-TAXI-04] — Execução e Máquina de Status

**AC-01 (Happy Path — a ida)**
- **Dado** a corrida de coleta do Thor, janela 08:30–09:30, atribuída ao João
- **Quando** o João marca "saí" às 08:20, "cheguei" às 08:41, "peguei o pet" às 08:44 e "entreguei no petshop" às 09:05
- **Então** os status percorrem `EN_ROUTE → ARRIVED → ONBOARD → DELIVERED`, cada transição grava hora real em `taxi_ride_status_log` e publica o evento correspondente

**AC-02 (Happy Path — a volta destravada pela conclusão)**
- **Dado** a corrida de entrega do Thor, presa ao agendamento
- **Quando** o `atendimento.concluido` chega
- **Então** a corrida de volta ganha `ready_at` e sobe para o topo da rota do motorista. Antes disso ela aparece esmaecida: **não se leva de volta um pet que ainda está molhado**

**AC-03 (Validação / Erro — ordem dos estados)**
- **Dado** uma corrida em `ASSIGNED`
- **Quando** o motorista marca "entreguei" sem passar por `ONBOARD`
- **Então** retorna **409** `ERR_TAXI_008` "Marque a coleta do pet antes da entrega"

**AC-04 (Edge Case — motorista só mexe no que é dele)**
- **Dado** o motorista Pedro autenticado
- **Quando** tenta mudar o status de uma corrida atribuída ao João
- **Então** retorna **403** `ERR_TAXI_009`. `taxi:operate` no papel DRIVER vale para as **próprias** corridas; a recepção e o admin operam qualquer uma (§9)

**AC-05 (Edge Case — offline no meio da rua)**
- **Dado** o motorista sem sinal ao coletar o pet
- **Quando** marca `ONBOARD` 20 minutos depois, já com sinal, informando `occurredAt` retroativo
- **Então** é aceito: `occurred_at` é a hora informada, `recorded_at` é a hora do servidor, e as duas ficam no log. Retroagir além de 6h ou para o futuro é recusado com **422** `ERR_TAXI_003`

**AC-06 (Edge Case — troca de motorista no meio)**
- **Dado** a van do João quebrada com o pet ainda a bordo
- **Quando** a recepção reatribui a corrida ao Pedro
- **Então** a reatribuição é permitida em qualquer status não terminal, gera linha no log com o motorista anterior, e **o status não retrocede**: o pet continua `ONBOARD`, só muda de mãos

---

### [MOD-TAXI-05] — Cobrança da Corrida

**AC-01 (Happy Path)**
- **Dado** o tenant com o serviço de catálogo "Taxi Dog" (categoria `TAXI`) e preço de R$ 20,00 por perna
- **Quando** a ida e a volta são criadas
- **Então** **dois** `appointment_items` entram no agendamento, R$ 20,00 cada, `duration_min = 0`, e `appointments.total_cents` sobe R$ 40,00. Na conclusão, o `atendimento.concluido` já leva os itens e o MOD-LEDGER debita tudo junto — sem evento de dinheiro próprio deste módulo

**AC-02 (Validação / Erro — sem serviço de taxi no catálogo)**
- **Dado** um tenant que nunca cadastrou o serviço de categoria `TAXI`
- **Quando** tenta criar uma corrida
- **Então** retorna **422** `ERR_TAXI_010` "Cadastre o serviço de Taxi Dog no catálogo antes de oferecer leva-e-traz", com link para `/agenda/servicos`

**AC-03 (Edge Case — corrida cancelada antes da execução)**
- **Dado** a ida cancelada na véspera
- **Quando** o cancelamento é gravado
- **Então** o `appointment_item` correspondente é **removido** e `total_cents` recalculado. Corrida não rodada não se cobra, e o agendamento ainda não foi concluído — nada saiu para o ledger

**AC-04 (Edge Case — coleta frustrada)**
- **Dado** a ida em `FAILED` porque ninguém atendeu (MOD-TAXI-09)
- **Quando** o motorista registra a falha
- **Então** o item **permanece** se `charge_failed_pickup = true` nas configurações do tenant, e é removido caso contrário. O padrão é **false**: a v1 não cobra por porta fechada sem o tenant pedir

**AC-05 (Edge Case — preço congela na criação)**
- **Dado** que o tenant reajustou o Taxi Dog de R$ 20,00 para R$ 25,00 hoje
- **Quando** uma corrida criada ontem é executada hoje
- **Então** ela cobra R$ 20,00. Mesma regra do RN-04 do MOD-AGENDA, pelo mesmo motivo: reajuste não retroage a compromisso assumido

---

### [MOD-TAXI-06] — Zonas e Tabela de Preço

**AC-01 (Happy Path)**
- **Dado** as zonas "Centro" (R$ 15,00) e "Zona Sul" (R$ 30,00), cada uma com uma lista de prefixos de CEP
- **Quando** uma corrida é criada para um CEP `04567-000`
- **Então** resolve "Zona Sul", congela R$ 30,00 no item e grava `zone_id` na corrida

**AC-02 (Edge Case — CEP fora de todas as zonas)**
- **Dado** um CEP que nenhum prefixo cobre
- **Quando** a corrida é criada
- **Então** usa `taxi_settings.default_price_cents` e marca `zone_id = null` com `price_source = 'DEFAULT'`. Com `block_outside_zones = true`, em vez disso retorna **422** `ERR_TAXI_011` com o CEP — o petshop que não atende a cidade inteira precisa poder dizer não

**AC-03 (Edge Case — prefixos sobrepostos)**
- **Dado** as zonas "Centro" (`0100`) e "Centro Histórico" (`010012`)
- **Quando** o CEP `01001-250` é resolvido
- **Então** vence o **prefixo mais longo**. Empate exato entre duas zonas é recusado na criação da zona com **409** `ERR_TAXI_012`

**AC-04 (Edge Case — preço combinado na hora)**
- **Dado** um caso especial acertado no balcão
- **Quando** a recepção informa `priceCentsOverride` com justificativa
- **Então** o valor é aceito, `price_source = 'MANUAL'`, e a justificativa vai para o audit log. Exige `taxi:configure` — o motorista e a recepção comum não redefinem preço

---

### [MOD-TAXI-07] — Painel do Dia e Rota do Motorista

**AC-01 (Happy Path)**
- **Dado** o dia com 14 corridas entre três motoristas
- **Quando** a recepção abre `GET /v1/taxi/board?date=2026-08-27`
- **Então** recebe as corridas agrupadas por motorista, ordenadas pelo início da janela, com uma faixa "sem motorista" no topo — e um contador de corridas atrasadas (janela vencida sem `DELIVERED`)

**AC-02 (Happy Path — a visão do motorista)**
- **Dado** o João autenticado no celular
- **Quando** abre `GET /v1/taxi/my-route?date=hoje`
- **Então** vê só as próprias corridas, na ordem da janela, cada uma com nome e foto do pet, endereço decifrado, instruções de acesso, telefone do tutor com link de discagem e os **alertas clínicos** do pet (RN-08)

**AC-03 (Edge Case — corrida de volta ainda não liberada)**
- **Dado** uma volta cujo atendimento não concluiu
- **Quando** o motorista abre a rota
- **Então** ela aparece na lista, esmaecida e com o rótulo "aguardando o atendimento terminar", não escondida: o motorista precisa saber que ela existe para planejar a tarde

**AC-04 (Edge Case — fuso do tenant)**
- **Dado** um tenant em `America/Manaus`
- **Quando** o painel pergunta por "hoje"
- **Então** o dia é recortado pelo fuso do tenant, não pelo do servidor nem pelo do navegador (RN-12)

---

### [MOD-TAXI-08] — Aviso ao Tutor

**AC-01 (Happy Path)**
- **Dado** a corrida que muda para `EN_ROUTE`
- **Quando** a transição é gravada
- **Então** publica `taxi.a_caminho` com `tenantId`, `rideId`, `tutorId`, `petId` e a janela. O **envio** da mensagem é do MOD-CRM: este módulo não fala com WhatsApp

**AC-02 (Edge Case — transições que não avisam)**
- **Dado** as transições `REQUESTED → ASSIGNED` e a reatribuição de motorista
- **Quando** acontecem
- **Então** publicam evento para auditoria e painel, mas o payload traz `notify: false`. Avisar o tutor a cada remanejo interno é ruído que faz o cliente silenciar o canal

**AC-03 (Edge Case — óbito do pet)**
- **Dado** o `pet.obito` consumido
- **Quando** corridas futuras daquele pet são canceladas
- **Então** o cancelamento é gravado com `notify: false`, como no RN-10 do MOD-AGENDA. Um "sua corrida foi cancelada" automático nessa hora é crueldade operacional

---

### [MOD-TAXI-09] — Cancelamento e Coleta Frustrada

**AC-01 (Happy Path)**
- **Dado** a corrida de ida de amanhã
- **Quando** o tutor avisa que vai trazer o pet ele mesmo
- **Então** status vai para `CANCELLED` com motivo, o item de cobrança é removido (AC-03 de MOD-TAXI-05) e publica `taxi.cancelado`

**AC-02 (Happy Path — ninguém em casa)**
- **Dado** o João em `ARRIVED` há 10 minutos, tocando a campainha
- **Quando** registra "ninguém atendeu" com o motivo
- **Então** status vai para `FAILED` com `failure_reason = 'NO_ONE_HOME'`, publica `taxi.falhou` e **o agendamento não é cancelado** — a recepção decide se o tutor ainda traz o pet. Cancelar a agenda por conta própria seria decidir pelo cliente

**AC-03 (Edge Case — pet que não entra na van)**
- **Dado** um pet de porte GIANT e uma van que já leva outros três
- **Quando** o motorista registra `FAILED` com `PET_REFUSED` ou `NO_SPACE`
- **Então** a falha é gravada com o motivo, e o motivo alimenta a métrica `taxi_failure_rate` por causa — capacidade mal configurada aparece como padrão, não como azar

**AC-04 (Edge Case — cancelamento em cascata do agendamento)**
- **Dado** um agendamento cancelado
- **Quando** o `agendamento.cancelado` é consumido
- **Então** todas as corridas não terminais daquele agendamento vão para `CANCELLED` com `reason = 'APPOINTMENT_CANCELLED'`. Corrida órfã é pet esperando na calçada

**AC-05 (Edge Case — reagendamento)**
- **Dado** um agendamento remarcado de quinta para sexta
- **Quando** o `agendamento.reagendado` é consumido
- **Então** as corridas **não são movidas automaticamente**: elas vão para `CANCELLED` com `reason = 'APPOINTMENT_RESCHEDULED'` e a corrida nova nasce presa ao novo agendamento (que é um registro novo, pelo RN-16 do MOD-AGENDA). A recepção confirma as janelas, porque a disponibilidade do motorista na sexta é outra história

**AC-06 (Edge Case — cancelar corrida já em execução)**
- **Dado** uma corrida em `ONBOARD` com o pet dentro da van
- **Quando** o cancelamento é tentado
- **Então** retorna **409** `ERR_TAXI_008`. De `ONBOARD` só se sai por `DELIVERED` ou `FAILED` — o pet está fisicamente em algum lugar e o sistema precisa dizer onde

---

## 4. Modelo de Dados

### Tabelas Envolvidas

| Tabela | Campo | Tipo | Obrigatório | Descrição |
|---|---|---|---|---|
| taxi_rides | id / tenant_id | UUID | ✓ | PK e isolamento (RLS) |
| taxi_rides | appointment_id | UUID | ✓ | **Sem corrida órfã** (AC-02 de MOD-TAXI-01) |
| taxi_rides | pet_id / tutor_id | UUID | ✓ | Denormalizados do agendamento: a rota do motorista não pode depender de join cross-serviço |
| taxi_rides | leg | Enum | ✓ | PICKUP, DROPOFF — **uma linha por perna** |
| taxi_rides | status | Enum | ✓ | Ver §6 |
| taxi_rides | window_starts_at / window_ends_at | Timestamptz | ✓ | A janela **prometida ao tutor**, não a estimada |
| taxi_rides | driver_id | UUID | — | `professionals` com `role_key = 'DRIVER'`; nulo = fila sem dono |
| taxi_rides | vehicle_id | UUID | — | Capacidade efetiva é `min(motorista, veículo)` (AC-04) |
| taxi_rides | address_id | UUID | — | Origem do endereço; nulo quando informado na hora |
| taxi_rides | zip_code | VarChar(8) | ✓ | Em claro: resolve a zona e não identifica ninguém sozinho |
| taxi_rides | street_encrypted / number_encrypted / complement_encrypted | Text | ✓/— | **Snapshot** cifrado (AC-01 de MOD-TAXI-02) |
| taxi_rides | district / city / state | — | ✓ | Em claro, como em `tutor_addresses` |
| taxi_rides | access_notes_encrypted | Text | — | "Interfone 12, o portão trava" |
| taxi_rides | latitude / longitude | Decimal(9,6) | — | Copiadas do endereço; insumo do MOD-TAXI-10 |
| taxi_rides | zone_id | UUID | — | Nulo quando o preço veio do padrão ou foi manual |
| taxi_rides | price_cents | BigInt | ✓ | Congelado na criação (AC-05 de MOD-TAXI-05) |
| taxi_rides | price_source | Enum | ✓ | ZONE, DEFAULT, MANUAL |
| taxi_rides | appointment_item_id | UUID | — | O item que cobra esta corrida; nulo após cancelamento |
| taxi_rides | ready_at | Timestamptz | — | Quando a volta foi liberada pelo `atendimento.concluido` |
| taxi_rides | assigned_at / en_route_at / arrived_at / onboard_at / delivered_at | Timestamptz | — | Horas **reais** de cada marco |
| taxi_rides | failure_reason | Enum | — | NO_ONE_HOME, WRONG_ADDRESS, PET_REFUSED, NO_SPACE, VEHICLE_ISSUE, OTHER |
| taxi_rides | cancel_reason | Enum | — | TUTOR_REQUEST, APPOINTMENT_CANCELLED, APPOINTMENT_RESCHEDULED, PET_DECEASED, SHOP_REQUEST |
| taxi_rides | notes_encrypted | Text | — | Campo livre do motorista |
| taxi_rides | created_by / created_at / updated_at | — | ✓ | Auditoria |
| taxi_ride_status_log | ride_id / from / to | — | ✓ | Trilha da máquina, **append-only por trigger** |
| taxi_ride_status_log | occurred_at / recorded_at | Timestamptz | ✓ | Hora informada × hora do servidor (AC-05 de MOD-TAXI-04) |
| taxi_ride_status_log | driver_id / by | UUID | — | Quem estava com a corrida e quem apertou o botão |
| taxi_vehicles | id / tenant_id | UUID | ✓ | PK e isolamento |
| taxi_vehicles | plate | VarChar(8) | ✓ | Único por tenant |
| taxi_vehicles | label / model | VarChar(40) | ✓/— | "Van branca", "Fiorino 2019" |
| taxi_vehicles | pet_capacity | SmallInt | ✓ | Quantos pets cabem juntos |
| taxi_vehicles | active | Boolean | ✓ | Veículo na oficina sai do seletor sem sumir do histórico |
| taxi_zones | id / tenant_id | UUID | ✓ | PK e isolamento |
| taxi_zones | name | VarChar(60) | ✓ | "Zona Sul" |
| taxi_zones | zip_prefixes | String[] | ✓ | Prefixos de CEP; o **mais longo vence** (AC-03) |
| taxi_zones | price_cents | BigInt | ✓ | Preço por perna |
| taxi_zones | active | Boolean | ✓ | Ciclo de vida |
| taxi_settings | tenant_id | UUID | ✓ | PK; um por tenant, como `billing_settings` |
| taxi_settings | enabled | Boolean | ✓ | O petshop que não faz leva-e-traz não vê o módulo |
| taxi_settings | taxi_service_id | UUID | — | O serviço de categoria `TAXI` que ancora a cobrança |
| taxi_settings | default_price_cents | BigInt | ✓ | Fallback do CEP sem zona |
| taxi_settings | block_outside_zones | Boolean | ✓ | Padrão **false** |
| taxi_settings | charge_failed_pickup | Boolean | ✓ | Padrão **false** (AC-04 de MOD-TAXI-05) |
| taxi_settings | default_window_minutes | SmallInt | ✓ | Largura da janela sugerida; padrão 60 |
| taxi_settings | unassigned_alert_hours | SmallInt | ✓ | Padrão 12 (AC-05 de MOD-TAXI-03) |

> **Divergência consciente do SPEC.md §129.** O SPEC descreve `taxidog_solicitacao` com `tipo [ida/volta/ambos]` em uma linha. Aqui são **duas linhas** quando o tutor pede ida e volta, porque cada perna tem janela, motorista, veículo, status, hora real e falha próprios. "Ambos" em uma linha só duplicaria cada um desses campos com sufixo `_volta`, e a máquina de estado teria de rodar duas vezes dentro do mesmo registro.

### Campos com Criptografia AES-256-GCM (em repouso)

| Campo | Tabela | Justificativa LGPD/PCI |
|---|---|---|
| street_encrypted / number_encrypted / complement_encrypted | taxi_rides | Endereço residencial é dado pessoal — mesma regra de `tutor_addresses` |
| access_notes_encrypted | taxi_rides | Instrução de acesso à casa: dado de segurança física do tutor |
| notes_encrypted | taxi_rides | Campo livre do motorista, propenso a dado pessoal |

> `zip_code`, `district`, `city` e `state` ficam em claro, como já ficam em `tutor_addresses`: sozinhos não identificam ninguém e são o que a resolução de zona e os relatórios operacionais precisam consultar.

### Índices Necessários

```sql
-- A consulta do painel e da rota: "as corridas de hoje, por motorista".
CREATE INDEX idx_taxi_rides_day ON taxi_rides(tenant_id, driver_id, window_starts_at)
  WHERE status NOT IN ('CANCELLED','DELIVERED','FAILED');

-- Capacidade da van (RN-09): sobreposição de janelas do mesmo motorista.
CREATE INDEX idx_taxi_rides_window ON taxi_rides
  USING GIST (driver_id, tstzrange(window_starts_at, window_ends_at))
  WHERE status IN ('ASSIGNED','EN_ROUTE','ARRIVED','ONBOARD');

-- Cascata de cancelamento e liberação da volta, vindas dos eventos da agenda.
CREATE INDEX idx_taxi_rides_appointment ON taxi_rides(appointment_id);

-- A fila "sem motorista" e o job `taxi-unassigned-alert`.
CREATE INDEX idx_taxi_rides_unassigned ON taxi_rides(tenant_id, window_starts_at)
  WHERE driver_id IS NULL AND status = 'REQUESTED';

-- O varredor de corrida atrasada.
CREATE INDEX idx_taxi_rides_overdue ON taxi_rides(tenant_id, window_ends_at)
  WHERE status IN ('ASSIGNED','EN_ROUTE','ARRIVED','ONBOARD');

CREATE INDEX idx_taxi_rides_tutor ON taxi_rides(tenant_id, tutor_id, window_starts_at DESC);
CREATE INDEX idx_taxi_ride_status_log_ride ON taxi_ride_status_log(ride_id, recorded_at);
CREATE UNIQUE INDEX idx_taxi_vehicles_plate ON taxi_vehicles(tenant_id, plate);

-- AC-04 de MOD-TAXI-01: uma perna viva por agendamento.
CREATE UNIQUE INDEX idx_taxi_rides_leg_alive ON taxi_rides(appointment_id, leg)
  WHERE status NOT IN ('CANCELLED','FAILED');
```

> Como no MOD-AGENDA, **não** se usa `EXCLUDE USING GIST`: a van leva vários pets ao mesmo tempo, então o conflito é `count(sobreposições) >= capacidade`, e a garantia vem da transação `SERIALIZABLE` do RN-09.

---

## 5. Contratos de API

Todo endpoint exige o contexto assinado pelo gateway (`@petshop/service-auth`) e infere `tenant_id` dele. Erros em `application/problem+json`. Paginação `?page=1&limit=20`.

### Endpoints

| Método | Path | Roles Permitidos | Descrição |
|---|---|---|---|
| GET | /v1/taxi/rides | ADMIN, RECEPÇÃO; DRIVER (próprias); TUTOR (próprias) | Listar com filtros de data, status, motorista |
| POST | /v1/taxi/rides | ADMIN, RECEPÇÃO | Criar corrida — aceita `legs: ['PICKUP','DROPOFF']` numa chamada |
| GET | /v1/taxi/rides/:id | Conforme acima | Detalhe com endereço decifrado e alertas do pet |
| PATCH | /v1/taxi/rides/:id | ADMIN, RECEPÇÃO | Janela, endereço, observação |
| POST | /v1/taxi/rides/:id/assign | ADMIN, RECEPÇÃO | Motorista e veículo — **transação SERIALIZABLE** |
| POST | /v1/taxi/rides/:id/status | ADMIN, RECEPÇÃO; DRIVER (próprias) | Transição com `occurredAt` opcional |
| POST | /v1/taxi/rides/:id/cancel | ADMIN, RECEPÇÃO | Cancelar com motivo |
| POST | /v1/taxi/rides/:id/fail | ADMIN, RECEPÇÃO; DRIVER (próprias) | Coleta frustrada com motivo |
| GET | /v1/taxi/board | ADMIN, RECEPÇÃO | Painel do dia agrupado por motorista |
| GET | /v1/taxi/my-route | DRIVER | A rota do motorista autenticado |
| GET | /v1/taxi/drivers/available | ADMIN, RECEPÇÃO | Motoristas livres numa janela, com folga restante |
| GET | /v1/taxi/vehicles | ADMIN, RECEPÇÃO | Frota |
| POST | /v1/taxi/vehicles | ADMIN | Cadastrar veículo |
| PATCH | /v1/taxi/vehicles/:id | ADMIN | Editar / desativar |
| GET | /v1/taxi/zones | ADMIN, RECEPÇÃO | Zonas e preços |
| POST | /v1/taxi/zones | ADMIN | Criar zona |
| PATCH | /v1/taxi/zones/:id | ADMIN | Editar / desativar |
| DELETE | /v1/taxi/zones/:id | ADMIN | Remover zona sem corrida futura |
| GET | /v1/taxi/settings | ADMIN, RECEPÇÃO | Configuração do módulo |
| PATCH | /v1/taxi/settings | ADMIN | Editar configuração |
| GET | /v1/taxi/quote | ADMIN, RECEPÇÃO; TUTOR | Preço de uma perna para um CEP, sem criar nada |

> `GET /v1/taxi/quote` existe separado porque o Portal e o agente de IA precisam responder "quanto custa buscar aqui?" antes de existir agendamento. É consulta pura, sem efeito.

### Schema Zod — pacote `packages/shared-types`

```typescript
import { z } from 'zod'

export const TaxiLegSchema = z.enum(['PICKUP', 'DROPOFF'])

export const TaxiRideStatusSchema = z.enum([
  'REQUESTED', 'ASSIGNED', 'EN_ROUTE', 'ARRIVED',
  'ONBOARD', 'DELIVERED', 'FAILED', 'CANCELLED',
])

export const TaxiPriceSourceSchema = z.enum(['ZONE', 'DEFAULT', 'MANUAL'])

export const TaxiFailureReasonSchema = z.enum([
  'NO_ONE_HOME', 'WRONG_ADDRESS', 'PET_REFUSED',
  'NO_SPACE', 'VEHICLE_ISSUE', 'OTHER',
])

export const TaxiCancelReasonSchema = z.enum([
  'TUTOR_REQUEST', 'APPOINTMENT_CANCELLED', 'APPOINTMENT_RESCHEDULED',
  'PET_DECEASED', 'SHOP_REQUEST',
])

/** Endereço informado na hora. Omitido, herda o primário do tutor (AC-01/02). */
export const TaxiAddressInputSchema = z.object({
  zipCode: z.string().regex(/^\d{8}$/),
  street: z.string().min(1).max(120),
  number: z.string().min(1).max(20),
  complement: z.string().max(60).optional(),
  district: z.string().min(1).max(80),
  city: z.string().min(1).max(80),
  state: z.string().length(2),
  accessNotes: z.string().max(500).optional(),
})

export const TaxiLegInputSchema = z.object({
  leg: TaxiLegSchema,
  windowStartsAt: z.coerce.date(),
  windowEndsAt: z.coerce.date(),
  address: TaxiAddressInputSchema.optional(),
  driverId: z.string().uuid().optional(),
  vehicleId: z.string().uuid().optional(),
  /** Exige `taxi:configure`; grava justificativa no audit log (AC-04). */
  priceCentsOverride: z.number().int().nonnegative().optional(),
  priceOverrideReason: z.string().max(200).optional(),
  notes: z.string().max(500).optional(),
})

export const CreateTaxiRidesSchema = z
  .object({
    appointmentId: z.string().uuid(),
    legs: z.array(TaxiLegInputSchema).min(1).max(2),
  })
  .refine((v) => new Set(v.legs.map((l) => l.leg)).size === v.legs.length, {
    message: 'Não repita a mesma perna na mesma chamada',
  })
  .refine((v) => v.legs.every((l) => l.windowEndsAt > l.windowStartsAt), {
    message: 'A janela precisa terminar depois de começar',
  })
  .refine((v) => v.legs.every((l) => !l.priceCentsOverride || l.priceOverrideReason), {
    message: 'Preço manual exige justificativa',
  })

export const AssignTaxiRideSchema = z.object({
  driverId: z.string().uuid(),
  vehicleId: z.string().uuid().optional(),
})

export const TaxiStatusTransitionSchema = z.object({
  to: TaxiRideStatusSchema,
  /** AC-05: retroativo até 6h, nunca no futuro. */
  occurredAt: z.coerce.date().optional(),
  notes: z.string().max(500).optional(),
})

export const FailTaxiRideSchema = z.object({
  reason: TaxiFailureReasonSchema,
  notes: z.string().max(500).optional(),
  occurredAt: z.coerce.date().optional(),
})

export const TaxiZoneSchema = z.object({
  name: z.string().min(1).max(60),
  /** Prefixo de CEP, 2 a 8 dígitos. O mais longo vence (AC-03). */
  zipPrefixes: z.array(z.string().regex(/^\d{2,8}$/)).min(1),
  priceCents: z.number().int().nonnegative(),
  active: z.boolean().default(true),
})

export const TaxiVehicleSchema = z.object({
  plate: z.string().regex(/^[A-Z]{3}\d[A-Z0-9]\d{2}$/),
  label: z.string().min(1).max(40),
  model: z.string().max(40).optional(),
  petCapacity: z.number().int().min(1).max(20),
  active: z.boolean().default(true),
})

export const TaxiSettingsSchema = z.object({
  enabled: z.boolean(),
  taxiServiceId: z.string().uuid().nullable(),
  defaultPriceCents: z.number().int().nonnegative(),
  blockOutsideZones: z.boolean().default(false),
  chargeFailedPickup: z.boolean().default(false),
  defaultWindowMinutes: z.number().int().min(15).max(240).default(60),
  unassignedAlertHours: z.number().int().min(1).max(72).default(12),
})
```

### Códigos de Erro Padronizados

| Código | HTTP | Cenário |
|---|---|---|
| ERR_TAXI_001 | 404 | Corrida não encontrada neste tenant |
| ERR_TAXI_002 | 422 | Corrida sem agendamento — não existe corrida solta |
| ERR_TAXI_003 | 422 | Janela inválida, incoerente com o atendimento ou `occurredAt` fora da tolerância |
| ERR_TAXI_004 | 409 | Já existe corrida viva desta perna neste agendamento |
| ERR_TAXI_005 | 422 | Sem endereço: nem informado, nem no cadastro do tutor |
| ERR_TAXI_006 | 409 | Motorista fora da jornada, em folga ou inativo |
| ERR_TAXI_007 | 409 | Capacidade da van esgotada na janela — traz `suggestions[]` |
| ERR_TAXI_008 | 409 | Transição inválida para o status atual |
| ERR_TAXI_009 | 403 | Papel insuficiente, ou motorista mexendo em corrida alheia |
| ERR_TAXI_010 | 422 | Tenant sem serviço de categoria `TAXI` no catálogo |
| ERR_TAXI_011 | 422 | CEP fora das zonas atendidas, com `block_outside_zones` ligado |
| ERR_TAXI_012 | 409 | Prefixo de CEP já coberto por outra zona |
| ERR_TAXI_013 | 409 | Zona ou veículo em uso por corrida futura — desative em vez de excluir |
| ERR_TAXI_014 | 409 | Taxi Dog desligado nas configurações do tenant |

---

## 6. Máquinas de Estado

### Corrida — Status

```
REQUESTED ──(atribuição)──► ASSIGNED ──(saiu)──► EN_ROUTE ──(chegou)──► ARRIVED
    │                          │                     │                     │
    │                          │                     │              (embarcou o pet)
    │                          │                     │                     │
    │                          │                     │                     ▼
    │                          │                     │                 ONBOARD
    │                          │                     │                     │
    │                          │                     │              (entregou)
    │                          │                     │                     ▼
    │                          │                     │                DELIVERED
    │                          │                     │                (terminal)
    │                          │                     │
    ├──(cancelamento)──────────┼─────────────────────┤
    │                          │                     │
    ▼                          ▼                     ▼
CANCELLED ◄────────────────────┴─────────────────────┘
(terminal)                              │
                                        │
                      (ninguém em casa / sem espaço / pet recusou)
                                        ▼
                                     FAILED
                                    (terminal)
```

**Regras da máquina:**

- **`ONBOARD` não cancela.** De `ONBOARD` só se sai por `DELIVERED` ou `FAILED` (AC-06 de MOD-TAXI-09): o pet está dentro da van, e o sistema tem de dizer onde ele foi parar.
- **`FAILED` só a partir de `EN_ROUTE`, `ARRIVED` ou `ONBOARD`.** Falhar antes de sair é cancelar.
- **A reatribuição de motorista não é transição** — muda `driver_id`, grava linha no log e mantém o status (AC-06 de MOD-TAXI-04).
- **A perna `DROPOFF` fica travada em `ASSIGNED`** até `ready_at` ser preenchido pelo `atendimento.concluido`. Tentar `EN_ROUTE` antes disso retorna `ERR_TAXI_008` — salvo override da recepção, que grava o motivo.

**Efeitos colaterais por transição:**

| De | Para | Evento RabbitMQ | Notifica o tutor | Audit Log |
|---|---|---|---|---|
| — | REQUESTED | `taxi.solicitado` | ✓ (confirmação da janela) | ✓ |
| REQUESTED | ASSIGNED | `taxi.atribuido` | — (`notify: false`) | ✓ |
| ASSIGNED | EN_ROUTE | `taxi.a_caminho` | ✓ ("o motorista saiu") | ✓ |
| EN_ROUTE | ARRIVED | `taxi.chegou` | ✓ ("chegou na sua porta") | ✓ |
| ARRIVED | ONBOARD | `taxi.coletado` | ✓ (só na perna PICKUP) | ✓ |
| ONBOARD | DELIVERED | `taxi.entregue` | ✓ | ✓ |
| qualquer não terminal | CANCELLED | `taxi.cancelado` | ✓, exceto óbito e cascata | ✓ |
| EN_ROUTE/ARRIVED/ONBOARD | FAILED | `taxi.falhou` | ✓ + aviso à recepção | ✓ |

---

## 7. Regras de Negócio & Edge Cases

| # | Cenário | Comportamento Esperado | Módulos Afetados |
|---|---|---|---|
| RN-01 | Não existe corrida sem agendamento | `appointment_id` é obrigatório. O Taxi Dog é complemento, e uma agenda paralela seria um segundo lugar para conciliar | MOD-TAXI, MOD-AGENDA |
| RN-02 | Uma linha por perna | Ida e volta são duas corridas, cada uma com janela, motorista, status e falha próprios. Diverge do SPEC §129 de propósito | MOD-TAXI |
| RN-03 | O motorista é um `professionals` | `role_key = 'DRIVER'`, com jornada, folga e capacidade lidas do MOD-AGENDA. Este módulo **não** cria uma segunda noção de escala | MOD-TAXI, MOD-AGENDA, MOD-IDENT |
| RN-04 | Capacidade efetiva é `min(motorista, veículo)` | `max_concurrent_pets` é a van cheia; um veículo menor no dia aperta o limite | MOD-TAXI, MOD-AGENDA |
| RN-05 | A cobrança pega carona no agendamento | A corrida vira `appointment_items` com `duration_min = 0`. O débito nasce do `atendimento.concluido` (RN-05 do MOD-AGENDA) — este módulo **não publica evento de dinheiro** | MOD-TAXI, MOD-AGENDA, MOD-LEDGER |
| RN-06 | Item de taxi não estica a janela do atendimento | `duration_min = 0`: o tempo gasto é do motorista, não do banhista, e somá-lo a `ends_at` bloquearia a bancada por engano | MOD-TAXI, MOD-AGENDA |
| RN-07 | Preço congela na criação da corrida | Fotografia do momento, como o RN-04 do MOD-AGENDA. Reajuste de zona não retroage | MOD-TAXI, MOD-LEDGER |
| RN-08 | Alerta clínico chega ao motorista | Quem põe a mão no pet primeiro é ele. `record:read_alerts` já está no papel DRIVER; o alerta é **informativo**, nunca bloqueia a corrida | MOD-TAXI, MOD-PRONT |
| RN-09 | Corrida pela última vaga na van | Contagem de sobreposições e gravação na mesma transação `SERIALIZABLE` sobre a janela do motorista; conflito de serialização vira 409, não 500 | MOD-TAXI |
| RN-10 | A volta espera a conclusão | `ready_at` vem do `atendimento.concluido`. Sair antes é buscar um pet que ainda está na secagem | MOD-TAXI, MOD-AGENDA |
| RN-11 | Endereço é congelado, não referenciado | Snapshot cifrado na corrida; `address_id` guarda só a procedência. Mudança de cadastro não reescreve para onde o motorista foi | MOD-TAXI, MOD-TUTOR |
| RN-12 | Fuso é o do tenant | `tenant_settings.timezone` recorta o "hoje" do painel e da rota, como no RN-19 do MOD-AGENDA | MOD-TAXI, MOD-IDENT |
| RN-13 | Falha na coleta não cancela o atendimento | `FAILED` é da corrida. Quem decide se o pet ainda vem é a recepção, com o tutor na linha | MOD-TAXI, MOD-AGENDA |
| RN-14 | Cancelar o agendamento cancela as corridas | Cascata pelo `agendamento.cancelado`. Corrida órfã é pet esperando na calçada | MOD-TAXI, MOD-AGENDA |
| RN-15 | Remarcar **não** move a corrida | O agendamento remarcado é um registro novo (RN-16 do MOD-AGENDA); as corridas antigas são canceladas e as novas nascem confirmadas pela recepção, porque a disponibilidade do motorista no dia novo é outra | MOD-TAXI, MOD-AGENDA |
| RN-16 | Porta fechada não se cobra por padrão | `charge_failed_pickup = false`. O tenant que quiser cobrar liga, e a política fica visível na configuração | MOD-TAXI, MOD-LEDGER |
| RN-17 | Zona vence pelo prefixo mais longo | `010012` ganha de `0100`. Prefixo idêntico em duas zonas é recusado na criação | MOD-TAXI |
| RN-18 | CEP fora de zona não bloqueia por padrão | Usa `default_price_cents`. Bloquear é opt-in — o petshop que não atende a cidade inteira liga `block_outside_zones` | MOD-TAXI |
| RN-19 | Motorista só opera as próprias corridas | `taxi:operate` no papel DRIVER é escopo próprio; recepção e admin operam todas | MOD-TAXI, MOD-SEC |
| RN-20 | Hora informada × hora gravada | `occurred_at` aceita retroação de até 6h (sinal ruim na rua); `recorded_at` é sempre o servidor. As duas ficam no log, e as métricas usam `occurred_at` | MOD-TAXI, MOD-ADMIN |
| RN-21 | Óbito cancela as corridas em silêncio | `pet.obito` cancela as futuras com `notify: false`, como o RN-10 do MOD-AGENDA | MOD-TAXI, MOD-PET, MOD-CRM |
| RN-22 | O módulo desligado não aparece | `taxi_settings.enabled = false` esconde a opção no wizard de agendamento e recusa a API com `ERR_TAXI_014`. O petshop sem van não vê campo morto | MOD-TAXI, MOD-AGENDA |

---

## 8. Eventos RabbitMQ (Mensageria Assíncrona)

Exchange: `petshop.events` (topic) | DLX habilitado com backoff exponencial (1s, 5s, 30s, 5min)

| Evento (routing key) | Publisher | Consumers | Payload Mínimo |
|---|---|---|---|
| `taxi.solicitado` | taxidog | crm-automation, notification, portal-bff, audit | `{ tenantId, rideId, appointmentId, petId, tutorId, leg, windowStartsAt, windowEndsAt, priceCents, notify, timestamp }` |
| `taxi.atribuido` | taxidog | portal-bff, audit | `{ tenantId, rideId, driverId, vehicleId, previousDriverId, notify: false, timestamp }` |
| `taxi.a_caminho` | taxidog | crm-automation, notification, portal-bff, audit | `{ tenantId, rideId, tutorId, petId, leg, driverId, occurredAt, notify, timestamp }` |
| `taxi.chegou` | taxidog | crm-automation, notification, portal-bff, audit | `{ tenantId, rideId, tutorId, occurredAt, notify, timestamp }` |
| `taxi.coletado` | taxidog | crm-automation, notification, portal-bff, audit | `{ tenantId, rideId, petId, tutorId, leg, occurredAt, notify, timestamp }` |
| `taxi.entregue` | taxidog | crm-automation, notification, portal-bff, audit | `{ tenantId, rideId, appointmentId, petId, tutorId, leg, occurredAt, notify, timestamp }` |
| `taxi.falhou` | taxidog | crm-automation, notification, audit | `{ tenantId, rideId, tutorId, reason, occurredAt, notify, timestamp }` |
| `taxi.cancelado` | taxidog | crm-automation, notification, audit | `{ tenantId, rideId, appointmentId, reason, chargeRemoved, notify, timestamp }` |

**Consome:**

| Evento | Origem | Efeito |
|---|---|---|
| `atendimento.concluido` | scheduling | Preenche `ready_at` da perna `DROPOFF` e a destrava (RN-10) |
| `agendamento.cancelado` | scheduling | Cancela as corridas não terminais em cascata (RN-14) |
| `agendamento.reagendado` | scheduling | Cancela com `APPOINTMENT_RESCHEDULED`; a nova corrida é criada pela recepção (RN-15) |
| `pet.obito` | pet | Cancela as futuras em silêncio (RN-21) |
| `pet.transferido` / `tutor.mesclado` / `tutor.anonimizado` | pet, tutor | Revincula `tutor_id` das corridas futuras |

> **Não há evento de dinheiro aqui.** O item de cobrança é escrito no agendamento e o débito nasce do `atendimento.concluido` do MOD-AGENDA (RN-05). O taxidog-service escreve em `appointment_items` na mesma transação da corrida — os dois serviços compartilham o mesmo Postgres, sob a mesma RLS de `withTenant()`, e o dono da regra de preço da corrida é este módulo.

---

## 9. Segurança & LGPD

### Controle de Acesso por Operação

| Operação | Super Admin | Tenant Admin | Recepção | Banhista/Tosador | Veterinário | Motorista | Tutor |
|---|---|---|---|---|---|---|---|
| Ver painel do dia | ✓¹ | ✓ | ✓ | — | — | própria rota | — |
| Ver corrida | ✓¹ | ✓ | ✓ | — | — | próprias | próprias |
| Criar corrida | — | ✓ | ✓ | — | — | — | —² |
| Editar janela / endereço | — | ✓ | ✓ | — | — | — | — |
| Atribuir motorista e veículo | — | ✓ | ✓ | — | — | — | — |
| Mudar status | — | ✓ | ✓ | — | — | próprias | — |
| Registrar falha | — | ✓ | ✓ | — | — | próprias | — |
| Cancelar | — | ✓ | ✓ | — | — | — | —² |
| Preço manual | — | ✓ | — | — | — | — | — |
| Gerir zonas, frota e configuração | — | ✓ | — | — | — | — | — |
| Consultar preço (`/quote`) | — | ✓ | ✓ | — | — | — | ✓ |

¹ Somente com grant de suporte ativo e auditoria por leitura.
² Solicitar e cancelar Taxi Dog pelo Portal fica para o MOD-PORTAL, junto com o agendamento online (MOD-AGENDA-06).

**Permissões.** `taxi:operate` **já existe** e já está concedida a TENANT_ADMIN, RECEPTIONIST e DRIVER. **`taxi:configure` é nova** (zonas, frota, configuração e preço manual), concedida só a TENANT_ADMIN — e exige `pnpm db:seed`, como as permissões novas do MOD-LEDGER e do MOD-PRONT.

### Audit Log — ações que DEVEM gerar registro imutável

- `taxi_ride.created` (com perna, janela, preço e origem do preço)
- `taxi_ride.assigned` / `taxi_ride.reassigned` — **com o motorista anterior**, porque "quem estava com o pet" é a primeira pergunta quando algo dá errado
- `taxi_ride.status_changed` (com `occurredAt` e `recordedAt`, para expor retroação)
- `taxi_ride.failed` (com motivo) e `taxi_ride.cancelled` (com motivo e se removeu cobrança)
- `taxi_ride.price_overridden` — quem redefiniu o preço no balcão e por quê
- `taxi_zone.created/updated/deactivated`, `taxi_vehicle.created/deactivated`, `taxi_settings.updated`

### Dados Pessoais (LGPD)

| Campo | Categoria | Base Legal | Retenção | Exportável | Deletável |
|---|---|---|---|---|---|
| Endereço da corrida (cifrado) | Dado pessoal | Execução de contrato | Relação ativa + 5 anos | ✓ | ✓ após a retenção fiscal |
| access_notes_encrypted | Dado de segurança física | Legítimo interesse | Relação ativa | ✓ | ✓ |
| latitude / longitude | Dado de localização | Execução de contrato | Relação ativa | ✓ | ✓ |
| Horas de coleta e entrega | Dado de comportamento | Execução de contrato | Relação ativa + 5 anos | ✓ | — (sustenta a cobrança) |
| notes_encrypted | Risco de dado sensível | Legítimo interesse | Relação ativa | ✓ | ✓ |

> **Duas notas.** (1) A rota do motorista mostra endereço e telefone de tutores — é o ponto do sistema em que mais PII chega a um dispositivo pessoal fora do balcão. A resposta de `/v1/taxi/my-route` traz **apenas as corridas de hoje** do próprio motorista, e o acesso é auditado por leitura. (2) A anonimização do tutor (MOD-TUTOR-08) apaga os campos cifrados de endereço e as coordenadas das corridas, mas **preserva** a corrida, as horas e o preço: são base da cobrança já emitida.

---

## 10. Performance & Observabilidade

### Cache Redis

| Dado | TTL | Chave | Invalida quando |
|---|---|---|---|
| Zonas do tenant | 3600s | `taxi:zones:{tenantId}` | Criação/edição/desativação de zona |
| Frota | 3600s | `taxi:vehicles:{tenantId}` | Veículo criado, editado ou desativado |
| Configuração | 3600s | `taxi:settings:{tenantId}` | PATCH em settings |
| Painel do dia | 20s | `taxi:board:{tenantId}:{date}` | Qualquer transição de status naquele dia |
| Rota do motorista | 15s | `taxi:route:{tenantId}:{driverId}:{date}` | Transição, atribuição ou `ready_at` daquele motorista |

> O TTL da rota é o mais curto do sistema. Ela é recarregada em rede móvel a cada parada, e rota velha manda o motorista para o endereço errado.

### Métricas de Negócio (Pino structured log)

```json
{ "metric": "taxi_window_adherence_rate", "tenantId": "...", "value": 0.88, "unit": "ratio" }
```

- `taxi_rides_total`: por perna e por origem — contínuo
- `taxi_window_adherence_rate`: corridas entregues dentro da janela prometida ÷ total — diário. **A métrica principal do módulo**: a janela é a promessa feita ao tutor
- `taxi_failure_rate`: `FAILED` ÷ executadas, **quebrado por motivo** — semanal. `NO_SPACE` recorrente é capacidade mal configurada, não azar
- `taxi_leg_duration_min`: `delivered_at − en_route_at` por zona — semanal; é o que corrige a largura da janela padrão
- `taxi_unassigned_at_dminus12`: corridas ainda sem motorista a 12h da janela — diário, insumo do alerta
- `taxi_reassignment_total`: trocas de motorista com pet a bordo — contínuo
- `taxi_late_delivery_min`: atraso além de `window_ends_at` — diário
- `taxi_revenue_cents`: soma dos itens de taxi concluídos — mensal, por zona

### SLOs

| Endpoint | p95 | Observação |
|---|---|---|
| `GET /v1/taxi/my-route` | 400ms | Rede móvel, recarregado a cada parada; é o mais crítico |
| `GET /v1/taxi/board` | 300ms | Painel aberto o dia inteiro na recepção |
| `POST /v1/taxi/rides/:id/status` | 300ms | Um toque na rua não pode parecer travado |
| `POST /v1/taxi/rides` | 500ms | Resolve zona, preço, escreve o item no agendamento |
| `POST /v1/taxi/rides/:id/assign` | 500ms | Inclui a transação SERIALIZABLE do RN-09 |
| `GET /v1/taxi/quote` | 150ms | Consulta pura sobre zonas cacheadas |

### Jobs

| Job | Cadência | O que faz |
|---|---|---|
| `taxi-unassigned-alert` | 30 min | Corrida sem motorista a menos de `unassigned_alert_hours` da janela → alerta à recepção |
| `taxi-overdue-sweeper` | 15 min | Corrida com janela vencida e status não terminal → marca atrasada e alimenta a métrica |

> Os dois entram em `packages/job-scheduler`, com lease no Postgres, como os oito jobs já no relógio.

---

## 11. Questões em Aberto

| # | Questão | Impacto | Decisor | Prazo |
|---|---|---|---|---|
| 1 | O preço do Taxi Dog é **por perna** (assumido aqui) ou por corrida ida-e-volta com desconto? | MOD-TAXI, MOD-LEDGER, comercial | PM comercial | Antes da implementação |
| 2 | Zonas por prefixo de CEP (assumido) ou por bairro/distância em km a partir do endereço do petshop? | MOD-TAXI-06, esforço, precisão | PM + cliente-piloto | Antes de MOD-TAXI-06 |
| 3 | O tutor pode solicitar Taxi Dog sozinho pelo Portal, ou é sempre a recepção que cria? | MOD-TAXI, MOD-PORTAL | PM | Fase 5 |
| 4 | Porta fechada se cobra? Assumido **não** por padrão, com chave por tenant | Relação com o cliente, receita | PM comercial | Antes da implementação |
| 5 | A largura da janela é definida pela recepção a cada corrida (assumido) ou calculada a partir da rota? | UX da recepção, adesão à janela | PM | Fase 3 |
| 6 | O motorista precisa de app próprio, ou a rota é uma tela web responsiva no navegador do celular? Assumido: **web responsiva** | Escopo do frontend, custo | Tech Lead + PM | Antes da implementação |
| 7 | Rastreamento por GPS em tempo real na tela do tutor entra em algum horizonte? Fora da v1 | MOD-TAXI-10, MOD-PORTAL, LGPD (localização do trabalhador) | PM + jurídico | Pós-piloto |
| 8 | O veículo é obrigatório na atribuição, ou opcional como assumido aqui? | MOD-TAXI-03, rigor operacional | PM + cliente-piloto | Fase 3 |
| 9 | `ServiceCategory` ganha o valor `TAXI` (assumido) ou o serviço de taxi usa `OTHER` com uma flag? | Migration no enum, seletor de agendamento | Tech Lead | Antes da implementação |
