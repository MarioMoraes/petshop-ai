# PetShop AI

## Frontend — telas de entrada de dados

Ao criar ou alterar **qualquer formulário** (cadastro, ficha, painel de configuração),
leia antes [`docs/design-formularios.md`](docs/design-formularios.md) e siga o padrão.

O resumo que mais importa:

- ficha com campos é `Card tone="soft"`; cartão de conteúdo (lista, detalhe, números)
  continua branco;
- toda seção abre com `<SectionHead>`, nunca um `<h2>` solto — título no *Título 4*
  (Inter 18px/600), **nunca serifa**;
- todo título sai em **Title Case** — as peças (`PageHeader`, `SectionHead`, `CardHead`,
  `Modal`, `EmptyState`) aplicam `titleCase` sozinhas; `<h1>`–`<h3>` à mão chama a função;
- um tom de ícone por formulário, o do domínio no menu lateral, repetido em todas as
  seções;
- nenhum controle nativo sem estilo: `<Choice>`, `<Segmented>`, `.check`, `.field`;
- botão é escuro (`primary`), no topo e dentro da tela; `ghost` só para desistir
  (Cancelar, Voltar, Fechar) ao lado da ação que grava, e destrutivo sem `text-danger`;
- alerta é `<Alert>`; barra de ação de formulário de página inteira é `<FormActions>`;
- formulário que responde a **uma linha de uma lista** é `<Modal>`, nunca um painel
  aberto dentro do cartão.

O documento traz também a tabela do **que já foi tentado e recusado** — vale conferir
antes de propor uma alternativa visual.

A referência viva é `frontend/src/app/(admin)/tutores/tutor-form.tsx`.

`/configuracoes` é uma **porta com três cartões** — o estabelecimento, a assinatura e a
importação da base anterior —, e não mais a ficha do estabelecimento direto: ela mudou-se
para `/configuracoes/estabelecimento` quando a faixa de abas chegou a nove e a décima
teria quebrado em duas linhas. Quem aponta para uma aba (`?aba=privacidade`, do sino)
aponta para a sub-rota.

`src/app` tem **quatro** raízes: `(admin)`, com o `ClerkProvider` e as telas de equipe;
`(site)`, que serve a página pública do petshop sem carregar identidade nenhuma;
`(portal)`, a superfície do cliente final, com o `ClerkProvider` da **mesma** instância do
Admin — o que separa as duas sessões é a resolução do papel, e não o provedor de
identidade; e `(platform)`, o console da equipe PetShop AI em `/plataforma`. O grupo entre
parênteses não vira segmento de URL.

O `(platform)` **divide o host do Admin e não o layout**: a moldura de lá lê `/v1/me` e
monta um menu de estabelecimento, e quem entra no console não tem estabelecimento nenhum —
a sessão da plataforma é justamente a que não traz Organization. Toda tela dele começa por
`ler()` de `lib/platform.ts`, que traduz o 404 da superfície no cartão neutro de
`SemAcesso` em vez de numa tela de erro. Rota nova em `src/app` precisa entrar em
`ADMIN_ROUTE_PREFIXES` (`lib/host.ts`) ou nasce pública no host de todo tenant;
`admin-routes.test.ts` compara a lista com o disco.

## Backend — o monólito modular

O `SPEC.md` e os PRDs descrevem um alvo de doze microserviços. **O repositório
consolidou esse alvo num monólito modular**: um backend deployable, com fronteiras de
módulo explícitas, para que cada módulo possa voltar a ser serviço depois sem reescrever
a lógica. A razão é que os doze serviços sempre compartilharam um schema Prisma e um
banco — nunca houve fronteira de dados entre eles, só o custo de atravessar processo.

Ao ler "serviço X" no SPEC ou num PRD, traduza para `backend/app/src/modules/X`.

A migração foi por estrangulamento, uma fatia por serviço, e **fechou na fatia 11**. O
que ela deixou:

- `backend/app/` é o processo, e é um só. `src/proxy.ts` e o `resolveInternalRequest`
  do `app.ts` — o encaminhamento e a porta interna assinada em HMAC — existiam só
  enquanto durava a migração, e saíram com ela. **A porta de entrada é uma: o token do
  Clerk.**
- `src/gateway/routes.ts` é onde as rotas de módulo são compostas. **A separação entre
  superfície pública e autenticada é por escopo do Fastify**, não por convenção de nome:
  rota administrativa registrada fora do escopo autenticado nasce aberta.
- `src/worker/` reúne os consumidores de evento e a grade de jobs de todos os módulos,
  num agendador só. O lease é por nome do job, então juntar as grades não muda quem
  roda o quê.
- **Chamada entre módulos passa por uma porta declarada**, nunca por import solto de
  serviço a serviço. O MOD-PORTAL tem cinco (`modules/portal/*-port.ts`), o MOD-CRM tem
  uma, o MOD-PET tem a da agenda. Cada uma é uma interface + a implementação em processo
  + um `setXPort` que os testes dublam — e a lista de métodos é o que mantém legível o
  que um módulo deixa outro fazer em seu nome.
- **Os testes ficam por módulo.** `tests/harness.ts` guarda o núcleo (app, banco, token,
  chamadores por papel) e `tests/<modulo>/fixtures.ts` o cenário de cada um, porque os
  nomes colidem: todo módulo tem um `givenTenant` com as configurações que ele precisa.
  Cada `fixtures.ts` reexporta o núcleo, então o teste importa de um lugar só.

**Nomes que atravessam processo não acompanharam a migração**: fila do RabbitMQ, chave
de cache e nome de job são identidade em infraestrutura. Renomeá-los junto com o código
cria fila órfã e cache frio, e o sintoma nunca é um erro no log. É por isso que as filas
ainda se chamam `<serviço>-service.events` e que `INTERNAL_SERVICE_SECRET` continua
exigido na subida sem ter leitor.

**Salto HTTP entre módulos virou chamada de função, passando pelo mesmo schema Zod que a
rota usava.** O schema não só valida: ele preenche defaults — `source` do aceite de
termo, `purpose` da transição de consentimento, `urgent` da mensagem — que a chamada
direta pularia. É a diferença que a serialização do salto de rede escondia.

**As permissões dos testes saem da matriz, não de uma lista.** Enquanto eram serviços,
os harnesses assinavam um contexto com as permissões que o teste quisesse. Agora a
identidade entra pela porta da produção — token, `membership` e matriz de papéis —, e um
cenário que a matriz não produz sozinha se monta com `tenant_role_overrides`
(`revokePermission` no harness), que é o mecanismo real do MOD-IDENT-04.

Os módulos: MOD-SITE (`modules/site`), MOD-TAXI (`modules/taxi`), MOD-CRM
(`modules/crm`), MOD-NOTIF (`modules/messaging`), MOD-PET (`modules/pets`,
`modules/catalog`, `modules/photos`), MOD-TUTOR (`modules/tutors`, `modules/terms`,
`modules/addresses`, `modules/consents`, `modules/tags`), MOD-IDENT
(`modules/identity`), MOD-PRONT (`modules/records`, `modules/attendances`,
`modules/prescriptions`), MOD-AGENDA (`modules/scheduling`,
`modules/schedule-catalog`), MOD-LEDGER (`modules/ledger`), MOD-SEC
(`modules/security`), MOD-PORTAL (`modules/portal`), MOD-AI (`modules/agent`),
MOD-IMPORT (`modules/import`) e MOD-ESTOQUE (`modules/inventory`, PRD
`docs/prd/estoque_16.md`).

**O MOD-ESTOQUE guarda o saldo duas vezes, de propósito.** `stock_lots.quantity_on_hand` é
o que as telas leem, e `stock_movements` — append-only por trigger — é a verdade.
`recordMovement` (`modules/inventory/movements.ts`) é a **única** função que escreve
movimento e mexe no saldo, sob `FOR UPDATE` no lote. Uma segunda que atualizasse o saldo
"só neste caso" seria a primeira divergência. O produto não tem coluna de saldo: é a soma
dos lotes. A quantidade é `Decimal(12,3)` e trafega como string, porque insumo se mede
em ml e g.

**O MOD-CAIXA (`modules/cash`, PRD `docs/prd/caixa_17.md`) é uma gaveta com livro, e o
esperado é a soma dos movimentos.** `cash_movements` é append-only por trigger, e não há coluna de
saldo. O caixa não tem rota de venda nem de pagamento: a venda avulsa e o pagamento do tutor entram
nele **na transação de quem os grava**, pelas portas `inventory/cash-port.ts` e `ledger/cash-port.ts`.
A assimetria é de propósito:
- a venda avulsa **exige** caixa aberto, porque sem tutor o dinheiro não tem outro lugar;
- o pagamento do tutor **nunca depende** do caixa, e só entra nele quando há um aberto, o plano
  inclui `CASH_REGISTER` e o dinheiro chegou depois da abertura.

Pelo mesmo motivo, `recordPayment` virou `writePaymentInTx` + `announcePayment`.

**O MOD-PORTAL é o único que lê de todos os outros e escreve por porta.** Ele agrega: as
leituras são banco direto, porque ler é escolher um recorte; as escritas passam pelas
cinco portas, porque gravar é aplicar regra. Cada porta **eleva permissão de propósito**
— o papel `TUTOR` não tem `tutor:update`, `schedule:write_all`, `taxi:operate` nem
`finance:read` —, e o que as contém é sempre o mesmo: o `tutorId` vem de
`requireOwnScope` e nunca do corpo, e a lista de métodos é curta e nomeada.

**O MOD-AI é o único módulo que o canal chama, e não o contrário.** A mensagem recebida
entra pelo webhook da Evolution, que é do MOD-NOTIF: `modules/messaging/inbound.ts`
traduz o payload do provedor, grava a linha `INBOUND` e chama a
`AgentInboundPort` — o vocabulário do provedor morre ali. A resposta volta pelo caminho de
sempre, `modules/agent/messaging-port.ts` → `enqueueMessage`: o motor do MOD-NOTIF é a
única saída do produto, e uma segunda seria uma saída sem fila, sem teto de vazão, sem
supressão e sem histórico.

**O push do app do tutor não é um canal do motor: pega carona na mensagem.** O texto
mora no catálogo (`push` em `messaging-seed.ts` — a lista de avisos **é** esse campo), é
renderizado no enfileiramento como o corpo, e sai em `messaging/push.ts` depois dos
portões do tutor e antes dos tetos de vazão, que protegem o número do petshop e não o
celular. `push_deliveries` único por (mensagem, aparelho) é o que impede a retentativa de
repetir o aviso, e falha do FCM nunca muda a mensagem. Os aparelhos são do MOD-NOTIF e o
Portal os grava pela `devices-port.ts`, a **sétima porta**; o token é único **entre
tenants**, porque um celular tem um dono só. Sem `FCM_*` o push não existe e nada mais
muda.

**O turno do modelo não roda dentro do webhook.** A Evolution reentrega o que não recebe
2xx depressa, e um turno com tools leva dezenas de segundos. O webhook grava e carimba
`agent_conversations.pending_at`; quem responde é `modules/agent/runner.ts`, disparado
logo depois do 204 — e `pending_at` é ao mesmo tempo o "desde quando espera" e a **posse**
de quem está respondendo, então o job `agent.sweep-pending` recolhe o que um processo
derrubado deixou pela metade. O provedor fica atrás de `model-port.ts`, e as sete leituras
mais as três escritas atrás de `portal-port.ts`, que é a **sexta porta** do MOD-PORTAL: o
agente e a tela do tutor respondem a mesma pergunta com a mesma função.

**Nenhum instante chega ao modelo em UTC.** Um modelo repassa ao cliente o número que leu,
e `2026-09-14T13:00:00.000Z` virava "13:00" para um horário das 10:00. Em `tools.ts`,
`momento`, `horaDoDia` e `isoLocal` são a única forma de um horário sair do arquivo — e é
por isso que os schemas das propostas aceitam offset (`z.iso.datetime({ offset: true })`).
Pela mesma razão a grade desce **agrupada por horário**, com os profissionais numa tabela
à parte: cortá-la por *slot* cortava o dia na primeira hora, porque um slot é um par
horário×profissional.

**O agente escreve em duas etapas, e a etapa do meio é uma linha de banco.** Marcar,
cancelar e remarcar não gravam: gravam uma proposta em `agent_tool_calls`, com token e
prazo de 15 minutos, e quem grava é `confirmarProposta` no turno seguinte — que só
alcança o token porque `readLiveProposal` devolve a proposta viva ao contexto da mensagem
seguinte: o histórico entre turnos é **só texto**, e o `tool_result` onde o token nasceu
morre com o turno. É o que dá
antecedente ao "sim" do cliente — sem a linha, a confirmação seria a interpretação de uma
palavra de duas letras sobre um histórico que o próprio modelo resume. **Uma proposta viva
por conversa é índice único parcial**, e não leitura seguida de escrita, porque duas
mensagens do mesmo tutor chegam juntas. E a mensagem de erro do domínio **não é
repassada ao modelo**: os textos do Portal foram escritos para uma tela com sessão, e um
deles diz o valor exato da dívida — neste canal a prova de identidade é o número de quem
escreveu (RN-01). O motivo completo fica em `result_summary`, que é onde a recepção o lê.

**O expurgo do agente esvazia a linha, e não a apaga.** A retenção do §9 (24 meses) tira
o corpo do turno, o argumento da tool e o vínculo com o tutor — e deixa a conversa, o
custo e a contagem, porque a mesma linha é a estatística do painel de qualidade. É a
diferença para o expurgo do MOD-SEC, onde a linha inteira **é** o dado pessoal. A
varredura é diária (`agent.retention`, 03h50) e atende também ao art. 18: a conversa de
um titular anonimizado sai no dia seguinte, sem esperar os 24 meses — o `contact_encrypted`
vazio é a marca de "já passou", e a conversa que ainda estava na fila da recepção é
encerrada com a data do **último turno**, sem evento, para não virar desfecho desta
semana no painel.

**O MOD-IMPORT é o único módulo que só escreve, e nunca é lido.** Ele traz a base do
sistema anterior — tutores, pets, profissionais e agenda — a partir do CSV que o
legado exporta, e não tem tabela de domínio nenhuma: compõe MOD-TUTOR, MOD-PET e
MOD-AGENDA por três portas (`modules/import/*-port.ts`), então a linha importada nasce
pelo mesmo serviço do formulário, com a mesma cifragem, o mesmo evento e a mesma
trilha. **Analisar e aplicar são o mesmo código**, com um `commit` no fim: um ensaio
que rodasse validação diferente da do gravar seria uma promessa falsa. **A idempotência
é a chave natural** — CPF/CNPJ ou celular do tutor, tutor+nome do pet, nome do
profissional, pet+profissional+horário —, e é a mesma que liga os arquivos entre si, o
que dispensa uma terceira tabela de `external_ref`. **Uma transação por linha**, não por
lote: falha na linha 300 deixa 299 criadas, e reenviar o arquivo corrigido converge
porque as 299 viram `IGNORADO`.

Três decisões do MOD-IMPORT valem por si. **Histórico não entra**: agendamento passado
gravado como `CONFIRMED` seria varrido pelo `no-show-sweeper` na hora seguinte e viraria
falta, com taxa e mensagem, sem atendimento nem lançamento por trás. **A carga entra
calada**: `agendamento.criado` e `agendamento.cancelado` ganharam um `notify` opcional
(o mesmo desenho do `notify` das corridas do MOD-TAXI), porque trezentas confirmações de
horários marcados semana passada, por um sistema que o cliente ainda não conhece, são a
pior estreia possível — o lembrete da véspera continua valendo, que é varredura de banco
e não evento. E **o consentimento importado tem origem `IMPORT`**: o aceite de termo
entra porque a relação já existia, com a origem dizendo que a prova é de segunda mão; o
de marketing nasce **não**, e só uma coluna dizendo sim o liga.

**O nome `modules/schedule-catalog` é o registro de uma colisão.** O MOD-AGENDA tinha
`catalog` e `scheduling` enquanto era serviço, e aqui `modules/catalog` já é o catálogo
de domínio do MOD-PET — espécie, raça, porte e pelagem. Juntar os dois num diretório só
trocaria o significado de "catálogo" no meio do processo. A fronteira entre as duas
metades continua sendo a **porta**, e não a pasta: o catálogo não sabe que
`appointments` existe, e as três regras que dependem disso perguntam pela
`AppointmentsPort`.

**A fatia 9 ligou uma regra que estava inerte.** O AC-02 de MOD-PET-05 — pet com
agendamento futuro não se transfere — estava escrito e testado desde o MOD-PET, mas a
porta que responde por ele só era ligada em teste. Com a agenda no mesmo processo,
`setSchedulingPort` entrou no registro do módulo e a regra passou a valer.

**As exceções de prefixo do `proxy.ts` acabaram com ele.** Eram duas, do mesmo desenho
frágil: o prontuário pendurava rotas sob `/v1/pets/:petId/…` e o financeiro sob
`/v1/tutors/:tutorId/packages`, e as duas eram desempatadas por **sufixo**, conferido
antes do prefixo do outro módulo. Funcionavam por coincidência — nenhuma rota do módulo
dono do espaço casava com aqueles sufixos —, e o dia em que alguém registrasse uma que
casasse, o Fastify preferiria a do módulo e a rota sumiria sem erro nenhum. Com todos na
mesma árvore, quem desempata é o roteador, que reclama no boot.

**O prefixo `/portal/v1` continua separado de `/v1`, e não por herança.** É a decisão de
segurança do AC-04 de MOD-PORTAL-11: a superfície do cliente final tem resolução de
sessão e rate limit próprios, e **nenhum papel `TUTOR` alcança o `/v1` administrativo**.
A sessão do Portal não sai do token — o tutor não tem Organization no Clerk —, sai do
host que o Next serviu, pelo header `x-petshop-tenant-slug`. Ver `isPortalPath` em
`modules/portal/routes.ts` e `resolvePortalSession` em `src/auth/portal-session.ts`.

**Nome de parâmetro de rota não precisa acompanhar a migração.** O MOD-PRONT usa
`:petId` onde o MOD-PET usa `:id`, na mesma posição, e o `find-my-way` aceita — foi
verificado antes da fatia, não presumido.

**O MOD-IDENT é o único módulo cujas rotas não exigem tenant no hook.** Três delas
existem justamente para quem ainda não é membro de estabelecimento nenhum: criar o
primeiro tenant, espiar um convite e aceitá-lo. Quem exige contexto de tenant é cada
handler, com `requireTenantContext` — e nos testes esse chamador é o `asStranger` de
`tests/identity/fixtures.ts`, um token válido sem Organization.

**O papel operacional abre ficha na agenda, e a porta é a mesma das duas regras.** A
RN-06 do MOD-IDENT — atribuir `GROOMER`, `BATHER`, `VET` ou `DRIVER` cria ou reativa a
linha de `professionals` — passa por `modules/identity/scheduling-port.ts`, que tem
quatro métodos: a leitura da agenda futura (RN-07) e as três escritas do espelho. O PRD
diz "via evento" e aqui é **chamada de função na transação de quem atribui o papel**: com
`DISABLE_EVENTS` (o `pnpm dev` e a suíte) o espelho nunca nasceria, e com o broker de pé
haveria a janela em que a pessoa tem o papel e não está na agenda.
`membership.papel_alterado` continua sendo publicado — o que ele não é mais é o único
caminho. Três decisões que o arquivo registra: a ficha nasce **pronta para agendar**
(jornada do horário de funcionamento e todos os serviços ativos, menos o motorista, que
não atende pet); ela **adota** o cadastro sem dono de mesmo nome, a chave natural do
MOD-IMPORT, e não adota nada quando dois casam; e **suspender o acesso não a toca**, de
propósito — quem entra de licença continua dono da agenda de sábado. Tirar o papel de
quem tem agenda futura é recusado com a lista, como remover. Enquanto ninguém escrevia
`professionals.user_id`, a guarda da RN-07 nunca achava nada: a regra estava escrita,
testada e inerte, o mesmo caso do AC-02 de MOD-PET-05.

**O gate de MFA roda na porta, não no módulo.** A exigência de segundo fator do
`TENANT_ADMIN` (MOD-SEC-02) fica em `src/auth/session.ts`, antes do roteamento — e é por
isso que corpo inválido numa rota bloqueada responde 423, e não o 422 que o módulo daria. A decisão sai do
**claim do token**, nunca de `users.mfa_enabled`, que é espelho e pode estar velho; a
carência mora em `memberships.mfa_grace_until` e é escrita quando o **papel** é
atribuído. O catálogo de erro é do módulo (`modules/security/errors.ts`) e o host o
importa, como já fazia com o ramo de multipart do MOD-PET.

**A trilha de auditoria agora tem leitor.** `modules/security` só lê — `GET
/v1/audit-logs` e `GET /v1/security-events`, sob `audit:read`, paginados por cursor e
com janela máxima de 92 dias. Uma rota de escrita nesse módulo seria a porta pela qual a
prova deixa de ser prova. `audit_logs` continua append-only com **uma** exceção nomeada
no schema: `DELETE` para `app_maintenance`, que é o expurgo de 24 meses; `UPDATE` segue
barrado para todos.

**O plano decide o que responde, e a divisão mora num lugar só:** `PLAN_CATALOG` em
`packages/shared-types/src/plans.ts`, conferido contra a landing por
`frontend/src/lib/landing-plans.test.ts`. **O preço saiu de lá**: desde 2026-09-18 ele vive
em `plan_prices`, mantido pelo console (`/plataforma/planos`), e o catálogo virou o
**padrão** — o valor de uma instalação nova e a reserva do HTML da landing. Todo caminho de
cobrança pergunta a `shared/plan-prices.ts` (`effectivePlanPrice`), nunca ao catálogo; a
landing lê `/api/planos` **no Next**, e não no backend, porque a borda publica do
gateway só o que nasce fora dela, e a landing não é esse caso (decisão 1 do
`infra/Caddyfile`). **Mexer no preço não reajusta quem já assina:** o
valor fica congelado em `tenant_subscriptions.price_cents` — e em
`scheduled_price_cents` quando a descida anual já foi agendada —, e é dele que saem a tela
do estabelecimento, a diferença de uma subida de plano e o desfazer de um agendamento. Rota da equipe sob recurso pago é bloqueada por
**prefixo**, na tabela `PLAN_GATES` de `src/gateway/plan-gates.ts` (402, `ERR_PLAN_001`) —
rota nova debaixo de um prefixo da tabela nasce bloqueada, e prefixo novo entra lá. O que
não passa por requisição pergunta a `shared/plan.ts` por conta própria: o site e o Portal
respondem 404 pela resolução do slug, os jobs de campanha pulam o tenant, o canal WhatsApp
fica indisponível e o agente lê a configuração **efetiva**. Descer de plano nunca apaga
dado. No frontend, a página checa `temRecurso` **antes** de chamar a API, e não o layout,
porque os dois renderizam em paralelo. Starter e Pro mudam pela assinatura
(`/v1/subscription`); o Enterprise, a cortesia e a correção, pelo console da plataforma
(`PATCH /platform/v1/tenants/:id/plan`). Os dois gravam por `applyTenantPlan`.

**O ciclo é escolhido ao assinar e não muda depois** — mensal, ou anual com
`ANNUAL_DISCOUNT_PERCENT` de desconto. Preço é sempre o par plano×ciclo (`planPriceCents`);
quem multiplicar por doze à mão está reinventando o desconto. **O anual quebra a simetria
da troca de plano**, porque o ano já foi pago: subir vale na hora e cobra a diferença dos
meses que faltam numa cobrança avulsa, marcada no `externalReference` para o webhook saber
que ela **não compra tempo**; descer fica em `scheduled_plan` e só entra em vigor quando a
renovação é paga. `current_period_ends_at` é escrito a cada pagamento que renova, sempre
**absoluto** (vencimento + ciclo, nunca o fim anterior + ciclo) — é o que torna inofensivo
o par `PAYMENT_CONFIRMED` + `PAYMENT_RECEIVED` que o Asaas manda para a mesma cobrança, e
é ele, e não mais um palpite de 31 dias sobre `last_paid_at`, que diz até quando uma
assinatura cancelada continua respondendo.

**O estado da conta muda por um caminho só:** `shared/tenant-status.ts`, com a transição
condicional ao estado de origem no `WHERE` — é o que torna idempotentes o job do fim do
teste (`TRIAL` → `TRIAL_EXPIRED`), o webhook do Asaas (pagamento → `ACTIVE`, atraso →
`PAST_DUE`) e o job da carência (→ `SUSPENDED`). `TRIAL_EXPIRED` e `SUSPENDED` são só
leitura na sessão, **menos** `/v1/subscription` (`BILLING_PREFIX` em `auth/session.ts`):
pagar começa por um `POST`. A assinatura mora em `modules/subscription`; o cartão passa pelo
Checkout do Asaas para o número nunca chegar a este servidor, e escolher o plano não o põe
em vigor — só o pagamento confirmado.

**Quem não opera é uma lista só:** `TENANT_BLOCKED_STATUSES` em
`shared-types/identity.ts` (`TRIAL_EXPIRED`, `SUSPENDED`, `TERMINATED`), e `PAST_DUE`
fica de fora de propósito — quem está em atraso trabalha durante a carência. Quatro
lugares perguntam, e nenhum guarda cópia: a porta barra a escrita (`auth/session.ts`), o
despacho bloqueia o que ia ao tutor com `TENANT_INACTIVE`, as varreduras diárias do
MOD-CRM pulam o tenant (`crm/daily.ts`) e o agente responde como desligado, porque
`readSettings` põe o estado no **efetivo** junto do plano. Fora da requisição, o estado
vem de `tenantOperational` (`shared/tenant-status.ts`), que passa pelo mesmo `tenant:status`
de um minuto que a sessão escreve.

**A conta parada cala o cliente final, nunca o administrador.** O bloqueio do despacho é
só para `TUTOR` — os três avisos da conta (`trial_ending`, `subscription_past_due`,
`tenant_suspended`) são `USER` e `TRANSACTIONAL`, vão a **todo** `TENANT_ADMIN` ativo e
saem mesmo com o motor do CRM desligado: o interruptor é a decisão do petshop sobre falar
com a base dele, e não sobre a conta que ele mantém aqui. E bloquear no **despacho**, e
não ao enfileirar, é o que impede a fila de virar estoque — quinze dias de lembretes
soltos no minuto do pagamento chegam como mentira. O aviso da véspera não nasce de
transição nenhuma: é o job `identity.trial-warnings`, uma vez por dia, e quem garante um
aviso só é o `dedupeKey` da mensagem, não uma coluna de estado.

**Um terceiro prefixo anônimo entrou com o MOD-NOTIF:** `/internal/`, onde moram os
webhooks dos provedores (Evolution no pareamento do WhatsApp, Resend no retorno de
entrega). O nome diz de onde a chamada nasce, não que ela seja privada — o `/internal/`
do Resend e do Clerk é publicado pela borda (`infra/Caddyfile`). Cada uma se autentica
sozinha, com o token da instância ou a assinatura Svix sobre o corpo cru.

**A borda publica do gateway só o que nasce fora da rede interna, caminho a caminho.**
Eram os webhooks; desde 2026-09-22 são eles e o **app do tutor**, em `api.{APP_DOMAIN}`,
onde passam `/portal/v1` e o catálogo de estabelecimentos — e nada mais. O `/v1` do Admin
e o `/platform/v1` do console não têm endereço na internet, e é a borda que os fecha, não
a matriz de papéis: rota administrativa nova não nasce publicada por engano, e rota nova
do Portal já nasce alcançável pelo app. O recorte está no matcher `@api` do
`infra/Caddyfile`, e `app/test/recorte_da_borda_test.dart` compara a lista com os
caminhos que o app de fato chama.

## O grafo do repositório (graphify)

`graphify-out/graph.json` é um grafo de conhecimento do código e dos documentos — quem
chama quem, quem importa o quê, que PRD fala de que tabela. Fica fora do git.

**Antes de implementar um recurso, consulte o grafo.** Ele responde em segundos o que
um grep responde em dez leituras:

- `graphify query "<pergunta>"` — o subgrafo em volta de um assunto;
- `graphify explain "<símbolo>"` — um nó e seus vizinhos (quem usa `withTenant`, por
  exemplo);
- `graphify path "<A>" "<B>"` — o caminho mais curto entre dois conceitos, que é como
  se descobre um acoplamento entre módulos que devia passar por porta.

O grafo é mapa, não fonte: o nó diz onde olhar (`source_file` e linha), e a decisão
sai da leitura do arquivo. `graphify-out/GRAPH_REPORT.md` só para visão de conjunto.

**Depois de mudar código, o grafo se atualiza no commit.** Os hooks `post-commit` e
`post-checkout` (`graphify hook install`, locais em `.git/hooks`) refazem em segundo
plano só a parte estrutural (AST, sem custo de modelo), com log em
`~/.cache/graphify-rebuild.log`. Duas coisas eles **não** fazem: reler documento
alterado — PRD, `SPEC.md`, este arquivo — e aceitar um grafo menor que o anterior. Mudança
em documento ou refatoração que apaga código pede `/graphify . --update` à mão. Na dúvida
sobre o frescor, a data do `graph.json` diz.
