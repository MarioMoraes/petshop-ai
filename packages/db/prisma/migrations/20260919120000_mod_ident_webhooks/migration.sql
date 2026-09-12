-- MOD-IDENT-03 — a idempotência do webhook do Clerk.
--
-- Escrita à mão, e não pelo `migrate dev`: o diff completo vinha com dezesseis
-- `DROP INDEX` dos índices parciais e de expressão que só existem em SQL, mais a
-- recriação de `tenants_slug_key` por cima de `idx_tenants_slug`. O procedimento está
-- em `../README.md`.
--
-- `webhook_events` **não** entra no RLS: não tem `tenant_id`, como `users` e
-- `platform_admins`. Um evento `user.updated` não fala de estabelecimento nenhum, e o
-- `organizationMembership.deleted` só diz de qual depois de resolvido o `clerk_org_id`.

CREATE TYPE "WebhookEventStatus" AS ENUM ('PROCESSED', 'IGNORED', 'FAILED');

CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider" VARCHAR(20) NOT NULL,
    "external_event_id" VARCHAR(80) NOT NULL,
    "event_type" VARCHAR(60) NOT NULL,
    "status" "WebhookEventStatus" NOT NULL DEFAULT 'PROCESSED',
    "error" VARCHAR(300),
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- A garantia da RN-09. Duas entregas do mesmo `svix-id` chegam juntas, então quem
-- desempata é a constraint e não uma leitura seguida de escrita.
CREATE UNIQUE INDEX "webhook_events_provider_external_event_id_key"
    ON "webhook_events"("provider", "external_event_id");

-- A varredura da regra `clerk_webhook_failing` no painel da plataforma: provedor,
-- status e a data em ordem decrescente.
CREATE INDEX "webhook_events_provider_status_received_at_idx"
    ON "webhook_events"("provider", "status", "received_at" DESC);

-- Tabela nova não é coberta pelo `GRANT ... ON ALL TABLES` da migration de RLS, que
-- rodou antes dela existir.
GRANT SELECT, INSERT, UPDATE, DELETE ON "webhook_events" TO app_user, app_maintenance;
