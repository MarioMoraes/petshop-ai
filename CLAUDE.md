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

`src/app` tem **três** raízes: `(admin)`, com o `ClerkProvider` e as telas de equipe;
`(site)`, que serve a página pública do petshop sem carregar identidade nenhuma; e
`(portal)`, a superfície do cliente final, com o `ClerkProvider` da **mesma** instância do
Admin — o que separa as duas sessões é a resolução do papel, e não o provedor de
identidade. O grupo entre parênteses não vira segmento de URL.

## Backend — a consolidação em andamento

O `SPEC.md` e os PRDs descrevem um alvo de doze microserviços. **O repositório está
migrando esse alvo para um monólito modular**: um backend deployable, com fronteiras de
módulo explícitas, para que cada módulo possa voltar a ser serviço depois sem reescrever
a lógica. A razão é que os doze serviços sempre compartilharam um schema Prisma e um
banco — nunca houve fronteira de dados entre eles, só o custo de atravessar processo.

Ao ler "serviço X" no SPEC ou num PRD, traduza para `backend/api-gateway/src/modules/X`
se o módulo já migrou, ou para `backend/X-service/` se ainda não.

A migração é por estrangulamento, uma fatia por serviço:

- `backend/api-gateway/` é o processo hospedeiro. Ele registra os módulos que já vivem
  nele e **encaminha ao serviço** o que ainda não migrou (`src/proxy.ts`).
- A lista de `*_SERVICE_URL` em `src/config/env.ts` é o marcador de progresso: some uma
  por fatia. Quando esvaziar, o `proxy.ts` sai junto e o diretório passa a se chamar
  `backend/app/`.
- `src/gateway/routes.ts` é onde as rotas de módulo são compostas. **A separação entre
  superfície pública e autenticada é por escopo do Fastify**, não por convenção de nome:
  rota administrativa registrada fora do escopo autenticado nasce aberta.
- `src/worker/` reúne os consumidores de evento e a grade de jobs de todos os módulos,
  num agendador só. O lease é por nome do job, então juntar as grades não muda quem
  roda o quê.
- **O processo tem duas portas de entrada enquanto a migração dura.** Pela de fora
  chega o token do Clerk. Pela de dentro chega um serviço que ainda não migrou, com o
  contexto já resolvido e assinado em HMAC — é como o `portal-bff` alcança o Taxi Dog
  agora que o Taxi Dog não tem porta própria. Ver `resolveInternalRequest` em
  `src/app.ts`; ela sai junto com o `proxy.ts` na última fatia.
- **Os testes ficam por módulo.** `tests/harness.ts` guarda o núcleo (app, banco, token,
  chamadores por papel) e `tests/<modulo>/fixtures.ts` o cenário de cada um, porque os
  nomes colidem: todo módulo tem um `givenTenant` com as configurações que ele precisa.
  Cada `fixtures.ts` reexporta o núcleo, então o teste importa de um lugar só.

**Nomes que atravessam processo não acompanham a migração**: fila do RabbitMQ, chave de
cache e nome de job são identidade em infraestrutura. Renomeá-los junto com o código
cria fila órfã e cache frio, e o sintoma nunca é um erro no log.

**As permissões dos testes saem da matriz, não de uma lista.** Enquanto eram serviços,
os harnesses assinavam um contexto com as permissões que o teste quisesse. Agora a
identidade entra pela porta da produção — token, `membership` e matriz de papéis —, e um
cenário que a matriz não produz sozinha se monta com `tenant_role_overrides`
(`revokePermission` no harness), que é o mecanismo real do MOD-IDENT-04.

Já migrados: MOD-SITE (`modules/site`), MOD-TAXI (`modules/taxi`), MOD-CRM
(`modules/crm`), MOD-NOTIF (`modules/messaging`) MOD-PET (`modules/pets`,
`modules/catalog`, `modules/photos`), MOD-TUTOR (`modules/tutors`, `modules/terms`,
`modules/addresses`, `modules/consents`, `modules/tags`), MOD-IDENT
(`modules/identity`), MOD-PRONT (`modules/records`, `modules/attendances`,
`modules/prescriptions`) e MOD-AGENDA (`modules/scheduling`,
`modules/schedule-catalog`) — com as duas metades do CRM juntas, o salto HTTP entre
elas virou chamada de função.

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

**A exceção de prefixo do `proxy.ts` acabou com o MOD-PRONT.** Enquanto o prontuário era
serviço, as rotas dele penduravam-se sob `/v1/pets/:petId/…` e o roteamento era por
**sufixo**, conferido antes do prefixo do pet — e funcionava por coincidência: nenhuma
rota do módulo do pet casava com aqueles sufixos, e o dia em que alguém registrasse uma
que casasse, o Fastify preferiria a do módulo e a rota sumiria sem erro nenhum. Com os
dois na mesma árvore, quem desempata é o roteador. Sobrou uma exceção só,
`/v1/tutors/:id/packages`, para o financeiro.

**Nome de parâmetro de rota não precisa acompanhar a migração.** O MOD-PRONT usa
`:petId` onde o MOD-PET usa `:id`, na mesma posição, e o `find-my-way` aceita — foi
verificado antes da fatia, não presumido.

**O MOD-IDENT é o único módulo cujas rotas não exigem tenant no hook.** Três delas
existem justamente para quem ainda não é membro de estabelecimento nenhum: criar o
primeiro tenant, espiar um convite e aceitá-lo. Quem exige contexto de tenant é cada
handler, com `requireTenantContext` — e nos testes esse chamador é o `asStranger` de
`tests/identity/fixtures.ts`, um token válido sem Organization.

**O gate de MFA roda na porta, não no módulo.** A exigência de segundo fator do
`TENANT_ADMIN` (MOD-SEC-02) fica em `src/auth/session.ts`, antes do roteamento — é o que
a faz valer também para o que ainda é encaminhado a outro processo. A decisão sai do
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
