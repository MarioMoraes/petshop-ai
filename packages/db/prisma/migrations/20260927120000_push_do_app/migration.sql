-- Notificações push do app do tutor (etapa 9 do app Flutter).
--
-- Escrita à mão, como toda migration desde o MOD-TUTOR (ver README.md).
--
-- O push não é um canal novo do motor: ele vai **junto** com a mensagem de WhatsApp ou
-- e-mail que já passou por consentimento, janela, supressão e deduplicação. Por isso o
-- texto mora na própria linha de `messages`, e a entrega é uma tabela pendurada nela.

-- ─── O texto, na mensagem ────────────────────────────────────────────────────
--
-- Renderizado na entrada da fila (RN-14) e apagado quando o despacho o entrega. Nulo em
-- todo template sem texto de push, que é a maioria.
ALTER TABLE "messages" ADD COLUMN "push_title_encrypted" TEXT;
ALTER TABLE "messages" ADD COLUMN "push_body_encrypted" TEXT;

-- ─── Os aparelhos ────────────────────────────────────────────────────────────

CREATE TYPE "PushPlatform" AS ENUM ('ANDROID', 'IOS');

CREATE TABLE "push_devices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "tutor_id" UUID NOT NULL,
    "token_encrypted" TEXT NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "platform" "PushPlatform" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "push_devices_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "push_devices"
  ADD CONSTRAINT "push_devices_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "push_devices"
  ADD CONSTRAINT "push_devices_tutor_id_fkey"
  FOREIGN KEY ("tutor_id") REFERENCES "tutors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Um aparelho, um dono — **em todos os tenants**. O token é do app instalado, e o
-- celular que passa a outra conta muda a linha de dono em vez de duplicá-la. Global de
-- propósito: por tenant, o mesmo aparelho logado em dois petshops receberia os avisos
-- dos dois depois de sair de um.
CREATE UNIQUE INDEX "idx_push_devices_token" ON "push_devices" ("token_hash");

CREATE INDEX "idx_push_devices_tutor" ON "push_devices" ("tenant_id", "tutor_id");

ALTER TABLE "push_devices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "push_devices" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "push_devices"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

-- ─── As entregas ─────────────────────────────────────────────────────────────

CREATE TYPE "PushDeliveryStatus" AS ENUM ('SENT', 'FAILED', 'INVALID_TOKEN');

CREATE TABLE "push_deliveries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "status" "PushDeliveryStatus" NOT NULL,
    "provider_message_id" VARCHAR(200),
    "error_code" VARCHAR(60),
    "sent_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_deliveries_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "push_deliveries"
  ADD CONSTRAINT "push_deliveries_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "push_deliveries"
  ADD CONSTRAINT "push_deliveries_message_id_fkey"
  FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "push_deliveries"
  ADD CONSTRAINT "push_deliveries_device_id_fkey"
  FOREIGN KEY ("device_id") REFERENCES "push_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A retentativa do despacho não repete o aviso: um par (mensagem, aparelho) só existe
-- uma vez, e a segunda tentativa de gravar é a prova de que ele já saiu.
CREATE UNIQUE INDEX "idx_push_deliveries_unico" ON "push_deliveries" ("message_id", "device_id");

ALTER TABLE "push_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "push_deliveries" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "push_deliveries"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON
  "push_devices",
  "push_deliveries"
  TO app_user, app_maintenance;
