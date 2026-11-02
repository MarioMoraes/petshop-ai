-- A troca de ciclo numa assinatura viva (mensal ↔ anual) espera a renovação, como a
-- descida de plano no anual: o período corrente já foi pago no ciclo de antes.
ALTER TABLE "tenant_subscriptions" ADD COLUMN "scheduled_cycle" "BillingCycle";
