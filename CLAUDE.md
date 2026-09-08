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

Já migrados: MOD-SITE (`modules/site`) e MOD-TAXI (`modules/taxi`).
