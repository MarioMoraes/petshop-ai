-- MOD-CRM — relacionamento e automação (PRD relacionamento_crm_08).
--
-- Gerada com `prisma migrate diff` contra banco-sombra, como manda o README desta
-- pasta. Foram removidos à mão do diff: 29 `DROP INDEX` de índices parciais e de
-- expressão que o Prisma não conhece, o `ALTER COLUMN signed_amount_cents DROP
-- DEFAULT` (a coluna é GENERATED ALWAYS) e o `CREATE UNIQUE INDEX tenants_slug_key`,
-- que teria desfeito o parcial `idx_tenants_slug`.

-- CreateEnum
CREATE TYPE "MessageChannel" AS ENUM ('WHATSAPP', 'EMAIL');


-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('OUTBOUND', 'INBOUND');


-- CreateEnum
CREATE TYPE "MessageCategory" AS ENUM ('TRANSACTIONAL', 'OPERATIONAL', 'MARKETING');


-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('QUEUED', 'SCHEDULED', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'DEAD', 'BLOCKED', 'CANCELLED');


-- CreateEnum
CREATE TYPE "MessageBlockReason" AS ENUM ('NO_CONSENT', 'SUPPRESSED', 'NO_CHANNEL', 'PET_DECEASED', 'QUIET_HOURS_EXPIRED');


-- CreateEnum
CREATE TYPE "MessageOriginType" AS ENUM ('APPOINTMENT', 'TAXI_RIDE', 'LEDGER_ENTRY', 'CAMPAIGN_RUN', 'PET', 'MANUAL');


-- CreateEnum
CREATE TYPE "SuppressionReason" AS ENUM ('HARD_BOUNCE', 'NOT_ON_WHATSAPP', 'ANONYMIZED', 'MANUAL');


-- CreateEnum
CREATE TYPE "MessageEventKind" AS ENUM ('SENT', 'DELIVERED', 'READ', 'FAILED', 'BOUNCED');


-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "tutor_id" UUID NOT NULL,
    "pet_id" UUID,
    "channel" "MessageChannel" NOT NULL,
    "direction" "MessageDirection" NOT NULL DEFAULT 'OUTBOUND',
    "category" "MessageCategory" NOT NULL,
    "template_key" VARCHAR(60) NOT NULL,
    "template_version" INTEGER NOT NULL DEFAULT 0,
    "to_encrypted" TEXT NOT NULL,
    "to_hash" CHAR(64) NOT NULL,
    "subject_encrypted" TEXT,
    "body_encrypted" TEXT NOT NULL,
    "status" "MessageStatus" NOT NULL DEFAULT 'QUEUED',
    "block_reason" "MessageBlockReason",
    "dedupe_key" VARCHAR(120) NOT NULL,
    "origin_type" "MessageOriginType",
    "origin_id" UUID,
    "scheduled_for" TIMESTAMPTZ(6),
    "sent_at" TIMESTAMPTZ(6),
    "delivered_at" TIMESTAMPTZ(6),
    "read_at" TIMESTAMPTZ(6),
    "failed_at" TIMESTAMPTZ(6),
    "attempts" SMALLINT NOT NULL DEFAULT 0,
    "provider" VARCHAR(20),
    "provider_message_id" VARCHAR(120),
    "error_code" VARCHAR(60),
    "error_detail" VARCHAR(500),
    "requested_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);


-- CreateTable
CREATE TABLE "message_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "event" "MessageEventKind" NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raw" JSONB,

    CONSTRAINT "message_events_pkey" PRIMARY KEY ("id")
);


-- CreateTable
CREATE TABLE "message_templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "key" VARCHAR(60) NOT NULL,
    "channel" "MessageChannel" NOT NULL,
    "subject" VARCHAR(160),
    "body" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_templates_pkey" PRIMARY KEY ("id")
);


-- CreateTable
CREATE TABLE "messaging_settings" (
    "tenant_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "quiet_start_min" SMALLINT NOT NULL DEFAULT 480,
    "quiet_end_min" SMALLINT NOT NULL DEFAULT 1200,
    "marketing_weekdays_only" BOOLEAN NOT NULL DEFAULT true,
    "daily_cap" INTEGER NOT NULL DEFAULT 500,
    "per_minute_cap" SMALLINT NOT NULL DEFAULT 20,
    "default_channel" VARCHAR(10) NOT NULL DEFAULT 'AUTO',
    "retention_months" SMALLINT NOT NULL DEFAULT 24,
    "sender_name" VARCHAR(60),
    "reply_to_email" VARCHAR(160),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messaging_settings_pkey" PRIMARY KEY ("tenant_id")
);


-- CreateTable
CREATE TABLE "messaging_suppressions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "channel" "MessageChannel" NOT NULL,
    "address_hash" CHAR(64) NOT NULL,
    "reason" "SuppressionReason" NOT NULL,
    "expires_at" TIMESTAMPTZ(6),
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messaging_suppressions_pkey" PRIMARY KEY ("id")
);


-- CreateTable
CREATE TABLE "automations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "key" VARCHAR(60) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "channel" VARCHAR(10) NOT NULL DEFAULT 'AUTO',
    "template_key" VARCHAR(60),
    "config" JSONB NOT NULL DEFAULT '{}',
    "updated_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automations_pkey" PRIMARY KEY ("id")
);


-- CreateIndex
CREATE INDEX "idx_messages_tutor" ON "messages"("tenant_id", "tutor_id", "created_at" DESC);


-- CreateIndex
CREATE INDEX "idx_message_events_message" ON "message_events"("message_id", "occurred_at");


-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_tutor_id_fkey" FOREIGN KEY ("tutor_id") REFERENCES "tutors"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_pet_id_fkey" FOREIGN KEY ("pet_id") REFERENCES "pets"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "message_events" ADD CONSTRAINT "message_events_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "messaging_settings" ADD CONSTRAINT "messaging_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "messaging_suppressions" ADD CONSTRAINT "messaging_suppressions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "automations" ADD CONSTRAINT "automations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Índices que o Prisma não declara: parciais e de expressão
-- ─────────────────────────────────────────────────────────────────────────────

-- O worker: o que pode sair agora, na ordem certa. Parcial porque a fila é uma
-- fração minúscula da tabela — o histórico fica, a fila esvazia.
CREATE INDEX "idx_messages_dispatch" ON "messages" ("tenant_id", "scheduled_for")
  WHERE "status" IN ('QUEUED', 'SCHEDULED') AND "direction" = 'OUTBOUND';

-- Idempotência do motor (AC-04 de MOD-CRM-03). É este índice que faz o reprocessamento
-- de um evento após redeploy não virar uma segunda mensagem no celular do tutor.
CREATE UNIQUE INDEX "idx_messages_dedupe" ON "messages" ("tenant_id", "dedupe_key");

-- Invalidação em cascata (AC-06 de MOD-CRM-03): o agendamento cancelado às 20h
-- precisa achar o lembrete das 8h da manhã seguinte.
CREATE INDEX "idx_messages_origin" ON "messages" ("origin_type", "origin_id")
  WHERE "status" IN ('QUEUED', 'SCHEDULED');

-- Casar o callback do provedor com a mensagem.
CREATE INDEX "idx_messages_provider" ON "messages" ("provider", "provider_message_id")
  WHERE "provider_message_id" IS NOT NULL;

-- Painel de falhas e o alerta de fila travada.
CREATE INDEX "idx_messages_failed" ON "messages" ("tenant_id", "status", "updated_at" DESC)
  WHERE "status" IN ('DEAD', 'FAILED', 'BLOCKED');

-- A consulta feita antes de **todo** envio: precisa ser uma busca só.
CREATE UNIQUE INDEX "idx_suppressions_addr"
  ON "messaging_suppressions" ("tenant_id", "channel", "address_hash");

CREATE UNIQUE INDEX "idx_templates_key" ON "message_templates" ("tenant_id", "key", "channel");
CREATE UNIQUE INDEX "idx_automations_key" ON "automations" ("tenant_id", "key");

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS (MOD-IDENT-07)
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "messages" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "messages"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "message_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "message_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "message_events"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "message_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "message_templates" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "message_templates"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "messaging_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "messaging_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "messaging_settings"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "messaging_suppressions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "messaging_suppressions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "messaging_suppressions"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "automations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "automations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "automations"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON
  "messages", "message_events", "message_templates",
  "messaging_settings", "messaging_suppressions", "automations"
  TO app_user, app_maintenance;

-- ─────────────────────────────────────────────────────────────────────────────
-- `message_events` é append-only, como `audit_logs` e `tutor_consents`
-- ─────────────────────────────────────────────────────────────────────────────

-- É a prova de entrega. Uma linha editável não prova nada — e é justamente o registro
-- que se consulta semanas depois, quando o tutor jura que não recebeu.
CREATE OR REPLACE FUNCTION message_events_append_only() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'message_events é append-only: % não é permitido', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER message_events_no_update
  BEFORE UPDATE OR DELETE ON "message_events"
  FOR EACH ROW EXECUTE FUNCTION message_events_append_only();

-- ─────────────────────────────────────────────────────────────────────────────
-- Invariantes que a aplicação não pode ser a única a garantir
-- ─────────────────────────────────────────────────────────────────────────────

-- Bloqueio sem motivo é bloqueio que ninguém consegue explicar ao petshop (§6).
ALTER TABLE "messages" ADD CONSTRAINT "messages_block_reason_check"
  CHECK (("status" = 'BLOCKED') = ("block_reason" IS NOT NULL));

-- A janela de silêncio é do tutor: uma janela invertida ou vazia deixaria o motor sem
-- hora nenhuma para enviar, e a fila cresceria em silêncio (RN-04).
ALTER TABLE "messaging_settings" ADD CONSTRAINT "messaging_settings_quiet_window_check"
  CHECK ("quiet_start_min" >= 0 AND "quiet_end_min" <= 1440 AND "quiet_start_min" < "quiet_end_min");
