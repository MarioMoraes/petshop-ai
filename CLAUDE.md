# PetShop AI

## Frontend — telas de entrada de dados

Ao criar ou alterar **qualquer formulário** (cadastro, ficha, painel de configuração),
leia antes [`docs/design-formularios.md`](docs/design-formularios.md) e siga o padrão.

O resumo que mais importa:

- ficha com campos é `Card tone="soft"`; cartão de conteúdo (lista, detalhe, números)
  continua branco;
- toda seção abre com `<SectionHead>`, nunca um `<h2>` solto — título no *Título 4*
  (Inter 18px/600), **nunca serifa**;
- um tom de ícone por formulário, o do domínio no menu lateral, repetido em todas as
  seções;
- nenhum controle nativo sem estilo: `<Choice>`, `<Segmented>`, `.check`, `.field`;
- alerta é `<Alert>`; barra de ação de formulário de página inteira é `<FormActions>`;
- formulário que responde a **uma linha de uma lista** é `<Modal>`, nunca um painel
  aberto dentro do cartão.

O documento traz também a tabela do **que já foi tentado e recusado** — vale conferir
antes de propor uma alternativa visual.

A referência viva é `frontend/src/app/(admin)/tutores/tutor-form.tsx`.

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
(`modules/security`), MOD-PORTAL (`modules/portal`) e MOD-AI (`modules/agent`).

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

**Um terceiro prefixo anônimo entrou com o MOD-NOTIF:** `/internal/`, onde moram os
webhooks dos provedores (Evolution no pareamento do WhatsApp, Resend no retorno de
entrega). O nome diz de onde a chamada nasce, não que ela seja privada — a rota do
Resend é a única superfície de backend que a borda publica (`infra/Caddyfile`). Cada uma
se autentica sozinha, com o token da instância ou a assinatura Svix sobre o corpo cru.
