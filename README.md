# PetShop AI

Micro-SaaS multi-tenant para petshops. Monorepo com frontend, um backend modular e
pacotes compartilhados, conforme `SPEC.md`.

**Estado:** as oito fases do roadmap (`PRD.md` §10) estão concluídas, a última delas a
Fase 8 — a camada de agentes de IA. A consolidação do backend terminou: os doze
microserviços do SPEC são hoje módulos de um processo só, em `backend/app/src/modules/`
— ver a seção "Backend" do `CLAUDE.md`.

Os dezessete PRDs de `docs/prd/` estão implementados — os quinze originais mais o estoque
(`estoque_16.md`) e o caixa do dia (`caixa_17.md`). Por cima deles vieram a camada
comercial (planos, assinatura pelo Asaas, teste gratuito e suspensão por atraso), o
console da equipe em `/plataforma`, a página de Integrações por estabelecimento e o app
Flutter do tutor, em `app/`. O que resta está em **O que ainda não existe**, no fim deste
arquivo.

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
| app | 3000 | O backend inteiro: token do Clerk, tenant, permissões e todos os módulos de domínio |
| frontend | 3002 | Admin, Portal do Tutor, site do estabelecimento e console da plataforma (Next.js) |

**A consolidação fechou na fatia 11.** Eram doze microserviços; hoje são módulos de
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
  shared-types/         Schemas Zod, matriz de permissões, catálogo de erros, eventos, planos
  db/                   Prisma, migrations, RLS, criptografia de PII, suporte a testes
  service-kit/          O mecanismo comum dos módulos (subida, erros, eventos, guardas de autorização)
  job-scheduler/        A grade de jobs com lease por nome
  pdf/, documents/      Geração de PDF e o registro de documentos emitidos
  api-client/           Cliente tipado do backend
  config/               Presets de tsconfig, eslint e vitest
frontend/               Next.js App Router: Admin, Portal, site do tenant e /plataforma
  landing-page/         A landing de venda, HTML estático
app/                    App Flutter do tutor (contrato em docs/app-flutter/)
infra/                  docker-compose local, Swarm de produção e a borda (Caddyfile)
scripts/                Publicar imagens, atualizar a VPS, conferir o ambiente
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

- **Encerramento de tenant (a outra metade do MOD-IDENT-10).** A suspensão existe — teste
  vencido, atraso e carência mudam o estado por `shared/tenant-status.ts`, e a assinatura
  é a tela de regularização —, mas nada grava `TERMINATED`: falta o encerramento com
  retenção legal. Apagar o tenant hoje deixa órfãs as tabelas fora do cascade.
- **Webhooks `organization.*` do Clerk.** Os de usuário e a saída de Organization estão
  ligados (MOD-IDENT-03); renomear ou excluir a Organization pelo painel do Clerk não
  chega ao tenant local.
- **O convite de equipe sai por fora do motor do MOD-NOTIF.** `identity/mailer.ts` chama o
  Resend direto — sem fila, sem retentativa e sem histórico no painel de entregas.
- **Trocar de ciclo numa assinatura viva.** Mensal e anual se escolhem ao assinar; passar
  de um para o outro depois exigiria mover o dinheiro de um ano no Asaas.
- **Cobrança real conferida de ponta a ponta.** O PIX da assinatura e o da cobrança do
  tutor foram pagos no sandbox; o cartão (Checkout) e a cobrança avulsa da subida de plano
  anual ainda não, e a conta Asaas de produção da plataforma não está ligada.
- **Retenção de dados no Google.** Contratual, não técnico. O agente (e a transcrição do
  áudio) usa a chave Gemini de cada estabelecimento, então o acordo é entre o petshop e o
  Google — e o free tier do AI Studio pode usar o conteúdo para treino; com faturamento
  ligado, não.
