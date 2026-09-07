# PRD Detalhado — Notificações Transacionais (E-mail)

**Módulo:** MOD-NOTIF
**Arquivo:** 12/15
**Prioridade:** P1
**Fase de Implementação:** Fase 6 — Documentos e Notificações
**Serviço Backend:** nenhum serviço novo. O `messaging-service` (porta 3010) é o motor único de saída; a **porta 3011 do SPEC §2 não nasce**
**Tabelas Principais:** `messages`, `message_templates`, `messaging_settings`, `messaging_suppressions` (alteradas). Nenhuma tabela nova
**Data:** 2026-09-07
**Status:** Draft

---

## 1. Visão Geral

**Contexto de negócio.** O e-mail transacional é o canal do produto para as duas coisas que o WhatsApp não faz. A primeira é falar com quem **não é cliente do petshop**: o dono que acabou de criar a conta, o membro da equipe no primeiro acesso, o administrador que precisa saber que algo quebrou. A segunda é **entregar arquivo**: recibo, receituário e termo aceito chegam por e-mail como anexo, e por WhatsApp só como link. Nenhuma das duas é conversa com o tutor sobre o banho do sábado, e é por isso que o MOD-CRM, que resolveu aquela, não resolve estas.

**O que já existe, e por que este módulo é menor do que o SPEC previa.** O e-mail está no ar desde a fatia 1 do MOD-CRM: `ports/email.ts` fala com o Resend por `fetch`, degrada para log sem `RESEND_API_KEY`, distingue recusa permanente de temporária e suprime endereço que voltou. A convenção fixada no PRD 08 vale e se confirma aqui — **o `messaging-service` é o motor único de saída**, e o `notification-service:3011` do SPEC §2 seria um segundo motor com a mesma fila, a mesma supressão e o mesmo provedor. O que falta ao MOD-NOTIF não é infraestrutura de envio; é **destinatário, molde e anexo**.

**As duas descobertas que dão substância ao módulo.** A primeira: **o motor é inteiro moldado no tutor.** `messages.tutor_id` é `NOT NULL` com FK e `onDelete: Cascade`, `resolveDelivery` lê a ficha do tutor para achar telefone e e-mail, e os três gates de despacho — consentimento, janela de silêncio e teto semanal — descrevem a relação comercial com um cliente. Nada disso se aplica a um e-mail dirigido a um membro da equipe, e é por isso que existe hoje uma **segunda saída de e-mail no sistema**: `identity-service/src/lib/mailer.ts`, que manda o convite de equipe direto ao Resend, sem histórico, sem painel e sem retentativa. O comentário do próprio `ports/email.ts` já anotou isso: *"quando o MOD-NOTIF for implementado, é o convite de equipe que migra para cá"*.

A segunda: **o bounce assíncrono não tem quem o escute.** `dispatch.ts` suprime o endereço quando o Resend **recusa na hora** (400, 401, 403, 404, 422). Mas o caminho normal de um endereço inexistente não é esse: o Resend aceita a mensagem, responde 202, e o bounce chega minutos depois por webhook. O `messaging-service` tem rota de webhook do WhatsApp e **nenhuma do Resend**. Na prática, o domínio de e-mail da instalação vai acumulando entregas a endereços mortos sem ninguém perceber, que é o caminho mais curto para a caixa de spam.

**Escopo da v1.** Entram as doze sub-features do §2, com a décima segunda **especificada e não migrada**. Ficam de fora, por decisão registrada em 2026-09-07: a **migração do convite de equipe** (o módulo constrói exatamente a máquina de que ele precisa e o deixa onde está — ver §MOD-NOTIF-12 e a questão 1) e os **avisos operacionais ao administrador** (falha de job, WhatsApp desconectado, documento morto), que seguem só no sino da topbar. Também fora, por já existirem ou pertencerem a outro módulo: confirmação e lembrete de agendamento por e-mail — **já saem hoje**, na queda do canal `AUTO` do MOD-CRM; recuperação de senha e verificação de identidade, que são fluxo do Clerk e continuam lá; e qualquer coisa parecida com newsletter, que é MARKETING e portanto MOD-CRM.

---

## 2. Sub-Features

| ID | Nome | Descrição | Must/Should/Nice |
|---|---|---|---|
| MOD-NOTIF-01 | Destinatário de dois tipos | `messages` passa a endereçar tutor **ou** usuário da equipe | Must Have |
| MOD-NOTIF-02 | Gates por tipo | Consentimento, janela e tetos valem para tutor; nunca para equipe | Must Have |
| MOD-NOTIF-03 | Identidade do remetente | Domínio da plataforma, nome e responder-para do tenant | Must Have |
| MOD-NOTIF-04 | Molde de marca | Segundo molde de HTML, só para texto escrito pelo produto | Must Have |
| MOD-NOTIF-05 | Anexos | O e-mail passa a carregar arquivo; o WhatsApp continua levando link | Must Have |
| MOD-NOTIF-06 | Recibo por e-mail | Fecha o `receipts.sent_at`, inalcançável desde o MOD-LEDGER | Must Have |
| MOD-NOTIF-07 | Documento por e-mail | Todo documento do MOD-DOC entregue como anexo ao titular | Should Have |
| MOD-NOTIF-08 | Boas-vindas do tenant | O e-mail que fecha o onboarding, ao administrador | Should Have |
| MOD-NOTIF-09 | Boas-vindas do usuário | Primeiro acesso de um membro da equipe | Should Have |
| MOD-NOTIF-10 | Retorno do provedor | Webhook do Resend: bounce e reclamação viram supressão | Must Have |
| MOD-NOTIF-11 | Histórico da equipe | O painel de entregas passa a mostrar o que foi para a equipe | Should Have |
| MOD-NOTIF-12 | Convite de equipe | Especificado; **não migrado na v1** | Nice to Have |

---

## 3. Critérios de Aceite

### [MOD-NOTIF-01] — Destinatário de Dois Tipos

> **Decisão de arquitetura (2026-09-07): o destinatário vira união, dentro do motor.** `messages.tutor_id` passa a ser anulável, entra `user_id` e entra `recipient_kind` (`TUTOR` | `USER`). A alternativa — deixar o e-mail de equipe no `identity-service` — mantém duas saídas de e-mail, duas configurações de remetente e nenhum painel que mostre o convite que não chegou. É a mesma forma da mudança que a fatia 1 do MOD-PORTAL fez em `service-auth` ao acrescentar `tutorId`: um campo opcional num contrato compartilhado, retrocompatível, mas que a suíte inteira atravessa.

**AC-01 (Happy Path — mensagem para a equipe)**
- **Dado** um e-mail dirigido a um membro da equipe
- **Quando** é enfileirado
- **Então** grava-se `recipient_kind = 'USER'`, `user_id` preenchido, `tutor_id` nulo, e a mensagem percorre a mesma fila, o mesmo despacho e o mesmo histórico das demais; **201**

**AC-02 (Validação / Erro — destinatário ambíguo)**
- **Dado** um enfileiramento com `tutorId` e `userId` ao mesmo tempo, ou com nenhum dos dois
- **Quando** submete
- **Então** **422** `ERR_CRM_002`. A garantia é de banco, não só de schema: um CHECK obriga exatamente um dos dois preenchido, coerente com `recipient_kind`

**AC-03 (Edge Case — o e-mail do usuário está cifrado com outra chave)**
- **Dado** um destinatário do tipo `USER`
- **Quando** o motor resolve o endereço
- **Então** ele abre a **chave de plataforma** (derivada da KEK por HKDF), e não a DEK do tenant. `users` é tabela **global**, fora de `RLS_MODELS`, e a leitura passa por `packages/db/src/platform.ts`. Usar o cifrador do tutor aqui devolveria lixo, não erro — é a pegadinha central desta sub-feature

**AC-04 (Edge Case — usuário removido do tenant)**
- **Dado** uma mensagem endereçada a um usuário cujo vínculo com o tenant foi encerrado
- **Quando** o despacho a alcança
- **Então** nasce `BLOCKED` com motivo `NO_CHANNEL`. O `user_id` **não** tem `onDelete: Cascade` como o do tutor: o histórico do que se mandou a um ex-membro é registro de auditoria, e apagá-lo junto com o vínculo apagaria a prova de que o convite foi enviado

**AC-05 (Edge Case — o parque existente)**
- **Dado** todas as mensagens já gravadas, todas de tutor
- **Quando** a migration roda
- **Então** `recipient_kind` nasce com `DEFAULT 'TUTOR'` e nenhuma linha precisa ser reescrita. Uma migration que exija backfill de tabela de fila é uma migration que trava o deploy

---

### [MOD-NOTIF-02] — Gates por Tipo de Destinatário

> Esta é a sub-feature que justifica a anterior. Os gates do MOD-CRM não são cerimônia: são a diferença entre um sistema que respeita o cliente e um que o incomoda. Aplicá-los à equipe seria absurdo — um convite que não sai às 21h porque a janela de silêncio fechou é um convite quebrado.

**AC-01 (Happy Path — a equipe não passa pelos gates do tutor)**
- **Dado** uma mensagem com `recipient_kind = 'USER'`
- **Quando** o despacho decide
- **Então** **não** se consulta `tutor_consents`, **não** se aplica a janela de silêncio, **não** contam o teto diário, o por minuto nem o teto semanal de marketing. O motivo é um só: os quatro descrevem a relação comercial com um cliente, e um membro da equipe não é cliente

**AC-02 (Cenário negativo — o gate que continua valendo)**
- **Dado** o endereço de um membro da equipe que está em `messaging_suppressions`
- **Quando** a mensagem é despachada
- **Então** nasce `BLOCKED` com motivo `SUPPRESSED`. A supressão é por **hash de endereço** e por tenant, sem acoplamento com tutor — vale para qualquer destinatário, e é a única proteção que protege o **domínio remetente**, não a pessoa

**AC-03 (Cenário negativo — MARKETING para a equipe)**
- **Dado** um enfileiramento com `recipient_kind = 'USER'` e um template de categoria `MARKETING`
- **Quando** submete
- **Então** **422** `ERR_CRM_002`. É a mesma linha que a guarda do `overrideAddress` já não cruza: sem ela, este campo viraria caminho de mandar oferta a qualquer endereço, sem consentimento e sem ficha

**AC-04 (Edge Case — o motor desligado)**
- **Dado** um tenant com `messaging_settings.enabled = false`, que é o padrão de nascimento
- **Quando** um e-mail transacional de equipe é enfileirado
- **Então** ele **sai assim mesmo**. O interruptor foi desenhado para o disparo ao cliente, que é a decisão de quem responde pelo número do petshop. Um tenant que não ligou o CRM ainda precisa receber o e-mail de boas-vindas do próprio onboarding — senão o interruptor desliga justamente a mensagem que ensina a ligá-lo

---

### [MOD-NOTIF-03] — Identidade do Remetente

> **Decisão de produto (2026-09-07): domínio da plataforma, identidade do tenant.** O e-mail sai de um domínio verificado **uma vez** no Resend, com o nome do petshop no remetente e o e-mail dele no responder-para. `messaging_settings.sender_name` e `reply_to_email` já existem e passam a ter uso. Domínio próprio por tenant exigiria SPF, DKIM e DMARC verificados por petshop — o mesmo fluxo de DNS que o MOD-SITE adiou, pela mesma razão, e que aqui custaria caro: reputação de entrega fragmentada em centenas de domínios novos entrega **pior** que um domínio único bem cuidado.

**AC-01 (Happy Path)**
- **Dado** um tenant com nome de remetente e responder-para configurados
- **Quando** qualquer e-mail sai
- **Então** o cabeçalho é `{sender_name} <{MAIL_FROM}>` e o `reply_to` é o e-mail do petshop. O tutor que responder fala com o petshop, não com o vazio

**AC-02 (Edge Case — `MAIL_FROM` já vem com nome)**
- **Dado** `MAIL_FROM = "PetShop AI <contato@dominio>"`, que é o formato do `.env` deste projeto
- **Quando** o remetente é montado
- **Então** o nome do tenant **não** é prefixado de novo. Prefixar produziria `Nome <PetShop AI <contato@…>>`, que o Resend recusa — e a recusa só apareceria em produção, no primeiro envio. O `ports/email.ts` já trata isso; o teste que fixa o comportamento entra aqui

**AC-03 (Cenário negativo — sem domínio verificado)**
- **Dado** uma instalação sem `RESEND_API_KEY` ou sem `MAIL_FROM`
- **Quando** um e-mail é despachado
- **Então** ele é marcado como enviado com `provider = 'log'` e registrado. Travar a fila por falta de chave trocaria um problema de entrega por um de fila cheia, e no dia da configuração o petshop dispararia semanas de mensagem de uma vez

**AC-04 (Edge Case — responder-para inválido)**
- **Dado** um `reply_to_email` que não é endereço válido
- **Quando** o admin salva as configurações
- **Então** **422** na gravação, não no envio. Endereço inválido descoberto no despacho vira falha permanente de uma mensagem que era boa

---

### [MOD-NOTIF-04] — Molde de Marca

> **Decisão de produto (2026-09-07): dois moldes, escolhidos pelo autor do texto.** O corpo escrito **pelo petshop** na tela do CRM continua em texto puro com o embrulho mínimo de hoje — quem edita ali não escreve marcação, e um texto de WhatsApp dentro de moldura corporativa soa falso. O corpo escrito **pelo produto** (boas-vindas, recibo, documento) ganha molde com logo, cores e rodapé do tenant. Um molde só para os dois casos pioraria um dos dois.

**AC-01 (Happy Path — texto do produto)**
- **Dado** um template marcado como `authored: 'SYSTEM'` no catálogo
- **Quando** o e-mail é renderizado
- **Então** sai no molde de marca: logo do tenant no topo, cor primária no título, corpo, e rodapé com nome, endereço e telefone do estabelecimento — o mesmo cabeçalho que o MOD-DOC define para o PDF, montado da mesma fonte

**AC-02 (Happy Path — texto do petshop)**
- **Dado** um template `authored: 'TENANT'`, que é todo o catálogo de hoje
- **Quando** o e-mail é renderizado
- **Então** sai como sai hoje: texto puro, quebras de linha preservadas, nenhuma imagem

**AC-03 (Edge Case — cliente de e-mail sem imagem)**
- **Dado** um destinatário cujo cliente bloqueia imagens externas, que é o padrão de boa parte deles
- **Quando** abre o e-mail
- **Então** o conteúdo continua legível e a ação continua clicável. O logo tem `alt` com o nome do petshop e nenhuma informação vive só dentro de imagem

**AC-04 (Edge Case — tenant sem identidade visual)**
- **Dado** um tenant que não subiu logo nem escolheu cor
- **Quando** o molde é montado
- **Então** cai no padrão do produto, sem espaço vazio e sem imagem quebrada

**AC-05 (Edge Case — escape)**
- **Dado** um nome de tutor ou de petshop com `<`, `>` ou `&`
- **Quando** entra no molde
- **Então** aparece literal. O molde é função pura como o do MOD-DOC, sem engine de template, e todo campo livre passa por escape

---

### [MOD-NOTIF-05] — Anexos

**AC-01 (Happy Path)**
- **Dado** um e-mail com um documento arquivado do MOD-DOC
- **Quando** é despachado
- **Então** o arquivo é lido do R2 no momento do envio, vai em base64 no corpo do POST ao Resend, e a mensagem registra a referência ao documento — **nunca o conteúdo**. O corpo cifrado da mensagem guarda texto, não arquivo

**AC-02 (Cenário negativo — anexo grande demais)**
- **Dado** um documento acima do teto de 8 MB
- **Quando** o envio é montado
- **Então** o e-mail sai **com link em vez de anexo**, e o histórico registra a troca. Falhar a entrega de um recibo por causa do tamanho é pior que entregá-lo por link

**AC-03 (Cenário negativo — anexo no WhatsApp)**
- **Dado** uma mensagem com anexo cujo canal resolvido é `WHATSAPP`
- **Quando** o despacho monta o envio
- **Então** o anexo é substituído por link para o Portal. Arquivo pela Evolution cai nas regras de mídia, engorda a fila e some do histórico do tutor

**AC-04 (Edge Case — documento ainda pendente)**
- **Dado** um documento do MOD-DOC ainda em `PENDING`, porque o Gotenberg estava fora
- **Quando** o e-mail seria despachado
- **Então** a mensagem fica `SCHEDULED` e é retomada quando o `documento.emitido` chegar. Mandar e-mail dizendo "segue o recibo" sem recibo é pior que atrasar

**AC-05 (Edge Case — a URL assinada não vaza para o histórico)**
- **Dado** uma mensagem que caiu para link
- **Quando** o corpo é gravado
- **Então** o que se grava é o endereço da página do Portal, **nunca** a URL assinada do bucket. URL assinada é credencial, e credencial em histórico é credencial vazada

---

### [MOD-NOTIF-06] — Recibo por E-mail

**AC-01 (Happy Path)**
- **Dado** um pagamento registrado e o recibo emitido pelo MOD-DOC
- **Quando** o `documento.emitido` do tipo `RECEIPT` é consumido
- **Então** enfileira-se o template `receipt_issued` para o tutor, com o PDF anexado; entregue, grava-se `receipts.sent_at` e o recibo vai a `SENT`

**AC-02 (Edge Case — o estado que existia sem caminho)**
- **Dado** que `receipts.sent_at` está no schema desde o MOD-LEDGER com o comentário *"inalcançável até o MOD-NOTIF existir: não há quem envie"*
- **Quando** este módulo entra
- **Então** a máquina de estado `PENDING → ISSUED → SENT` do PRD 05 §6 fica completa pela primeira vez

**AC-03 (Cenário negativo — tutor sem e-mail)**
- **Dado** um tutor cadastrado só com telefone, que é o caso comum no balcão
- **Quando** o recibo é emitido
- **Então** a mensagem nasce `BLOCKED` com `NO_CHANNEL`, o recibo **continua `ISSUED`** e disponível no Portal, e nada falha. Recibo não enviado não é recibo não emitido

**AC-04 (Edge Case — recibo cancelado antes do envio)**
- **Dado** um recibo cancelado enquanto a mensagem ainda estava na fila
- **Quando** o despacho a alcança
- **Então** ela vai a `CANCELLED`, não `BLOCKED` — não foi impedimento do destinatário, foi o assunto que deixou de existir. É a mesma distinção que a fatia 3 do MOD-CRM fixou para o saldo quitado na régua de cobrança

---

### [MOD-NOTIF-07] — Documento por E-mail

**AC-01 (Happy Path)**
- **Dado** um receituário emitido para o pet de um tutor com e-mail
- **Quando** o `prescricao.emitida` é consumido
- **Então** o tutor recebe o PDF anexado, com o assunto nomeando o pet

**AC-02 (Cenário negativo — documento sem titular)**
- **Dado** um documento sem `tutor_id` (um relatório interno do tenant)
- **Quando** o consumidor de `documento.emitido` o processa
- **Então** nada é enfileirado. A regra é a mesma do §MOD-DOC-10: filtra-se por titularidade, não por tipo, para que um tipo novo não vaze por esquecimento

**AC-03 (Edge Case — termo aceito não é notificado)**
- **Dado** um aceite de termo registrado no balcão
- **Quando** o documento é emitido
- **Então** **não** se manda e-mail automático. O tutor acabou de assinar na frente do atendente; um e-mail imediato confirmando o que ele acabou de fazer é ruído. O PDF fica no Portal e sai por e-mail quando pedido

---

### [MOD-NOTIF-08] — Boas-vindas do Tenant

**AC-01 (Happy Path)**
- **Dado** um tenant que concluiu a quarta e última etapa do onboarding
- **Quando** `ONBOARDING_LAST_STEP` é alcançado
- **Então** o administrador recebe o e-mail de boas-vindas, no molde de marca, com o endereço do Admin, o endereço público do site e o do Portal — os três montados de `APP_DOMAIN` em tempo de execução, nunca de constante cravada

**AC-02 (Edge Case — o domínio errado)**
- **Dado** uma instalação cujo `APP_DOMAIN` não é `petshopai.app`
- **Quando** o e-mail é montado
- **Então** os endereços refletem a instalação. É o mesmo bug que já mordeu uma vez, quando `.petshopai.app` estava cravado no onboarding e em `/configuracoes`: o e-mail é lido em `frontend/src/lib/domain.ts`, `server-only`, e **não** por `NEXT_PUBLIC_`, que seria inlinado no build e amarraria a imagem a uma instalação

**AC-03 (Edge Case — reprocesso do evento)**
- **Dado** que o publish de eventos ainda é best-effort pós-commit e o consumidor pode receber o mesmo evento duas vezes
- **Quando** o evento repete
- **Então** o `dedupe_key` da mensagem impede o segundo envio. Boas-vindas em duplicata é a primeira impressão do produto errando

---

### [MOD-NOTIF-09] — Boas-vindas do Usuário

**AC-01 (Happy Path)**
- **Dado** um membro da equipe que aceitou o convite e fez o primeiro acesso
- **Quando** o vínculo passa a `ACTIVE`
- **Então** ele recebe o e-mail com o nome do petshop, o papel que recebeu e o endereço do Admin

**AC-02 (Cenário negativo — o funcionário que também é cliente)**
- **Dado** um usuário que é membro da equipe **e** tutor do mesmo petshop, caso que a instância única do Clerk permite de propósito
- **Quando** os dois e-mails coexistem
- **Então** eles são mensagens distintas, com `recipient_kind` distinto, e nenhuma decisão de uma interfere na outra. O opt-out de marketing do tutor **não** cala o e-mail de equipe, e a supressão do endereço cala os dois

**AC-03 (Edge Case — papel alterado depois)**
- **Dado** um membro cujo papel muda semanas depois
- **Quando** a mudança ocorre
- **Então** **nenhum** e-mail é disparado na v1. Notificação de mudança de papel é aviso operacional, e avisos operacionais ficaram fora do escopo por decisão

---

### [MOD-NOTIF-10] — Retorno do Provedor

> A lacuna descrita no §1: hoje `HARD_BOUNCE` só nasce da recusa **síncrona** do Resend. O bounce de verdade chega depois, por webhook, e ninguém o escuta.

**AC-01 (Happy Path — bounce)**
- **Dado** um e-mail aceito pelo Resend e devolvido minutos depois
- **Quando** o webhook `email.bounced` chega em `/internal/v1/email/webhook`
- **Então** grava-se `MessageEvent` com `BOUNCED`, o endereço entra em `messaging_suppressions` com `HARD_BOUNCE`, e a mensagem vai a `FAILED`

**AC-02 (Happy Path — reclamação de spam)**
- **Dado** um destinatário que marcou o e-mail como spam
- **Quando** o webhook `email.complained` chega
- **Então** o endereço é suprimido **permanentemente** e, se for de tutor, registra-se também a revogação de consentimento de marketing. Reclamação de spam é opt-out, e tratá-la só como supressão técnica ignora o que a pessoa disse

**AC-03 (Cenário negativo — webhook não autenticado)**
- **Dado** uma requisição sem a assinatura do Resend ou com assinatura inválida
- **Quando** chega ao endpoint
- **Então** **401**, sem processar nada e sem revelar se a mensagem existe. Um webhook aberto é uma porta para suprimir o endereço de qualquer concorrente

**AC-04 (Edge Case — entrega e abertura)**
- **Dado** os eventos `email.delivered` e `email.opened`
- **Quando** chegam
- **Então** `DELIVERED` é registrado; **abertura não é**. Rastrear abertura exige pixel, pixel é tratamento de dado sem base legal declarada, e o produto não precisa saber se o tutor abriu o recibo

**AC-05 (Edge Case — webhook fora de ordem)**
- **Dado** um `delivered` que chega depois de um `bounced` do mesmo envio
- **Quando** processado
- **Então** o estado não regride. A ordem canônica é a de `MessageStatus`, e o evento antigo é registrado sem mover o status

---

### [MOD-NOTIF-11] — Histórico da Equipe

**AC-01 (Happy Path)**
- **Dado** e-mails enviados a membros da equipe
- **Quando** o admin abre o painel de entregas em `/crm`
- **Então** vê-os junto dos demais, com um filtro por tipo de destinatário e a coluna dizendo quem recebeu

**AC-02 (Cenário negativo — a ficha do tutor não muda)**
- **Dado** a aba **Mensagens** da ficha do tutor
- **Quando** carrega
- **Então** mostra só mensagens de tutor. A aba responde "o que mandamos a esta pessoa como cliente", e misturar e-mail de equipe ali confundiria as duas relações que a instância única do Clerk já aproxima

**AC-03 (Cenário negativo — a Central de Comunicação do Portal)**
- **Dado** um tutor que também é da equipe, olhando `/portal/mensagens`
- **Quando** a lista é montada
- **Então** aparecem só as mensagens de `recipient_kind = 'TUTOR'` dele. O Portal é a superfície do cliente, e o e-mail que ele recebeu como funcionário não é assunto dele ali

---

### [MOD-NOTIF-12] — Convite de Equipe *(especificado, não migrado na v1)*

O `identity-service/src/lib/mailer.ts` continua sendo o caminho do convite. **Esta é uma decisão consciente e tem um custo declarado:** o módulo constrói exatamente a máquina de que o convite precisa — destinatário do tipo `USER`, molde de marca, fila com retentativa e painel — e não a usa para ele. Enquanto isso durar, o sistema tem duas saídas de e-mail, duas configurações de remetente, e o convite que não chegou continua invisível para o admin, que só descobre perguntando ao convidado.

A migração, quando acontecer, é pequena e tem forma conhecida: um template `team_invitation` com `authored: 'SYSTEM'`, `recipient_kind = 'USER'` e o endereço **do convidado**, que ainda não é usuário — o único destinatário do sistema que não tem `user_id`, e portanto o caso que obriga `overrideAddress` a valer também para a equipe. O `mailer.ts` some, e com ele o `RESEND_API_KEY` do `identity-service`. Ver a questão 1 do §11.

---

## 4. Modelo de Dados

### Tabelas Alteradas

| Tabela | Mudança | Motivo |
|---|---|---|
| `messages` | `tutor_id` passa a **anulável** | Mensagem de equipe não tem tutor |
| `messages` | `+ user_id UUID` (FK `users`, **sem** cascade) | O destinatário da equipe |
| `messages` | `+ recipient_kind` enum `TUTOR` \| `USER`, default `TUTOR` | O parque existente não precisa de backfill |
| `messages` | `+ document_id UUID` | O anexo, por referência — nunca o conteúdo |
| `messages` | CHECK de coerência | Exatamente um destinatário, casando com `recipient_kind` |
| `message_templates` | `+ authored` enum `TENANT` \| `SYSTEM`, default `TENANT` | Escolhe o molde (§MOD-NOTIF-04) |
| `messaging_settings` | `reply_to_email` ganha validação na gravação | Endereço inválido descoberto no envio vira falha permanente |

```sql
ALTER TABLE messages
  ALTER COLUMN tutor_id DROP NOT NULL,
  ADD COLUMN user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN recipient_kind message_recipient_kind NOT NULL DEFAULT 'TUTOR',
  ADD COLUMN document_id uuid,
  ADD CONSTRAINT messages_recipient_check CHECK (
    (recipient_kind = 'TUTOR' AND tutor_id IS NOT NULL AND user_id IS NULL) OR
    (recipient_kind = 'USER'  AND user_id  IS NOT NULL AND tutor_id IS NULL)
  );

CREATE INDEX idx_messages_tenant_user ON messages(tenant_id, user_id, created_at DESC);
```

> **Cuidado com o índice existente.** `messages` tem índices por `(tenant_id, tutor_id, …)`. Tornar `tutor_id` anulável não os invalida, mas as consultas do painel precisam parar de assumir que a coluna existe — é o tipo de suposição que o typecheck não pega, porque o Prisma passa a tipar `string | null` e o código que fazia `message.tutorId` continua compilando dentro de um `where`.

> **`users` é tabela global**, fora de `RLS_MODELS`, cifrada com a **chave de plataforma** (HKDF sobre a KEK) e não com a DEK do tenant. A FK de uma tabela sob RLS para uma global é o que `memberships` já faz; o que muda é o cifrador que o motor precisa abrir para ler o endereço.

### Catálogo de Templates — `packages/shared-types/src/messaging-seed.ts`

Os textos continuam **em código**, não semeados no banco: o petshop só ganha linha em `message_templates` quando **muda** o texto, e a tela mostra a união dos dois. Templates novos desta fase:

| Chave | Categoria | Destinatário | Autor | Assunto |
|---|---|---|---|---|
| `receipt_issued` | TRANSACTIONAL | TUTOR | SYSTEM | Seu recibo de {petshop.nome} |
| `document_issued` | TRANSACTIONAL | TUTOR | SYSTEM | {documento.tipo} de {pet.nome} |
| `tenant_welcome` | TRANSACTIONAL | USER | SYSTEM | Sua conta em {petshop.nome} está pronta |
| `user_welcome` | TRANSACTIONAL | USER | SYSTEM | Bem-vindo à equipe de {petshop.nome} |

`MessageTemplateDefinition` ganha dois campos: `audience: 'TUTOR' | 'USER'` e `authored: 'TENANT' | 'SYSTEM'`. Ambos com padrão que preserva os dezessete templates existentes sem tocá-los.

---

## 5. Contratos de API

| Método | Path | Serviço | Permissão | Descrição |
|---|---|---|---|---|
| POST | `/internal/v1/messages` | messaging | contexto HMAC | Enfileirar (ganha `userId` e `documentId`) |
| POST | `/internal/v1/email/webhook` | messaging | assinatura do Resend | Bounce, reclamação e entrega |
| GET | `/v1/messages` | messaging | `crm:read` | Painel, com filtro por `recipientKind` |
| POST | `/v1/messages/:id/resend` | messaging | `crm:send` | Reenviar |
| GET | `/v1/messaging/suppressions` | messaging | `crm:configure` | Endereços suprimidos |
| DELETE | `/v1/messaging/suppressions/:id` | messaging | `crm:configure` | Reabilitar endereço |

> **Nenhuma permissão nova.** O total continua em **55**, e nenhum `pnpm db:seed` é exigido. `crm:read`, `crm:send` e `crm:configure` existem desde a fatia 1 do MOD-CRM e cobrem o que o módulo acrescenta.

### Schema Zod

```typescript
export const MessageRecipientKindSchema = z.enum(['TUTOR', 'USER'])

export const EnqueueMessageSchema = z
  .strictObject({
    templateKey: z.string().max(60),
    recipientKind: MessageRecipientKindSchema.default('TUTOR'),
    tutorId: z.string().uuid().optional(),
    userId: z.string().uuid().optional(),
    petId: z.string().uuid().optional(),
    documentId: z.string().uuid().optional(),
    channel: z.enum(['AUTO', 'WHATSAPP', 'EMAIL']).default('AUTO'),
    overrideAddress: z.string().max(160).optional(),
    variables: z.record(z.string(), z.string()).default({}),
    dedupeKey: z.string().max(120).optional(),
  })
  .refine(
    (input) =>
      input.recipientKind === 'TUTOR' ? Boolean(input.tutorId) && !input.userId
                                      : Boolean(input.userId) && !input.tutorId,
    { message: 'Informe exatamente um destinatário, coerente com recipientKind' },
  )
```

> `z.strictObject`, nunca `z.object` — chave desconhecida descartada em silêncio foi o defeito do `AutomationConfigSchema` do MOD-CRM.

### Códigos de Erro

O módulo **não cria família nova**. Reusa o catálogo do MOD-CRM: `ERR_CRM_001` (404), `ERR_CRM_002` (422, destinatário ambíguo e marketing para equipe), `ERR_CRM_003` (403), `ERR_CRM_004` (409, dedupe). Criar `ERR_NOTIF_*` para um módulo que roda dentro do mesmo serviço daria ao cliente duas famílias para o mesmo motor.

---

## 6. Máquinas de Estado

`MessageStatus` **não muda**. O que muda é quem pode chegar a cada estado e por qual porta.

```
        QUEUED ──(janela fechada, só TUTOR)──► SCHEDULED ──► SENDING
           │                                                    │
           │                                    ┌───────────────┼───────────────┐
           ▼                                    ▼               ▼               ▼
    BLOCKED (gates)                           SENT ──► DELIVERED ──► READ    FAILED ──► DEAD
           │                                                                    │
   TUTOR: NO_CONSENT, QUIET_HOURS_EXPIRED,                             (webhook: BOUNCED
   WEEKLY_CAP, PET_DECEASED, SUPPRESSED, NO_CHANNEL                     → supressão)
   USER:  SUPPRESSED, NO_CHANNEL — e mais nenhum
```

**Efeitos colaterais por transição:**

| De | Para | Evento | Efeito |
|---|---|---|---|
| SENDING | SENT | `mensagem.enviada` | `receipts.sent_at` quando o assunto é recibo |
| SENT | FAILED (webhook) | `mensagem.falhou` | Supressão do endereço com `HARD_BOUNCE` |
| SENT | FAILED (reclamação) | `mensagem.falhou` | Supressão permanente **e** revogação de marketing se for tutor |
| QUEUED | CANCELLED | — | Assunto deixou de existir (recibo cancelado, documento anulado) |

---

## 7. Regras de Negócio & Edge Cases

| # | Cenário | Comportamento Esperado | Módulos Afetados |
|---|---|---|---|
| RN-01 | Um motor só | Toda saída de e-mail passa pelo `messaging-service`. A porta 3011 do SPEC não nasce | MOD-CRM, MOD-IDENT |
| RN-02 | Destinatário exclusivo | Exatamente um entre tutor e usuário, garantido por CHECK e não só por schema | transversal |
| RN-03 | Gates são do tutor | Consentimento, janela de silêncio e os três tetos nunca se aplicam a `USER` | MOD-CRM |
| RN-04 | Supressão é de endereço | Vale para qualquer destinatário; protege o domínio remetente, não a pessoa | MOD-CRM |
| RN-05 | `enabled` não cala o transacional de equipe | O interruptor do motor é sobre disparo ao cliente | MOD-IDENT |
| RN-06 | Anexo é do e-mail | WhatsApp leva link, sempre | MOD-DOC, MOD-CRM |
| RN-07 | Teto de anexo | Acima de 8 MB, o e-mail sai com link e o histórico registra a troca | MOD-DOC |
| RN-08 | Credencial não vai ao histórico | URL assinada nunca é gravada no corpo da mensagem | MOD-DOC |
| RN-09 | Molde pelo autor | Texto do petshop em texto puro; texto do produto no molde de marca | MOD-CRM |
| RN-10 | Remetente único | Domínio da plataforma, nome e responder-para do tenant | MOD-SITE |
| RN-11 | Abertura não se rastreia | Sem pixel. Entrega e bounce, sim; comportamento do destinatário, não | LGPD |
| RN-12 | Reclamação é opt-out | Marcar como spam revoga o consentimento de marketing, não só suprime o endereço | MOD-TUTOR, MOD-CRM |
| RN-13 | Chaves distintas | Endereço de tutor sai da DEK do tenant; o de usuário, da chave de plataforma | MOD-IDENT |
| RN-14 | Histórico do usuário sobrevive ao vínculo | `user_id` sem cascade: o registro do que se enviou é auditoria | MOD-IDENT, MOD-ADMIN |
| RN-15 | Duas relações, duas listas | O Portal e a ficha do tutor mostram só `recipient_kind = 'TUTOR'` | MOD-PORTAL |
| RN-16 | Documento pendente adia | Mensagem com anexo espera o `documento.emitido` em vez de sair sem ele | MOD-DOC |

---

## 8. Eventos RabbitMQ

Exchange `petshop.events` (topic), DLX com backoff 1s / 5s / 30s / 5min.

| Evento | Publisher | Consumers | Payload Mínimo |
|---|---|---|---|
| `documento.emitido` | serviço emissor | **messaging** (novo consumidor), notification, audit | `{ tenantId, documentId, kind, tutorId?, timestamp }` |
| `prescricao.emitida` | medical-record | **messaging** (novo consumidor), audit | `{ tenantId, prescriptionId, documentId, petId, tutorId, timestamp }` |
| `tenant.onboarding_concluido` | identity | **messaging** (novo consumidor) | `{ tenantId, adminUserId, timestamp }` |
| `membro.ativado` | identity | **messaging** (novo consumidor) | `{ tenantId, userId, roleKey, timestamp }` |
| `mensagem.enviada` | messaging | ledger (grava `receipts.sent_at`), audit | `{ tenantId, messageId, channel, recipientKind, documentId?, timestamp }` |

> **Os dois eventos do identity-service não existem ainda.** `tenant.onboarding_concluido` e `membro.ativado` precisam ser publicados por lá — é a única dependência que este módulo cria em outro serviço. E vale o de sempre: `packages/service-kit/src/events.ts` publica best-effort depois do commit, então cada consumidor precisa do seu `dedupe_key`, e boas-vindas em duplicata é o defeito que este módulo mais facilmente comete.

---

## 9. Segurança & LGPD

### Controle de Acesso

| Operação | TENANT_ADMIN | MANAGER | RECEPTIONIST | Demais |
|---|---|---|---|---|
| Ver painel de entregas | ✓ | ✓ | ✓ | — |
| Reenviar mensagem | ✓ | ✓ | — | — |
| Ver e remover supressões | ✓ | — | — | — |

### Audit Log

Geram registro: reenvio manual, remoção de supressão (é reabilitar um endereço que pediu para parar, e precisa ter dono), alteração de remetente e responder-para. O **envio automático não gera** `audit_logs` — ele já é uma linha em `messages`, que é o histórico do módulo; duplicar encheria a trilha de auditoria com o volume da fila.

### Dados Pessoais

| Campo | Categoria | Base Legal | Retenção | Exportável | Deletável |
|---|---|---|---|---|---|
| `messages.address_encrypted` | dado pessoal | execução de contrato | `retention_months` (24 por padrão) | ✓ | ✓ |
| `messages.body_encrypted` | dado pessoal | execução de contrato | idem | ✓ | ✓ |
| `messaging_suppressions.address_hash` | pseudonimizado | legítimo interesse | **permanente** | — | — |
| `messages` de `recipient_kind = USER` | dado pessoal | execução de contrato de trabalho | 24 meses | ✓ | ✓ |

> **A supressão sobrevive à exclusão do titular, de propósito.** Guardar o hash de quem pediu para parar é o que impede que o mesmo contato, recadastrado amanhã, volte a ser incomodado. É pseudonimização a serviço do próprio titular, e o texto da fila de exclusão do MOD-PORTAL-09 precisa dizer isso.

> **Nenhum pixel de rastreamento.** O produto registra entrega e devolução, que são fatos do provedor, e não abertura nem clique, que são comportamento do destinatário. Não há base legal declarada para o segundo, e acrescentá-lo depois exigiria mexer no aviso de privacidade.

---

## 10. Performance & Observabilidade

### Cache Redis

| Dado | TTL | Chave | Invalida quando |
|---|---|---|---|
| Identidade do remetente | 10 min | `notif:sender:{tenantId}` | `tenant.configuracao.atualizada` |
| Cabeçalho do molde de marca | 10 min | `doc:header:{tenantId}` | idem — é o mesmo do MOD-DOC |

O anexo **nunca** é cacheado: ele vem do R2 no momento do envio, e um PDF em Redis é o mesmo arquivo em dois lugares com dois ciclos de vida.

### Métricas (Pino estruturado)

- `email_sent` — envios por template e por tipo de destinatário.
- `email_bounced` — devoluções por causa. Sustentado acima de 2% do volume é incidente de reputação, não de código.
- `email_complained` — reclamações de spam. Qualquer valor merece leitura, e é a métrica que mais rápido derruba um domínio.
- `notif_attachment_fallback` — quantas vezes o anexo virou link. Se subir, o teto de 8 MB está errado.

**Lembre do `resetEnvCache()` no harness.** `lib/logger.ts` chama `loadEnv()` no corpo do módulo e `loadEnv` é memoizado: um teste que importe um módulo do serviço antes do harness congela o ambiente sem as variáveis dele, sem erro nenhum. Foi corrigido no messaging-service; os outros serviços têm a mesma armadilha.

---

## 11. Questões em Aberto

| # | Questão | Impacto | Decisor | Prazo |
|---|---|---|---|---|
| 1 | O convite de equipe ficou fora da v1 por decisão de 2026-09-07, e o módulo constrói exatamente a máquina de que ele precisa. Enquanto não migrar, há duas saídas de e-mail e o convite que não chegou é invisível ao admin. Quando migra? | MOD-IDENT-06, operação | PM + Tech Lead | Revisitar ao fim da Fase 6 |
| 2 | Avisos operacionais ao administrador também ficaram fora, e hoje vivem só no sino da topbar — que ninguém vê no domingo à noite, que é quando o WhatsApp cai | MOD-ADMIN, suporte | PM | Fase 7 |
| 3 | Domínio próprio por tenant no e-mail. Recusado na v1 por fragmentar reputação de entrega; revisitar se algum tenant grande exigir | Entrega, MOD-SITE-12 | Tech Lead | Pós-v1 |
| 4 | Teto de 8 MB para anexo: confirmar contra o limite real do Resend e contra o tamanho médio de um receituário com logo | MOD-DOC | Tech Lead | Fase 6 |
| 5 | Recuperação de senha e verificação de e-mail continuam no Clerk, com o visual do Clerk. Aceitável enquanto a tela de entrada é a única superfície de identidade | MOD-IDENT, marca | PM | Fase 7 |
| 6 | `tenant.onboarding_concluido` e `membro.ativado` não existem e precisam ser publicados pelo identity-service. É a única dependência que este módulo cria em outro serviço | MOD-IDENT | Tech Lead | Início da implementação |
