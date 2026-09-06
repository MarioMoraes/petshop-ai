-- MOD-CRM fatia 3 — campanhas, régua de cobrança e o teto semanal por tutor.
--
-- Escrita à mão, e não gerada por `prisma migrate dev`: o diff automático vinha com
-- trinta e poucos `DROP INDEX idx_*` e o `tenants_slug_key` de sempre, porque nada
-- disso está expressável no `schema.prisma`. Ver o README desta pasta.

-- CreateEnum
CREATE TYPE "CampaignType" AS ENUM ('INACTIVE', 'BIRTHDAY', 'DUNNING', 'MANUAL');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'RUNNING', 'DONE', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "CampaignTargetStatus" AS ENUM ('SENT', 'SKIPPED', 'FAILED');

-- CreateEnum
CREATE TYPE "CampaignSkipReason" AS ENUM ('NO_CONSENT', 'ALREADY_TARGETED', 'HAS_DEBT', 'PET_DECEASED', 'NO_CHANNEL', 'SUPPRESSED', 'WEEKLY_CAP', 'ENQUEUE_FAILED');

-- AlterEnum
-- O tutor já recebeu a mensagem de marketing da semana. Só acrescenta o valor; nenhuma
-- linha o usa nesta transação, que é a condição para o Postgres aceitar o ADD VALUE
-- dentro do bloco em que o Prisma roda a migration.
ALTER TYPE "MessageBlockReason" ADD VALUE 'WEEKLY_CAP';

-- AlterTable
-- Questão 5 do §11 do PRD, respondida pelo dono do produto: uma mensagem de marketing
-- por tutor por semana. O teto diário protege o número do petshop; este protege o tutor.
ALTER TABLE "messaging_settings"
  ADD COLUMN "marketing_weekly_cap" SMALLINT NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "campaigns" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "type" "CampaignType" NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "template_key" VARCHAR(60) NOT NULL,
    "channel" VARCHAR(10) NOT NULL DEFAULT 'AUTO',
    "segment" JSONB NOT NULL DEFAULT '{}',
    "scheduled_for" TIMESTAMPTZ(6),
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    "targeted" INTEGER NOT NULL DEFAULT 0,
    "sent" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "campaign_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_targets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "tutor_id" UUID NOT NULL,
    "status" "CampaignTargetStatus" NOT NULL,
    "skip_reason" "CampaignSkipReason",
    "message_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_targets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "campaigns_tenant_id_status_created_at_idx" ON "campaigns"("tenant_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "campaign_runs_campaign_id_started_at_idx" ON "campaign_runs"("campaign_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "idx_campaign_targets_run" ON "campaign_targets"("run_id", "status");

-- CreateIndex
-- A carência da campanha de inativos (AC-02 de MOD-CRM-07) consulta por aqui: "esta
-- pessoa já entrou na mira nos últimos 60 dias?".
CREATE INDEX "idx_campaign_targets_tutor" ON "campaign_targets"("tutor_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_runs" ADD CONSTRAINT "campaign_runs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_runs" ADD CONSTRAINT "campaign_runs_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_targets" ADD CONSTRAINT "campaign_targets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_targets" ADD CONSTRAINT "campaign_targets_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "campaign_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_targets" ADD CONSTRAINT "campaign_targets_tutor_id_fkey" FOREIGN KEY ("tutor_id") REFERENCES "tutors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS — toda tabela de negócio nova, como manda o README desta pasta.
ALTER TABLE "campaigns" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "campaigns" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "campaigns"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "campaign_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "campaign_runs" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "campaign_runs"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "campaign_targets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "campaign_targets" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "campaign_targets"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

-- ─── Permissões dos papéis da aplicação ──────────────────────────────────────
--
-- Explícito pelo mesmo motivo da migration do Portal: o `ALTER DEFAULT PRIVILEGES` da
-- migration de RLS só cobre tabela criada pelo papel que o executou, e uma migration
-- aplicada por outro dono deixaria as três tabelas mudas sem erro nenhum aqui.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "campaigns",
  "campaign_runs",
  "campaign_targets"
  TO app_user, app_maintenance;
