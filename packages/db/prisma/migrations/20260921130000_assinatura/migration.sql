-- Camada comercial, fatia 4 — a assinatura do estabelecimento, cobrada pelo Asaas.
--
-- Escrita à mão, pelo mesmo motivo de toda migration desde o MOD-TUTOR (ver README.md).
--
-- **Uma linha por estabelecimento**, e não uma por assinatura já feita: o que o produto
-- precisa saber é a situação de agora — qual plano, por qual meio, em que estado, e qual
-- é o link da cobrança em aberto. O histórico de pagamentos é do Asaas, que é quem os
-- guarda; duplicá-lo aqui seria manter duas contas que precisam bater.
--
-- A idempotência do webhook reaproveita `webhook_events` (provider = 'asaas'), criada no
-- MOD-IDENT-03 justamente com o provedor em coluna.

CREATE TYPE "SubscriptionStatus" AS ENUM ('PENDING', 'ACTIVE', 'PAST_DUE', 'CANCELED');
CREATE TYPE "BillingMethod" AS ENUM ('CREDIT_CARD', 'PIX');

CREATE TABLE "tenant_subscriptions" (
    "tenant_id" UUID NOT NULL,
    "provider" VARCHAR(20) NOT NULL DEFAULT 'asaas',
    -- O plano **contratado**. Só vira `tenants.plan` quando o pagamento é confirmado:
    -- escolher o Pro na tela e fechar a aba não pode dar o Pro a ninguém.
    "plan" "Plan" NOT NULL,
    "method" "BillingMethod" NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'PENDING',
    -- Os identificadores do Asaas. O cliente é a chave do webhook: toda cobrança traz
    -- `payment.customer`, e é por ele que um pagamento chega ao estabelecimento.
    "provider_customer_id" VARCHAR(64),
    "provider_subscription_id" VARCHAR(64),
    -- O checkout do cartão, que é de onde o cliente do Asaas sai quando o pagamento é
    -- por cartão (a página é deles, e o cadastro também).
    "provider_checkout_id" VARCHAR(64),
    -- O link para pagar o que está em aberto: a fatura do PIX ou o checkout do cartão.
    "payment_url" TEXT,
    -- Desde quando a mensalidade está vencida. A carência conta daqui.
    "overdue_since" TIMESTAMPTZ(6),
    "last_paid_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_subscriptions_pkey" PRIMARY KEY ("tenant_id"),
    CONSTRAINT "tenant_subscriptions_tenant_id_fkey" FOREIGN KEY ("tenant_id")
      REFERENCES "tenants"("id") ON UPDATE CASCADE ON DELETE CASCADE
);

-- Um cliente, uma assinatura e um checkout do Asaas pertencem a um estabelecimento só.
-- Parciais porque os três nascem nulos e são preenchidos ao longo do fluxo.
CREATE UNIQUE INDEX "idx_tenant_subscriptions_customer"
    ON "tenant_subscriptions"("provider", "provider_customer_id")
    WHERE "provider_customer_id" IS NOT NULL;
CREATE UNIQUE INDEX "idx_tenant_subscriptions_subscription"
    ON "tenant_subscriptions"("provider", "provider_subscription_id")
    WHERE "provider_subscription_id" IS NOT NULL;
CREATE UNIQUE INDEX "idx_tenant_subscriptions_checkout"
    ON "tenant_subscriptions"("provider", "provider_checkout_id")
    WHERE "provider_checkout_id" IS NOT NULL;

-- A varredura da carência: quem está em atraso, pela data.
CREATE INDEX "idx_tenant_subscriptions_overdue"
    ON "tenant_subscriptions"("overdue_since")
    WHERE "status" = 'PAST_DUE';

ALTER TABLE "tenant_subscriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_subscriptions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tenant_subscriptions"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant_subscriptions" TO app_user, app_maintenance;
