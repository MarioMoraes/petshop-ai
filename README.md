# PetShop AI

Micro-SaaS multi-tenant para petshops. Monorepo com frontend, microserviços e pacotes
compartilhados, conforme `SPEC.md`.

**Estado:** Fase 7 concluída (segurança e compliance). O backend está em consolidação:
os doze microserviços do SPEC estão virando módulos de um processo só — restam três —
ver a seção "Backend" do `CLAUDE.md`.

- `docs/prd/identidade_tenancy_01.md` — MOD-IDENT-01 (provisionamento), 02 (onboarding),
  04 (RBAC) e 07 (isolamento RLS).
- `docs/prd/tutores_02.md` — MOD-TUTOR-01 a 09: CRUD, deduplicação, endereço com CEP,
  consentimento LGPD, tags, busca, visão 360º, anonimização e merge de duplicatas.

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
| api-gateway | 3000 | O backend: token do Clerk, tenant, permissões, os módulos já consolidados e o encaminhamento do que falta |
| frontend | 3002 | Admin, Portal do Tutor e site do estabelecimento (Next.js) |
| billing-ledger-service | 3007 | Conta corrente do tutor — ainda não migrado |
| portal-bff | 3020 | A superfície do cliente final — ainda não migrado |

A lista de `*_SERVICE_URL` em `backend/api-gateway/src/config/env.ts` é o marcador de
progresso da consolidação: some uma a cada fatia.

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
próprio banco (`petshop_test_db`, `petshop_test_gateway`, e um por serviço ainda não
migrado), criado automaticamente na primeira execução.

Para conferir o isolamento RLS à mão, conectado como a role da aplicação e **sem**
contexto de tenant — deve devolver zero linhas:

```bash
docker exec petshop-postgres psql -U app_user -d petshop -c "SELECT count(*) FROM tenants;"
```

## Estrutura

```
backend/
  api-gateway/          O backend: autenticação, RBAC, rate limit, os módulos e o proxy
    src/modules/        Um diretório por módulo consolidado (identity, tutors, pets, …)
    src/worker/         Consumidores de evento e a grade de jobs de todos os módulos
packages/
  shared-types/         Schemas Zod, matriz de permissões, catálogo de erros, eventos
  db/                   Prisma, migrations, RLS, criptografia de PII, suporte a testes
  service-auth/         Contrato HMAC entre gateway e microserviços
  api-client/           Cliente tipado do gateway
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

Lacunas conhecidas desta entrega, marcadas no código com `TODO(MOD-…)`:

- Convites de equipe (MOD-IDENT-06) — a etapa 4 do wizard só oferece "pular".
- Serviços e profissionais na etapa 3 (MOD-AGENDA).
- Seed de espécies, portes e pelagens no provisionamento (MOD-PET, MOD-AGENDA).
- Webhooks do Clerk (MOD-IDENT-03) — o espelho local do usuário é criado sob demanda.
- Troca de tenant (MOD-IDENT-05) e suspensão por inadimplência (MOD-IDENT-10).
- Importação de tutores por CSV (MOD-TUTOR-11) — o próprio PRD a joga para a Fase 1.5.
- A visão 360º do tutor devolve `pendingModules` no lugar de pets, agenda, financeiro e
  comunicações; o merge reaponta o que é do tutor e deixa o resto para os serviços que
  consomem `tutor.mesclado`. Idem para o bloqueio de exclusão por agendamento futuro.
- Os consumidores de `atendimento.concluido`, `lancamento.criado` e `mensagem.recebida`
  existem e são testados — falta quem publique.
