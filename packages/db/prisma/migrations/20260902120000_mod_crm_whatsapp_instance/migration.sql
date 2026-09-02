-- MOD-CRM-01 — a conexão de WhatsApp do estabelecimento.
--
-- Escrita à mão a partir de `prisma migrate diff`. O diff veio, como sempre, querendo
-- derrubar os índices parciais, os de expressão e a coluna gerada do ledger, além de
-- recriar `tenants_slug_key` por cima de `idx_tenants_slug` — nada disso está aqui.
-- Ver `packages/db/prisma/migrations/README.md`.

-- CreateEnum
CREATE TYPE "WhatsappInstanceStatus" AS ENUM ('NOT_CONFIGURED', 'CONNECTING', 'CONNECTED', 'DISCONNECTED', 'BANNED');

-- CreateTable
CREATE TABLE "whatsapp_instances" (
    "tenant_id" UUID NOT NULL,
    "provider" VARCHAR(20) NOT NULL DEFAULT 'evolution',
    "instance_name" VARCHAR(80) NOT NULL,
    "status" "WhatsappInstanceStatus" NOT NULL DEFAULT 'NOT_CONFIGURED',
    "phone_e164" VARCHAR(20),
    "api_key_encrypted" TEXT,
    "webhook_token_hash" CHAR(64),
    "connected_at" TIMESTAMPTZ(6),
    "last_seen_at" TIMESTAMPTZ(6),
    "warmup_started_at" TIMESTAMPTZ(6),
    "last_error" VARCHAR(300),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_instances_pkey" PRIMARY KEY ("tenant_id")
);

-- O webhook do provedor chega sem saber de que tenant é: quem o resolve é este índice,
-- pelo hash do token, no escopo de plataforma (`packages/db/src/platform.ts`).
CREATE INDEX "idx_whatsapp_webhook_token" ON "whatsapp_instances"("webhook_token_hash");

-- AddForeignKey
ALTER TABLE "whatsapp_instances" ADD CONSTRAINT "whatsapp_instances_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS, como toda tabela de negócio nova.
ALTER TABLE "whatsapp_instances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "whatsapp_instances" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "whatsapp_instances"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

-- O `GRANT ... ON ALL TABLES` da migration de RLS já rodou; tabela nova não é
-- alcançada por ele e precisa do seu.
GRANT SELECT, INSERT, UPDATE, DELETE ON "whatsapp_instances" TO app_user, app_maintenance;

-- `@updatedAt` é preenchido pela aplicação; o default cobre quem escreve por SQL.
ALTER TABLE "whatsapp_instances" ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;
