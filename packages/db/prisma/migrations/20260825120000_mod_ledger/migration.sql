-- MOD-LEDGER — conta corrente do tutor (PRD financeiro_tutor_05 §4).
--
-- Gerada com `prisma migrate diff` sobre banco-sombra e **podada à mão**, como manda
-- `packages/db/prisma/migrations/README.md`: o diff queria derrubar 16 índices
-- parciais/GIN/trigram escritos à mão e recriar `tenants_slug_key` por cima de
-- `idx_tenants_slug`. Nada disso foi pedido.
--
-- O que vem depois do bloco gerado é o que o Prisma não sabe declarar: a coluna
-- gerada `signed_amount_cents`, os CHECK de invariante, os índices parciais do §4, o
-- trigger que torna o lançamento imutável, a RULE que impede DELETE e as políticas RLS.

-- CreateEnum
CREATE TYPE "EntryDirection" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "EntryCategory" AS ENUM ('SERVICE', 'PRODUCT', 'NO_SHOW_FEE', 'PACKAGE_PURCHASE', 'PACKAGE_REDEMPTION', 'PAYMENT', 'PAYMENT_REVERSAL', 'ADJUSTMENT', 'FEE_WAIVER', 'DISCOUNT');

-- CreateEnum
CREATE TYPE "EntrySourceType" AS ENUM ('ATTENDANCE', 'APPOINTMENT', 'PAYMENT', 'PACKAGE', 'MANUAL', 'SYSTEM');

-- CreateEnum
CREATE TYPE "EntryStatus" AS ENUM ('POSTED', 'REVERSED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'PIX_MANUAL', 'CARD_MACHINE_DEBIT', 'CARD_MACHINE_CREDIT', 'BANK_TRANSFER', 'PACKAGE_CREDIT', 'OTHER');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('RECORDED', 'REVERSED');

-- CreateEnum
CREATE TYPE "AllocationSource" AS ENUM ('AUTO_FIFO', 'MANUAL');

-- CreateEnum
CREATE TYPE "PurchaseStatus" AS ENUM ('ACTIVE', 'CONSUMED', 'EXPIRED', 'SUSPENDED', 'CANCELLED');

-- CreateTable
CREATE TABLE "ledger_accounts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "tutor_id" UUID NOT NULL,
    "balance_cents" BIGINT NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL DEFAULT 'BRL',
    "version" INTEGER NOT NULL DEFAULT 0,
    "last_entry_at" TIMESTAMPTZ(6),
    "last_payment_at" TIMESTAMPTZ(6),
    "overdue_since" TIMESTAMPTZ(6),
    "needs_review" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "tutor_id" UUID NOT NULL,
    "direction" "EntryDirection" NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "signed_amount_cents" BIGINT,
    "balance_after_cents" BIGINT NOT NULL,
    "category" "EntryCategory" NOT NULL,
    "description" VARCHAR(200) NOT NULL,
    "internal_notes_encrypted" TEXT,
    "source_type" "EntrySourceType" NOT NULL,
    "source_id" UUID,
    "pet_id" UUID,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "posted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "EntryStatus" NOT NULL DEFAULT 'POSTED',
    "reversed_by_entry_id" UUID,
    "reverses_entry_id" UUID,
    "settled_cents" BIGINT NOT NULL DEFAULT 0,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "tutor_id" UUID NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "allocated_cents" BIGINT NOT NULL DEFAULT 0,
    "method" "PaymentMethod" NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL,
    "received_by" UUID,
    "entry_id" UUID NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'RECORDED',
    "reversal_reason" TEXT,
    "proof_url_encrypted" TEXT,
    "notes_encrypted" TEXT,
    "external_ref" VARCHAR(120),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_allocations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "debit_entry_id" UUID NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "allocated_by" "AllocationSource" NOT NULL DEFAULT 'AUTO_FIFO',
    "reversed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_packages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "service_ids" UUID[],
    "credits" INTEGER NOT NULL,
    "price_cents" BIGINT NOT NULL,
    "validity_days" INTEGER NOT NULL DEFAULT 90,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "package_purchases" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "tutor_id" UUID NOT NULL,
    "package_id" UUID NOT NULL,
    "pet_id" UUID,
    "snapshot" JSONB NOT NULL,
    "credits_total" INTEGER NOT NULL,
    "credits_used" INTEGER NOT NULL DEFAULT 0,
    "purchased_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "status" "PurchaseStatus" NOT NULL DEFAULT 'ACTIVE',
    "suspension_reason_encrypted" TEXT,
    "payment_id" UUID,
    "entry_id" UUID NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "package_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "package_credit_usages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "purchase_id" UUID NOT NULL,
    "attendance_id" UUID NOT NULL,
    "appointment_id" UUID,
    "service_id" UUID NOT NULL,
    "pet_id" UUID NOT NULL,
    "entry_id" UUID NOT NULL,
    "used_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reverted_at" TIMESTAMPTZ(6),

    CONSTRAINT "package_credit_usages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_settings" (
    "tenant_id" UUID NOT NULL,
    "credit_limit_cents" BIGINT,
    "overdue_days" INTEGER NOT NULL DEFAULT 30,
    "enabled_payment_methods" "PaymentMethod"[],
    "default_package_validity_days" INTEGER NOT NULL DEFAULT 90,
    "package_expiry_warning_days" INTEGER[] DEFAULT ARRAY[15, 3]::INTEGER[],
    "no_show_consumes_package_credit" BOOLEAN NOT NULL DEFAULT false,
    "receipt_footer_text" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_settings_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "ledger_idempotency_keys" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "key" UUID NOT NULL,
    "endpoint" VARCHAR(60) NOT NULL,
    "request_hash" VARCHAR(64) NOT NULL,
    "resource_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payments_entry_id_key" ON "payments"("entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "package_purchases_entry_id_key" ON "package_purchases"("entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "package_credit_usages_entry_id_key" ON "package_credit_usages"("entry_id");

-- AddForeignKey
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_tutor_id_fkey" FOREIGN KEY ("tutor_id") REFERENCES "tutors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "ledger_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_debit_entry_id_fkey" FOREIGN KEY ("debit_entry_id") REFERENCES "ledger_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_purchases" ADD CONSTRAINT "package_purchases_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "service_packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_purchases" ADD CONSTRAINT "package_purchases_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_purchases" ADD CONSTRAINT "package_purchases_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "ledger_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_credit_usages" ADD CONSTRAINT "package_credit_usages_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "package_purchases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_credit_usages" ADD CONSTRAINT "package_credit_usages_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "ledger_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_settings" ADD CONSTRAINT "billing_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- SQL manual: o que o schema.prisma não expressa
-- ─────────────────────────────────────────────────────────────────────────────

-- Coluna gerada: o sinal do lançamento vive no banco, não na aplicação.
-- É o que o job de reconciliação (MOD-LEDGER-11) soma para conferir com o saldo
-- materializado. Deixá-la à aplicação seria confiar no código que se quer auditar.
-- O bloco gerado a criou como coluna comum (o Prisma não declara `GENERATED`);
-- aqui ela é derrubada e recriada com a expressão.
ALTER TABLE "ledger_entries" DROP COLUMN "signed_amount_cents";

ALTER TABLE "ledger_entries"
  ADD COLUMN "signed_amount_cents" BIGINT
  GENERATED ALWAYS AS (
    CASE WHEN "direction" = 'CREDIT' THEN "amount_cents" ELSE -"amount_cents" END
  ) STORED;

-- Invariantes garantidas no banco — o ledger não confia apenas na aplicação (§4).
ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "chk_amount_positive"
    CHECK ("amount_cents" > 0 OR "category" = 'PACKAGE_REDEMPTION'),
  ADD CONSTRAINT "chk_settled_bounds"
    CHECK ("settled_cents" >= 0 AND "settled_cents" <= "amount_cents");

ALTER TABLE "package_purchases"
  ADD CONSTRAINT "chk_credits_bounds"
    CHECK ("credits_used" >= 0 AND "credits_used" <= "credits_total");

ALTER TABLE "payments"
  ADD CONSTRAINT "chk_allocated_bounds"
    CHECK ("allocated_cents" >= 0 AND "allocated_cents" <= "amount_cents");

ALTER TABLE "payment_allocations"
  ADD CONSTRAINT "chk_allocation_positive" CHECK ("amount_cents" > 0);

ALTER TABLE "billing_settings"
  ADD CONSTRAINT "chk_overdue_days" CHECK ("overdue_days" BETWEEN 1 AND 365);

-- Índices (§4). Uma conta por tutor por tenant.
CREATE UNIQUE INDEX "idx_ledger_accounts_tutor" ON "ledger_accounts"("tenant_id", "tutor_id");

-- Quem deve. Parcial porque a esmagadora maioria das contas está zerada.
CREATE INDEX "idx_ledger_accounts_debtors" ON "ledger_accounts"("tenant_id", "balance_cents")
  WHERE "balance_cents" < 0;

CREATE INDEX "idx_ledger_accounts_review" ON "ledger_accounts"("tenant_id")
  WHERE "needs_review";

-- Contas com movimentação recente: é a varredura do job de reconciliação.
CREATE INDEX "idx_ledger_accounts_recent" ON "ledger_accounts"("last_entry_at")
  WHERE "last_entry_at" IS NOT NULL;

-- Extrato: o acesso dominante do módulo. Ordena por `occurred_at` (RN-23), não por
-- `posted_at` — o serviço de ontem lançado hoje aparece na data em que aconteceu.
CREATE INDEX "idx_entries_account_time"
  ON "ledger_entries"("tenant_id", "account_id", "occurred_at" DESC, "id" DESC);

-- Idempotência de consumo de evento: a garantia mais importante da tabela.
-- `MANUAL` fica de fora porque lançamento de balcão não tem origem no sistema — a
-- repetição dele é barrada por `ledger_idempotency_keys`, não por aqui.
CREATE UNIQUE INDEX "idx_entries_source"
  ON "ledger_entries"("tenant_id", "source_type", "source_id", "direction")
  WHERE "source_id" IS NOT NULL AND "source_type" <> 'MANUAL';

-- Alocação FIFO: débitos abertos, mais antigos primeiro.
CREATE INDEX "idx_entries_open_debits"
  ON "ledger_entries"("tenant_id", "account_id", "occurred_at")
  WHERE "direction" = 'DEBIT' AND "status" = 'POSTED' AND "settled_cents" < "amount_cents";

CREATE INDEX "idx_entries_reverses" ON "ledger_entries"("reverses_entry_id")
  WHERE "reverses_entry_id" IS NOT NULL;

CREATE INDEX "idx_payments_account" ON "payments"("tenant_id", "account_id", "received_at" DESC);
CREATE INDEX "idx_payments_tenant_time" ON "payments"("tenant_id", "received_at" DESC);

-- Pagamentos com crédito sobrando: é o que o débito novo consome (RN-07).
CREATE INDEX "idx_payments_unallocated" ON "payments"("tenant_id", "account_id", "received_at")
  WHERE "status" = 'RECORDED' AND "allocated_cents" < "amount_cents";

CREATE INDEX "idx_allocations_debit" ON "payment_allocations"("debit_entry_id");
CREATE INDEX "idx_allocations_payment" ON "payment_allocations"("payment_id");

CREATE INDEX "idx_packages_tenant" ON "service_packages"("tenant_id", "active");

CREATE INDEX "idx_purchases_active" ON "package_purchases"("tenant_id", "tutor_id", "status")
  WHERE "status" = 'ACTIVE';

CREATE INDEX "idx_purchases_expiring" ON "package_purchases"("tenant_id", "expires_at")
  WHERE "status" = 'ACTIVE';

-- Resgate: achar o pacote do pet que cobre o serviço. O GIN sobre o snapshot é o
-- que torna RN-10 (casamento por `service_id`) barato o bastante para rodar dentro
-- do consumo de `atendimento.concluido`.
CREATE INDEX "idx_purchases_pet_service" ON "package_purchases"
  USING GIN (("snapshot" -> 'serviceIds'))
  WHERE "status" = 'ACTIVE';

CREATE INDEX "idx_purchases_pet" ON "package_purchases"("tenant_id", "pet_id")
  WHERE "pet_id" IS NOT NULL;

-- Idempotência do resgate: a reentrega do evento não queima o crédito duas vezes.
CREATE UNIQUE INDEX "idx_usages_attendance_service"
  ON "package_credit_usages"("tenant_id", "attendance_id", "service_id");

CREATE INDEX "idx_usages_purchase" ON "package_credit_usages"("purchase_id");

-- RN-04: a mesma chave no mesmo endpoint é uma repetição, não uma operação nova.
CREATE UNIQUE INDEX "idx_ledger_idempotency"
  ON "ledger_idempotency_keys"("tenant_id", "endpoint", "key");

-- RN-01 — imutabilidade absoluta.
--
-- Um lançamento nasce definitivo. Só metadados de estorno e o avanço da quitação
-- podem mudar; valor, direção, conta, data do fato e saldo corrido, nunca. Correção
-- é sempre um lançamento inverso vinculado por `reverses_entry_id`.
CREATE OR REPLACE FUNCTION prevent_ledger_entry_mutation() RETURNS trigger AS $$
BEGIN
  IF NEW."amount_cents"        IS DISTINCT FROM OLD."amount_cents"
     OR NEW."direction"        IS DISTINCT FROM OLD."direction"
     OR NEW."account_id"       IS DISTINCT FROM OLD."account_id"
     OR NEW."tutor_id"         IS DISTINCT FROM OLD."tutor_id"
     OR NEW."category"         IS DISTINCT FROM OLD."category"
     OR NEW."occurred_at"      IS DISTINCT FROM OLD."occurred_at"
     OR NEW."posted_at"        IS DISTINCT FROM OLD."posted_at"
     OR NEW."balance_after_cents" IS DISTINCT FROM OLD."balance_after_cents" THEN
    RAISE EXCEPTION 'ERR_LEDGER_005: lançamento é imutável — use estorno por contrapartida';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ledger_entry_immutable
  BEFORE UPDATE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION prevent_ledger_entry_mutation();

-- Nem DELETE. `TRUNCATE` ignora RULEs, então a suíte de testes continua limpando.
CREATE RULE no_delete_ledger_entries AS ON DELETE TO "ledger_entries" DO INSTEAD NOTHING;

-- ─── RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE "ledger_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ledger_accounts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ledger_accounts"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "ledger_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ledger_entries" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ledger_entries"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payments" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "payments"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "payment_allocations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_allocations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "payment_allocations"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "service_packages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "service_packages" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "service_packages"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "package_purchases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "package_purchases" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "package_purchases"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "package_credit_usages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "package_credit_usages" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "package_credit_usages"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "billing_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "billing_settings"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "ledger_idempotency_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ledger_idempotency_keys" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ledger_idempotency_keys"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

-- Sem GRANT explícito: o `ALTER DEFAULT PRIVILEGES` da migration de RLS já cobre
-- toda tabela nova do schema `public`.
