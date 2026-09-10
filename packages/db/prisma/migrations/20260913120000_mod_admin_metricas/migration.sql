-- MOD-ADMIN-05 e 06 — a série temporal e os alertas (PRD observabilidade_admin_14)
--
-- As 51 métricas do produto já eram emitidas em log estruturado, e log responde "o que
-- aconteceu naquele instante" — nunca "isso está piorando desde terça". A série é o que
-- transforma um número solto em tendência, e o alerta é o que dispensa alguém de olhar
-- para o painel para descobrir que algo quebrou.
--
-- **As duas tabelas ficam fora do RLS, apesar de terem `tenant_id`.** A coluna aqui não
-- é dono: é rótulo de agregação. A linha pertence à plataforma, que precisa somar todos
-- os estabelecimentos numa consulta só — e `tenant_id` nulo é a métrica que nasce sem
-- tenant (`mfa_claim_missing`), que política nenhuma por tenant alcançaria. A exceção é
-- declarada em `PLATFORM_MODELS`, no teste que compara esta migration com o guard.

CREATE TYPE "MetricResolution" AS ENUM ('FIVE_MIN', 'DAY');

CREATE TABLE "platform_metrics" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),

  -- Sem catálogo fechado de propósito: métrica nova aparece na série no primeiro
  -- roll-up, sem migration. Uma lista de nomes aqui garantiria que a métrica mais
  -- recente — justamente a do problema que se está investigando — fosse a que falta.
  "metric" VARCHAR(60) NOT NULL,

  "tenant_id" UUID,

  "bucket"     TIMESTAMPTZ(6) NOT NULL,
  "resolution" "MetricResolution" NOT NULL,

  "sum"   DECIMAL(18,4) NOT NULL,
  "count" INTEGER NOT NULL,
  "min"   DECIMAL(18,4) NOT NULL,
  "max"   DECIMAL(18,4) NOT NULL,
  "p95"   DECIMAL(18,4) NOT NULL,

  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "platform_metrics_pkey" PRIMARY KEY ("id")
);

-- **A chave do upsert, e o `COALESCE` não é enfeite.** No Postgres, `NULL` nunca é igual
-- a `NULL`, então um índice único direto sobre `tenant_id` deixaria a métrica de
-- plataforma criar uma linha nova a cada drenagem — e o `ON CONFLICT` do roll-up nunca
-- casaria justamente onde as réplicas mais se encontram.
CREATE UNIQUE INDEX "idx_metrics_bucket"
  ON "platform_metrics"("metric", "resolution", "bucket",
                        COALESCE("tenant_id", '00000000-0000-0000-0000-000000000000'::uuid));

-- O caminho da consulta: uma métrica, no intervalo, do mais recente para trás.
CREATE INDEX "idx_metrics_consulta" ON "platform_metrics"("metric", "bucket" DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- MOD-ADMIN-06 — alertas
-- ═══════════════════════════════════════════════════════════════════════════

-- `PENDING` é o estado que o §6 do PRD não desenha. Ele existe porque a regra só dispara
-- quando a condição vale em duas avaliações seguidas, e o contador precisa sobreviver a
-- deploy e a troca de réplica: em memória ele zeraria a cada subida, e com três réplicas
-- revezando o lease do job nunca chegaria a dois.
CREATE TYPE "PlatformAlertStatus" AS ENUM ('PENDING', 'FIRING', 'RESOLVED');

CREATE TABLE "platform_alerts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),

  "rule"      VARCHAR(60) NOT NULL,
  "tenant_id" UUID,

  "status" "PlatformAlertStatus" NOT NULL DEFAULT 'PENDING',
  "value"  DECIMAL(18,4) NOT NULL,

  "breach_streak" INTEGER NOT NULL DEFAULT 1,
  "clear_streak"  INTEGER NOT NULL DEFAULT 0,

  "first_seen_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_evaluated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "fired_at"          TIMESTAMPTZ(6),
  "resolved_at"       TIMESTAMPTZ(6),

  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "platform_alerts_pkey" PRIMARY KEY ("id")
);

-- Um alerta aberto por regra e alvo. O índice é **parcial**: fechado o alerta, a mesma
-- regra pode abrir outro amanhã, e o histórico dos dois precisa caber na tabela.
CREATE UNIQUE INDEX "idx_alerts_aberto"
  ON "platform_alerts"("rule",
                       COALESCE("tenant_id", '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE "status" <> 'RESOLVED';

CREATE INDEX "idx_alerts_abertos" ON "platform_alerts"("status", "fired_at" DESC);

-- `app_user` recebe SELECT e nada mais nas duas: nenhuma rota de tenant as lê hoje, e a
-- escrita é do job, que roda como `app_maintenance`.
GRANT SELECT ON "platform_metrics", "platform_alerts" TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "platform_metrics", "platform_alerts" TO app_maintenance;
