-- MOD-ESTOQUE, fatia 2 — a venda no balcão (PRD estoque_16, MOD-ESTOQUE-05/06).
--
-- Escrita à mão, como toda migration desde o MOD-TUTOR (ver README.md).
--
-- A venda grava a baixa do estoque e o débito `PRODUCT` no razão na mesma transação
-- (RN-11). O razão ganha uma origem nova, e o índice `idx_entries_source` — que já
-- cobre toda origem que não é `MANUAL` — passa a proteger a venda de débito duplo.

-- ─── A origem no razão ───────────────────────────────────────────────────────

ALTER TYPE "EntrySourceType" ADD VALUE 'PRODUCT_SALE';

-- ─── A venda ─────────────────────────────────────────────────────────────────

CREATE TYPE "ProductSaleStatus" AS ENUM ('COMPLETED', 'REVERSED');

CREATE TABLE "product_sales" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "tutor_id" UUID,
    "total_cents" BIGINT NOT NULL,
    "status" "ProductSaleStatus" NOT NULL DEFAULT 'COMPLETED',
    "ledger_entry_id" UUID,
    "credit_override_reason" VARCHAR(200),
    "idempotency_key" VARCHAR(80),
    "reversal_reason" VARCHAR(200),
    "reversed_by" UUID,
    "reversed_at" TIMESTAMPTZ(6),
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_sales_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "product_sale_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "sale_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "label" VARCHAR(120) NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unit_price_cents" BIGINT NOT NULL,
    "total_price_cents" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_sale_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_product_sales_recent" ON "product_sales"("tenant_id", "created_at" DESC);
CREATE INDEX "idx_product_sales_tutor" ON "product_sales"("tenant_id", "tutor_id", "created_at" DESC);
CREATE INDEX "idx_product_sale_items_sale" ON "product_sale_items"("tenant_id", "sale_id");

-- O duplo clique do "Confirmar venda": a mesma chave não vende duas vezes.
CREATE UNIQUE INDEX "idx_product_sales_idempotency"
  ON "product_sales" ("tenant_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;

-- Tutor e produto com `NO ACTION`, pela mesma razão da fatia 1: a exclusão do tenant
-- apaga tudo de uma vez pelo cascade, e fora dela nada apaga um tutor ou um produto que
-- tem venda.
ALTER TABLE "product_sales" ADD CONSTRAINT "product_sales_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_sales" ADD CONSTRAINT "product_sales_tutor_id_fkey" FOREIGN KEY ("tutor_id") REFERENCES "tutors"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "product_sale_items" ADD CONSTRAINT "product_sale_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_sale_items" ADD CONSTRAINT "product_sale_items_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "product_sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_sale_items" ADD CONSTRAINT "product_sale_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- ─── Invariantes ─────────────────────────────────────────────────────────────

ALTER TABLE "product_sales"
  ADD CONSTRAINT "product_sales_total_non_negative" CHECK ("total_cents" >= 0);
ALTER TABLE "product_sale_items"
  ADD CONSTRAINT "product_sale_items_quantity_positive" CHECK ("quantity" > 0);

-- Estorno sem motivo é exclusão disfarçada.
ALTER TABLE "product_sales"
  ADD CONSTRAINT "product_sales_reversal_has_reason"
  CHECK ("status" <> 'REVERSED' OR ("reversal_reason" IS NOT NULL AND "reversed_at" IS NOT NULL));

-- ─── RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE "product_sales" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product_sales" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "product_sales"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "product_sale_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product_sale_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "product_sale_items"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON "product_sales", "product_sale_items" TO app_user, app_maintenance;
