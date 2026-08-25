-- Agendador de jobs + recibo em PDF.
--
-- Gerada com `prisma migrate diff` sobre banco-sombra e **podada à mão**: o diff trouxe
-- 26 `DROP INDEX` (agora incluindo os do MOD-LEDGER), o `tenants_slug_key` de sempre, e
-- um `ALTER COLUMN "signed_amount_cents" DROP DEFAULT` — que é o Prisma tentando
-- "corrigir" a coluna gerada, exatamente como o README das migrations previu.
--
-- `job_leases` e `job_runs` são tabelas de **plataforma**: não têm `tenant_id`, não têm
-- RLS e não entram em `RLS_MODELS`. Um job varre todos os tenants por definição.

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('OK', 'FAILED', 'TIMEOUT');

-- CreateEnum
CREATE TYPE "ReceiptStatus" AS ENUM ('PENDING', 'ISSUED', 'SENT', 'CANCELLED');

-- CreateTable
CREATE TABLE "job_leases" (
    "name" VARCHAR(80) NOT NULL,
    "holder" VARCHAR(160) NOT NULL,
    "leased_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_until" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "job_leases_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "job_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(80) NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "finished_at" TIMESTAMPTZ(6) NOT NULL,
    "status" "JobStatus" NOT NULL,
    "result" JSONB,
    "error" TEXT,

    CONSTRAINT "job_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "tutor_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "number" VARCHAR(20) NOT NULL,
    "storage_key" TEXT,
    "status" "ReceiptStatus" NOT NULL DEFAULT 'PENDING',
    "issued_at" TIMESTAMPTZ(6),
    "sent_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt_counters" (
    "tenant_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "receipt_counters_pkey" PRIMARY KEY ("tenant_id","year")
);

-- CreateIndex
CREATE INDEX "idx_job_runs_name_time" ON "job_runs"("name", "started_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "receipts_payment_id_key" ON "receipts"("payment_id");

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- SQL manual
-- ─────────────────────────────────────────────────────────────────────────────

-- RN-21: sequencial por tenant e ano. Recibo cancelado não devolve o número.
CREATE UNIQUE INDEX "idx_receipts_number" ON "receipts"("tenant_id", "number");
CREATE INDEX "idx_receipts_tutor" ON "receipts"("tenant_id", "tutor_id");

-- O job de reprocesso varre só o que ficou para trás — nunca a tabela inteira.
CREATE INDEX "idx_receipts_pending" ON "receipts"("tenant_id", "created_at")
  WHERE "status" = 'PENDING';

-- Contas em atraso: a varredura do MOD-LEDGER-09 e a régua de cobrança do MOD-CRM.
CREATE INDEX "idx_ledger_accounts_overdue" ON "ledger_accounts"("tenant_id", "overdue_since")
  WHERE "overdue_since" IS NOT NULL;

-- Lease vencido é lease disponível: o job de reivindicação procura por esta coluna.
CREATE INDEX "idx_job_leases_expiry" ON "job_leases"("lease_until");

ALTER TABLE "receipt_counters"
  ADD CONSTRAINT "chk_receipt_counter_year" CHECK ("year" BETWEEN 2000 AND 2200),
  ADD CONSTRAINT "chk_receipt_counter_number" CHECK ("last_number" >= 0);

-- ─── RLS ─────────────────────────────────────────────────────────────────────
--
-- `job_leases` e `job_runs` ficam deliberadamente **de fora**, como `users`, `roles`,
-- `permissions` e `role_permissions` (ver o comentário no fim de `*_rls_policies`).

ALTER TABLE "receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "receipts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "receipts"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "receipt_counters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "receipt_counters" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "receipt_counters"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());
