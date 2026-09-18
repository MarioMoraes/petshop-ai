-- Camada comercial — a contratação anual, com desconto (decisão do produto de 2026-09-18).
--
-- Escrita à mão, pelo mesmo motivo de toda migration desde o MOD-TUTOR (ver README.md).
--
-- **O ciclo é da assinatura, e o preço é do catálogo.** Nada de preço em coluna: o valor
-- de cada plano em cada ciclo mora em `PLAN_CATALOG` (`shared-types/plans.ts`), que é
-- também o que a landing promete. Guardar o preço aqui criaria uma segunda tabela de
-- preços que ninguém lembraria de mexer junto.
--
-- **`scheduled_plan` existe porque descer de plano no anual não é para agora.** Quem pagou
-- doze meses de Pro e escolhe o Starter no mês 4 continua no Pro até a renovação — a linha
-- guarda o que entra quando o ano virar, e o webhook do pagamento é quem o aplica.
--
-- **`current_period_ends_at` é o que torna a subida proporcional possível**: a diferença
-- cobrada é a dos meses que ainda faltam, e sem esta data não há como saber quantos são.
-- Ela também substitui, para a assinatura cancelada, o palpite de 31 dias sobre
-- `last_paid_at` — que num anual suspenderia a conta onze meses cedo demais.

CREATE TYPE "BillingCycle" AS ENUM ('MONTHLY', 'YEARLY');

ALTER TABLE "tenant_subscriptions"
  ADD COLUMN "cycle" "BillingCycle" NOT NULL DEFAULT 'MONTHLY',
  ADD COLUMN "scheduled_plan" "Plan",
  ADD COLUMN "current_period_ends_at" TIMESTAMPTZ(6);

-- A varredura de quem cancelou: o período pago acabou e a conta ainda responde.
CREATE INDEX "idx_tenant_subscriptions_period_end"
    ON "tenant_subscriptions"("current_period_ends_at")
    WHERE "status" = 'CANCELED';
