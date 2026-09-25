-- MOD-CAIXA — o caixa do dia (PRD caixa_17).
--
-- Escrita à mão, como toda migration desde o MOD-TUTOR (ver README.md).
--
-- A gaveta do balcão ganha um livro: a sessão (abertura com troco, fechamento com a
-- contagem) e os movimentos dela. A venda avulsa, que até aqui só baixava o estoque,
-- passa a dizer como foi paga e em que caixa o dinheiro entrou.

-- ─── Tipos ───────────────────────────────────────────────────────────────────

CREATE TYPE "CashSessionStatus" AS ENUM ('OPEN', 'CLOSED');
CREATE TYPE "CashMovementType" AS ENUM (
  'OPENING_FLOAT',
  'WALK_IN_SALE',
  'SALE_REFUND',
  'TUTOR_PAYMENT',
  'PAYMENT_REVERSAL',
  'WITHDRAWAL',
  'DEPOSIT'
);

-- ─── Tabelas ─────────────────────────────────────────────────────────────────

CREATE TABLE "cash_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "status" "CashSessionStatus" NOT NULL DEFAULT 'OPEN',
    "opened_by" UUID,
    "opened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "opening_float_cents" BIGINT NOT NULL DEFAULT 0,
    "closed_by" UUID,
    "closed_at" TIMESTAMPTZ(6),
    "closing_counts" JSONB,
    "difference_cents" BIGINT,
    "closing_notes" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "cash_sessions_float_non_negative" CHECK ("opening_float_cents" >= 0),
    -- Fechada tem quem fechou, quando e a contagem; aberta não tem nenhum dos três.
    CONSTRAINT "cash_sessions_closed_shape" CHECK (
      ("status" = 'OPEN' AND "closed_at" IS NULL AND "closing_counts" IS NULL)
      OR ("status" = 'CLOSED' AND "closed_at" IS NOT NULL AND "closing_counts" IS NOT NULL)
    )
);

CREATE TABLE "cash_movements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "type" "CashMovementType" NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "source_type" VARCHAR(30),
    "source_id" UUID,
    "reason" VARCHAR(200),
    "created_by" UUID,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_movements_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "cash_movements_amount_not_zero" CHECK ("amount_cents" <> 0)
);

-- ─── A venda avulsa diz como foi paga ────────────────────────────────────────

ALTER TABLE "product_sales" ADD COLUMN "payment_method" "PaymentMethod";
ALTER TABLE "product_sales" ADD COLUMN "cash_session_id" UUID;
ALTER TABLE "product_sales" ADD COLUMN "payment_id" UUID;

-- ─── Índices ─────────────────────────────────────────────────────────────────

-- Um caixa aberto por estabelecimento. Índice, e não leitura seguida de escrita: dois
-- cliques em "Abrir caixa" chegam juntos.
CREATE UNIQUE INDEX "idx_cash_sessions_one_open" ON "cash_sessions" ("tenant_id") WHERE "status" = 'OPEN';
CREATE INDEX "idx_cash_sessions_recent" ON "cash_sessions" ("tenant_id", "opened_at" DESC);
CREATE INDEX "idx_cash_movements_session" ON "cash_movements" ("tenant_id", "session_id", "occurred_at");
-- A mesma origem não entra duas vezes no caixa com o mesmo sentido.
CREATE UNIQUE INDEX "idx_cash_movements_source" ON "cash_movements" ("tenant_id", "type", "source_id") WHERE "source_id" IS NOT NULL;

-- ─── Chaves ──────────────────────────────────────────────────────────────────

ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- NO ACTION, e não RESTRICT: é conferido no fim do comando, e é isso que deixa o
-- cascade da exclusão do tenant passar pelas três tabelas.
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "cash_sessions"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "product_sales" ADD CONSTRAINT "product_sales_cash_session_id_fkey" FOREIGN KEY ("cash_session_id") REFERENCES "cash_sessions"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- ─── O movimento é imutável ──────────────────────────────────────────────────
--
-- O mesmo desenho do estoque: `UPDATE` nunca; `DELETE` só pelo cascade da exclusão do
-- tenant ou por `app_maintenance`. Correção de caixa é outro movimento, com motivo.
CREATE OR REPLACE FUNCTION prevent_cash_movement_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND (current_user = 'app_maintenance' OR pg_trigger_depth() > 1) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'ERR_CASH_009: movimento de caixa é imutável — corrija com outro lançamento';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_cash_movement_immutable
  BEFORE UPDATE OR DELETE ON "cash_movements"
  FOR EACH ROW EXECUTE FUNCTION prevent_cash_movement_mutation();

-- ─── RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE "cash_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cash_sessions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "cash_sessions"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "cash_movements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cash_movements" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "cash_movements"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

-- ─── Grants ──────────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE ON "cash_sessions" TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "cash_sessions" TO app_maintenance;
GRANT SELECT, INSERT ON "cash_movements" TO app_user;
GRANT SELECT, INSERT, DELETE ON "cash_movements" TO app_maintenance;
