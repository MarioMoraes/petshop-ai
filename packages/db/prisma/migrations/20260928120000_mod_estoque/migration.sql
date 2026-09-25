-- MOD-ESTOQUE, fatia 1 — cadastro de produto, lote e o razão de movimentos
-- (PRD estoque_16).
--
-- Escrita à mão, como toda migration desde o MOD-TUTOR (ver README.md). As tabelas da
-- venda (`product_sales`, `product_sale_items`) entram na fatia 2.
--
-- O desenho é o do MOD-LEDGER: o saldo mora **materializado** em
-- `stock_lots.quantity_on_hand` para as telas lerem sem somar, e a verdade é
-- `stock_movements`, que só cresce.

-- ─── Tipos ───────────────────────────────────────────────────────────────────

CREATE TYPE "ProductKind" AS ENUM ('RETAIL', 'SUPPLY', 'BOTH');
CREATE TYPE "ProductUnit" AS ENUM ('UN', 'ML', 'L', 'G', 'KG');
CREATE TYPE "StockMovementType" AS ENUM ('PURCHASE_IN', 'SALE_OUT', 'CONSUMPTION_OUT', 'ADJUSTMENT', 'LOSS', 'RETURN_IN', 'VOID_RETURN');
CREATE TYPE "StockSourceType" AS ENUM ('ENTRY', 'ADJUSTMENT', 'SALE_ITEM', 'ATTENDANCE_ITEM', 'INTERNAL_USE');

-- ─── Tabelas ─────────────────────────────────────────────────────────────────

CREATE TABLE "products" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "sku" VARCHAR(40),
    "barcode" VARCHAR(40),
    "kind" "ProductKind" NOT NULL,
    "unit" "ProductUnit" NOT NULL DEFAULT 'UN',
    "sale_price_cents" BIGINT,
    "cost_cents" BIGINT,
    "min_quantity" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "tracks_expiry" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "stock_lots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "batch_code" VARCHAR(40) NOT NULL,
    "expires_at" DATE,
    "quantity_on_hand" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "unit_cost_cents" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_lots_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "stock_movements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "type" "StockMovementType" NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "quantity_after" DECIMAL(12,3) NOT NULL,
    "source_type" "StockSourceType" NOT NULL,
    "source_id" UUID,
    "idempotency_key" VARCHAR(80),
    "reason" VARCHAR(200),
    "pet_id" UUID,
    "tutor_id" UUID,
    "created_by" UUID,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "posted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- ─── Índices ─────────────────────────────────────────────────────────────────

CREATE INDEX "idx_products_active" ON "products"("tenant_id", "active");
CREATE INDEX "idx_stock_lots_fefo" ON "stock_lots"("tenant_id", "product_id", "expires_at");
CREATE UNIQUE INDEX "idx_stock_lots_batch" ON "stock_lots"("tenant_id", "product_id", "batch_code");
CREATE INDEX "idx_stock_movements_product" ON "stock_movements"("tenant_id", "product_id", "occurred_at" DESC);
CREATE INDEX "idx_stock_movements_lot" ON "stock_movements"("tenant_id", "lot_id", "occurred_at" DESC);

-- O SKU é único entre os produtos vivos. Parcial porque o Prisma só declara unicidade
-- total, e a total impediria reaproveitar o código de um produto excluído.
CREATE UNIQUE INDEX "idx_products_sku"
  ON "products" ("tenant_id", "sku")
  WHERE "sku" IS NOT NULL AND "deleted_at" IS NULL;

-- O duplo clique da tela de entrada e de ajuste: a mesma chave não grava duas vezes.
CREATE UNIQUE INDEX "idx_stock_movements_idempotency"
  ON "stock_movements" ("tenant_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;

-- ─── Chaves estrangeiras ─────────────────────────────────────────────────────
--
-- Produto e lote com `NO ACTION`, e não `RESTRICT`: o `NO ACTION` é conferido no fim
-- do comando, e é isso que deixa a exclusão do tenant apagar os três de uma vez pelo
-- cascade. Fora dela, nada apaga lote nem produto com movimento.

ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "stock_lots"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- ─── Invariantes ─────────────────────────────────────────────────────────────

-- Movimento de zero não move nada, e só polui o histórico.
ALTER TABLE "stock_movements"
  ADD CONSTRAINT "stock_movements_quantity_not_zero" CHECK ("quantity" <> 0);

ALTER TABLE "products"
  ADD CONSTRAINT "products_min_quantity_non_negative" CHECK ("min_quantity" >= 0);

-- RN-01 — o movimento é imutável.
--
-- `UPDATE` nunca. `DELETE` só em dois casos: o expurgo de `app_maintenance`, e o
-- cascade da exclusão do tenant — que chega por dentro do trigger de chave estrangeira,
-- daí o `pg_trigger_depth() > 1`. `TRUNCATE` não dispara trigger de linha, e a suíte de
-- testes continua limpando.
CREATE OR REPLACE FUNCTION prevent_stock_movement_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND (current_user = 'app_maintenance' OR pg_trigger_depth() > 1) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'ERR_INV_014: movimento de estoque é imutável — corrija com um ajuste';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_stock_movement_immutable
  BEFORE UPDATE OR DELETE ON "stock_movements"
  FOR EACH ROW EXECUTE FUNCTION prevent_stock_movement_mutation();

-- ─── RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "products" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "products"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "stock_lots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_lots" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "stock_lots"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "stock_movements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_movements" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "stock_movements"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

-- ─── Grants ──────────────────────────────────────────────────────────────────
--
-- O movimento não ganha `UPDATE` de ninguém: o trigger já barra, e o grant ausente é a
-- segunda porta — a mesma decisão de `tutor_consents`.

GRANT SELECT, INSERT, UPDATE, DELETE ON "products", "stock_lots" TO app_user, app_maintenance;
GRANT SELECT, INSERT ON "stock_movements" TO app_user;
GRANT SELECT, INSERT, DELETE ON "stock_movements" TO app_maintenance;
