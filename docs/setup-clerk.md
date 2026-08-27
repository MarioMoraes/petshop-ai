# Configuração do Clerk

O Clerk é o provedor de identidade do PetShop AI (SPEC §5). A modelagem segue a
recomendação do SPEC §3.3: **Organization do Clerk = tenant**, e **Organization
Membership = vínculo do usuário com o petshop**.

A suíte de testes não depende de nada disto — o Clerk é substituído por um dublê na
fronteira de `backend/identity-service/src/lib/clerk.ts`. O que está aqui é o
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

## 3. JWT template `petshop` (claim `permVersion`)

Em **Configure → Sessions → JWT templates**, crie um template chamado `petshop` com:

```json
{
  "permVersion": "{{org_membership.public_metadata.permVersion}}",
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
rebaixa alguém que está com sessão aberta. O `identity-service` incrementa
`memberships.perm_version`, invalida o cache `perm:{tenantId}:{userId}` e republica o
valor no metadata do membership no Clerk. O gateway compara o claim do token com o
valor corrente e, na divergência, relê o papel do banco antes de decidir qualquer coisa.

**Se você não criar o template**, o sistema continua correto: a invalidação do cache na
troca de papel já garante que a requisição seguinte use o papel novo. O claim é a
segunda garantia, para o caso de o Redis ter reiniciado ou uma réplica ter ficado
particionada. A escolha está comentada em
`backend/api-gateway/src/auth/session.ts`, em `resolvePermissions`.

## 4. Origens autorizadas

```bash
CLERK_AUTHORIZED_PARTIES="http://localhost:3002"
```

Em produção, liste os domínios reais do Admin e do Portal. O gateway rejeita token
apresentado por origem fora desta lista.

## 5. MFA para papéis administrativos

SPEC §7.1 exige MFA para `TENANT_ADMIN` e para o Super Admin. Habilite em
**Configure → Multi-factor** e marque como obrigatório.

O espelho local guarda o estado em `users.mfa_enabled`. A **imposição** por papel é
MOD-SEC (arquivo 13 dos PRDs) e não está nesta entrega — hoje o campo é só reflexo.

## O que ainda não está ligado

- **Webhooks `user.*` / `organization.*` (MOD-IDENT-03).** Não estão nesta entrega.
  Até que estejam, o espelho local do usuário é criado sob demanda, na primeira
  requisição em que ele aparece (`ensureLocalUser`). Alteração de nome ou e-mail feita
  no Clerk **não** se propaga sozinha para o banco local.
- **`POST /v1/webhooks/clerk`.** A rota não existe; não configure o endpoint no
  dashboard ainda.

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
