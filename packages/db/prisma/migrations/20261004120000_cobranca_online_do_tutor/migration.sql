-- MOD-LEDGER — a cobrança online do tutor, pela conta do Asaas do estabelecimento.
--
-- Escrita à mão, como toda migration desde o MOD-TUTOR (ver README.md).
--
-- Até aqui o pagamento do tutor era sempre registrado à mão no balcão. Agora o petshop
-- conecta a conta dele no Asaas em Configurações › Integrações, e o tutor paga por PIX ou
-- cartão num link — o botão "Pagar agora" do Portal/app, ou o link que a recepção gera. A
-- baixa entra sozinha, pelo webhook que a própria conexão registra no Asaas.
--
-- O dinheiro é do petshop: a chave é dele, o webhook é da conta dele, e a PetShop AI não
-- intermedeia nada. A chave é cifrada com a DEK do tenant; do token do webhook guarda-se
-- só o hash, como no WhatsApp.

-- ─── Os meios online ─────────────────────────────────────────────────────────
--
-- Só nascem do webhook. Não entram na lista de meios que o balcão habilita.

ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'PIX_ONLINE';
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'CARD_ONLINE';

-- ─── A conexão ───────────────────────────────────────────────────────────────

CREATE TYPE "AsaasEnvironment" AS ENUM ('SANDBOX', 'PRODUCTION');

ALTER TABLE "billing_settings"
  ADD COLUMN "asaas_api_key_encrypted" TEXT,
  ADD COLUMN "asaas_api_key_last4" VARCHAR(4),
  ADD COLUMN "asaas_environment" "AsaasEnvironment",
  ADD COLUMN "asaas_webhook_id" VARCHAR(64),
  ADD COLUMN "asaas_webhook_token_hash" CHAR(64),
  ADD COLUMN "asaas_verified_at" TIMESTAMPTZ(6),
  ADD COLUMN "asaas_error" VARCHAR(300);

CREATE UNIQUE INDEX "billing_settings_asaas_webhook_token_hash_key"
  ON "billing_settings"("asaas_webhook_token_hash");

-- ─── As cobranças ────────────────────────────────────────────────────────────

CREATE TYPE "TutorChargeStatus" AS ENUM ('PENDING', 'PAID', 'EXPIRED', 'CANCELLED');
CREATE TYPE "TutorChargeOrigin" AS ENUM ('PORTAL', 'ADMIN');

CREATE TABLE "tutor_charges" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "tutor_id" UUID NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "origin" "TutorChargeOrigin" NOT NULL,
    "status" "TutorChargeStatus" NOT NULL DEFAULT 'PENDING',
    "checkout_id" VARCHAR(64) NOT NULL,
    "checkout_url" VARCHAR(500) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "asaas_payment_id" VARCHAR(64),
    "payment_id" UUID,
    "paid_at" TIMESTAMPTZ(6),
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tutor_charges_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tutor_charges_amount_positive" CHECK ("amount_cents" > 0),
    -- Paga tem pagamento; o resto não tem. É o que impede uma cobrança "paga" sem
    -- dinheiro no livro, ou um pagamento pendurado numa cobrança vencida.
    CONSTRAINT "tutor_charges_paid_has_payment"
      CHECK (("status" = 'PAID') = ("payment_id" IS NOT NULL))
);

CREATE UNIQUE INDEX "tutor_charges_checkout_id_key" ON "tutor_charges"("checkout_id");
CREATE UNIQUE INDEX "tutor_charges_asaas_payment_id_key" ON "tutor_charges"("asaas_payment_id");
CREATE UNIQUE INDEX "tutor_charges_payment_id_key" ON "tutor_charges"("payment_id");
CREATE INDEX "idx_tutor_charges_tutor" ON "tutor_charges"("tenant_id", "tutor_id", "created_at" DESC);
CREATE INDEX "idx_tutor_charges_pending" ON "tutor_charges"("expires_at") WHERE "status" = 'PENDING';

ALTER TABLE "tutor_charges" ADD CONSTRAINT "tutor_charges_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tutor_charges" ADD CONSTRAINT "tutor_charges_tutor_id_fkey"
  FOREIGN KEY ("tutor_id") REFERENCES "tutors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tutor_charges" ADD CONSTRAINT "tutor_charges_payment_id_fkey"
  FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "tutor_charges" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tutor_charges" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tutor_charges"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

-- O `GRANT ... ON ALL TABLES` da migration de RLS já rodou; tabela nova não é alcançada
-- por ele. O `app_maintenance` é quem acha o tenant pelo token do webhook e quem vence
-- as cobranças de todos.
GRANT SELECT, INSERT, UPDATE, DELETE ON "tutor_charges" TO app_user, app_maintenance;
