# PRD Detalhado — Portal do Tutor

**Módulo:** MOD-PORTAL
**Arquivo:** 09/15
**Prioridade:** P1
**Fase de Implementação:** Fase 5 — Presença Digital
**Serviço Backend:** `portal-bff` (porta 3020)
**Tabelas Principais:** `portal_link_challenges` (nova), `tutors`, `tenant_settings` — e leitura agregada de `pets`, `appointments`, `attendances`, `ledger_entries`, `messages`, `taxi_rides`
**Data:** 2026-08-28
**Status:** Draft

---

## 1. Visão Geral

**Contexto de negócio.** O petshop já sabe tudo sobre o tutor — quantos pets ele tem, o que foi feito no último banho, quanto ele deve, que o Thor tem alergia a aveia. O tutor não sabe nada disso. Para descobrir qualquer coisa ele liga, e do outro lado alguém para o que estava fazendo para consultar a mesma tela que este módulo entrega. Cada ligação dessas é operação que o produto prometeu eliminar. O Portal do Tutor é a devolução dessa informação a quem ela pertence, e é também a única superfície do sistema onde o **cliente final** entra: as oito fases anteriores construíram um produto para a equipe do petshop, e esta é a primeira em que quem paga a conta vê a tela. O KPI que o PRD-mãe §11 escolheu para medir isso é direto — **% de agendamentos feitos pelo Portal contra os feitos no balcão**.

**Integração sistêmica.** Este módulo é, deliberadamente, o que menos código de domínio escreve em todo o sistema. Upstream: **MOD-IDENT** (Clerk, identidade visual do tenant, `tenant_settings`), **MOD-TUTOR** (a ficha, `portal_user_id`, endereços, consentimentos), **MOD-PET** (pets do vínculo ativo, fotos), **MOD-PRONT** (a linha do tempo, filtrada por `visibility`), **MOD-AGENDA** (disponibilidade real, preço resolvido, criação, cancelamento, reagendamento), **MOD-LEDGER** (saldo, extrato, recibo, pacotes), **MOD-TAXI** (a corrida junto do agendamento, e o acompanhamento dela), **MOD-CRM** (o histórico de mensagens). Downstream: **MOD-SITE** (o botão "agendar" do site público desemboca aqui) e **MOD-AI** (o agente conversa sobre exatamente estes dados, e o Portal é o link que ele manda quando a conversa não resolve). O `portal-bff` **não** reimplementa nenhuma regra: janela de cancelamento, antecedência mínima, gate de crédito e capacidade do motorista continuam morando nos serviços de domínio, e é isso que garante que o agente de IA da Fase 8 herde as mesmas validações sem uma segunda cópia (SPEC §286).

**O que este módulo torna real.** Duas coisas existem hoje no sistema como promessa não cumprida, e são a substância do MOD-PORTAL. A primeira: o campo `tutors.portal_user_id` está no schema desde o MOD-TUTOR e **nunca é preenchido por ninguém** — não há fluxo que crie login de tutor. A segunda: o papel `TUTOR` tem nove permissões declaradas em `packages/shared-types/src/permissions.ts` (`tutor:read_own`, `pet:update_own`, `finance:read_own`, `schedule:write_own`…) e **nenhuma rota de nenhum serviço as exige** — o sufixo `_own` é hoje letra morta, porque nunca houve quem o carregasse. Enquanto o escopo "próprio" não for aplicado de verdade, cada uma dessas permissões é uma porta destrancada esperando alguém do lado de fora. O MOD-PORTAL fecha as duas lacunas: cria a identidade do tutor e faz o escopo valer.

**Escopo da v1.** Entram as onze sub-features do §2. Ficam de fora, com o motivo: **pagamento online** (não há PSP na v1 — questão 1 do `financeiro_tutor_05.md`; o Portal mostra o extrato e o recibo, mas quitar é no balcão ou por PIX manual); **rastreamento por GPS ao vivo** do Taxi Dog (questão 7 do `taxi_dog_07.md`, com o agravante de ser localização de trabalhador); **conversa** — o Portal é tela, não chat, e responder texto livre é o MOD-AI; e **aplicativo nativo** — é web responsiva, aberta pelo link que chega no WhatsApp.

---

## 2. Sub-Features

| ID | Nome | Descrição | Must/Should/Nice |
|---|---|---|---|
| MOD-PORTAL-01 | Acesso e Vínculo | Tutor cria login e o sistema casa com a ficha existente por código de verificação | Must Have |
| MOD-PORTAL-02 | Contexto e Escopo `own` | `tutorId` no contexto assinado; todo serviço passa a aplicar o sufixo `_own` | Must Have |
| MOD-PORTAL-03 | Meus Pets | Lista e ficha dos pets do vínculo ativo; edição parcial; foto | Must Have |
| MOD-PORTAL-04 | Histórico do Pet | Linha do tempo resumida — serviços, vacinas, receituário, fotos | Must Have |
| MOD-PORTAL-05 | Agendamento Online | Disponibilidade real, preço calculado, criação respeitando os gates | Must Have |
| MOD-PORTAL-06 | Meus Agendamentos | Próximos e passados; cancelar e reagendar dentro da regra do tenant | Must Have |
| MOD-PORTAL-07 | Taxi Dog no Agendamento | Leva-e-traz pedido junto do agendamento; acompanhamento do status | Should Have |
| MOD-PORTAL-08 | Extrato e Recibos | Saldo, lançamentos, recibo em PDF, créditos de pacote | Must Have |
| MOD-PORTAL-09 | Meus Dados | Dados cadastrais próprios, endereços, telefone com reverificação | Must Have |
| MOD-PORTAL-10 | Central de Comunicação | Histórico do que foi enviado e preferências de canal (consentimento) | Should Have |
| MOD-PORTAL-11 | Superfície Pública Segura | Rate limit, honeypot, anti-enumeração e defesa de IDOR | Must Have |

---

## 3. Critérios de Aceite

### [MOD-PORTAL-01] — Acesso e Vínculo do Tutor

> **Decisão de produto (2026-08-28): auto-cadastro com verificação.** O tutor entra com o e-mail ou o telefone que já deu ao petshop; o sistema procura a ficha pelo mesmo `hashSearchable(namespace, valor)` que o MOD-TUTOR usa para CPF e telefone, e manda um código. Casou, vincula. **Não casou, não cria nada** — nem conta, nem ficha. O contrário criaria ficha órfã (um "tutor" sem pet, sem histórico e sem relação comercial) e, pior, deixaria qualquer pessoa reivindicar o cadastro alheio digitando um e-mail. O petshop continua sendo quem cria tutor; o Portal só reconhece quem já existe.

**AC-01 (Happy Path)**
- **Dado** que a Maria tem ficha no petshop com o telefone `11987654321` e nunca acessou o Portal
- **Quando** ela informa esse telefone em `POST /portal/v1/access/challenge`
- **Então** o sistema encontra a ficha por `phone_hash`, gera um código de 6 dígitos com validade de 10 minutos, envia pelo canal informado via **messaging-service** (categoria `TRANSACTIONAL`, que ignora janela de silêncio e não exige consentimento de marketing) e retorna **202** com `{ challengeId, channel: 'WHATSAPP', maskedTarget: '(11) 9****-4321' }`

**AC-02 (Happy Path — consumo do código)**
- **Dado** um desafio válido e a Maria já autenticada no Clerk (conta recém-criada com o mesmo telefone)
- **Quando** ela envia o código em `POST /portal/v1/access/verify`
- **Então** `tutors.portal_user_id` recebe o `users.id` local, `portal_linked_at` é gravado, o desafio é consumido, publica-se `tutor.portal_vinculado`, grava-se `audit_logs` e retorna **200** com o contexto inicial do Portal

**AC-03 (Validação / Erro — identificador desconhecido)**
- **Dado** um e-mail que não corresponde a nenhuma ficha do tenant
- **Quando** o desafio é solicitado
- **Então** o sistema retorna **202 com exatamente a mesma forma e o mesmo tempo de resposta do AC-01**, e não envia nada. A resposta **não** pode revelar se a pessoa é cliente do petshop: um 404 aqui transformaria o Portal em oráculo de "fulano é cliente daqui?", e isso é vazamento de dado pessoal por si só. O `verify` correspondente falha com **422** `ERR_PORTAL_002` "Código inválido ou expirado"

**AC-04 (Edge Case — ficha já vinculada a outra conta)**
- **Dado** um tutor cujo `portal_user_id` já aponta para outro usuário do Clerk
- **Quando** alguém tenta vincular a mesma ficha
- **Então** retorna **409** `ERR_PORTAL_003` "Esta ficha já tem acesso ao Portal", **sem** dizer para qual conta, e o evento vai para `security_events` — é a assinatura de uma tentativa de sequestro de ficha. Trocar o vínculo é operação de equipe (`tutor:update`), com auditoria

**AC-05 (Edge Case — força bruta no código)**
- **Dado** um desafio aberto
- **Quando** o mesmo `challengeId` recebe 5 tentativas erradas
- **Então** o desafio é invalidado (`consumed_at` preenchido, `blocked = true`), a próxima tentativa retorna **429** `ERR_PORTAL_004`, e o identificador entra em cooldown de 15 minutos. Seis dígitos são 10⁶ combinações; sem esse teto, um script acerta em minutos

**AC-06 (Edge Case — mesmo telefone em duas fichas)**
- **Dado** dois tutores do mesmo tenant com o telefone repetido (o MOD-TUTOR detecta duplicata, mas não impede quando a recepção confirma que são pessoas diferentes — marido e esposa no mesmo celular)
- **Quando** o desafio é verificado
- **Então** o vínculo **não** é criado automaticamente: retorna **409** `ERR_PORTAL_005` com orientação de procurar o petshop. Escolher uma das duas fichas por conta própria daria a um dos dois o extrato financeiro do outro

**AC-07 (Edge Case — tutor anonimizado ou inativo)**
- **Dado** um tutor com `anonymized_at` preenchido (direito de exclusão do MOD-SEC exercido)
- **Quando** tenta obter desafio
- **Então** comporta-se exatamente como o AC-03 (identificador desconhecido). Ficha anonimizada não é ficha; e o hash de busca dela já foi destruído pelo próprio processo de anonimização

---

### [MOD-PORTAL-02] — Contexto do Tutor e o Escopo `own`

> Esta sub-feature é a mudança estrutural do módulo, e ela **altera um contrato compartilhado**: `ServiceAuthContext` em `packages/service-auth` hoje carrega `clerkUserId`, `userId`, `tenantId`, `role`, `permissions` e `permVersion` — e nada que diga *qual tutor* é este usuário. Sem esse campo, `tutor:read_own` é indistinguível de `tutor:read`.

**AC-01 (Happy Path)**
- **Dado** um tutor vinculado acessando o Portal
- **Quando** o gateway resolve a sessão
- **Então** o contexto assinado inclui `tutorId`, o novo header `x-petshop-tutor-id` entra no **payload canônico do HMAC** (na posição fixa após `role`, mantendo a ordem reproduzível dos dois lados), e `role = 'TUTOR'` com as nove permissões `_own` da matriz

**AC-02 (Happy Path — escopo aplicado no serviço)**
- **Dado** um serviço de domínio recebendo `permissions: ['pet:read_own']` e `tutorId: T1`
- **Quando** `GET /v1/pets` é chamado
- **Então** o `requirePermission` do `service-kit` reconhece o par e **injeta o filtro por vínculo** (`pet_tutors.tutor_id = T1`, vínculo ativo) antes de qualquer consulta. O filtro não é opcional nem depende de o handler lembrar de aplicá-lo — quem tem só a permissão `_own` **não consegue** emitir consulta sem escopo

**AC-03 (Validação / Erro — IDOR)**
- **Dado** o tutor T1 autenticado
- **Quando** pede `GET /portal/v1/pets/{id de um pet do tutor T2}`
- **Então** retorna **404**, não 403. Um 403 confirma que o recurso existe; com id sequencial isso seria um enumerador de pets do tenant. (Os ids são UUID, o que já dificulta, mas a resposta certa não deve depender disso.) O evento vai para `security_events`

**AC-04 (Edge Case — usuário com os dois papéis)**
- **Dado** alguém que é **funcionário do petshop e também cliente dele** (caso comum: o banhista leva o próprio cachorro)
- **Quando** entra no Portal
- **Então** ele é atendido como `TUTOR`, com as permissões `_own` e nada mais. O papel operacional vive no Admin, resolvido por `membership`; o papel de tutor vive no Portal, resolvido por `tutor_id` (RN-05 de `identidade_tenancy_01`). São duas sessões com dois escopos, e o Portal **nunca** amplia permissão por o usuário ter membership

**AC-05 (Edge Case — vínculo revogado no meio da sessão)**
- **Dado** um tutor cujo `portal_user_id` foi desvinculado pela equipe há instantes
- **Quando** a próxima requisição chega com o JWT ainda válido
- **Então** a resolução de contexto falha com **401** `ERR_PORTAL_006` e a sessão do Clerk é encerrada. O `permVersion` que o MOD-IDENT já usa para invalidar permissão de equipe é o mesmo mecanismo aqui — desvincular incrementa a versão

---

### [MOD-PORTAL-03] — Meus Pets

> **Decisão de produto (2026-08-28): o tutor edita tudo, menos o que altera preço.** Nome, foto, data de nascimento, castração, observações e contato de emergência são edição direta. **Peso, porte, raça e pelagem são somente leitura**, com um caminho de "está errado? avise o petshop". O motivo é concreto: porte e pelagem entram no cálculo de duração e preço do serviço (MOD-AGENDA), e um tutor que corrige "porte médio" para "porte pequeno" na véspera do banho muda quanto vai pagar. Não é desconfiança do tutor; é que esses quatro campos são cláusula comercial, não dado cadastral.

**AC-01 (Happy Path)**
- **Dado** a Maria com dois pets ativos
- **Quando** abre "Meus pets"
- **Então** vê os dois com foto, espécie, raça, idade calculada e o próximo agendamento de cada um; **200**

**AC-02 (Happy Path — edição permitida)**
- **Dado** o pet Mel com a data de nascimento errada
- **Quando** a tutora corrige em `PATCH /portal/v1/pets/:id`
- **Então** o campo é atualizado via `pet:update_own`, gera `audit_logs` com `actor = TUTOR` e retorna **200**

**AC-03 (Validação / Erro — campo travado)**
- **Dado** a mesma requisição carregando `weightKg` ou `sizeId`
- **Quando** é processada
- **Então** retorna **422** `ERR_PORTAL_007` "Peso, porte, raça e pelagem são atualizados pelo petshop — fale com a gente e corrigimos". O schema Zod do Portal (`UpdateOwnPetSchema`) **não tem** esses campos; a validação recusa antes de chegar ao pet-service, e o pet-service recusa de novo se chegar

**AC-04 (Edge Case — foto enviada pelo tutor)**
- **Dado** a tutora subindo uma foto
- **Quando** o upload é aceito (`pet:upload_photo`)
- **Então** a foto entra com `source = TUTOR` (o enum `PhotoSource` já prevê), passa pelo mesmo redimensionamento e limite do MOD-PET-08, e fica distinguível das fotos `GROOMING_RESULT` que a equipe publica

**AC-05 (Edge Case — pet transferido ou falecido)**
- **Dado** um pet transferido para outro tutor, ou com óbito registrado
- **Quando** a lista é montada
- **Então** o transferido **some** da lista do tutor anterior (RN-07 de `pets_03`), preservando os recibos dele no extrato; o falecido aparece numa seção "em memória", somente leitura, sem botão de agendar

---

### [MOD-PORTAL-04] — Histórico do Pet

**AC-01 (Happy Path)**
- **Dado** o pet Thor com cinco atendimentos
- **Quando** o tutor abre o histórico
- **Então** vê data, serviço, profissional, fotos do resultado e as notas marcadas `TUTOR_VISIBLE`; **200**

**AC-02 (Validação / Erro — nota interna)**
- **Dado** um atendimento com nota `visibility = INTERNAL` ("tutor discutiu o preço, atenção no próximo")
- **Quando** o histórico é montado
- **Então** a nota **não** viaja na resposta — não é omitida no front, é excluída na consulta do medical-record-service. RN-09 de `prontuario_04`: o tutor vê o que foi feito, não o que a equipe escreveu entre si

**AC-03 (Edge Case — atendimento anulado)**
- **Dado** um atendimento anulado (`record:void`, MOD-PRONT-09)
- **Quando** aparece na linha do tempo
- **Então** aparece marcado como anulado, com a data da anulação, e **sem** o motivo interno. Sumir com ele seria pior: o tutor viu o pet ir ao petshop naquele dia, e uma linha do tempo que nega isso destrói a confiança na tela inteira

**AC-04 (Edge Case — alergia e alerta médico)**
- **Dado** um pet com alergia registrada
- **Quando** o tutor abre a ficha
- **Então** as alergias e os alertas médicos aparecem (é informação dele, e o MOD-PRONT já a trata como dado do pet), mas **temperamento** com classificação de risco não aparece no Portal — "agressivo com estranhos" é anotação operacional da equipe, e devolvê-la ao dono do animal por uma tela sem contexto é conflito garantido no balcão

---

### [MOD-PORTAL-05] — Agendamento Online

> As regras aqui **já estão escritas e implementadas** em `agenda_operacao_06.md` (MOD-AGENDA-06): entra `CONFIRMED` por padrão; `online_booking_requires_approval` liga a triagem com reserva de 24h; a antecedência mínima vem de `tenant_settings.min_booking_notice_hours`; o tutor inadimplente é barrado e **não existe override no Portal**. O que o MOD-PORTAL acrescenta é a superfície e o preço visível.
>
> **Atenção de nomenclatura:** o PRD 06 chama a chave de `min_booking_lead_hours`; a coluna real, já migrada, é **`min_booking_notice_hours`**. Vale a coluna.

**AC-01 (Happy Path)**
- **Dado** a Maria escolhendo "Banho" para a Mel na quinta
- **Quando** o Portal consulta `GET /v1/availability`
- **Então** recebe os horários reais da grade de 15 minutos, já descontadas jornada, folgas, bloqueios e capacidade paralela do profissional — a **mesma** consulta que a recepção faz, sem cópia de lógica

**AC-02 (Happy Path — preço à vista)**
- **Dado** o serviço "Banho" com preço que varia por porte e pelagem
- **Quando** os horários são exibidos
- **Então** o Portal mostra **o preço calculado para aquele pet** (`GET /v1/services/:id/pricing` resolvido por `petId`), e é esse valor que congela na criação do agendamento. Decisão de produto de 2026-08-28: agendar sem saber o preço faz o tutor ligar, e a ligação anula o self-service que justifica o módulo

**AC-03 (Happy Path — criação)**
- **Dado** o horário escolhido
- **Quando** o Portal chama `POST /v1/appointments` com `source = PORTAL`
- **Então** o agendamento nasce `CONFIRMED`, retorna **201**, publica `agendamento.criado` e a confirmação sai pelo MOD-CRM. O enum `AppointmentSource.PORTAL` já existe no schema desde o MOD-AGENDA — é este módulo que finalmente o produz

**AC-04 (Validação / Erro — antecedência mínima)**
- **Dado** `min_booking_notice_hours = 2` e agora são 09:00
- **Quando** o tutor tenta 10:30
- **Então** **422** `ERR_AGENDA_007`, e a mensagem **sempre** traz a alternativa: "Agendamentos pelo site precisam de 2 horas de antecedência. O próximo horário disponível é 11:00." Erro que fecha a porta sem apontar a saída devolve o tutor ao telefone

**AC-05 (Validação / Erro — inadimplência)**
- **Dado** um tutor com débito acima de `billing_settings.credit_limit_cents`
- **Quando** tenta agendar
- **Então** **409** `ERR_AGENDA_008` com o saldo devedor e o convite a falar com o petshop. O override do RN-11 do MOD-AGENDA **não é exposto no Portal**: quem libera exceção é a equipe, não o devedor

**AC-06 (Edge Case — aprovação ligada)**
- **Dado** `online_booking_requires_approval = true`
- **Quando** o tutor agenda
- **Então** entra `PENDING`, o horário fica reservado por 24h, o Portal mostra "aguardando confirmação do petshop", e a expiração sem decisão é do job `booking-approval-expiry` — que avisa o tutor

**AC-07 (Edge Case — Portal desligado)**
- **Dado** `online_booking_enabled = false` no tenant
- **Quando** o tutor abre a aba de agendar
- **Então** a aba não existe, e a rota responde **403** `ERR_PORTAL_008` mesmo se chamada direto. O restante do Portal (histórico, extrato, dados) continua funcionando — desligar agendamento online não é desligar o Portal

**AC-08 (Edge Case — corrida entre dois tutores no mesmo horário)**
- **Dado** o último horário livre das 14:00 e dois tutores confirmando ao mesmo tempo
- **Quando** as duas requisições chegam
- **Então** uma vence e a outra recebe **409** `ERR_AGENDA_00x` com a lista de horários próximos. Quem garante isso é a transação `SERIALIZABLE` na janela do profissional (RN-13 do MOD-AGENDA), não o Portal — que só precisa **não** tratar o conflito como erro genérico

---

### [MOD-PORTAL-06] — Meus Agendamentos

**AC-01 (Happy Path)**
- **Dado** a Maria com um agendamento na quinta e três no histórico
- **Quando** abre "Meus agendamentos"
- **Então** vê os próximos com pet, serviço, horário, profissional, preço congelado e status; e os passados paginados; **200**

**AC-02 (Happy Path — cancelamento dentro da janela)**
- **Dado** um agendamento para quinta 09:00, hoje é terça, `cancellation_window_hours = 24`
- **Quando** cancela pelo Portal
- **Então** status `CANCELLED` **sem taxa**, publica `agendamento.cancelado`, o horário volta à grade; **200** (AC-01 de MOD-AGENDA-08)

**AC-03 (Validação / Erro — cancelamento tardio)**
- **Dado** um agendamento em menos de 24h
- **Quando** o tutor cancela
- **Então** o Portal **primeiro mostra a consequência** ("cancelar agora gera uma taxa de R$ X") e só cancela com a confirmação explícita. O cancelamento **acontece** — o pet não vem de qualquer jeito —, com `late = true` e o débito de `no_show_fee_percent` no MOD-LEDGER. Com o percentual em 0, nenhuma taxa é gerada e o aviso não aparece

**AC-04 (Edge Case — reagendamento)**
- **Dado** um agendamento futuro
- **Quando** o tutor reagenda
- **Então** vale o mesmo fluxo do AC-01 do agendamento (disponibilidade real, antecedência, gates), o registro anterior vai a `RESCHEDULED` e o preço **é recalculado** para a nova data — congelar preço protege contra mudança de tabela, não contra mudança de horário pedida pelo cliente

**AC-05 (Edge Case — status em andamento)**
- **Dado** um agendamento já em `CHECKED_IN` ou `IN_PROGRESS`
- **Quando** o tutor tenta cancelar
- **Então** **409** `ERR_PORTAL_009` "Seu pet já está no petshop — fale com a gente". A máquina de estado do MOD-AGENDA não aceita a transição, e a mensagem precisa explicar isso em português de cliente

---

### [MOD-PORTAL-07] — Taxi Dog no Agendamento

> **Decisão de produto (2026-08-28), respondendo à questão 3 de `taxi_dog_07.md`: o tutor pede o leva-e-traz junto com o agendamento, não como pedido solto.** Isso preserva a regra estrutural do MOD-TAXI — o agendamento é o dono da corrida — e evita uma segunda fila de aprovação além da que o agendamento online já pode ter. Ida e volta continuam sendo **duas linhas** em `taxi_rides` (RN-02 do MOD-TAXI).

**AC-01 (Happy Path)**
- **Dado** a Maria agendando um banho e marcando "quero leva-e-traz (ida e volta)"
- **Quando** confirma
- **Então** nascem o agendamento e **duas** corridas, o endereço do tutor entra como **snapshot cifrado** na corrida (não FK viva), e o Portal mostra a janela estimada de coleta; **201**

**AC-02 (Happy Path — preço antes de pedir)**
- **Dado** o endereço da Maria numa zona atendida
- **Quando** ela marca a opção
- **Então** o Portal consulta `GET /v1/taxi/quote` e mostra o valor da corrida somado ao do serviço, **antes** da confirmação. O `quote` existe separado exatamente para isso (§5 do MOD-TAXI: "o Portal e o agente de IA precisam responder *quanto custa buscar aqui?* antes de existir agendamento")

**AC-03 (Validação / Erro — fora da área)**
- **Dado** um endereço fora de toda zona configurada
- **Quando** o tutor marca a opção
- **Então** **422** `ERR_TAXI_00x` com a mensagem de que o endereço está fora da área de atendimento, e o agendamento **segue sem o taxi** — perder o banho por causa do transporte seria o pior desfecho possível

**AC-04 (Edge Case — sem capacidade)**
- **Dado** que a van já está cheia naquela janela (capacidade efetiva = `min(motorista, veículo)`)
- **Quando** o tutor pede
- **Então** **409** com as janelas alternativas do mesmo dia. O Portal **não** enfileira pedido sem vaga: uma corrida "quem sabe" é uma promessa que a operação não fez

**AC-05 (Edge Case — acompanhamento)**
- **Dado** uma corrida em andamento
- **Quando** o tutor abre o agendamento
- **Então** vê o status textual (`A caminho` / `Chegou` / `A bordo` / `Entregue`) e a janela — **sem mapa e sem posição do veículo**. Rastreamento por GPS é a questão 7 do MOD-TAXI, fora da v1, e carrega uma discussão de LGPD sobre localização do trabalhador que não se resolve numa tela

**AC-06 (Edge Case — cancelamento em cascata)**
- **Dado** um agendamento com taxi
- **Quando** o tutor cancela o agendamento
- **Então** as duas corridas são canceladas com `TaxiCancelReason.TUTOR_REQUEST`, e a regra de taxa é a do agendamento — não se cobra duas vezes pelo mesmo arrependimento

---

### [MOD-PORTAL-08] — Extrato e Recibos

**AC-01 (Happy Path)**
- **Dado** a Maria com saldo devedor de R$ 180,00
- **Quando** abre "Financeiro"
- **Então** vê o saldo com a convenção única da plataforma (**negativo = deve; positivo = tem crédito**, RN-02 do MOD-LEDGER), os lançamentos paginados com data, descrição e valor, e o extrato do período; **200**

**AC-02 (Validação / Erro — nota interna do lançamento)**
- **Dado** um lançamento com `internal_notes` ("dei desconto porque ela reclamou")
- **Quando** o extrato é montado para o Portal
- **Então** o campo não viaja. O billing-ledger-service já separa isso por permissão; o Portal usa `finance:read_own`, que não alcança `internal_notes`

**AC-03 (Happy Path — recibo em PDF)**
- **Dado** um pagamento registrado
- **Quando** o tutor pede o recibo
- **Então** o PDF do MOD-DOC (Gotenberg) é gerado e entregue por URL assinada de vida curta, e o acesso fica em `audit_logs`

**AC-04 (Edge Case — pacote e créditos)**
- **Dado** um pacote de 4 banhos com 1 restante
- **Quando** o tutor abre a tela
- **Então** vê "1 banho restante — expira em 12/11/2026", exatamente como o AC do MOD-LEDGER-03 previu. E vê a regra: crédito não usado expira e **nada é devolvido** (RN-08), dita antes do vencimento, não depois

**AC-05 (Edge Case — sem forma de pagar)**
- **Dado** um tutor com débito olhando o extrato
- **Quando** procura "pagar agora"
- **Então** não existe botão, e sim o caminho real: a chave PIX do petshop e o horário de atendimento. Fingir um checkout que não existe (não há PSP na v1) é pior que a ausência dele

---

### [MOD-PORTAL-09] — Meus Dados

**AC-01 (Happy Path)**
- **Dado** a Maria mudando de casa
- **Quando** atualiza o endereço em `PATCH /portal/v1/me/addresses/:id`
- **Então** o endereço é atualizado via `tutor:update_own`, com o mesmo ViaCEP e as mesmas validações do Admin; **200**. O endereço novo **não** altera corridas de taxi já criadas — elas guardam snapshot

**AC-02 (Validação / Erro — telefone e e-mail)**
- **Dado** a tutora trocando o telefone
- **Quando** confirma
- **Então** a mudança **não** é aplicada direto: dispara um desafio de verificação no canal novo (o mesmo mecanismo do MOD-PORTAL-01) e só propaga com o código. RN-13 de `tutores_02`: alterar e-mail no Portal exige reverificação antes de propagar. Telefone e e-mail são as chaves de identidade e os canais de cobrança — deixar trocar sem prova permite sequestrar a ficha por dentro

**AC-03 (Validação / Erro — CPF)**
- **Dado** a tutora tentando corrigir o próprio CPF
- **Quando** envia
- **Então** **422** `ERR_PORTAL_007`. CPF é chave de deduplicação e de identificação fiscal; corrigi-lo é operação de balcão com conferência de documento

**AC-04 (Edge Case — direito de acesso, LGPD art. 18)**
- **Dado** a tutora querendo seus dados
- **Quando** clica em "baixar meus dados"
- **Então** o Portal usa o `GET /v1/tutors/:id/export` **que já existe** no tutor-service, escopado a ela, e entrega o arquivo. O Portal é a primeira implementação de **autoatendimento** do direito de acesso — hoje ele depende de alguém do petshop rodar a exportação

**AC-05 (Edge Case — pedido de exclusão)**
- **Dado** a tutora pedindo exclusão dos dados
- **Quando** confirma
- **Então** o pedido é **registrado e encaminhado à equipe**, não executado. A anonimização do MOD-SEC apaga a ficha de quem pode ter débito aberto e obrigação fiscal de guarda; a decisão precisa de gente. O Portal informa o prazo legal de resposta

---

### [MOD-PORTAL-10] — Central de Comunicação e Preferências

**AC-01 (Happy Path)**
- **Dado** a Maria que recebeu 12 mensagens do petshop
- **Quando** abre "Mensagens"
- **Então** vê **as suas** mensagens enviadas e entregues, com data e canal; **200** (AC-03 de MOD-CRM-10)

**AC-02 (Validação / Erro — o que não se mostra)**
- **Dado** mensagens bloqueadas por consentimento ou falhadas por erro do provedor
- **Quando** a lista é montada
- **Então** elas **não** aparecem. O tutor não precisa saber que o petshop tentou e falhou; e listar bloqueio por consentimento seria expor a régua interna

**AC-03 (Happy Path — preferências)**
- **Dado** a tutora querendo parar de receber promoções
- **Quando** desliga "novidades e promoções"
- **Então** grava-se `tutor_consents` com `source = PORTAL` (o enum já prevê), o canal `MARKETING` para de sair no próximo disparo, e as mensagens `TRANSACTIONAL` e `OPERATIONAL` **continuam** — confirmação de agendamento e aviso do motorista não são marketing e não dependem de opt-in

**AC-04 (Edge Case — append-only)**
- **Dado** que `tutor_consents` é append-only por trigger
- **Quando** a tutora liga e desliga três vezes
- **Então** são três linhas novas, nenhuma alterada. O estado atual é a última linha por `channel × purpose`, e a trilha jurídica fica intacta — é o que prova, num questionamento futuro, *quando* ela consentiu e *quando* revogou

---

### [MOD-PORTAL-11] — Superfície Pública Segura

> Esta é a primeira superfície do sistema exposta a quem não é funcionário. Todo o resto do produto vive atrás de um convite de equipe; aqui a porta é pública por definição. As defesas não são adorno.

**AC-01 (Happy Path — rate limit por identificador)**
- **Dado** o endpoint de desafio
- **Quando** o mesmo identificador pede 3 códigos em 15 minutos
- **Então** o quarto retorna **429** `ERR_PORTAL_004`. O limite é por identificador **e** por IP, em janelas distintas: só por IP, um NAT de operadora bloqueia um bairro inteiro; só por identificador, um script rotativo passa

**AC-02 (Happy Path — honeypot)**
- **Dado** o formulário público de acesso
- **Quando** o campo oculto do honeypot vem preenchido
- **Então** a resposta é **202 idêntica à do sucesso** e nada acontece. Exigência explícita do PRD-mãe §315 e do SPEC §195; responder com erro ensinaria o bot a contornar

**AC-03 (Edge Case — enumeração por tempo)**
- **Dado** que a busca por ficha existente é mais rápida que a inexistente
- **Quando** os dois casos respondem
- **Então** o tempo de resposta é equalizado por um piso artificial. Sem isso, o AC-03 do MOD-PORTAL-01 é derrotado por cronômetro — a resposta é idêntica, mas o relógio conta

**AC-04 (Edge Case — o Portal não é o Admin)**
- **Dado** um tutor autenticado
- **Quando** chama uma rota administrativa (`/v1/tutors`, `/v1/agenda/day`) direto no gateway
- **Então** **403**, e o gateway **não** encaminha. O `portal-bff` é uma superfície separada com uma lista de rotas própria (SPEC §173), e nenhum papel `TUTOR` alcança o prefixo `/v1` administrativo

---

## 4. Modelo de Dados

### Tabelas Envolvidas

| Tabela | Campo | Tipo | Obrigatório | Descrição |
|---|---|---|---|---|
| `portal_link_challenges` **(nova)** | `id` | UUID | ✓ | PK |
| `portal_link_challenges` | `tenant_id` | UUID | ✓ | Isolamento multi-tenant (RLS) |
| `portal_link_challenges` | `tutor_id` | UUID | — | Ficha encontrada. **Nulo quando não casou** — a linha existe mesmo assim, para o rate limit contar tentativa de identificador inexistente |
| `portal_link_challenges` | `identifier_hash` | String | ✓ | `hashSearchable('portal_identifier', valor)` — nunca o e-mail ou telefone em claro |
| `portal_link_challenges` | `channel` | Enum | ✓ | `EMAIL` \| `WHATSAPP` |
| `portal_link_challenges` | `code_hash` | String | ✓ | HMAC do código de 6 dígitos. Guardar o código legível daria a quem lesse a tabela o acesso à ficha |
| `portal_link_challenges` | `clerk_user_id` | Text | ✓ | Quem pediu. O vínculo só se completa se o mesmo usuário verificar |
| `portal_link_challenges` | `attempts` | SmallInt | ✓ | Default 0; teto de 5 (AC-05) |
| `portal_link_challenges` | `expires_at` | Timestamptz | ✓ | 10 minutos |
| `portal_link_challenges` | `consumed_at` | Timestamptz | — | Uso único |
| `portal_link_challenges` | `blocked` | Boolean | ✓ | Default false; true após esgotar tentativas |
| `portal_link_challenges` | `ip_address` | Inet | — | Para o rate limit e a investigação de abuso |
| `portal_link_challenges` | `created_at` | Timestamptz | ✓ | — |
| `tutors` | `portal_user_id` | UUID | — | **Já existe.** Passa a ser preenchido por este módulo |
| `tutors` | `portal_linked_at` | Timestamptz | — | **Novo.** Quando o vínculo nasceu — o `portal_user_id` sozinho não conta essa história |
| `tutors` | `portal_last_seen_at` | Timestamptz | — | **Novo.** Alimenta a métrica de adoção e a decisão de continuar mandando WhatsApp para quem nunca abre o Portal |
| `tenant_settings` | `portal_enabled` | Boolean | ✓ | **Novo**, default `true`. Distinto de `online_booking_enabled`: desligar agendamento online não é desligar o Portal |
| `tenant_settings` | `online_booking_enabled` | Boolean | ✓ | Já existe |
| `tenant_settings` | `online_booking_requires_approval` | Boolean | ✓ | Já existe |
| `tenant_settings` | `min_booking_notice_hours` | SmallInt | ✓ | Já existe. **É este o nome da coluna** — o PRD 06 a chama de `min_booking_lead_hours` |

**Somente leitura, via serviço de domínio (o `portal-bff` não tem tabela própria além da acima):** `pets`, `pet_tutors`, `pet_photos`, `attendances`, `attendance_notes`, `appointments`, `appointment_items`, `taxi_rides`, `ledger_entries`, `package_purchases`, `messages`, `tutor_consents`, `tutor_addresses`.

### Campos com Criptografia AES-256-GCM (em repouso)

| Campo | Tabela | Justificativa LGPD/PCI |
|---|---|---|
| — | `portal_link_challenges` | **Nenhum campo cifrado, de propósito.** O identificador é *hash* (busca por igualdade, sem necessidade de decifrar) e o código é *hash* (nunca precisa ser lido de volta, só comparado). Cifrar aqui daria a ilusão de proteção com a chave ao lado; o hash é a escolha certa quando ninguém precisa do texto original |

> Os dados pessoais que o Portal exibe (CPF, telefone, endereço) continuam cifrados nas tabelas de origem, e o `portal-bff` os recebe já decifrados pelos serviços de domínio, sob `withTenant()` e escopo `_own`. **O BFF não decifra nada** — não tem acesso à KEK, e não deve ter.

### Índices Necessários

```sql
CREATE INDEX idx_portal_challenges_tenant_identifier
  ON portal_link_challenges (tenant_id, identifier_hash, created_at DESC);

-- Rate limit por IP na janela curta.
CREATE INDEX idx_portal_challenges_ip
  ON portal_link_challenges (ip_address, created_at DESC)
  WHERE ip_address IS NOT NULL;

-- Varredura do job de expiração.
CREATE INDEX idx_portal_challenges_expiry
  ON portal_link_challenges (expires_at)
  WHERE consumed_at IS NULL;

-- Um tutor, um login. O índice parcial é o que impede o AC-04 do MOD-PORTAL-01
-- por constraint, e não por checagem no código.
CREATE UNIQUE INDEX idx_tutors_portal_user
  ON tutors (tenant_id, portal_user_id)
  WHERE portal_user_id IS NOT NULL;
```

> `portal_link_challenges` entra em `RLS_MODELS` e ganha policy na migration, como toda tabela com `tenant_id` (ver `packages/db/prisma/migrations/README.md`). **Com uma ressalva de implementação:** a busca do desafio acontece **antes** de haver contexto de tenant resolvido pela sessão — o tenant vem do subdomínio, não do JWT. Essa consulta é uma das que ficam restritas a `packages/db/src/platform.ts`, com `app_maintenance`, e recebe o `tenant_id` do host explicitamente.

---

## 5. Contratos de API

Superfície separada sob o prefixo **`/portal/v1`**, roteada pelo gateway ao `portal-bff:3020`. O prefixo não é cosmético: é o que permite uma allowlist de rotas própria (SPEC §173), rate limit próprio e a garantia do AC-04 de MOD-PORTAL-11 — nenhum papel `TUTOR` alcança `/v1`. Autenticação por JWT do Clerk, como no Admin; o tenant vem do host (subdomínio do tenant), e o `tutorId` sai da resolução de sessão.

### Endpoints

| Método | Path | Autenticação | Descrição |
|---|---|---|---|
| GET | `/portal/v1/tenant` | **pública** | Identidade visual do tenant para a tela de login (nome, logo, cores). Sem dado de cliente |
| POST | `/portal/v1/access/challenge` | pública + honeypot | Pede código de verificação (sempre 202) |
| POST | `/portal/v1/access/verify` | Clerk | Consome o código e cria o vínculo |
| GET | `/portal/v1/me` | TUTOR | Contexto: tutor, tenant, flags (`portalEnabled`, `onlineBookingEnabled`) |
| PATCH | `/portal/v1/me` | TUTOR | Dados próprios (sem CPF; telefone e e-mail exigem desafio) |
| GET/POST | `/portal/v1/me/addresses` | TUTOR | Endereços próprios |
| PATCH/DELETE | `/portal/v1/me/addresses/:id` | TUTOR | — |
| GET | `/portal/v1/me/export` | TUTOR | Direito de acesso (LGPD art. 18) |
| POST | `/portal/v1/me/deletion-request` | TUTOR | Registra pedido de exclusão para a equipe |
| GET | `/portal/v1/pets` | TUTOR | Pets do vínculo ativo |
| GET | `/portal/v1/pets/:id` | TUTOR | Ficha, com alergias e alertas médicos |
| PATCH | `/portal/v1/pets/:id` | TUTOR | Campos permitidos (`UpdateOwnPetSchema`) |
| POST | `/portal/v1/pets/:id/photos` | TUTOR | Foto com `source = TUTOR` |
| GET | `/portal/v1/pets/:id/timeline` | TUTOR | Histórico resumido (sem `INTERNAL`) |
| GET | `/portal/v1/booking/services` | TUTOR | Serviços agendáveis (`BOOKABLE_SERVICE_CATEGORIES` — exclui `TAXI`) |
| GET | `/portal/v1/booking/availability` | TUTOR | Disponibilidade real + preço por pet |
| GET | `/portal/v1/booking/taxi-quote` | TUTOR | Preço do leva-e-traz para o endereço |
| POST | `/portal/v1/booking` | TUTOR | Cria agendamento (+ corridas, se pedido) |
| GET | `/portal/v1/appointments` | TUTOR | Próximos e passados |
| GET | `/portal/v1/appointments/:id` | TUTOR | Detalhe, com status do taxi |
| POST | `/portal/v1/appointments/:id/cancel` | TUTOR | Cancela; devolve a taxa prevista antes de confirmar |
| POST | `/portal/v1/appointments/:id/reschedule` | TUTOR | Reagenda |
| GET | `/portal/v1/finance` | TUTOR | Saldo, pacotes ativos e resumo |
| GET | `/portal/v1/finance/statement` | TUTOR | Extrato paginado |
| GET | `/portal/v1/finance/receipts/:paymentId` | TUTOR | Recibo em PDF (URL assinada) |
| GET | `/portal/v1/messages` | TUTOR | Central de comunicação |
| GET/PUT | `/portal/v1/preferences` | TUTOR | Consentimentos por canal e finalidade |

> **Agregação, não regra.** `POST /portal/v1/booking` é uma chamada que vira `POST /v1/appointments` no scheduling-service e, quando há leva-e-traz, `POST /v1/taxi/rides` no taxidog-service. O BFF orquestra e traduz o erro para linguagem de cliente; **quem valida é o serviço de domínio**. Se a corrida falhar depois do agendamento criado, o BFF **não** desfaz o agendamento (AC-03 de MOD-PORTAL-07): devolve o agendamento criado e o aviso sobre o transporte.

### Schema Zod — pacote `packages/shared-types`

```typescript
import { z } from 'zod'

/** MOD-PORTAL-01. O identificador é e-mail OU telefone; o canal decorre dele. */
export const PortalChallengeSchema = z.object({
  identifier: z.string().min(5).max(120),
  /** Honeypot: precisa chegar vazio. Nome inócuo de propósito. */
  website: z.string().max(0).optional(),
})
export type PortalChallengeInput = z.infer<typeof PortalChallengeSchema>

export const PortalVerifySchema = z.object({
  challengeId: z.string().uuid(),
  code: z.string().regex(/^\d{6}$/),
})

/**
 * MOD-PORTAL-03 — o schema é a trava.
 * Peso, porte, raça e pelagem NÃO estão aqui, e é por isso que o AC-03 funciona
 * antes de qualquer checagem no handler: o campo simplesmente não é aceito.
 */
export const UpdateOwnPetSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  birthDate: z.coerce.date().optional(),
  neutered: z.boolean().optional(),
  notes: z.string().max(500).optional(),
  emergencyContact: z.string().max(120).optional(),
}).strict()

/** MOD-PORTAL-05 e 07 — o agendamento e o transporte num pedido só. */
export const PortalBookingSchema = z.object({
  petId: z.string().uuid(),
  serviceIds: z.array(z.string().uuid()).min(1),
  startsAt: z.string().datetime(),
  professionalId: z.string().uuid().optional(),
  taxi: z.object({
    legs: z.enum(['PICKUP', 'DROPOFF', 'BOTH']),
    addressId: z.string().uuid(),
  }).optional(),
  /** Idempotência de duplo toque no celular — o mesmo padrão do MOD-LEDGER. */
  idempotencyKey: z.string().uuid(),
}).strict()

export const PortalContextResponseSchema = z.object({
  tutor: z.object({
    id: z.string().uuid(),
    name: z.string(),
    balanceCents: z.number().int(),
  }),
  tenant: z.object({
    name: z.string(),
    slug: z.string(),
    branding: z.record(z.string()),
    timezone: z.string(),
  }),
  features: z.object({
    portalEnabled: z.boolean(),
    onlineBookingEnabled: z.boolean(),
    onlineBookingRequiresApproval: z.boolean(),
    taxiEnabled: z.boolean(),
  }),
})
```

### Códigos de Erro Padronizados

| Código | HTTP | Cenário |
|---|---|---|
| `ERR_PORTAL_001` | 404 | Recurso não encontrado **no escopo deste tutor** (inclui o caso de existir para outro — AC-03 de MOD-PORTAL-02) |
| `ERR_PORTAL_002` | 422 | Código de verificação inválido ou expirado |
| `ERR_PORTAL_003` | 409 | Ficha já vinculada a outro acesso |
| `ERR_PORTAL_004` | 429 | Limite de tentativas ou de pedidos de código |
| `ERR_PORTAL_005` | 409 | Identificador corresponde a mais de uma ficha |
| `ERR_PORTAL_006` | 401 | Vínculo revogado ou sessão inválida |
| `ERR_PORTAL_007` | 422 | Campo não editável pelo tutor |
| `ERR_PORTAL_008` | 403 | Recurso desligado no tenant (`portal_enabled`, `online_booking_enabled`) |
| `ERR_PORTAL_009` | 409 | Operação incompatível com o estado atual do agendamento |
| `ERR_PORTAL_010` | 502 | Serviço de domínio indisponível — o BFF não inventa resposta |

> Erros dos serviços de domínio (`ERR_AGENDA_007`, `ERR_AGENDA_008`, `ERR_TAXI_*`, `ERR_LEDGER_*`) **atravessam com o código original**. Reescrevê-los como `ERR_PORTAL_*` esconderia a origem do problema de quem for depurar; o BFF traduz a **mensagem** para linguagem de cliente, não o código.

---

## 6. Máquinas de Estado

### Vínculo do Tutor ao Portal

```
UNLINKED  (tutors.portal_user_id IS NULL)
  │
  ├─(POST /access/challenge, ficha encontrada)──► CHALLENGED
  │                                                  │
  │                                                  ├─(código correto, dentro de 10 min)──► LINKED
  │                                                  │
  │                                                  ├─(5 tentativas erradas)──► BLOCKED ──(15 min)──► UNLINKED
  │                                                  │
  │                                                  └─(expirou sem uso)──► UNLINKED
  │
  ├─(POST /access/challenge, ficha NÃO encontrada)──► UNLINKED
  │     (mesma resposta 202, nada enviado, linha gravada só para o rate limit)
  │
  └─ LINKED ──(equipe desvincula, tutor:update)──► UNLINKED  [permVersion++]
             ──(tutor anonimizado, MOD-SEC)──────► UNLINKED  [vínculo destruído junto]
```

**Efeitos colaterais por transição:**

| De | Para | Evento RabbitMQ | Notificações | Audit Log |
|---|---|---|---|---|
| UNLINKED | CHALLENGED | — | Código por WhatsApp/e-mail (`TRANSACTIONAL`) | ✓ |
| CHALLENGED | LINKED | `tutor.portal_vinculado` | Boas-vindas (`TRANSACTIONAL`) | ✓ |
| CHALLENGED | BLOCKED | — | — | ✓ + `security_events` |
| LINKED | UNLINKED | `tutor.portal_desvinculado` | Aviso ao tutor de que o acesso foi encerrado | ✓ |

> **Agendamento, corrida e lançamento não têm máquina de estado própria aqui.** O Portal é mais um ator sobre as máquinas do MOD-AGENDA, do MOD-TAXI e do MOD-LEDGER. Desenhar uma segunda versão delas neste arquivo criaria duas fontes de verdade — e a que estaria errada seria esta.

---

## 7. Regras de Negócio & Edge Cases

| # | Cenário | Comportamento Esperado | Módulos Afetados |
|---|---|---|---|
| RN-01 | O Portal não decide nada | Toda regra (janela, antecedência, crédito, capacidade) é avaliada pelo serviço de domínio. O BFF agrega, traduz erro e nunca valida por conta própria | MOD-PORTAL, todos |
| RN-02 | Escopo `own` é filtro, não checagem | A permissão `_own` **injeta** o filtro por `tutorId` na consulta. Handler que "esquece" de filtrar não deve ser possível | MOD-PORTAL, MOD-IDENT |
| RN-03 | 404 em vez de 403 para recurso alheio | 403 confirma existência. Toda negação por escopo responde 404 | MOD-PORTAL, MOD-SEC |
| RN-04 | Resposta uniforme na porta pública | Identificador existente e inexistente respondem igual, em forma e em tempo | MOD-PORTAL, MOD-SEC |
| RN-05 | Um tutor, um login | `UNIQUE (tenant_id, portal_user_id)` parcial. Trocar o vínculo é operação de equipe, auditada | MOD-PORTAL, MOD-TUTOR |
| RN-06 | Um login, vários petshops | A mesma pessoa pode ser tutora em dois tenants. Cada vínculo é independente, e o tenant vem do host — nunca de um seletor que o tutor controla | MOD-PORTAL, MOD-IDENT |
| RN-07 | Campos que definem preço são somente leitura | Peso, porte, raça e pelagem não entram no schema de edição do Portal | MOD-PORTAL, MOD-PET, MOD-AGENDA |
| RN-08 | Telefone e e-mail exigem reverificação | São chave de identidade e canal de cobrança; trocar sem prova é sequestrar a ficha por dentro | MOD-PORTAL, MOD-TUTOR |
| RN-09 | O tutor vê o que foi feito, não o que se escreveu | `INTERNAL` nunca sai; `TUTOR_VISIBLE` sai. Temperamento com classificação de risco não aparece | MOD-PORTAL, MOD-PRONT |
| RN-10 | Sem override no Portal | O gate de crédito do MOD-AGENDA não tem exceção acionável pelo tutor. Quem libera é a equipe | MOD-PORTAL, MOD-LEDGER, MOD-AGENDA |
| RN-11 | Preço à vista e congelado | O preço mostrado antes de confirmar é o que congela no agendamento. Reagendamento recalcula | MOD-PORTAL, MOD-AGENDA |
| RN-12 | Taxi só junto de agendamento | Não existe corrida avulsa pedida pelo tutor. O agendamento é o dono da corrida | MOD-PORTAL, MOD-TAXI |
| RN-13 | Falha parcial não desfaz o todo | Agendamento criado + taxi falhado = agendamento mantido, com aviso. O contrário perde o serviço por causa do transporte | MOD-PORTAL, MOD-AGENDA, MOD-TAXI |
| RN-14 | Idempotência no toque duplo | Todo POST que cria (agendamento, corrida, desafio) aceita `idempotencyKey`. Celular com conexão ruim é a regra, não a exceção | MOD-PORTAL, MOD-AGENDA, MOD-LEDGER |
| RN-15 | Desligar agendamento ≠ desligar Portal | `online_booking_enabled` e `portal_enabled` são chaves independentes | MOD-PORTAL, MOD-IDENT |
| RN-16 | O BFF não guarda dado pessoal | Nenhuma cópia local de PII, nenhum cache de resposta com dado de cliente em disco. O que ele cacheia é catálogo e configuração | MOD-PORTAL, MOD-SEC |

---

## 8. Eventos RabbitMQ (Mensageria Assíncrona)

Exchange `petshop.events` (topic), DLX com backoff 1s / 5s / 30s / 5min.

| Evento (routing key) | Publisher | Consumers | Payload Mínimo |
|---|---|---|---|
| `tutor.portal_vinculado` | portal-bff | crm-automation (boas-vindas), tutor-service (`portal_linked_at`), audit | `{ tenantId, tutorId, userId, channel, occurredAt }` |
| `tutor.portal_desvinculado` | identity/tutor-service | portal-bff (invalidar sessão), audit | `{ tenantId, tutorId, reason, occurredAt }` |
| `portal.acesso_suspeito` | portal-bff | MOD-ADMIN (alerta), MOD-SEC | `{ tenantId, identifierHash, ip, attempts, occurredAt }` |

**Eventos que o Portal apenas provoca, sem publicar:** `agendamento.criado` (com `source = PORTAL`), `agendamento.cancelado`, `taxi.solicitado`, `consentimento.alterado`. Eles saem dos serviços de domínio, como já saem quando a origem é o balcão — e é essa uniformidade que faz o MOD-CRM tratar os dois casos sem saber a diferença.

**Consumidos pelo Portal:** nenhum, na v1. O Portal lê estado sob demanda. Consumir evento aqui só faria sentido para notificação em tempo real na aba aberta, que não está no escopo.

---

## 9. Segurança & LGPD

### Controle de Acesso por Operação

| Operação | Super Admin | Admin do Tenant | Recepção | Profissional | Motorista | **Tutor (Portal)** |
|---|---|---|---|---|---|---|
| Ver os próprios pets | ✓ | ✓ (todos) | ✓ (todos) | ✓ (atribuídos) | ✓ (atribuídos) | **✓ (vínculo ativo)** |
| Editar campo livre do pet | ✓ | ✓ | ✓ | — | — | **✓ (`pet:update_own`)** |
| Editar peso/porte/raça/pelagem | ✓ | ✓ | ✓ | ✓ (peso) | — | **—** |
| Ver histórico clínico completo | ✓ | ✓ | ✓ | ✓ | — | **— (só resumo)** |
| Agendar | ✓ | ✓ | ✓ | ✓ (próprio) | — | **✓ (`schedule:write_own`)** |
| Cancelar agendamento | ✓ | ✓ | ✓ | — | — | **✓ (próprio)** |
| Liberar exceção de crédito | ✓ | ✓ | ✓ | — | — | **—** |
| Ver extrato financeiro | ✓ | ✓ | ✓ | — | — | **✓ (`finance:read_own`)** |
| Registrar pagamento | ✓ | ✓ | ✓ | — | — | **—** |
| Pedir Taxi Dog | ✓ | ✓ | ✓ | — | — | **✓ (junto do agendamento)** |
| Ver mensagens enviadas | ✓ | ✓ | ✓ (`crm:read`) | — | — | **✓ (`crm:read_own`)** |
| Alterar consentimento | ✓ | ✓ | ✓ | — | — | **✓ (o próprio)** |
| Vincular/desvincular Portal | ✓ | ✓ | ✓ | — | — | **✓ (só vincular a si)** |

> **Permissão nova: `crm:read_own`.** A central de comunicação precisa de uma leitura escopada que a matriz ainda não tem — `crm:read` é permissão de equipe e alcança todas as mensagens do tenant. Sai de 53 para **54 permissões**, e exige `pnpm db:seed`, como toda mudança de catálogo. As outras nove permissões do papel `TUTOR` **já existem** desde o MOD-IDENT-04; este módulo é o primeiro a usá-las.

### Audit Log — ações que DEVEM gerar registro imutável

- **Vínculo criado** → `action = 'portal.link.created'`, com `tutorId`, `clerkUserId`, `channel`, `ipAddress`, `userAgent`
- **Vínculo revogado** → quem revogou e por quê
- **Tentativa de vincular ficha já vinculada** (AC-04) → também em `security_events`
- **Bloqueio por tentativas** (AC-05) → também em `security_events`
- **Acesso negado por escopo** (IDOR, AC-03 do MOD-PORTAL-02) → `security_events`, com o recurso pedido
- **Edição de dado próprio** (tutor ou pet) → `actor` marcado como `TUTOR`, para que a ficha distinga o que o cliente mudou do que a equipe mudou
- **Download de exportação LGPD** e **pedido de exclusão**
- **Alteração de consentimento** → além da linha append-only em `tutor_consents`

### Dados Pessoais (LGPD)

| Campo | Categoria | Base Legal | Retenção | Exportável | Deletável |
|---|---|---|---|---|---|
| `identifier_hash` | Dado pessoal (pseudonimizado) | Legítimo interesse (segurança do acesso) | 90 dias | — | ✓ (com o desafio) |
| `ip_address` do desafio | Dado pessoal | Legítimo interesse (prevenção a fraude) | 90 dias | — | ✓ |
| `portal_user_id`, `portal_linked_at` | Dado cadastral | Execução de contrato | Enquanto durar a relação | ✓ | ✓ (na anonimização) |
| Consentimentos alterados no Portal | Dado pessoal | Consentimento | 5 anos após revogação (prova) | ✓ | — (trilha jurídica) |

**O Portal é a implementação prática de dois direitos do art. 18.** O de **acesso** vira autoatendimento (MOD-PORTAL-09 AC-04) usando a exportação que o tutor-service já tem. O de **exclusão** permanece intermediado (AC-05): a anonimização apaga a ficha de alguém que pode ter débito aberto e obrigação fiscal de guarda, e essa avaliação não cabe num botão.

---

## 10. Performance & Observabilidade

### Cache Redis

| Dado | TTL | Chave | Invalida quando |
|---|---|---|---|
| Identidade visual do tenant (tela pública) | 300s | `portal:tenant:{slug}` | `tenant.settings_atualizado` |
| Catálogo de serviços agendáveis | 120s | `portal:services:{tenantId}` | `servico.atualizado` |
| Contexto do tutor (`/me`) | 30s | `portal:me:{tenantId}:{tutorId}` | Qualquer escrita do próprio tutor; `permVersion++` |
| Rate limit de desafio | 900s | `portal:rl:{tenantId}:{identifierHash}` e `portal:rl:ip:{ip}` | Janela |

> **Disponibilidade, extrato e histórico não são cacheados.** Mostrar horário vago que já foi tomado, ou saldo desatualizado, produz exatamente a ligação que o Portal existe para evitar. O SLO cobre a latência; o cache não é o instrumento certo aqui.

### Métricas de Negócio (Pino structured log)

```json
{ "metric": "portal_booking_created", "tenantId": "...", "value": 1, "unit": "count" }
```

- `portal_link_completed` / `portal_link_abandoned`: quantos pedem código e quantos concluem. A distância entre os dois é o funil de adoção, e é o número que diz se o auto-cadastro foi a escolha certa
- `portal_booking_created`: agendamentos com `source = PORTAL`. Contra o total, é o **KPI do PRD-mãe §11**
- `portal_booking_blocked`: por motivo (`antecedência`, `crédito`, `capacidade`, `Portal desligado`) — diz o que está travando o self-service
- `portal_active_tutors`: tutores com `portal_last_seen_at` nos últimos 30 dias
- `portal_scope_violation`: tentativas de acesso a recurso alheio. **Espera-se zero**; qualquer valor não nulo é investigação, não estatística

### SLOs

| Superfície | Alvo |
|---|---|
| `/portal/v1/me` e listagens | p95 < 400 ms |
| `/portal/v1/booking/availability` | p95 < 800 ms (agrega scheduling + pricing) |
| `POST /portal/v1/booking` | p95 < 1,2 s (agrega scheduling + taxi) |
| Disponibilidade do Portal | 99,5% — o PRD-mãe §357 exige 24/7 do Portal, embora o petshop opere em horário comercial |

### Jobs

| Job | Cadência | O que faz |
|---|---|---|
| `portal-challenge-expiry` | 5 min | Marca desafios vencidos e apaga os com mais de 90 dias (retenção da tabela) |
| `portal-adoption-rollup` | diário | Consolida `portal_active_tutors` e a taxa de agendamento self-service por tenant |

---

## 11. Questões em Aberto

| # | Questão | Impacto | Decisor | Prazo |
|---|---|---|---|---|
| 1 | **Onde o Portal mora.** `slug.dominio.com.br/portal` (o mesmo host do Admin, separado por rota) ou `portal.dominio.com.br/slug`? O wildcard TLS já cobre os dois; o que muda é a instância do Clerk e o isolamento de cookie entre a sessão de equipe e a de cliente | MOD-PORTAL, MOD-SITE, implantação em VPS | Tech Lead | Antes da fatia 1 |
| 2 | **Instância do Clerk do tutor.** A mesma do Admin (um diretório de usuários, papéis distintos) ou uma separada? A mesma é mais barata e permite o caso do funcionário-cliente (AC-04 de MOD-PORTAL-02) sem segunda conta; separada dá isolamento real entre quem opera e quem consome | MOD-PORTAL, MOD-IDENT, custo Clerk | Tech Lead | Antes da fatia 1 |
| 3 | **Co-tutor vê o extrato?** Dois tutores no mesmo pet (casal, pai e filho) enxergam o mesmo pet, e isso está decidido no MOD-PET. Mas o extrato é **por tutor**: cada um vê só o seu. Confirmar que é isso mesmo, ou se o co-tutor de um pet deve ver o que foi cobrado por aquele pet, ainda que na conta do outro | MOD-PORTAL, MOD-LEDGER, LGPD | Dono do produto | Antes da fatia 3 |
| 4 | **Notificação de mudança feita pelo tutor.** Quando o tutor cancela às 23h de véspera, quem da equipe fica sabendo antes de chegar de manhã? Hoje o MOD-CRM avisa o tutor, não o petshop. Um canal de "avisos da operação" é MOD-ADMIN ou uma automação de CRM apontando para a equipe? | MOD-PORTAL, MOD-CRM, MOD-ADMIN | Dono do produto | Durante a fatia 2 |
| 5 | **Primeiro acesso em massa.** Um petshop que entra com 800 tutores cadastrados quer avisar todos de uma vez sobre o Portal. Isso é campanha de MOD-CRM (e conta contra o teto diário e o aquecimento do número), ou um disparo transacional à parte? O risco de banimento do WhatsApp mora nessa resposta | MOD-PORTAL, MOD-CRM | Dono do produto + Tech Lead | Antes do piloto com Portal |
| 6 | **Sessão longa no celular.** Tutor não quer logar toda vez. Qual a validade da sessão do Portal, e ela é diferente da do Admin (que lida com dado de terceiros e merece expirar mais rápido)? | MOD-PORTAL, MOD-SEC | Tech Lead | Antes da fatia 1 |

---

## Apêndice — Fatiamento sugerido da implementação

O módulo não cabe numa entrega só, e a ordem abaixo mantém cada fatia utilizável por si.

| Fatia | Conteúdo | Por que nesta ordem |
|---|---|---|
| **1** | MOD-PORTAL-01, 02, 11 + `GET /portal/v1/me` | Sem identidade e sem escopo `_own` aplicado, nada mais pode ser exposto com segurança. A fatia 1 não entrega tela útil ao tutor — entrega a porta |
| **2** | MOD-PORTAL-03, 04, 09 | Leitura e edição do que é dele. Já é um Portal com valor: o tutor para de ligar para perguntar quando foi o último banho |
| **3** | MOD-PORTAL-05, 06 | O agendamento online, que é o KPI. Depende do escopo da fatia 1 e da ficha da fatia 2 |
| **4** | MOD-PORTAL-07, 08, 10 | Taxi, financeiro e comunicação — os três se apoiam em módulos que já estão prontos, e nenhum bloqueia os anteriores |

> **Dependência de código que já existe e precisa mudar:** a fatia 1 altera `packages/service-auth` (campo `tutorId` no contexto assinado e no payload canônico do HMAC) e o `requirePermission` do `packages/service-kit` (o par permissão `_own` → filtro). São dois pacotes compartilhados pelos dez serviços; a alteração é retrocompatível (campo opcional), mas a suíte inteira do monorepo passa por ela.
