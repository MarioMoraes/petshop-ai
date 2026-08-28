# PRD Detalhado — Relacionamento e Automação (CRM)

**Módulo:** MOD-CRM
**Arquivo:** 08/15
**Prioridade:** P1
**Fase de Implementação:** 4 — Relacionamento
**Serviços Backend:** crm-automation-service (porta **3009**) · messaging-service (porta **3010**)
**Tabelas Principais:** automations, campaigns, campaign_runs, campaign_targets, message_templates, messages, message_events, messaging_settings, messaging_suppressions, whatsapp_instances
**Data:** 2026-08-28
**Status:** Draft

---

## 1. Visão Geral

**Contexto de negócio.** O petshop já sabe tudo o que precisa para falar com o tutor na hora certa — quem tem banho amanhã, de quem é o aniversário do pet, quem não aparece há quatro meses, quem está devendo — e não fala. Fala pelo WhatsApp pessoal da recepcionista, quando ela lembra, no intervalo entre dois cachorros. O prejuízo é medido em três números que o dono conhece de cor: **a falta** (o tutor esqueceu o horário), **o cliente que evaporou** (parou de vir e ninguém percebeu) e **o débito envelhecido** (ninguém cobrou porque cobrar é constrangedor). Este módulo pega os eventos que os sete módulos anteriores já publicam e os transforma em mensagem enviada, entregue e registrada — sem ninguém lembrar de nada.

**Recorte deliberado da v1.** Este módulo **fala, não conversa**. Não há recebimento de respostas, não há bot, não há atendimento por WhatsApp: a mensagem informa e manda o tutor ligar ou usar o Portal. A tabela `messages` já nasce com `direction`, e o webhook do provedor já recebe o evento de mensagem recebida — mas na v1 ele só registra e ignora. O motivo é escopo honesto: aceitar resposta significa casar texto livre com agendamento, decidir o que é "quem sabe", e reabrir a regra de 24h do MOD-AGENDA para um cancelamento que chega às 23h47. É o MOD-AI (arquivo 15) que resolve isso, e ele precisa desta base pronta antes.

**A escolha do provedor, e o que ela custa.** O canal WhatsApp usa **Evolution API** auto-hospedada (um container ao lado do Gotenberg), com pareamento por QR code do número do próprio petshop. Isso **diverge da decisão 3 do dossiê de negócio**, que dizia "BSP oficial": não há aprovação de template, não há custo por mensagem e o onboarding é escanear um QR — em troca, é uma camada não-oficial sobre o WhatsApp Web, e **o número do petshop pode ser banido pela Meta**. Esse risco não é um aviso no rodapé: ele é a razão de existirem, dentro deste PRD, a janela de silêncio (§7 RN-04), o teto diário por tenant, o aquecimento dos primeiros dias (RN-06), o intervalo com jitter entre disparos (RN-05) e a recusa de marketing para quem nunca interagiu. Um módulo de CRM que ignora isso queima o ativo mais caro do petshop: o número que os clientes já têm salvo.

**Integração sistêmica.** Upstream (fontes de gatilho, todas já publicando hoje): **MOD-AGENDA** (`agendamento.criado`, `.cancelado`, `.reagendado`, `.no_show`), **MOD-PRONT** (`atendimento.concluido`, `.anulado`), **MOD-LEDGER** (`lancamento.criado`, `pacote.expirado`, `pagamento.registrado`), **MOD-TAXI** (`taxi.a_caminho`, `.chegou`, `.entregue`, `.falhou`), **MOD-PET** (`pet.criado`, `pet.obito`), **MOD-TUTOR** (consentimentos, tags, `tutor.anonimizado`), MOD-IDENT (fuso e identidade visual do tenant). Downstream: **MOD-PORTAL** (central de comunicação e preferências do tutor), **MOD-NOTIF** (que passa a ser catálogo de e-mails transacionais sobre este motor, e não um segundo motor — ver a divergência abaixo), MOD-ADMIN (falha de integração vira alerta), MOD-AI (o histórico é o contexto do agente).

> **Divergência consciente do SPEC.md §2.** O SPEC separa `messaging-service` (WhatsApp) de `notification-service` (Resend, porta 3011). Aqui o **messaging-service é o motor único de saída**, com dois adaptadores de canal — `WhatsAppPort` (Evolution API) e `EmailPort` (Resend) — porque tudo o que é caro já é comum aos dois: a fila, o retry, o dedupe, a janela de silêncio, a checagem de consentimento, o histórico e a criptografia do corpo. Dois motores significaria escrever isso duas vezes e ter dois históricos para o tutor. **MOD-NOTIF (arquivo 12) passa a especificar o catálogo de e-mails transacionais**, não a infraestrutura; a porta 3011 provavelmente não nasce. O `identity-service` hoje chama o Resend direto para o convite de equipe (MOD-IDENT-06) — essa chamada migra para cá quando o MOD-NOTIF for implementado, e até lá convive.

---

## 2. Sub-Features

| ID | Nome | Descrição | Must/Should/Nice |
|---|---|---|---|
| MOD-CRM-01 | Conexão do WhatsApp do Tenant | Instância Evolution por petshop, pareamento por QR, estado da conexão | Must Have |
| MOD-CRM-02 | Templates de Mensagem | Textos por tenant e por canal, com variáveis, semeados no provisionamento | Must Have |
| MOD-CRM-03 | Motor de Envio e Fila | Outbox com retry, dedupe, janela de silêncio e limite de vazão | Must Have |
| MOD-CRM-04 | Consentimento e Opt-out | Trilha transacional × marketing sobre `tutor_consents`, com supressão | Must Have |
| MOD-CRM-05 | Lembrete de Agendamento | D-1 configurável, cancelado junto com o agendamento | Must Have |
| MOD-CRM-06 | Aniversário de Pet e Tutor | Disparo diário, silenciado por óbito | Should Have |
| MOD-CRM-07 | Campanha de Inativos | Segmentação por dias sem atendimento, reusando a tag INATIVO | Should Have |
| MOD-CRM-08 | Régua de Cobrança | Sequência de avisos sobre saldo devedor, ancorada no vencimento | Should Have |
| MOD-CRM-09 | Avisos do Taxi Dog | "O motorista saiu", "chegamos", "entregue" — a partir dos eventos de corrida | Must Have |
| MOD-CRM-10 | Histórico de Comunicação | Tudo que foi enviado a um tutor, auditável, na ficha e no Portal | Must Have |
| MOD-CRM-11 | Painel de Entregas e Falhas | O que saiu, o que falhou, o que foi bloqueado e por quê | Must Have |
| MOD-CRM-12 | Campanha Manual | Disparo pontual para um segmento escolhido a dedo, com prévia | Should Have |
| MOD-CRM-13 | Recebimento de Respostas | Inbound registrado, sem interpretação — base para o MOD-AI | Nice to Have |

**Fatiamento sugerido da implementação.** *Fatia 1 (e-mail):* 02, 03, 04, 05, 10, 11 com o `EmailPort` (Resend) e um adaptador falso nos testes — entrega valor sem depender do WhatsApp. *Fatia 2 (WhatsApp):* 01, 09 e o `WhatsAppPort` sobre a Evolution API. *Fatia 3 (proatividade):* 06, 07, 08, 12. O 13 fica para o MOD-AI.

---

## 3. Critérios de Aceite

### [MOD-CRM-01] — Conexão do WhatsApp do Tenant

**AC-01 (Happy Path)**
- **Dado** um tenant sem WhatsApp conectado
- **Quando** o TENANT_ADMIN abre `/configuracoes/mensagens` e clica em "Conectar WhatsApp"
- **Então** o sistema cria a instância na Evolution API (`instance_name = 'tenant-' || slug`), retorna **201** com o QR code em base64 e `status = CONNECTING`, e a tela faz polling a cada 3s

**AC-02 (Happy Path — pareado)**
- **Dado** o QR exibido na tela
- **Quando** o dono escaneia com o WhatsApp do petshop
- **Então** o webhook `CONNECTION_UPDATE` chega com `state = 'open'`, a instância vai a `CONNECTED`, `phone_e164` é gravado, e a fila represada do tenant começa a escoar

**AC-03 (Validação / Erro — QR expirado)**
- **Dado** um QR gerado há mais de 60 segundos
- **Quando** ninguém escaneou
- **Então** a tela pede um novo QR, e o backend responde `POST /v1/messaging/whatsapp/qr` com um código novo — **sem** recriar a instância, para não perder o histórico

**AC-04 (Edge Case — desconexão silenciosa)**
- **Dado** um tenant conectado cujo celular ficou três dias sem internet
- **Quando** o webhook informa `state = 'close'`
- **Então** a instância vai a `DISCONNECTED`, **as mensagens deixam de falhar e passam a ficar em `SCHEDULED`**, e o painel exibe faixa vermelha "WhatsApp desconectado — reconecte". Nada é descartado; a fila escoa quando voltar

**AC-05 (Edge Case — número banido)**
- **Dado** um retorno de erro permanente do provedor indicando bloqueio da conta
- **Quando** o motor tenta enviar
- **Então** a instância vai a `BANNED`, o canal WhatsApp é desligado para o tenant, as mensagens pendentes **caem para o canal de e-mail** quando o tutor tem e-mail com consentimento, e um alerta é publicado para o MOD-ADMIN. O petshop não descobre isso por um cliente reclamando

**AC-06 (Validação / Erro — papel insuficiente)**
- **Dado** um RECEPTIONIST
- **Quando** tenta conectar ou desconectar o WhatsApp
- **Então** **403** `ERR_CRM_012`. Conectar o número da empresa é ato de dono (`crm:connect_channel`, só TENANT_ADMIN)

---

### [MOD-CRM-02] — Templates de Mensagem

**AC-01 (Happy Path)**
- **Dado** um tenant recém-provisionado
- **Quando** o provisionamento termina
- **Então** os templates de sistema já existem, em português, com o nome do petshop resolvido: `appointment_reminder`, `appointment_confirmed`, `appointment_cancelled`, `taxi_en_route`, `taxi_arrived`, `taxi_delivered`, `birthday_pet`, `birthday_tutor`, `inactive_winback`, `dunning_soft`, `dunning_firm`, `package_expiring`, `service_done` — cada um em WHATSAPP e EMAIL

**AC-02 (Happy Path — edição)**
- **Dado** o template `appointment_reminder`
- **Quando** o admin reescreve o corpo mantendo `{{tutor.primeiro_nome}}` e `{{agendamento.hora}}`
- **Então** salva com **200**, `version` incrementa, e a versão anterior fica no histórico. Mensagens já na fila **usam o texto que foi renderizado quando entraram**, não o novo

**AC-03 (Validação / Erro — variável inexistente)**
- **Dado** um corpo com `{{pet.raca_favorita}}`
- **Quando** é salvo
- **Então** **422** `ERR_CRM_003` listando as variáveis válidas daquele template. Variável inventada vira texto vazio no celular do cliente — o erro precisa doer na hora de escrever, não na hora de enviar

**AC-04 (Edge Case — template de sistema apagado)**
- **Dado** um template com `is_system = true`
- **Quando** o admin tenta excluir
- **Então** **409** `ERR_CRM_004`. Dá para **desativar** a automação que o usa; o texto não some, porque a automação sem template é um envio sem corpo

**AC-05 (Edge Case — corpo longo demais)**
- **Dado** um corpo de WhatsApp com 5.000 caracteres
- **Quando** é salvo
- **Então** **422** `ERR_CRM_003` com o limite de 4.096. Para EMAIL o limite é 20.000 e há campo `subject` obrigatório — validação por canal, não global

---

### [MOD-CRM-03] — Motor de Envio e Fila

**AC-01 (Happy Path)**
- **Dado** um pedido interno `POST /v1/messages` com `templateKey`, `tutorId`, `channel: 'AUTO'` e `dedupeKey`
- **Quando** o tutor tem consentimento e a hora está dentro da janela
- **Então** retorna **202** com a mensagem em `QUEUED`, o corpo já renderizado e cifrado, e o worker a envia em segundos

**AC-02 (Happy Path — canal AUTO)**
- **Dado** um tutor com WhatsApp consentido e e-mail consentido
- **Quando** o canal pedido é `AUTO`
- **Então** escolhe **WhatsApp**; se o canal estiver desconectado, banido ou sem consentimento, cai para **EMAIL**; sem nenhum dos dois, a mensagem nasce `BLOCKED` com `block_reason = NO_CHANNEL` e **não** é erro do chamador

**AC-03 (Edge Case — fora da janela de silêncio)**
- **Dado** uma mensagem gerada às 22h10, com janela 08:00–20:00 no fuso do tenant
- **Quando** entra na fila
- **Então** fica `SCHEDULED` para 08:00 do dia seguinte. **Nunca é descartada e nunca é enviada fora da janela** — exceto a categoria `OPERATIONAL` do Taxi Dog (RN-04), que é sobre um pet que está na van agora

**AC-04 (Edge Case — duplicata)**
- **Dado** um consumidor de evento que reprocessa `agendamento.criado` após um redeploy
- **Quando** pede a mesma mensagem com o mesmo `dedupeKey`
- **Então** retorna **200** com a mensagem já existente, sem criar nem enviar de novo. O `dedupeKey` é único por tenant e sobrevive por 30 dias

**AC-05 (Edge Case — falha transitória)**
- **Dado** o provedor fora do ar
- **Quando** o envio falha com erro 5xx ou timeout
- **Então** a mensagem volta para `QUEUED` com `attempts + 1` e backoff 1min/5min/30min/2h; na quinta falha vai a `DEAD` e aparece no painel de falhas com o erro do provedor

**AC-06 (Edge Case — evento que invalida a mensagem)**
- **Dado** um lembrete `SCHEDULED` para amanhã às 09:00
- **Quando** o agendamento é cancelado hoje às 20h
- **Então** a mensagem vai a `CANCELLED` pelo par `origin_type/origin_id` e **não sai**. Mandar "seu banho é amanhã" para um horário cancelado é pior que não mandar nada

**AC-07 (Edge Case — teto diário)**
- **Dado** um tenant que já disparou o teto do dia
- **Quando** uma campanha pede mais 400 mensagens
- **Então** as excedentes ficam `SCHEDULED` para o dia seguinte, em ordem de chegada, e o painel avisa. Mensagens de categoria `TRANSACTIONAL` e `OPERATIONAL` **não contam** para o teto e nunca são represadas por ele

---

### [MOD-CRM-04] — Consentimento e Opt-out

**AC-01 (Happy Path — transacional passa)**
- **Dado** um tutor que revogou o consentimento de MARKETING no WhatsApp e mantém o TRANSACTIONAL
- **Quando** o lembrete do banho de amanhã é solicitado
- **Então** é enviado. Lembrete de compromisso é execução de contrato, não propaganda

**AC-02 (Happy Path — marketing barrado)**
- **Dado** o mesmo tutor
- **Quando** a campanha de inativos o inclui
- **Então** a mensagem nasce `BLOCKED` com `block_reason = NO_CONSENT`, entra no histórico como bloqueada e o alvo da campanha fica `SKIPPED`. **Bloqueio é registro, não silêncio** — o petshop precisa saber por que só 60 dos 100 receberam

**AC-03 (Validação / Erro — consentimento inexistente)**
- **Dado** um tutor importado sem nenhum registro de consentimento
- **Quando** uma mensagem de MARKETING é pedida
- **Então** é bloqueada. **Ausência de consentimento não é consentimento** (LGPD art. 8º). Para TRANSACTIONAL, a base legal é contrato e o envio prossegue

**AC-04 (Edge Case — pedido de parar)**
- **Dado** um tutor que pede à recepção "não quero mais mensagens"
- **Quando** a recepção registra o opt-out na ficha
- **Então** o `PUT /v1/tutors/:id/consents` do MOD-TUTOR revoga, e o CRM passa a bloquear na próxima solicitação — **sem tabela de consentimento própria**. A trilha de consentimento é uma só, e ela é do tutor-service

**AC-05 (Edge Case — supressão técnica)**
- **Dado** um e-mail que devolveu *hard bounce* ou um número que a Evolution reporta como inexistente no WhatsApp
- **Quando** o retorno chega
- **Então** o endereço entra em `messaging_suppressions` (por hash, não em claro) e toda mensagem futura para ele nasce `BLOCKED` com `SUPPRESSED`, em qualquer categoria — inclusive transacional, porque o endereço não existe. A ficha do tutor mostra o aviso de contato inválido

**AC-06 (Edge Case — tutor anonimizado)**
- **Dado** um `tutor.anonimizado` (direito ao esquecimento, MOD-TUTOR)
- **Quando** o evento chega
- **Então** todas as mensagens do tutor têm corpo, assunto e destinatário **apagados** (não cifrados: apagados), preservando metadados de auditoria — data, canal, template, status. E o tutor entra em supressão permanente

---

### [MOD-CRM-05] — Lembrete de Agendamento

**AC-01 (Happy Path)**
- **Dado** a automação `appointment_reminder` ligada com `lead_hours = 24`
- **Quando** o job horário varre a janela
- **Então** cada agendamento `CONFIRMED` que começa entre 24h e 25h à frente ganha uma mensagem `SCHEDULED`, com `dedupeKey = 'reminder:' || appointment_id`

**AC-02 (Happy Path — confirmação imediata)**
- **Dado** a automação `appointment_confirmed` ligada
- **Quando** chega `agendamento.criado`
- **Então** a confirmação sai na hora (categoria TRANSACTIONAL), com data, hora, serviço, pet e profissional

**AC-03 (Edge Case — agendado para daqui a duas horas)**
- **Dado** um agendamento criado hoje às 15h para hoje às 17h
- **Quando** o lembrete de 24h seria no passado
- **Então** **nenhum lembrete é criado** — a confirmação do AC-02 já cumpriu o papel. Lembrete com hora negativa não vira "enviar agora"

**AC-04 (Edge Case — reagendamento)**
- **Dado** um lembrete `SCHEDULED` e um `agendamento.reagendado`
- **Quando** o evento chega
- **Então** a mensagem antiga vai a `CANCELLED` e uma nova é agendada para a nova data, com o mesmo `dedupeKey` liberado

**AC-05 (Edge Case — vários pets no mesmo horário)**
- **Dado** um tutor com três pets no mesmo agendamento
- **Quando** o lembrete é montado
- **Então** sai **uma** mensagem listando os três. Três mensagens seguidas para o mesmo número é o comportamento que faz o cliente bloquear o petshop

---

### [MOD-CRM-06] — Aniversário de Pet e Tutor

**AC-01 (Happy Path)**
- **Dado** o job diário às 09:00 no fuso do tenant
- **Quando** roda
- **Então** pets com `birth_date` de mês e dia iguais aos de hoje geram `birthday_pet` (categoria MARKETING), respeitando consentimento

**AC-02 (Edge Case — pet falecido)**
- **Dado** um pet com `status = DECEASED`
- **Quando** o aniversário chega
- **Então** **nada é enviado**, em nenhuma hipótese, e o alvo é registrado como `SKIPPED` com motivo `PET_DECEASED`. É a falha mais cara que este módulo pode cometer

**AC-03 (Edge Case — data de nascimento aproximada)**
- **Dado** um pet com `birth_date_is_estimated = true` (adotado, idade estimada)
- **Quando** o job roda
- **Então** o envio depende de `automations.config.include_estimated_birthdays`, padrão **false**. Parabenizar por uma data que o próprio cadastro diz ser chute expõe o petshop

**AC-04 (Edge Case — 29 de fevereiro)**
- **Dado** um pet nascido em 29/02
- **Quando** o ano não é bissexto
- **Então** a mensagem sai em **28/02**. Regra explícita, não acidente de comparação de datas

---

### [MOD-CRM-07] — Campanha de Inativos

**AC-01 (Happy Path)**
- **Dado** a campanha de inativos com `inactive_days = 90` (o mesmo limite que já governa a tag INATIVO do MOD-TUTOR)
- **Quando** roda
- **Então** seleciona tutores `ACTIVE` com `last_attendance_at` anterior a 90 dias, sem agendamento futuro, com consentimento de MARKETING, e cria um `campaign_run` com um `campaign_target` por tutor

**AC-02 (Edge Case — não repetir)**
- **Dado** um tutor que recebeu a campanha de reativação há 20 dias e continua inativo
- **Quando** a campanha roda de novo
- **Então** ele é `SKIPPED` com `ALREADY_TARGETED`. O intervalo mínimo é `automations.config.cooldown_days`, padrão **60**

**AC-03 (Edge Case — voltou sozinho)**
- **Dado** um tutor que agendou ontem
- **Quando** a campanha roda
- **Então** ele sai do segmento. A seleção é feita **no momento da execução**, nunca de uma lista congelada dias antes

**AC-04 (Validação / Erro — campanha sem template)**
- **Dado** uma campanha cujo template foi desativado
- **Quando** é executada
- **Então** **422** `ERR_CRM_006` e a campanha vai a `FAILED` sem enviar nada — falha inteira, não pela metade

**AC-05 (Edge Case — tutor inadimplente)**
- **Dado** um tutor inativo **e** com a tag INADIMPLENTE
- **Quando** a campanha de reativação o selecionaria
- **Então** ele é `SKIPPED` com `HAS_DEBT`. Oferecer desconto de volta a quem deve é convite errado; esse tutor é assunto da régua de cobrança (MOD-CRM-08)

---

### [MOD-CRM-08] — Régua de Cobrança

**AC-01 (Happy Path)**
- **Dado** um tutor com saldo devedor e lançamento vencido há 3 dias
- **Quando** o job diário roda
- **Então** envia `dunning_soft` (categoria TRANSACTIONAL — cobrança de dívida é execução de contrato, não marketing) com o valor em aberto e o convite a regularizar no balcão

**AC-02 (Happy Path — escalada)**
- **Dado** a régua padrão D+3 → D+10 → D+30
- **Quando** o débito persiste
- **Então** cada degrau dispara uma vez, com template próprio, e o degrau seguinte só ocorre se o débito continuar. Pagamento em qualquer ponto interrompe a régua

**AC-03 (Edge Case — pagou entre a fila e o envio)**
- **Dado** um `dunning_firm` `SCHEDULED` para as 08:00
- **Quando** `pagamento.registrado` zera o saldo às 07:40
- **Então** a mensagem vai a `CANCELLED`. **O motor revalida o saldo imediatamente antes de enviar** — cobrar quem acabou de pagar destrói a confiança que a régua inteira depende

**AC-04 (Edge Case — valor irrisório)**
- **Dado** um saldo devedor de R$ 3,00
- **Quando** a régua rodaria
- **Então** nada é enviado abaixo de `automations.config.min_debt_cents`, padrão **2000** (R$ 20). Custo social de cobrar troco é maior que o troco

**AC-05 (Edge Case — sem link de pagamento)**
- **Dado** que a v1 não tem gateway (decisão 5 do dossiê: só registro manual)
- **Quando** o template é renderizado
- **Então** **não existe variável de link de pagamento**. A mensagem convida a pagar no balcão ou por PIX na chave do petshop, escrita no próprio template pelo tenant

---

### [MOD-CRM-09] — Avisos do Taxi Dog

**AC-01 (Happy Path)**
- **Dado** a corrida de ida do Thor
- **Quando** o motorista marca "a caminho" e chega `taxi.a_caminho`
- **Então** o tutor recebe `taxi_en_route` com a janela prometida, **na categoria OPERATIONAL** — que ignora a janela de silêncio, porque um motorista às 07h30 é um fato, não uma promoção

**AC-02 (Happy Path — entregue)**
- **Dado** `taxi.entregue` da perna de volta
- **Quando** o evento chega
- **Então** o tutor recebe o aviso de entrega. Com `atendimento.concluido` no mesmo minuto, as duas mensagens são **agrupadas em uma** dentro de uma janela de 5 minutos (RN-08)

**AC-03 (Edge Case — coleta frustrada)**
- **Dado** `taxi.falhou` com `NO_ONE_HOME`
- **Quando** o evento chega
- **Então** o aviso sai imediatamente, em OPERATIONAL, com o motivo em linguagem de gente ("não conseguimos encontrar ninguém no endereço") — nunca o enum

**AC-04 (Edge Case — Taxi desligado)**
- **Dado** um tenant com `taxi_settings.enabled = false`
- **Quando** as automações são listadas
- **Então** as de taxi não aparecem na tela. Configuração de um módulo desligado é ruído

---

### [MOD-CRM-10] — Histórico de Comunicação

**AC-01 (Happy Path)**
- **Dado** a ficha de um tutor
- **Quando** a aba "Mensagens" é aberta
- **Então** lista tudo — enviado, entregue, lido, falhado, bloqueado — em ordem decrescente, com canal, template, corpo e o motivo do bloqueio quando houver

**AC-02 (Validação / Erro — sem permissão)**
- **Dado** um BATHER
- **Quando** tenta abrir o histórico
- **Então** **403** `ERR_CRM_012`. Precisa de `crm:read`

**AC-03 (Edge Case — o Portal vê o seu)**
- **Dado** o tutor logado no Portal
- **Quando** abre a central de comunicação
- **Então** vê **as suas** mensagens enviadas e entregues, sem as bloqueadas nem os erros técnicos do provedor. O tutor não precisa saber que o petshop tentou e falhou

**AC-04 (Edge Case — retenção)**
- **Dado** uma mensagem com mais de 24 meses
- **Quando** o job `messages-retention` roda
- **Então** o corpo e o destinatário são apagados e a linha permanece com metadados, para estatística. Guardar conversa antiga sem finalidade é passivo de LGPD

---

### [MOD-CRM-11] — Painel de Entregas e Falhas

**AC-01 (Happy Path)**
- **Dado** o painel `/mensagens`
- **Quando** aberto
- **Então** mostra, por período: enviadas, entregues, lidas, falhadas, bloqueadas (por motivo) e a fila represada, com o estado da conexão do WhatsApp em destaque

**AC-02 (Happy Path — reenvio)**
- **Dado** uma mensagem `DEAD`
- **Quando** o admin clica em "tentar de novo"
- **Então** volta a `QUEUED` com contador zerado, revalidando consentimento e supressão. Reenvio não é atalho para burlar bloqueio

**AC-03 (Edge Case — fila crescendo)**
- **Dado** mais de 200 mensagens em `QUEUED` há mais de 30 minutos
- **Quando** o job de saúde roda
- **Então** publica alerta para o MOD-ADMIN e a faixa aparece no painel. Fila travada em silêncio é o modo de falha mais comum de motor de mensagem

---

### [MOD-CRM-12] — Campanha Manual

**AC-01 (Happy Path)**
- **Dado** um admin com `crm:send`
- **Quando** monta uma campanha escolhendo o segmento (tags, faixa de inatividade, espécie do pet), o template e a data
- **Então** a prévia mostra **quantos serão atingidos, quantos serão pulados e por quê**, antes de qualquer envio

**AC-02 (Validação / Erro — confirmação da contagem)**
- **Dado** uma prévia de 340 destinatários
- **Quando** o disparo é confirmado com `expectedTargets = 300`
- **Então** **409** `ERR_CRM_010`. Divergência entre o que foi visto e o que será enviado exige nova prévia — a rede de proteção contra o disparo em massa acidental

**AC-03 (Edge Case — cancelar em andamento)**
- **Dado** um `campaign_run` em curso
- **Quando** o admin cancela
- **Então** as mensagens ainda `QUEUED`/`SCHEDULED` vão a `CANCELLED`; as já entregues não voltam atrás, e o run fecha como `CANCELLED` com os números parciais

---

### [MOD-CRM-13] — Recebimento de Respostas *(fora da v1)*

**AC-01 (Registro puro)**
- **Dado** um tutor que responde à mensagem
- **Quando** o webhook `MESSAGES_UPSERT` chega
- **Então** a mensagem é gravada com `direction = INBOUND`, casada ao tutor pelo telefone, e aparece no histórico. **Nenhuma ação automática é tomada** — nem opt-out por palavra-chave, que na v1 é registrado pela recepção na ficha

---

## 4. Modelo de Dados

### Tabelas Envolvidas

| Tabela | Campo | Tipo | Obrigatório | Descrição |
|---|---|---|---|---|
| messages | id / tenant_id | UUID | ✓ | PK e isolamento (RLS) |
| messages | tutor_id | UUID | ✓ | Destinatário; toda mensagem tem dono |
| messages | pet_id | UUID | — | Quando a mensagem é sobre um pet (aniversário, taxi) |
| messages | channel | Enum | ✓ | WHATSAPP, EMAIL |
| messages | direction | Enum | ✓ | OUTBOUND, INBOUND — INBOUND só é gravado (MOD-CRM-13) |
| messages | category | Enum | ✓ | TRANSACTIONAL, OPERATIONAL, MARKETING — governa consentimento, janela e teto |
| messages | template_key / template_version | — | ✓/— | Qual texto e qual versão geraram este corpo |
| messages | to_encrypted | Text | ✓ | Telefone E.164 ou e-mail, cifrado |
| messages | to_hash | Char(64) | ✓ | HMAC para casar supressão e inbound sem decifrar |
| messages | subject_encrypted | Text | — | Só EMAIL |
| messages | body_encrypted | Text | ✓ | **Renderizado na entrada da fila**, não no envio (AC-02 de MOD-CRM-02) |
| messages | status | Enum | ✓ | Ver §6 |
| messages | block_reason | Enum | — | NO_CONSENT, SUPPRESSED, NO_CHANNEL, PET_DECEASED, QUIET_HOURS_EXPIRED |
| messages | dedupe_key | VarChar(120) | ✓ | Único por tenant nos últimos 30 dias (AC-04 de MOD-CRM-03) |
| messages | origin_type / origin_id | — | — | APPOINTMENT, TAXI_RIDE, LEDGER_ENTRY, CAMPAIGN_RUN, PET, MANUAL — o que a invalida (AC-06) |
| messages | scheduled_for | Timestamptz | — | Quando pode sair; nulo = agora |
| messages | sent_at / delivered_at / read_at / failed_at | Timestamptz | — | Marcos reais |
| messages | attempts | SmallInt | ✓ | Padrão 0; morre em 5 |
| messages | provider / provider_message_id | — | — | `evolution` \| `resend`; o id devolvido, para casar callback |
| messages | error_code / error_detail | — | — | O que o provedor disse, em claro, para o painel |
| messages | requested_by | UUID | — | Nulo quando o gatilho foi automação |
| messages | created_at / updated_at | — | ✓ | Auditoria |
| message_events | id / message_id | UUID | ✓ | Callback do provedor, **append-only por trigger** |
| message_events | event / occurred_at / raw | — | ✓ | SENT, DELIVERED, READ, FAILED, BOUNCED + payload bruto |
| message_templates | id / tenant_id | UUID | ✓ | PK e isolamento |
| message_templates | key / channel | — | ✓ | Único por (tenant, key, channel) |
| message_templates | category | Enum | ✓ | Herdada pela mensagem; define a base legal |
| message_templates | subject / body | Text | —/✓ | `subject` obrigatório em EMAIL |
| message_templates | variables | String[] | ✓ | Whitelist validada na gravação (AC-03) |
| message_templates | is_system / active / version | — | ✓ | Sistema não se apaga; versão para o histórico |
| messaging_settings | tenant_id | UUID | ✓ | PK; um por tenant, como `taxi_settings` |
| messaging_settings | enabled | Boolean | ✓ | Desliga o módulo inteiro |
| messaging_settings | quiet_start / quiet_end | Time | ✓ | Padrão 08:00 / 20:00, no fuso do tenant |
| messaging_settings | marketing_weekdays_only | Boolean | ✓ | Padrão **true**: marketing não sai domingo |
| messaging_settings | daily_cap | Int | ✓ | Padrão 500; TRANSACTIONAL e OPERATIONAL não contam |
| messaging_settings | per_minute_cap | SmallInt | ✓ | Padrão 20 (RN-05) |
| messaging_settings | default_channel | Enum | ✓ | AUTO, WHATSAPP, EMAIL |
| messaging_settings | retention_months | SmallInt | ✓ | Padrão 24 (AC-04 de MOD-CRM-10) |
| messaging_settings | reply_to_email / sender_name | — | — | Identidade do e-mail do tenant |
| whatsapp_instances | tenant_id | UUID | ✓ | PK; uma instância por tenant (decisão 3: número próprio) |
| whatsapp_instances | provider / instance_name | — | ✓ | `evolution`; `tenant-<slug>` |
| whatsapp_instances | phone_e164 | VarChar(20) | — | Preenchido no pareamento |
| whatsapp_instances | status | Enum | ✓ | NOT_CONFIGURED, CONNECTING, CONNECTED, DISCONNECTED, BANNED |
| whatsapp_instances | api_key_encrypted | Text | — | Chave da instância, cifrada |
| whatsapp_instances | webhook_token_hash | Char(64) | — | Autentica o callback (RN-11) |
| whatsapp_instances | connected_at / last_seen_at / warmup_started_at | Timestamptz | — | `warmup_started_at` ancora o teto progressivo (RN-06) |
| automations | id / tenant_id | UUID | ✓ | PK e isolamento |
| automations | key | VarChar(60) | ✓ | `appointment_reminder`, `birthday_pet`, `dunning`, `taxi_en_route`… |
| automations | enabled / channel / template_key | — | ✓ | Liga, canal preferido e o texto |
| automations | config | JSONB | ✓ | `lead_hours`, `cooldown_days`, `min_debt_cents`, `steps[]` — validado por Zod **por key** |
| campaigns | id / tenant_id | UUID | ✓ | PK e isolamento |
| campaigns | name / type | — | ✓ | INACTIVE, BIRTHDAY, DUNNING, MANUAL |
| campaigns | status | Enum | ✓ | DRAFT, SCHEDULED, RUNNING, DONE, CANCELLED, FAILED |
| campaigns | segment | JSONB | ✓ | Filtro reproduzível: tags, dias de inatividade, espécie, porte |
| campaigns | template_key / channel / scheduled_for | — | ✓/— | O que e quando |
| campaigns | created_by / created_at | — | ✓ | Disparo em massa tem autor |
| campaign_runs | id / campaign_id | UUID | ✓ | Uma execução |
| campaign_runs | started_at / finished_at | Timestamptz | ✓/— | Duração |
| campaign_runs | targeted / sent / skipped / failed | Int | ✓ | Os números que o painel mostra |
| campaign_targets | id / run_id / tutor_id | UUID | ✓ | Quem entrou na mira |
| campaign_targets | status / skip_reason / message_id | — | ✓/— | SENT, SKIPPED, FAILED; `NO_CONSENT`, `ALREADY_TARGETED`, `HAS_DEBT`, `PET_DECEASED` |
| messaging_suppressions | id / tenant_id | UUID | ✓ | PK e isolamento |
| messaging_suppressions | channel / address_hash | — | ✓ | **Hash, não endereço** (AC-05 de MOD-CRM-04) |
| messaging_suppressions | reason / created_at / expires_at | — | ✓/— | HARD_BOUNCE, NOT_ON_WHATSAPP, ANONYMIZED, MANUAL; `expires_at` nulo = permanente |

> **Por que o consentimento não ganha tabela aqui.** `tutor_consents` (MOD-TUTOR) já tem `channel` × `purpose` com TRANSACTIONAL/MARKETING/BOTH, é append-only por trigger e é a prova jurídica. Uma segunda trilha no CRM criaria duas verdades sobre a mesma pergunta — e a que valeria num processo seria a do tutor-service. O CRM **lê**, nunca grava consentimento.

### Campos com Criptografia AES-256-GCM (em repouso)

| Campo | Tabela | Justificativa LGPD/PCI |
|---|---|---|
| to_encrypted | messages | Telefone e e-mail são dado pessoal — mesma regra de `tutors` |
| body_encrypted / subject_encrypted | messages | O corpo carrega nome, pet, valor devido e horário: perfil completo do titular |
| api_key_encrypted | whatsapp_instances | Credencial de acesso ao WhatsApp do cliente; vazamento = personificação do petshop |

> `to_hash` (HMAC com namespace, como `hashSearchable` do `packages/db`) fica ao lado para casar supressão e inbound sem decifrar nada. Endereço nunca vai em claro para `messaging_suppressions`.

### Índices Necessários

```sql
-- O worker: o que pode sair agora, na ordem certa.
CREATE INDEX idx_messages_dispatch ON messages(tenant_id, scheduled_for)
  WHERE status IN ('QUEUED','SCHEDULED') AND direction = 'OUTBOUND';

-- Dedupe (AC-04 de MOD-CRM-03).
CREATE UNIQUE INDEX idx_messages_dedupe ON messages(tenant_id, dedupe_key);

-- Invalidação em cascata (AC-06 de MOD-CRM-03, AC-04 de MOD-CRM-05).
CREATE INDEX idx_messages_origin ON messages(origin_type, origin_id)
  WHERE status IN ('QUEUED','SCHEDULED');

-- Histórico na ficha e no Portal.
CREATE INDEX idx_messages_tutor ON messages(tenant_id, tutor_id, created_at DESC);

-- Callback do provedor.
CREATE INDEX idx_messages_provider ON messages(provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- Painel de falhas e o alerta de fila travada.
CREATE INDEX idx_messages_failed ON messages(tenant_id, status, updated_at DESC)
  WHERE status IN ('DEAD','FAILED','BLOCKED');

-- Supressão: a consulta feita antes de todo envio.
CREATE UNIQUE INDEX idx_suppressions_addr
  ON messaging_suppressions(tenant_id, channel, address_hash);

CREATE UNIQUE INDEX idx_templates_key ON message_templates(tenant_id, key, channel);
CREATE UNIQUE INDEX idx_automations_key ON automations(tenant_id, key);
CREATE INDEX idx_campaign_targets_run ON campaign_targets(run_id, status);

-- Cooldown da campanha de inativos (AC-02 de MOD-CRM-07).
CREATE INDEX idx_campaign_targets_tutor ON campaign_targets(tutor_id, created_at DESC);
```

> O teto por minuto **não** é índice: é contador em Redis (`msgrate:<tenantId>:<minuto>`), porque a janela é curta e a contagem no Postgres a cada envio seria uma varredura por mensagem.

---

## 5. Contratos de API

Todo endpoint exige o contexto assinado pelo gateway (`@petshop/service-auth`) e infere `tenant_id` dele. Erros em `application/problem+json`. Paginação `?page=1&limit=20`.

### Endpoints — messaging-service (3010)

| Método | Path | Roles Permitidos | Descrição |
|---|---|---|---|
| POST | /v1/messages | **serviço a serviço** + ADMIN (`crm:send`) | Enfileirar uma mensagem (idempotente por `dedupeKey`) |
| GET | /v1/messages | ADMIN, RECEPÇÃO (`crm:read`) | Listar com filtros de status, canal, categoria, tutor, período |
| GET | /v1/messages/:id | ADMIN, RECEPÇÃO | Detalhe com corpo decifrado e trilha de eventos |
| POST | /v1/messages/:id/retry | ADMIN (`crm:send`) | Reenviar mensagem morta, revalidando bloqueios |
| POST | /v1/messages/:id/cancel | ADMIN, RECEPÇÃO | Cancelar mensagem ainda não enviada |
| GET | /v1/messages/stats | ADMIN, RECEPÇÃO | Números do painel por período |
| GET | /v1/tutors/:tutorId/messages | ADMIN, RECEPÇÃO; TUTOR (só as suas) | Histórico do tutor (MOD-CRM-10) |
| GET | /v1/messaging/templates | ADMIN, RECEPÇÃO | Templates do tenant |
| PUT | /v1/messaging/templates/:key | ADMIN (`crm:configure`) | Editar texto e assunto por canal |
| POST | /v1/messaging/templates/preview | ADMIN, RECEPÇÃO | Renderizar com dados de exemplo, sem enviar |
| GET | /v1/messaging/settings | ADMIN, RECEPÇÃO | Janela, tetos, canal padrão, retenção |
| PATCH | /v1/messaging/settings | ADMIN (`crm:configure`) | Editar |
| GET | /v1/messaging/whatsapp | ADMIN, RECEPÇÃO | Estado da instância |
| POST | /v1/messaging/whatsapp/connect | ADMIN (`crm:connect_channel`) | Criar instância e devolver QR |
| POST | /v1/messaging/whatsapp/qr | ADMIN (`crm:connect_channel`) | Novo QR sem recriar instância (AC-03) |
| DELETE | /v1/messaging/whatsapp | ADMIN (`crm:connect_channel`) | Desconectar |
| POST | /v1/webhooks/evolution/:instance | **público, token no header** | Callback do provedor (RN-11) |
| POST | /v1/webhooks/resend | **público, assinatura** | Callback de entrega e bounce |
| GET | /v1/messaging/suppressions | ADMIN | Endereços suprimidos e o motivo |
| DELETE | /v1/messaging/suppressions/:id | ADMIN | Remover supressão após o tutor corrigir o contato |

### Endpoints — crm-automation-service (3009)

| Método | Path | Roles Permitidos | Descrição |
|---|---|---|---|
| GET | /v1/crm/automations | ADMIN, RECEPÇÃO (`crm:read`) | Automações e seu estado |
| PATCH | /v1/crm/automations/:key | ADMIN (`crm:configure`) | Ligar/desligar, canal, template, `config` |
| GET | /v1/crm/campaigns | ADMIN, RECEPÇÃO | Campanhas |
| POST | /v1/crm/campaigns | ADMIN (`crm:send`) | Criar campanha manual |
| PATCH | /v1/crm/campaigns/:id | ADMIN (`crm:send`) | Editar rascunho |
| POST | /v1/crm/campaigns/:id/preview | ADMIN (`crm:send`) | Prévia: atingidos, pulados e por quê (AC-01 de MOD-CRM-12) |
| POST | /v1/crm/campaigns/:id/run | ADMIN (`crm:send`) | Disparar — exige `expectedTargets` (AC-02) |
| POST | /v1/crm/campaigns/:id/cancel | ADMIN (`crm:send`) | Cancelar campanha em curso |
| GET | /v1/crm/campaigns/:id/runs | ADMIN, RECEPÇÃO | Execuções e seus números |
| GET | /v1/crm/runs/:runId/targets | ADMIN, RECEPÇÃO | Quem recebeu, quem foi pulado e o motivo |

> **`POST /v1/messages` é a única porta de entrada do envio.** O crm-automation-service chama por HTTP com contexto de serviço — não escreve na tabela de mensagens, não conhece provedor. É o mesmo padrão do `BillingPort` do MOD-AGENDA: um serviço decide *quem e quando*, o outro sabe *como entregar*.

### Schema Zod — pacote `packages/shared-types`

```typescript
import { z } from 'zod'

export const MessageChannelSchema = z.enum(['WHATSAPP', 'EMAIL'])
export const MessageChannelPrefSchema = z.enum(['AUTO', 'WHATSAPP', 'EMAIL'])

/**
 * A categoria é o que decide base legal, janela de silêncio e teto diário.
 * TRANSACTIONAL: execução de contrato (lembrete, confirmação, cobrança).
 * OPERATIONAL: acontecendo agora com o pet (taxi) — ignora a janela.
 * MARKETING: exige consentimento (aniversário, campanha).
 */
export const MessageCategorySchema = z.enum(['TRANSACTIONAL', 'OPERATIONAL', 'MARKETING'])

export const MessageStatusSchema = z.enum([
  'QUEUED', 'SCHEDULED', 'SENDING', 'SENT', 'DELIVERED',
  'READ', 'FAILED', 'DEAD', 'BLOCKED', 'CANCELLED',
])

export const MessageBlockReasonSchema = z.enum([
  'NO_CONSENT', 'SUPPRESSED', 'NO_CHANNEL', 'PET_DECEASED', 'QUIET_HOURS_EXPIRED',
])

export const MessageOriginTypeSchema = z.enum([
  'APPOINTMENT', 'TAXI_RIDE', 'LEDGER_ENTRY', 'CAMPAIGN_RUN', 'PET', 'MANUAL',
])

/** Entrada única do motor. Idempotente por `dedupeKey`. */
export const EnqueueMessageSchema = z.object({
  tutorId: z.string().uuid(),
  petId: z.string().uuid().optional(),
  templateKey: z.string().min(1).max(60),
  channel: MessageChannelPrefSchema.default('AUTO'),
  /** Vem do template quando omitida; explícita só para campanha manual. */
  category: MessageCategorySchema.optional(),
  variables: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
  dedupeKey: z.string().min(1).max(120),
  originType: MessageOriginTypeSchema.optional(),
  originId: z.string().uuid().optional(),
  /** Nulo = assim que a janela permitir. Nunca "agora à força". */
  scheduledFor: z.coerce.date().optional(),
})

export const MessageTemplateSchema = z
  .object({
    channel: MessageChannelSchema,
    category: MessageCategorySchema,
    subject: z.string().max(160).optional(),
    body: z.string().min(1),
    active: z.boolean().default(true),
  })
  .refine((v) => v.channel !== 'EMAIL' || !!v.subject, {
    message: 'E-mail exige assunto',
  })
  .refine((v) => v.channel !== 'WHATSAPP' || v.body.length <= 4096, {
    message: 'WhatsApp aceita no máximo 4096 caracteres',
  })
  .refine((v) => v.channel !== 'EMAIL' || v.body.length <= 20000, {
    message: 'E-mail aceita no máximo 20000 caracteres',
  })

export const MessagingSettingsSchema = z
  .object({
    enabled: z.boolean(),
    quietStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('08:00'),
    quietEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('20:00'),
    marketingWeekdaysOnly: z.boolean().default(true),
    dailyCap: z.number().int().min(0).max(10000).default(500),
    perMinuteCap: z.number().int().min(1).max(60).default(20),
    defaultChannel: MessageChannelPrefSchema.default('AUTO'),
    retentionMonths: z.number().int().min(6).max(60).default(24),
    senderName: z.string().max(60).optional(),
    replyToEmail: z.string().email().optional(),
  })
  .refine((v) => v.quietEnd > v.quietStart, {
    message: 'A janela precisa terminar depois de começar — madrugada não é janela válida',
  })

/** `config` das automações: validado por chave, não um JSON solto. */
export const AutomationConfigSchema = z.discriminatedUnion('key', [
  z.object({
    key: z.literal('appointment_reminder'),
    leadHours: z.number().int().min(1).max(168).default(24),
  }),
  z.object({
    key: z.literal('birthday_pet'),
    includeEstimatedBirthdays: z.boolean().default(false),
    sendAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('09:00'),
  }),
  z.object({
    key: z.literal('inactive_winback'),
    inactiveDays: z.number().int().min(30).max(730).default(90),
    cooldownDays: z.number().int().min(7).max(365).default(60),
  }),
  z.object({
    key: z.literal('dunning'),
    minDebtCents: z.number().int().min(0).default(2000),
    steps: z.array(z.object({
      afterDays: z.number().int().min(0).max(365),
      templateKey: z.string().min(1).max(60),
    })).min(1).max(5),
  }),
])

export const CampaignSegmentSchema = z.object({
  tagKeys: z.array(z.string().max(40)).max(10).optional(),
  excludeTagKeys: z.array(z.string().max(40)).max(10).optional(),
  inactiveDaysMin: z.number().int().min(0).max(3650).optional(),
  species: z.array(z.string().max(30)).max(10).optional(),
  hasFutureAppointment: z.boolean().optional(),
})

/** AC-02 de MOD-CRM-12: a contagem vista precisa bater com a que vai sair. */
export const RunCampaignSchema = z.object({
  expectedTargets: z.number().int().min(0),
})
```

### Códigos de Erro Padronizados

| Código | HTTP | Cenário |
|---|---|---|
| ERR_CRM_001 | 404 | Mensagem, template, automação ou campanha não encontrada neste tenant |
| ERR_CRM_002 | 422 | Variável obrigatória do template ausente na solicitação |
| ERR_CRM_003 | 422 | Template inválido: variável desconhecida, corpo longo, e-mail sem assunto |
| ERR_CRM_004 | 409 | Template de sistema não pode ser excluído |
| ERR_CRM_005 | 409 | WhatsApp não conectado, desconectado ou banido para este tenant |
| ERR_CRM_006 | 422 | Campanha sem template ativo, ou automação com `config` inválida para a chave |
| ERR_CRM_007 | 409 | Transição de status inválida para a mensagem (ex.: cancelar o que já saiu) |
| ERR_CRM_008 | 429 | Teto por minuto ou teto diário atingido — resposta traz `retryAfter` |
| ERR_CRM_009 | 409 | Campanha já em execução ou já concluída |
| ERR_CRM_010 | 409 | `expectedTargets` diverge da contagem atual — refaça a prévia |
| ERR_CRM_011 | 422 | Segmento vazio: nenhum tutor atingido |
| ERR_CRM_012 | 403 | Papel insuficiente, ou tutor tentando ver mensagem alheia |
| ERR_CRM_013 | 409 | Módulo de mensagens desligado nas configurações do tenant |
| ERR_CRM_014 | 401 | Webhook com token ou assinatura inválida |
| ERR_CRM_015 | 502 | Provedor indisponível — a mensagem permanece na fila, não se perde |
| ERR_CRM_016 | 422 | Destinatário suprimido: contato inválido, corrija o cadastro do tutor |

---

## 6. Máquinas de Estado

### Mensagem — Status

```
        (solicitada)
             │
             ├─(sem consentimento / suprimido / sem canal)──► BLOCKED  [terminal]
             │
             ├─(fora da janela ou scheduledFor futuro)──► SCHEDULED
             │                                              │
             │                                              ├─(janela abriu)──► QUEUED
             │                                              │
             │                                              └─(evento de origem invalidou)──► CANCELLED  [terminal]
             │
             └─(dentro da janela)──► QUEUED
                                        │
                                        ├─(worker pegou)──► SENDING
                                        │                     │
                                        │                     ├─(provedor aceitou)──► SENT
                                        │                     │                        │
                                        │                     │                        ├─(callback)──► DELIVERED ──(callback)──► READ
                                        │                     │                        │
                                        │                     │                        └─(bounce)──► FAILED
                                        │                     │
                                        │                     └─(erro transitório)──► FAILED
                                        │                                               │
                                        │                                               ├─(attempts < 5)──► QUEUED
                                        │                                               │
                                        │                                               └─(attempts = 5)──► DEAD  [terminal, reenviável]
                                        │
                                        └─(cancelada pelo operador ou pelo evento)──► CANCELLED  [terminal]
```

**Efeitos colaterais por transição:**

| De | Para | Evento RabbitMQ | Efeito | Audit Log |
|---|---|---|---|---|
| — | QUEUED / SCHEDULED | `mensagem.enfileirada` | Corpo renderizado e cifrado; contador do teto reservado | — |
| — | BLOCKED | `mensagem.bloqueada` | Alvo da campanha vira SKIPPED com o motivo | ✓ (LGPD: prova de que o opt-out foi respeitado) |
| SENDING | SENT | `mensagem.enviada` | `provider_message_id` gravado; teto diário debitado | — |
| SENT | DELIVERED / READ | `mensagem.entregue` | Métrica de entrega; `campaign_runs.sent` | — |
| SENDING | FAILED | — | Backoff 1min/5min/30min/2h | — |
| FAILED | DEAD | `mensagem.falhou` | Painel de falhas; alerta ao MOD-ADMIN se em massa | ✓ |
| QUEUED/SCHEDULED | CANCELLED | — | Nada sai; motivo registrado | ✓ quando cancelada por pessoa |

### Instância de WhatsApp — Status

```
NOT_CONFIGURED ──(connect)──► CONNECTING ──(webhook: open)──► CONNECTED
                                   │                              │
                                   │                              ├─(webhook: close)──► DISCONNECTED ──(reconnect)──► CONNECTING
                                   │                              │
                                   └─(QR expirou 3x)──► NOT_CONFIGURED
                                                                  │
                                                                  └─(erro permanente de conta)──► BANNED  [exige número novo]
```

> `DISCONNECTED` **represa**, não descarta (AC-04 de MOD-CRM-01). `BANNED` derruba o canal e reencaminha o que der para e-mail (AC-05).

### Campanha — Status

```
DRAFT ──(agendar)──► SCHEDULED ──(job)──► RUNNING ──(fim)──► DONE
  │                      │                   │
  │                      │                   ├─(cancelar)──► CANCELLED
  │                      │                   │
  │                      │                   └─(template sumiu / segmento vazio)──► FAILED
  │                      │
  └──(disparo imediato)──┴──► RUNNING
```

---

## 7. Regras de Negócio & Edge Cases

| # | Cenário | Comportamento Esperado | Módulos Afetados |
|---|---|---|---|
| RN-01 | A categoria decide a base legal | TRANSACTIONAL e OPERATIONAL fluem por execução de contrato (LGPD art. 7º, V); MARKETING exige consentimento vigente em `tutor_consents` para o canal. A categoria vem do template e o chamador **não pode elevá-la** — campanha não vira transacional mudando um campo | MOD-CRM, MOD-TUTOR, MOD-SEC |
| RN-02 | Consentimento é lido, nunca escrito, pelo CRM | O CRM consulta o tutor-service (com cache Redis de 5 min, invalidado por `tutor.updated`) e jamais grava consentimento. Uma verdade só | MOD-CRM, MOD-TUTOR |
| RN-03 | Revalidação no instante do envio | Consentimento, supressão, estado do pet e — na régua de cobrança — o saldo são checados **imediatamente antes de despachar**, não só ao enfileirar. Uma mensagem pode esperar 12h na fila; o mundo muda nesse intervalo (AC-03 de MOD-CRM-08) | MOD-CRM, MOD-LEDGER, MOD-PET |
| RN-04 | Janela de silêncio | Padrão 08:00–20:00 no fuso do tenant, configurável. MARKETING respeita ainda `marketing_weekdays_only` (padrão true). **OPERATIONAL é a única exceção**: o motorista está na rua agora | MOD-CRM, MOD-TAXI, MOD-IDENT |
| RN-05 | Vazão e jitter | Máximo `per_minute_cap` (padrão 20) por tenant, com intervalo aleatório de 2 a 6 segundos entre disparos do mesmo número. Rajada uniforme é a assinatura de robô que a Meta procura | MOD-CRM |
| RN-06 | Aquecimento do número | Nos 7 primeiros dias após `warmup_started_at`, o teto diário é `min(daily_cap, 30 × dias_desde_conexão)`. Número novo disparando 500 mensagens no primeiro dia é banimento pedido | MOD-CRM |
| RN-07 | Marketing só para quem tem histórico | MARKETING exige, além do consentimento, ao menos **um atendimento concluído** do tutor. Número que nunca interagiu recebendo oferta é denúncia de spam | MOD-CRM, MOD-PRONT |
| RN-08 | Agrupamento por janela | Mensagens da mesma categoria para o mesmo tutor dentro de 5 minutos são consolidadas em uma, com as linhas concatenadas. Cobre o caso "entregue pelo taxi + atendimento concluído" e o tutor com três pets (AC-05 de MOD-CRM-05) | MOD-CRM, MOD-TAXI, MOD-PRONT |
| RN-09 | Óbito silencia tudo que é festivo | `pet.obito` cancela mensagens `SCHEDULED` de origem PET e suprime aniversário e campanha para aquele pet permanentemente. Nenhuma configuração reabre isso | MOD-CRM, MOD-PET |
| RN-10 | Anonimização apaga corpo, preserva metadado | `tutor.anonimizado` limpa `to_encrypted`, `body_encrypted` e `subject_encrypted` e cria supressão permanente; data, canal, template e status ficam para estatística e auditoria | MOD-CRM, MOD-TUTOR, MOD-SEC |
| RN-11 | Webhook é superfície pública | `POST /v1/webhooks/evolution/:instance` valida token no header contra `webhook_token_hash`, aceita corpo de no máximo 256 KB, é idempotente pelo id do provedor e responde 200 mesmo ao descartar — provedor que recebe 4xx faz retry infinito | MOD-CRM, MOD-SEC |
| RN-12 | Falha do provedor não perde mensagem | Erro de rede ou 5xx devolve a mensagem à fila; a *lease* do worker (mesmo mecanismo do `packages/job-scheduler`) garante que uma mensagem seja pega por um worker só. Reinício no meio do envio pode gerar reenvio — por isso `dedupeKey` e `provider_message_id` | MOD-CRM, MOD-ADMIN |
| RN-13 | Tenant desligado não é fila parada | `messaging_settings.enabled = false` faz `POST /v1/messages` responder **409** `ERR_CRM_013` sem enfileirar. Nada acumula esperando alguém religar | MOD-CRM |
| RN-14 | O texto congela na entrada | O corpo é renderizado quando a mensagem entra na fila, com os dados daquele instante. Editar o template ou reagendar o atendimento não reescreve o que já está na fila — o que muda é cancelar e recriar (AC-04 de MOD-CRM-05) | MOD-CRM |

---

## 8. Eventos RabbitMQ (Mensageria Assíncrona)

Exchange `petshop.events` (topic), DLX com backoff 1s/5s/30s/5min, como nos módulos 01–07.

### Publicados por este módulo

| Evento (routing key) | Publisher | Consumers | Payload Mínimo |
|---|---|---|---|
| `mensagem.enfileirada` | messaging-service | crm-automation, audit | `{ tenantId, messageId, tutorId, channel, category, templateKey, scheduledFor }` |
| `mensagem.enviada` | messaging-service | crm-automation, audit | `{ tenantId, messageId, tutorId, channel, providerMessageId, sentAt }` |
| `mensagem.entregue` | messaging-service | crm-automation, portal | `{ tenantId, messageId, tutorId, deliveredAt, readAt? }` |
| `mensagem.falhou` | messaging-service | crm-automation, audit, admin | `{ tenantId, messageId, tutorId, channel, errorCode, attempts }` |
| `mensagem.bloqueada` | messaging-service | crm-automation, audit | `{ tenantId, messageId, tutorId, blockReason, category }` |
| `canal.desconectado` | messaging-service | admin, identity | `{ tenantId, channel, status, occurredAt }` |
| `campanha.concluida` | crm-automation-service | audit, admin | `{ tenantId, campaignId, runId, targeted, sent, skipped, failed }` |

### Consumidos por este módulo

| Evento | Publisher | Automação que dispara |
|---|---|---|
| `agendamento.criado` | scheduling-service | `appointment_confirmed` (imediato) + agenda o `appointment_reminder` |
| `agendamento.cancelado` | scheduling-service | Cancela lembretes pendentes; envia `appointment_cancelled` |
| `agendamento.reagendado` | scheduling-service | Cancela e reagenda o lembrete (AC-04 de MOD-CRM-05) |
| `agendamento.no_show` | scheduling-service | Aviso de falta, quando a automação está ligada |
| `atendimento.concluido` | medical-record-service | `service_done`; alimenta o histórico usado pela RN-07 |
| `atendimento.anulado` | medical-record-service | Cancela mensagens pendentes daquele atendimento |
| `taxi.a_caminho` / `.chegou` / `.entregue` / `.falhou` | taxidog-service | Avisos OPERATIONAL (MOD-CRM-09) |
| `lancamento.criado` | billing-ledger-service | Alimenta a régua de cobrança |
| `pagamento.registrado` | billing-ledger-service | **Interrompe a régua** e cancela cobranças pendentes |
| `pacote.expirado` | billing-ledger-service | `package_expiring` / aviso de crédito perdido |
| `pet.obito` | pet-service | RN-09: silencia festivo, cancela pendentes |
| `tutor.anonimizado` | tutor-service | RN-10: apaga corpo, cria supressão |
| `tutor.updated` | tutor-service | Invalida o cache de consentimento (RN-02) |

> **A dívida do outbox continua valendo aqui.** `packages/service-kit/src/events.ts` publica best-effort depois do commit (`TODO(MOD-ADMIN)`). Para o CRM isso significa que um evento perdido é uma mensagem que nunca sai. **Mitigação da v1:** as automações críticas (lembrete, aniversário, cobrança, inativos) rodam por **job varredor** sobre o estado do banco, não só por evento — o evento antecipa, a varredura garante. Só as de reação imediata (confirmação, taxi) dependem exclusivamente do evento, e nelas a perda é tolerável.

---

## 9. Segurança & LGPD

### Controle de Acesso por Operação

| Operação | SUPER_ADMIN | TENANT_ADMIN | RECEPTIONIST | GROOMER / BATHER / VET | DRIVER | TUTOR |
|---|---|---|---|---|---|---|
| Ver histórico de mensagens | ✓ | ✓ | ✓ | — | — | ✓ (só as suas) |
| Ver painel de entregas | ✓ | ✓ | ✓ | — | — | — |
| Editar templates | ✓ | ✓ | — | — | — | — |
| Configurar automações e janela | ✓ | ✓ | — | — | — | — |
| Conectar / desconectar WhatsApp | ✓ | ✓ | — | — | — | — |
| Criar e disparar campanha | ✓ | ✓ | — | — | — | — |
| Reenviar mensagem morta | ✓ | ✓ | — | — | — | — |
| Cancelar mensagem pendente | ✓ | ✓ | ✓ | — | — | — |

**Permissões novas** (a matriz de `packages/shared-types/src/permissions.ts` vai de 49 para 53; **exige `pnpm db:seed`**):

| Chave | Quem tem por padrão | O que abre |
|---|---|---|
| `crm:read` | TENANT_ADMIN, RECEPTIONIST | Histórico, painel, templates em leitura |
| `crm:configure` | TENANT_ADMIN | Templates, automações, janela, tetos |
| `crm:send` | TENANT_ADMIN | Campanha manual, disparo, reenvio |
| `crm:connect_channel` | TENANT_ADMIN | Parear e desconectar o WhatsApp do petshop |

### Audit Log (tabela `audit_logs`)

Ações que geram registro imutável:
- **Conectar / desconectar / banir canal** → `action`, `tenantId`, `userId`, `channel`, `phone`, `ipAddress`
- **Editar template** → versão anterior e nova, `templateKey`, `channel`
- **Disparar campanha manual** → `campaignId`, `targeted`, `segment`, `userId` — disparo em massa sempre tem autor
- **Mensagem bloqueada por falta de consentimento** → é a prova de que o opt-out foi respeitado; sem ela, o petshop não tem defesa
- **Reenvio manual** → `messageId`, `userId`, motivo
- **Remoção de supressão** → `addressHash`, `userId` (destravar contato é ato deliberado)
- **Anonimização propagada** → quantas mensagens tiveram corpo apagado

### Dados Pessoais (LGPD)

| Campo | Categoria | Base Legal | Retenção | Exportável | Deletável |
|---|---|---|---|---|---|
| `messages.to_encrypted` | Dado pessoal (contato) | Execução de contrato / consentimento | 24 meses | ✓ | ✓ |
| `messages.body_encrypted` | Dado pessoal (perfil de consumo) | Execução de contrato / consentimento | 24 meses | ✓ | ✓ |
| `messages` (metadados) | Registro de operação | Legítimo interesse (prova de envio e de opt-out) | 5 anos | ✓ | — |
| `whatsapp_instances.phone_e164` | Dado da empresa | Execução de contrato | Enquanto o tenant existir | ✓ | ✓ |
| `messaging_suppressions.address_hash` | Pseudonimizado | Legítimo interesse (não incomodar quem pediu para parar) | Permanente | — | — |

> **A supressão sobrevive à exclusão.** É contraintuitivo e é correto: guardar o *hash* de quem pediu para não receber é o que impede que o mesmo contato, recadastrado amanhã, volte a ser incomodado. É o mesmo raciocínio das listas de opt-out do e-mail marketing, e é interesse do titular.

---

## 10. Performance & Observabilidade

### Cache Redis

| Dado | TTL | Chave | Invalida quando |
|---|---|---|---|
| Consentimentos do tutor | 300s | `consent:<tenantId>:<tutorId>` | `tutor.updated`, `tutor.anonimizado` |
| Configuração de mensagens | 600s | `msgcfg:<tenantId>` | `PATCH /v1/messaging/settings` |
| Template renderizável | 600s | `tpl:<tenantId>:<key>:<channel>` | `PUT /v1/messaging/templates/:key` |
| Contador de vazão | 60s | `msgrate:<tenantId>:<minuto>` | Expira sozinho |
| Contador do teto diário | até a virada do dia no fuso | `msgcap:<tenantId>:<data>` | Expira sozinho |
| Estado da instância | 30s | `wa:<tenantId>` | Webhook `CONNECTION_UPDATE` |

### Jobs (grade do `packages/job-scheduler`)

| Job | Cron | O que faz |
|---|---|---|
| `message-dispatch` | a cada 30s | Pega o lote elegível com *lease* e despacha respeitando vazão |
| `message-retry` | a cada 5min | Devolve à fila as falhas cujo backoff venceu |
| `appointment-reminders` | de hora em hora | Varredura da janela de `lead_hours` (a rede de proteção da §8) |
| `birthday-messages` | diário, 09:00 do tenant | Aniversários de pet e tutor |
| `dunning-run` | diário, 10:00 do tenant | Degraus da régua de cobrança |
| `inactive-campaign` | semanal, segunda 10:00 | Campanha de reativação |
| `messages-retention` | diário, 03:00 | Apaga corpo além da retenção |
| `channel-health` | a cada 10min | Fila represada, instância caída, alerta ao MOD-ADMIN |

### Métricas de Negócio (log estruturado Pino)

```json
{ "metric": "message_delivery_rate", "tenantId": "...", "value": 0.94, "unit": "ratio" }
```

- `message_delivery_rate`: entregues ÷ enviadas, por canal e por dia — a saúde da conexão
- `message_block_rate`: bloqueadas ÷ solicitadas, por motivo — bloqueio alto por `NO_CONSENT` é problema de cadastro, não do CRM
- `reminder_no_show_rate`: taxa de falta **entre quem recebeu lembrete** e entre quem não recebeu — o único número que justifica o módulo
- `winback_conversion`: alvos de campanha de inativos que agendaram em até 30 dias
- `opt_out_rate`: revogações de MARKETING por 100 mensagens — se subir, o texto ou a frequência estão errados
- `queue_depth` e `queue_age_seconds`: profundidade e idade da fila, por tenant
- `dunning_recovery_cents`: quanto entrou em até 15 dias após cada degrau da régua

---

## 11. Questões em Aberto

| # | Questão | Impacto | Decisor | Prazo |
|---|---|---|---|---|
| 1 | **Cupom de aniversário.** O PRD-mãe fala em "possivelmente com cupom/benefício", mas não existe cupom em lugar nenhum do sistema — o MOD-LEDGER tem crédito e pacote, não desconto condicional. A v1 manda só a felicitação, ou nasce um crédito de cortesia no ledger? | MOD-CRM-06, MOD-LEDGER | Dono do produto | Antes da fatia 3 |
| 2 | **Plano B do número banido.** Se a Evolution API custar o número do petshop, qual é a saída oferecida: número novo (perde as conversas), migração para a Cloud API oficial (custo por mensagem, aprovação de template) ou canal só de e-mail? A resposta muda o que a tela mostra no estado BANNED | MOD-CRM-01, MOD-ADMIN | Dono do produto | Antes da fatia 2 |
| 3 | **Onde roda a Evolution API.** Um container por plataforma com instância por tenant (mais simples, um ponto de falha comum) ou um container por tenant (isolamento real, custo de infra linear)? A modelagem suporta os dois; a operação, não | MOD-CRM, implantação em VPS | Tech Lead | Antes da fatia 2 |
| 4 | **A porta 3011 nasce?** Se o messaging-service é o motor único, MOD-NOTIF vira catálogo e o notification-service não existe como serviço. Confirmar antes de escrever o PRD 12 | MOD-NOTIF, SPEC §2 | Tech Lead | Antes do arquivo 12 |
| 5 | **Frequência máxima por tutor.** Existe um teto de mensagens por tutor por semana, somando todas as automações? Hoje um tutor com três pets, taxi e débito pode receber muita coisa numa semana movimentada. A RN-08 agrupa por 5 minutos, o que não resolve o acúmulo ao longo de dias | MOD-CRM-03 | Dono do produto | Durante a fatia 3 |
| 6 | **Aviso de no-show.** Mandar mensagem para quem faltou é cobrança educada ou constrangimento? A automação existe no modelo e nasce **desligada** até a decisão | MOD-CRM-05, MOD-AGENDA | Dono do produto | Durante a fatia 1 |

---

## Apêndice — Variáveis disponíveis nos templates

| Namespace | Variáveis | Origem |
|---|---|---|
| `tutor` | `nome`, `primeiro_nome`, `saldo` | MOD-TUTOR, MOD-LEDGER |
| `pet` | `nome`, `especie`, `raca`, `idade` | MOD-PET |
| `pets` | `lista` (nomes concatenados, para o AC-05 de MOD-CRM-05) | MOD-PET |
| `agendamento` | `data`, `hora`, `servico`, `profissional`, `duracao` | MOD-AGENDA |
| `taxi` | `janela_inicio`, `janela_fim`, `motorista`, `motivo_falha` | MOD-TAXI |
| `financeiro` | `valor_devido`, `dias_atraso`, `vencimento` | MOD-LEDGER |
| `petshop` | `nome`, `telefone`, `endereco`, `horario` | MOD-IDENT |

> A whitelist é validada na gravação do template (AC-03 de MOD-CRM-02) e **por template**: `taxi.motivo_falha` só existe em `taxi_failed`. Variável fora de contexto renderiza vazio, e é exatamente isso que a validação impede.
