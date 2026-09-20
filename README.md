# PetShop AI

Micro-SaaS multi-tenant para petshops. Monorepo com frontend, um backend modular e
pacotes compartilhados, conforme `SPEC.md`.

**Estado:** as oito fases do roadmap (`PRD.md` §10) estão concluídas, a última delas a
Fase 8 — a camada de agentes de IA. A consolidação do backend terminou: os doze
microserviços do SPEC são hoje módulos de um processo só, em `backend/app/src/modules/`
— ver a seção "Backend" do `CLAUDE.md`.

Os quinze PRDs de `docs/prd/` estão implementados. O que resta está em **O que ainda não
existe**, no fim deste arquivo.

## Rodando localmente

Requer Node 22+, pnpm 11+ e Docker.

```bash
pnpm install
pnpm infra:up                 # Postgres, Redis e RabbitMQ
cp .env.example .env          # e preencha as chaves do Clerk
pnpm db:migrate && pnpm db:seed
pnpm dev
```

| Processo | Porta | O que faz |
|---|---|---|
| app | 3000 | O backend inteiro: token do Clerk, tenant, permissões e os doze módulos de domínio |
| frontend | 3002 | Admin, Portal do Tutor e site do estabelecimento (Next.js) |

**A consolidação fechou na fatia 11.** Eram doze microserviços; hoje são doze módulos de
um processo só, em `backend/app/src/modules/`, com fronteira explícita entre eles para que
qualquer um possa voltar a ser serviço sem reescrever a lógica. A lista de
`*_SERVICE_URL` que marcava o progresso esvaziou, e o `proxy.ts` saiu com ela.

Para o login funcionar no navegador é preciso preencher as chaves do Clerk —
ver **[docs/setup-clerk.md](docs/setup-clerk.md)**. A suíte de testes não depende
delas: o Clerk é substituído por um dublê na fronteira do adapter.

## Verificação

```bash
pnpm typecheck
pnpm lint
pnpm test
```

Os testes de banco sobem contra o Postgres do `docker compose`, cada pacote no seu
próprio banco (`petshop_test_db` e `petshop_test_gateway`), criado automaticamente na
primeira execução. A suíte do backend fica por módulo, em `backend/app/tests/<modulo>/`.

Para conferir o isolamento RLS à mão, conectado como a role da aplicação e **sem**
contexto de tenant — deve devolver zero linhas:

```bash
docker exec petshop-postgres psql -U app_user -d petshop -c "SELECT count(*) FROM tenants;"
```

## Estrutura

```
backend/
  app/                  O backend inteiro: autenticação, RBAC, rate limit e os módulos
    src/modules/        Um diretório por módulo (identity, tutors, pets, ledger, portal, …)
    src/worker/         Consumidores de evento e a grade de jobs de todos os módulos
packages/
  shared-types/         Schemas Zod, matriz de permissões, catálogo de erros, eventos
  db/                   Prisma, migrations, RLS, criptografia de PII, suporte a testes
  service-auth/         O contexto de autorização, e o contrato HMAC de quem voltar a ser serviço
  api-client/           Cliente tipado do backend
  config/               Presets de tsconfig, eslint e vitest
frontend/               Admin do tenant (Next.js App Router)
infra/                  docker-compose do ambiente local
docs/prd/               PRDs detalhados por módulo
design/                 Biblioteca de padrões visuais
```

## Decisões que valem para todo o código

- **Isolamento por RLS.** Toda tabela de negócio tem política `tenant_id`, com
  `FORCE ROW LEVEL SECURITY`. A aplicação conecta como `app_user`, papel **sem**
  BYPASSRLS — as políticas valem para o backend também. Jobs cross-tenant usam
  `app_maintenance`, explicitamente. Ver `packages/db/prisma/migrations/README.md`.
- **Todo acesso a dado de negócio passa por `withTenant()`**, que abre transação e
  seta `app.tenant_id`. Uma guarda no cliente Prisma recusa operação em tabela com RLS
  fora desse contexto.
- **PII cifrada em repouso** (AES-256-GCM, envelope com DEK por tenant). Busca por
  CPF, telefone e e-mail usa coluna `*_hash` (HMAC-SHA256 com pepper e namespace por
  campo), nunca `LIKE` sobre texto cifrado. Nome fica em claro, decisão consciente,
  para viabilizar a busca por similaridade `pg_trgm` no balcão.
- **`audit_logs` e `tutor_consents` são append-only**, por `REVOKE` e por trigger. Uma
  revogação de consentimento grava linha nova; o estado atual é derivado do histórico.
- **Erros em `application/problem+json`** com códigos por módulo (`ERR_IDENT_00N`,
  `ERR_TUTOR_00N`), catálogo único em `packages/shared-types/src/errors.ts`.
- **Eventos de domínio** no exchange topic `petshop.events`, nomeados `dominio.acao`.

## O que ainda não existe

- **Suspensão e encerramento de tenant (MOD-IDENT-10).** O tenant suspenso já é barrado
  pela porta (`auth/session.ts` lê o status com TTL curto), mas ninguém o suspende: falta
  o job de inadimplência, a tela de regularização e o encerramento com retenção legal.
- **Webhooks `organization.*` do Clerk.** Os de usuário e a saída de Organization estão
  ligados (MOD-IDENT-03); renomear ou excluir a Organization pelo painel do Clerk não
  chega ao tenant local.
- **Importação de tutores por CSV (MOD-TUTOR-11).** O próprio PRD a classifica como
  *nice to have* e a joga para depois.
- **Espelho de `professionals` por papel (RN-06 de MOD-IDENT).** Atribuir `GROOMER`,
  `BATHER`, `VET` ou `DRIVER` deveria criar ou reativar o profissional da agenda; os
  eventos são publicados (`membership.papel_alterado`, `membership.suspenso`) e não há
  consumidor. Hoje o profissional é cadastrado à mão em `/agenda/profissionais`.
- **Zero data retention com a Anthropic.** Contratual, não técnico — e é o que trava a
  ida do MOD-AI a produção.
