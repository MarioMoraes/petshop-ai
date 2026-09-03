-- MOD-PORTAL — fatia 1: identidade do tutor e o desafio que a cria.
--
-- Escrita à mão. O `prisma migrate diff` produziu, junto do que se pediu aqui, 22
-- `DROP INDEX` de índices parciais e de expressão que o schema.prisma não sabe
-- declarar, um `DROP DEFAULT` na coluna gerada do ledger e a recriação do
-- `tenants_slug_key` total por cima do parcial. Nada disso entrou — é exatamente o que
-- `prisma/migrations/README.md` manda podar.

CREATE TYPE "PortalChannel" AS ENUM ('EMAIL', 'WHATSAPP');

-- ─── O desafio de vínculo ────────────────────────────────────────────────────

CREATE TABLE "portal_link_challenges" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "tutor_id" UUID,
    "identifier_hash" TEXT NOT NULL,
    "channel" "PortalChannel" NOT NULL,
    "code_hash" TEXT NOT NULL,
    "clerk_user_id" TEXT NOT NULL,
    "ambiguous" BOOLEAN NOT NULL DEFAULT false,
    "attempts" SMALLINT NOT NULL DEFAULT 0,
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "ip_address" INET,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portal_link_challenges_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "portal_link_challenges"
  ADD CONSTRAINT "portal_link_challenges_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "portal_link_challenges"
  ADD CONSTRAINT "portal_link_challenges_tutor_id_fkey"
  FOREIGN KEY ("tutor_id") REFERENCES "tutors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Rate limit e cooldown por identificador, na janela curta.
CREATE INDEX "idx_portal_challenges_tenant_identifier"
  ON "portal_link_challenges" ("tenant_id", "identifier_hash", "created_at" DESC);

-- Rate limit por IP. Parcial: linha sem IP não interessa à contagem.
CREATE INDEX "idx_portal_challenges_ip"
  ON "portal_link_challenges" ("ip_address", "created_at" DESC)
  WHERE "ip_address" IS NOT NULL;

-- Varredura do job de expiração.
CREATE INDEX "idx_portal_challenges_expiry"
  ON "portal_link_challenges" ("expires_at")
  WHERE "consumed_at" IS NULL;

ALTER TABLE "portal_link_challenges" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "portal_link_challenges" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "portal_link_challenges"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

-- ─── O vínculo na ficha do tutor ─────────────────────────────────────────────

ALTER TABLE "tutors"
  ADD COLUMN "portal_linked_at" TIMESTAMPTZ(6),
  ADD COLUMN "portal_last_seen_at" TIMESTAMPTZ(6);

-- RN-05 — um tutor, um login. Parcial porque a esmagadora maioria das fichas nunca
-- terá acesso ao Portal, e `NULL` não colide com `NULL` em índice único: sem o
-- `WHERE`, o índice seria só peso morto sobre milhares de nulos.
CREATE UNIQUE INDEX "idx_tutors_portal_user"
  ON "tutors" ("tenant_id", "portal_user_id")
  WHERE "portal_user_id" IS NOT NULL;

-- ─── A chave que liga o Portal, distinta da do agendamento online ────────────

ALTER TABLE "tenant_settings"
  ADD COLUMN "portal_enabled" BOOLEAN NOT NULL DEFAULT true;
