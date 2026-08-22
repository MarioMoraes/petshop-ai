# PetShop AI

Micro-SaaS multi-tenant para petshops. Monorepo com frontend, microserviços e pacotes
compartilhados, conforme `SPEC.md`.

**Estado:** Fase 0 — Fundação. Implementados os módulos MOD-IDENT-01 (Provisionamento
de Tenant), MOD-IDENT-02 (Onboarding Wizard), MOD-IDENT-04 (RBAC) e MOD-IDENT-07
(Isolamento RLS) de `docs/prd/identidade_tenancy_01.md`.

## Rodando localmente

Requer Node 22+, pnpm 11+ e Docker.

```bash
pnpm install
pnpm infra:up                 # Postgres, Redis e RabbitMQ
cp .env.example .env          # e preencha as chaves do Clerk
pnpm db:migrate && pnpm db:seed
pnpm dev
```

| Serviço | Porta | O que faz |
|---|---|---|
| api-gateway | 3000 | Valida o token do Clerk, resolve tenant e permissões, encaminha aos serviços |
| identity-service | 3001 | Tenants, onboarding, RBAC, auditoria |
| frontend | 3002 | Admin do tenant (Next.js) |

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
próprio banco (`petshop_test_db`, `petshop_test_identity`, `petshop_test_gateway`),
criado automaticamente na primeira execução.

Para conferir o isolamento RLS à mão, conectado como a role da aplicação e **sem**
contexto de tenant — deve devolver zero linhas:

```bash
docker exec petshop-postgres psql -U app_user -d petshop -c "SELECT count(*) FROM tenants;"
```

## Estrutura

```
backend/
  api-gateway/          Entrada única: autenticação, RBAC, rate limit, proxy
  identity-service/     Tenants, onboarding, papéis e permissões, auditoria
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
  e-mail usa coluna `*_hash` (HMAC-SHA256 com pepper), nunca `LIKE` sobre texto cifrado.
- **`audit_logs` é append-only**, por `REVOKE` e por trigger.
- **Erros em `application/problem+json`** com códigos `ERR_IDENT_00N` (PRD §5).
- **Eventos de domínio** no exchange topic `petshop.events`, nomeados `dominio.acao`.

## O que ainda não existe

Lacunas conhecidas desta entrega, marcadas no código com `TODO(MOD-…)`:

- Convites de equipe (MOD-IDENT-06) — a etapa 4 do wizard só oferece "pular".
- Serviços e profissionais na etapa 3 (MOD-AGENDA).
- Seed de espécies, portes e pelagens no provisionamento (MOD-PET, MOD-AGENDA).
- Webhooks do Clerk (MOD-IDENT-03) — o espelho local do usuário é criado sob demanda.
- Troca de tenant (MOD-IDENT-05) e suspensão por inadimplência (MOD-IDENT-10).
