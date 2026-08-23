-- MOD-PET-03/05/08 — visibilidade do catálogo, log de transferência e registro de
-- óbito (PRD pets_03 §4 e §6).
--
-- Removido do diff gerado, como o `migrations/README.md` manda:
--   · `CREATE UNIQUE INDEX "tenants_slug_key"`, que desfaria o índice parcial de
--     `*_rls_policies`;
--   · os `DROP INDEX` de `idx_tutors_search`, `idx_tutors_name_trgm`,
--     `idx_tutors_tenant_phone`, `idx_tags_tenant_key` e
--     `idx_consents_tutor_channel` — todos escritos à mão em `*_mod_tutor`.

-- CreateEnum
CREATE TYPE "TransferReason" AS ENUM ('ADOPTION', 'SALE', 'TUTOR_DEATH', 'CORRECTION', 'OTHER');

-- AlterTable
-- AC-03 de MOD-PET-08: a janela de 30 dias conta do registro, não da data do óbito.
ALTER TABLE "pets" ADD COLUMN "deceased_recorded_at" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "breed_visibility" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "breed_id" UUID NOT NULL,
    "hidden_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "hidden_by" UUID,

    CONSTRAINT "breed_visibility_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pet_transfer_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "pet_id" UUID NOT NULL,
    "from_tutor_id" UUID,
    "to_tutor_id" UUID NOT NULL,
    "reason" "TransferReason" NOT NULL,
    "notes" TEXT,
    "effective_date" DATE,
    "performed_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pet_transfer_log_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "breed_visibility" ADD CONSTRAINT "breed_visibility_breed_id_fkey" FOREIGN KEY ("breed_id") REFERENCES "breeds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pet_transfer_log" ADD CONSTRAINT "pet_transfer_log_pet_id_fkey" FOREIGN KEY ("pet_id") REFERENCES "pets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- Parte escrita à mão
-- ═══════════════════════════════════════════════════════════════════════════

-- Esconder duas vezes a mesma raça é a mesma coisa que esconder uma: o índice
-- transforma a segunda tentativa em conflito em vez de em linha duplicada.
CREATE UNIQUE INDEX "idx_breed_visibility_unique" ON "breed_visibility" ("tenant_id", "breed_id");

-- A leitura sempre pergunta "o que este tenant escondeu", nunca "quem escondeu esta raça".
CREATE INDEX "idx_breed_visibility_tenant" ON "breed_visibility" ("tenant_id");

CREATE INDEX "idx_pet_transfer_pet" ON "pet_transfer_log" ("pet_id", "created_at" DESC);

-- RN-07: o Portal do tutor anterior precisa saber o que ele já teve, para manter os
-- recibos dele visíveis sem devolver o pet.
CREATE INDEX "idx_pet_transfer_from_tutor" ON "pet_transfer_log" ("tenant_id", "from_tutor_id");

-- ═══════════════════════════════════════════════════════════════════════════
-- Row Level Security
-- ═══════════════════════════════════════════════════════════════════════════
-- `breed_visibility` é do tenant mesmo quando a raça é global: o isolamento é
-- simples, não a política mista do catálogo. É por isso que a preferência é uma
-- tabela à parte, e não uma coluna em `breeds`.

ALTER TABLE "breed_visibility" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "breed_visibility" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "breed_visibility"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "pet_transfer_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pet_transfer_log" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pet_transfer_log"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

-- O log de transferência é prova, como `audit_logs` e `tutor_consents`: entra e não
-- sai. Mesma construção — REVOKE tira a permissão da role da aplicação, o trigger
-- barra qualquer um. Sem isso, um UPDATE reescreveria de quem o animal era.

REVOKE UPDATE, DELETE ON "pet_transfer_log" FROM app_user, app_maintenance;

CREATE OR REPLACE FUNCTION pet_transfer_log_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pet_transfer_log é append-only: % não é permitido', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER pet_transfer_log_append_only
  BEFORE UPDATE OR DELETE ON "pet_transfer_log"
  FOR EACH ROW EXECUTE FUNCTION pet_transfer_log_append_only();

-- ─── Catálogo: fechar o DELETE do global (AC-02 de MOD-PET-03) ───────────────
-- A política `tenant_catalog` do `*_mod_pet` protege o UPDATE pelo WITH CHECK: uma
-- linha global reescrita continuaria com `tenant_id` nulo e seria recusada. O DELETE
-- não passa por WITH CHECK — só pelo USING, que libera o global de propósito para a
-- leitura. Sem esta política, um `DELETE FROM breeds WHERE id = <global>` passaria.
--
-- RESTRICTIVE, e não mais uma permissiva: permissivas se somam com OR e não
-- restringiriam nada.

CREATE POLICY tenant_catalog_delete ON "species" AS RESTRICTIVE FOR DELETE
  USING ("tenant_id" = current_tenant_id());
CREATE POLICY tenant_catalog_delete ON "breeds" AS RESTRICTIVE FOR DELETE
  USING ("tenant_id" = current_tenant_id());
CREATE POLICY tenant_catalog_delete ON "sizes" AS RESTRICTIVE FOR DELETE
  USING ("tenant_id" = current_tenant_id());
CREATE POLICY tenant_catalog_delete ON "coats" AS RESTRICTIVE FOR DELETE
  USING ("tenant_id" = current_tenant_id());
