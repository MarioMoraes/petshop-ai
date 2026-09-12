# Configuração do Clerk

O Clerk é o provedor de identidade do PetShop AI (SPEC §5). A modelagem segue a
recomendação do SPEC §3.3: **Organization do Clerk = tenant**, e **Organization
Membership = vínculo do usuário com o petshop**.

A suíte de testes não depende de nada disto — o Clerk é substituído por um dublê na
fronteira de `backend/app/src/modules/identity/clerk.ts`. O que está aqui é o
necessário para o **login funcionar no navegador**.

## 1. Criar a instância

1. Crie uma aplicação em [dashboard.clerk.com](https://dashboard.clerk.com).
2. Em **Configure → Email, Phone, Username**, deixe habilitado ao menos e-mail + senha.
3. Copie as chaves de **API Keys** para o `.env` da raiz:

```bash
CLERK_SECRET_KEY="sk_test_..."
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY="pk_test_..."
```

> O `.env` versionado traz um `pk_test_` de formato válido apenas para o
> `next build` rodar sem credenciais. Ele **não** autentica ninguém.

## 2. Habilitar Organizations

Em **Configure → Organizations**, ligue **Enable organizations**.

Sem isso, `POST /v1/tenants` falha ao criar a Organization e o tenant fica em
`PROVISIONING` — que é o caminho de recuperação do AC-03, não um erro fatal: o job
`tenant-provisioning-retry` continua tentando a cada 2 minutos, e o usuário vê a tela
"Estamos finalizando sua conta".

Ainda em **Organizations**, dois ajustes que não são opcionais:

- **Habilite os slugs de organização.** Instâncias novas vêm com eles desligados
  (`slug_disabled: true`). O backend cria a Organization passando um `slug` explícito,
  e sem isso o Clerk responde `403 organization_slugs_disabled` — o tenant fica preso
  em `PROVISIONING` e o job de retry bate no mesmo 403 a cada 2 minutos.
- **Desligue a seleção/criação de organização pelo usuário**
  (`force_organization_selection`, e a criação automática em *Organization creation
  defaults*). Quem cria a Organization é o backend, durante o provisionamento, para que
  o `slug` do Clerk e o do tenant local sejam sempre o mesmo — é essa igualdade que
  torna o retry idempotente. Com a seleção forçada ligada, o Clerk faz o usuário criar
  uma Organization própria no login, com slug auto-gerado e sem `publicMetadata`: ela
  não corresponde a tenant nenhum, e o frontend fica preso em "Preparando seu
  estabelecimento…".

  > **Confira este depois de mexer em qualquer coisa em Organizations.** Em
  > 2026-09-01 ele voltou a `true` sozinho, no meio de um ajuste no limite de
  > membros, e o efeito foi exatamente o descrito: quem se cadastrou recebeu do
  > *Clerk* — não do nosso wizard — um formulário de nome e slug, e a Organization
  > resultante (`public_metadata` vazio) não tinha tenant do outro lado. **Como
  > reconhecer:** a Organization existe no dashboard do Clerk, o `SELECT ... FROM
  > tenants` não a encontra, e o gateway registra `Organization sem tenant local`.
  > O frontend hoje ignora Organization sem vínculo local em vez de travar
  > (`components/ensure-active-organization.tsx`), mas a configuração continua
  > tendo de ser desligada — senão cada novo cadastro cria uma órfã.

Um terceiro ponto vale conferir antes de convidar equipe (MOD-IDENT-06): o
**limite de membros por Organization** (*Organization membership limit*). O aceite
de convite chama `createOrganizationMembership`, e com o limite abaixo do número de
assentos do plano o convidado recebe um erro do Clerk depois de o vínculo local já
ter sido gravado — o aceite é idempotente e se conserta clicando de novo no link,
mas só depois que o limite subir. Deixe-o igual ou maior que o maior plano vendido.

Conferindo os dois pela API, se preferir:

```bash
curl -s -H "Authorization: Bearer $CLERK_SECRET_KEY" \
  https://api.clerk.com/v1/instance/organization_settings
```

## 3. JWT template `petshop` (claims `permVersion` e `mfa`)

Em **Configure → Sessions → JWT templates**, crie um template chamado `petshop` com:

```json
{
  "permVersion": "{{org_membership.public_metadata.permVersion}}",
  "mfa": "{{user.two_factor_enabled}}",
  "org_id": "{{org.id}}",
  "org_slug": "{{org.slug}}",
  "org_role": "{{org_membership.role}}"
}
```

> **Os claims de organização não são opcionais.** Um template customizado do Clerk não
> herda o payload do token de sessão padrão — o token carrega só o que está declarado
> aqui, mais os claims padrão (`sub`, `iat`, `exp`…). Sem `org_id`, o gateway não
> resolve o tenant (`auth/clerk-token.ts`, `auth/session.ts`) e todo usuário vira
> "autenticado sem Organization ativa": o frontend fica preso no onboarding e **tudo
> responde 200**, sem erro em lugar nenhum. O gateway registra um `warn` quando isso
> acontece com usuário que tem vínculo ativo, que é o rastro para achar a causa.

**Para que serve.** RN-03 e o AC-03 de MOD-IDENT-04 tratam do caso em que o admin
rebaixa alguém que está com sessão aberta. O MOD-IDENT incrementa
`memberships.perm_version`, invalida o cache `perm:{tenantId}:{userId}` e republica o
valor no metadata do membership no Clerk. O gateway compara o claim do token com o
valor corrente e, na divergência, relê o papel do banco antes de decidir qualquer coisa.

**Se você não criar o template**, o sistema continua correto: a invalidação do cache na
troca de papel já garante que a requisição seguinte use o papel novo. O claim é a
segunda garantia, para o caso de o Redis ter reiniciado ou uma réplica ter ficado
particionada. A escolha está comentada em
`backend/app/src/auth/session.ts`, em `resolvePermissions`.

**O claim `mfa` é a fonte da exigência do MOD-SEC-02**, e o espelho `users.mfa_enabled`
não serve para isso: aquele é gravado quando o `ensureLocalUser` sincroniza com o Clerk e
pode estar horas atrasado. Decidir por espelho velho barraria justamente quem acabou de
ligar o segundo fator, que é o pior defeito que este gate pode ter.

**Template sem o claim `mfa` libera, e grita.** O gateway trata a ausência como "não
sei", nunca como "não tem" — tratar como "não tem" transformaria um deploy com template
desatualizado em indisponibilidade total do Admin, sem nada no corpo da resposta que
explicasse por quê. O rastro é um `warn` por requisição e a métrica `mfa_claim_missing`,
cujo único valor aceitável é zero.

## 4. Origens autorizadas

```bash
CLERK_AUTHORIZED_PARTIES="http://localhost:3002"
```

Em produção, liste os domínios reais do Admin e do Portal. O gateway rejeita token
apresentado por origem fora desta lista.

> **A lista é de origens exatas — curinga não funciona.** O `@clerk/backend` decide com
> `authorizedParties.includes(azp)`, comparação de string pura. Um
> `https://*.{APP_DOMAIN}` não casa com nada, e o Admin vive em `app.{APP_DOMAIN}`: sem
> essa entrada explícita, **todo request do Admin responde 401** — e só depois do
> deploy, porque em desenvolvimento a origem é `http://localhost:3002` e casa. Os
> compose de produção já trazem `https://app.${APP_DOMAIN},https://${APP_DOMAIN}`.

## 5. MFA para papéis administrativos

SPEC §7.2 exige MFA para `TENANT_ADMIN` e para o Super Admin. Habilite em
**Configure → Multi-factor** e ofereça pelo menos um segundo fator (TOTP resolve).

**A imposição é do produto, não do Clerk.** Marcar "obrigatório" no dashboard cobra de
todo mundo, inclusive da recepção e do tosador, e não sabe o que é `TENANT_ADMIN`. Quem
recorta por papel é o gate do MOD-SEC-02, em `auth/session.ts`: administrador sem segundo
fator perde a **escrita** depois de sete dias de carência, e a leitura continua.

O que precisa estar do lado do Clerk é só o meio de ligar o segundo fator (o
`<UserButton>` do Admin abre a tela de conta, e é para lá que o aviso aponta) e o claim
`mfa` no template da seção 3.

A carência mora em `memberships.mfa_grace_until` e é escrita quando o papel é atribuído,
não quando a pessoa entra — ver `modules/security/mfa.ts`. A migration `20260911120000_mod_sec`
concede sete dias a todo administrador que já existia no dia do deploy.

## 6. Webhook de sincronização (MOD-IDENT-03)

Sem ele o espelho local do usuário só nasce — nunca atualiza. Quem trocar nome, foto ou
e-mail no Clerk fica com o dado velho no produto para sempre.

Em **Configure → Webhooks → Add Endpoint**:

| Campo | Valor |
|---|---|
| Endpoint URL | `https://{APP_DOMAIN}/internal/v1/clerk/webhook` |
| Eventos | `user.created`, `user.updated`, `user.deleted`, `organizationMembership.deleted` |

Copie o **Signing Secret** (`whsec_…`) para `CLERK_WEBHOOK_SECRET` no `.env`. Ele **não** é
a `CLERK_SECRET_KEY`: um assina a entrega que chega, o outro autentica a nossa chamada à
API deles. **Sem o segredo a rota recusa tudo com 401**, que é o comportamento certo de um
endpoint sem meio de conferir quem bate.

Marque só esses quatro. Os outros eventos são aceitos e descartados sem virar linha
nenhuma no banco — `session.created` sozinho encheria a tabela de idempotência com
milhares de registros por dia.

**O caminho fica sob `/internal/`**, que é onde este repositório põe webhook de provedor,
e não sob `/v1` como o PRD escreveu. O nome diz de onde a chamada nasce, não que ela seja
privada: a borda o publica (`infra/Caddyfile`), só no domínio da aplicação e nunca nos
subdomínios de tenant.

O que cada evento faz:

- `user.created` e `user.updated` atualizam nome, foto, e-mail e o espelho do segundo
  fator. Entrega fora de ordem é descartada pela comparação com `users.clerk_synced_at`,
  e entrega repetida pelo `svix-id` em `webhook_events`.
- `user.deleted` desabilita o usuário e **suspende** os vínculos dele.
- `organizationMembership.deleted` suspende o vínculo local de quem for tirado da
  Organization pelo painel do Clerk. Suspende, não remove: a volta é um clique na tela de
  Equipe.

Em desenvolvimento o Clerk não alcança `localhost`. Para exercitar o caminho, assine um
POST à mão com o mesmo segredo — o teste `tests/identity/webhooks.test.ts` mostra o
formato do conteúdo assinado (`svix-id.svix-timestamp.corpo`).

## O que ainda não está ligado

- **Webhooks `organization.*`.** O nome e a exclusão da Organization não se propagam para
  o tenant local. Renomear um estabelecimento é do lado do produto, em Configurações, e é
  de lá que o nome sai.

## Conferindo

Com as chaves no `.env`:

```bash
pnpm infra:up
pnpm db:migrate && pnpm db:seed
pnpm dev
```

Abra `http://localhost:3002`, crie uma conta e percorra o wizard. O tenant deve ficar
em `TRIAL` e a Organization aparecer no dashboard do Clerk com o mesmo slug:

```bash
docker exec petshop-postgres psql -U postgres -d petshop \
  -c "SELECT slug, status, clerk_org_id FROM tenants;"
```
