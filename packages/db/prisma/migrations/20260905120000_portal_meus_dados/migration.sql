-- MOD-PORTAL-09 — Meus Dados: a troca de contato com prova de posse e o pedido de
-- exclusão do titular.
--
-- Escrita à mão, como as anteriores. O `prisma migrate diff` volta a propor a poda de
-- índices parciais e de expressão que o `schema.prisma` não sabe declarar, o
-- `DROP DEFAULT` da coluna gerada do ledger e o `tenants_slug_key` total por cima do
-- parcial. Nada disso entrou — ver `prisma/migrations/README.md`.

-- ─── A troca de telefone ou e-mail ───────────────────────────────────────────
--
-- Tabela própria, e não um `purpose` em `portal_link_challenges`. Aquela existe para
-- responder igual a cliente e a desconhecido (RN-04) e grava linha até para
-- identificador que não casa com ficha nenhuma. Esta é o contrário: quem pede já está
-- autenticado, já é dono da ficha, e o que falta provar é a posse do contato **novo**.

CREATE TYPE "PortalContactField" AS ENUM ('PHONE', 'EMAIL');

CREATE TABLE "portal_contact_changes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "tutor_id" UUID NOT NULL,
    "field" "PortalContactField" NOT NULL,
    "channel" "PortalChannel" NOT NULL,
    "pending_value_encrypted" TEXT NOT NULL,
    "pending_value_hash" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "attempts" SMALLINT NOT NULL DEFAULT 0,
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "ip_address" INET,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portal_contact_changes_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "portal_contact_changes"
  ADD CONSTRAINT "portal_contact_changes_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "portal_contact_changes"
  ADD CONSTRAINT "portal_contact_changes_tutor_id_fkey"
  FOREIGN KEY ("tutor_id") REFERENCES "tutors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- O pedido em aberto deste tutor, e o teto de tentativas por janela.
CREATE INDEX "idx_portal_contact_changes_tutor"
  ON "portal_contact_changes" ("tenant_id", "tutor_id", "created_at" DESC);

-- Varredura do que expirou sem uso.
CREATE INDEX "idx_portal_contact_changes_expiry"
  ON "portal_contact_changes" ("expires_at")
  WHERE "consumed_at" IS NULL;

ALTER TABLE "portal_contact_changes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "portal_contact_changes" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "portal_contact_changes"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

-- ─── O pedido de exclusão do titular ─────────────────────────────────────────

CREATE TYPE "DataDeletionRequestStatus" AS ENUM ('OPEN', 'DONE', 'REJECTED');

CREATE TABLE "data_deletion_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "tutor_id" UUID NOT NULL,
    "status" "DataDeletionRequestStatus" NOT NULL DEFAULT 'OPEN',
    "reason" TEXT,
    "due_at" TIMESTAMPTZ(6) NOT NULL,
    "responded_at" TIMESTAMPTZ(6),
    "responded_by" UUID,
    "resolution" TEXT,
    "ip_address" INET,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "data_deletion_requests_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "data_deletion_requests"
  ADD CONSTRAINT "data_deletion_requests_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "data_deletion_requests"
  ADD CONSTRAINT "data_deletion_requests_tutor_id_fkey"
  FOREIGN KEY ("tutor_id") REFERENCES "tutors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A fila da equipe: o que está aberto, o mais vencido primeiro.
CREATE INDEX "idx_deletion_requests_tenant_status"
  ON "data_deletion_requests" ("tenant_id", "status", "due_at");

-- O que o Portal mostra ao titular: o pedido dele, o mais recente na frente.
CREATE INDEX "idx_deletion_requests_tutor"
  ON "data_deletion_requests" ("tutor_id", "created_at" DESC);

-- Um pedido em análise por ficha (AC-05).
--
-- Parcial e no banco, não na aplicação: o titular ansioso clica três vezes, e três
-- linhas abertas para a mesma decisão fariam a fila da equipe contar trabalho que não
-- existe. Um pedido já respondido não impede o próximo — a lei não dá direito de uma vez
-- só, e a ficha pode ter mudado de situação desde a recusa.
CREATE UNIQUE INDEX "idx_deletion_requests_open_unico"
  ON "data_deletion_requests" ("tenant_id", "tutor_id")
  WHERE "status" = 'OPEN';

ALTER TABLE "data_deletion_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "data_deletion_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "data_deletion_requests"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

-- ─── Permissões dos papéis da aplicação ──────────────────────────────────────
--
-- O `ALTER DEFAULT PRIVILEGES` da migration de RLS já cobriria as duas, mas ele vale
-- para tabela criada pelo mesmo papel que o executou — e uma migration aplicada por
-- outro dono deixaria as tabelas mudas sem erro nenhum aqui. Explícito custa duas linhas.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "portal_contact_changes",
  "data_deletion_requests"
  TO app_user, app_maintenance;
