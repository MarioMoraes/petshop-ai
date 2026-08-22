-- MOD-TUTOR — Cadastro e gestão de tutores (PRD tutores_02 §4).
--
-- A primeira metade é o DDL gerado por `prisma migrate diff`. A segunda é escrita
-- à mão: extensões, índices parciais e de expressão, o trigger do `search_vector`,
-- as políticas RLS e o append-only de `tutor_consents`. Nada disso é expressável em
-- `schema.prisma` — ver `prisma/migrations/README.md`.
--
-- Removido do diff gerado: `CREATE UNIQUE INDEX "tenants_slug_key"`, que desfaria o
-- índice único **parcial** criado em `*_rls_policies` (o slug volta a ficar livre
-- depois do soft delete). É exatamente a pegadinha descrita no README.


-- CreateEnum
CREATE TYPE "PersonType" AS ENUM ('PF', 'PJ');

-- CreateEnum
CREATE TYPE "TutorStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'MERGED', 'ANONYMIZED');

-- CreateEnum
CREATE TYPE "DataCompleteness" AS ENUM ('COMPLETE', 'PARTIAL');

-- CreateEnum
CREATE TYPE "ConsentChannel" AS ENUM ('WHATSAPP', 'EMAIL', 'SMS', 'TERMS', 'IMAGE_USE');

-- CreateEnum
CREATE TYPE "ConsentPurpose" AS ENUM ('TRANSACTIONAL', 'MARKETING', 'BOTH');

-- CreateEnum
CREATE TYPE "ConsentSource" AS ENUM ('STAFF_FORM', 'PORTAL', 'SITE', 'WHATSAPP', 'IMPORT');

-- CreateTable
CREATE TABLE "tutors" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "person_type" "PersonType" NOT NULL DEFAULT 'PF',
    "full_name" VARCHAR(160) NOT NULL,
    "legal_name" VARCHAR(160),
    "social_name" VARCHAR(120),
    "cpf_encrypted" TEXT,
    "cpf_hash" TEXT,
    "cnpj_encrypted" TEXT,
    "cnpj_hash" TEXT,
    "phone_encrypted" TEXT NOT NULL,
    "phone_hash" TEXT NOT NULL,
    "phone_alt_encrypted" TEXT,
    "phone_alt_hash" TEXT,
    "email_encrypted" TEXT,
    "email_hash" TEXT,
    "birth_date" DATE,
    "notes" TEXT,
    "status" "TutorStatus" NOT NULL DEFAULT 'ACTIVE',
    "data_completeness" "DataCompleteness" NOT NULL DEFAULT 'PARTIAL',
    "portal_user_id" UUID,
    "merged_into_id" UUID,
    "search_vector" tsvector,
    "last_attendance_at" TIMESTAMPTZ(6),
    "balance_cents" INTEGER NOT NULL DEFAULT 0,
    "pets_count" INTEGER NOT NULL DEFAULT 0,
    "anonymized_at" TIMESTAMPTZ(6),
    "created_by" UUID,
    "updated_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "tutors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tutor_addresses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "tutor_id" UUID NOT NULL,
    "label" VARCHAR(40) NOT NULL DEFAULT 'Casa',
    "zip_code" VARCHAR(8) NOT NULL,
    "street_encrypted" TEXT NOT NULL,
    "number_encrypted" TEXT NOT NULL,
    "complement_encrypted" TEXT,
    "district" VARCHAR(80) NOT NULL,
    "city" VARCHAR(80) NOT NULL,
    "state" VARCHAR(2) NOT NULL,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "access_notes" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tutor_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tutor_tags" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "key" VARCHAR(40) NOT NULL,
    "label" VARCHAR(60) NOT NULL,
    "color" VARCHAR(9) NOT NULL DEFAULT '#E34A32',
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tutor_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tutor_tag_assignments" (
    "tenant_id" UUID NOT NULL,
    "tutor_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,
    "assigned_by" UUID,
    "assigned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tutor_tag_assignments_pkey" PRIMARY KEY ("tutor_id","tag_id")
);

-- CreateTable
CREATE TABLE "tutor_consents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "tutor_id" UUID NOT NULL,
    "channel" "ConsentChannel" NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "purpose" "ConsentPurpose" NOT NULL DEFAULT 'MARKETING',
    "version" VARCHAR(20) NOT NULL,
    "source" "ConsentSource" NOT NULL DEFAULT 'STAFF_FORM',
    "ip_address" INET,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tutor_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tutor_merge_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "target_id" UUID NOT NULL,
    "snapshot" JSONB NOT NULL,
    "moved_entities" JSONB NOT NULL,
    "performed_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tutor_merge_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tutor_addresses_tutor_id_idx" ON "tutor_addresses"("tutor_id");

-- CreateIndex
CREATE INDEX "tutor_tag_assignments_tag_id_idx" ON "tutor_tag_assignments"("tag_id");

-- CreateIndex
CREATE INDEX "tutor_merge_log_tenant_id_created_at_idx" ON "tutor_merge_log"("tenant_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "tutors" ADD CONSTRAINT "tutors_merged_into_id_fkey" FOREIGN KEY ("merged_into_id") REFERENCES "tutors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tutor_addresses" ADD CONSTRAINT "tutor_addresses_tutor_id_fkey" FOREIGN KEY ("tutor_id") REFERENCES "tutors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tutor_tag_assignments" ADD CONSTRAINT "tutor_tag_assignments_tutor_id_fkey" FOREIGN KEY ("tutor_id") REFERENCES "tutors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tutor_tag_assignments" ADD CONSTRAINT "tutor_tag_assignments_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tutor_tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tutor_consents" ADD CONSTRAINT "tutor_consents_tutor_id_fkey" FOREIGN KEY ("tutor_id") REFERENCES "tutors"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ═══════════════════════════════════════════════════════════════════════════
-- Parte escrita à mão
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Extensões
-- `pg_trgm` sustenta o alerta de duplicata provável por similaridade de nome
-- (AC-02 de MOD-TUTOR-02) e o `ILIKE` indexado da busca de balcão.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Índices (PRD tutores_02 §4)
-- ═══════════════════════════════════════════════════════════════════════════
-- Os únicos são **parciais**: RN-01 diz que CPF é único por tenant, mas um
-- cadastro soft-deleted ou mesclado não pode continuar bloqueando o CPF — senão o
-- merge de duplicatas se tornaria impossível, e é ele quem limpa a base.

CREATE INDEX "idx_tutors_tenant" ON "tutors" ("tenant_id") WHERE "deleted_at" IS NULL;

CREATE UNIQUE INDEX "idx_tutors_tenant_cpf" ON "tutors" ("tenant_id", "cpf_hash")
  WHERE "cpf_hash" IS NOT NULL AND "deleted_at" IS NULL AND "status" <> 'MERGED';

CREATE UNIQUE INDEX "idx_tutors_tenant_cnpj" ON "tutors" ("tenant_id", "cnpj_hash")
  WHERE "cnpj_hash" IS NOT NULL AND "deleted_at" IS NULL AND "status" <> 'MERGED';

-- RN-02: telefone **não** é único. Famílias compartilham número; o índice existe
-- para a busca e para o alerta de duplicata, nunca para bloquear o cadastro.
CREATE INDEX "idx_tutors_tenant_phone" ON "tutors" ("tenant_id", "phone_hash");
CREATE INDEX "idx_tutors_tenant_phone_alt" ON "tutors" ("tenant_id", "phone_alt_hash")
  WHERE "phone_alt_hash" IS NOT NULL;
CREATE INDEX "idx_tutors_tenant_email" ON "tutors" ("tenant_id", "email_hash")
  WHERE "email_hash" IS NOT NULL;

CREATE INDEX "idx_tutors_search" ON "tutors" USING GIN ("search_vector");
CREATE INDEX "idx_tutors_name_trgm" ON "tutors" USING GIN ("full_name" gin_trgm_ops);

-- Campanha de aniversário (MOD-TUTOR-10): a consulta é "quem faz aniversário hoje",
-- então o índice é por mês e dia — o ano não entra.
CREATE INDEX "idx_tutors_birthday" ON "tutors"
  ("tenant_id", (EXTRACT(MONTH FROM "birth_date")), (EXTRACT(DAY FROM "birth_date")))
  WHERE "birth_date" IS NOT NULL AND "deleted_at" IS NULL;

CREATE INDEX "idx_tutors_inactive" ON "tutors" ("tenant_id", "last_attendance_at")
  WHERE "status" = 'ACTIVE';

-- RN-15: exatamente um endereço principal por tutor. O índice é a garantia; o
-- serviço rebaixa o anterior na mesma transação.
CREATE UNIQUE INDEX "idx_tutor_address_primary" ON "tutor_addresses" ("tutor_id")
  WHERE "is_primary";

CREATE INDEX "idx_consents_tutor_channel"
  ON "tutor_consents" ("tutor_id", "channel", "created_at" DESC);

CREATE UNIQUE INDEX "idx_tags_tenant_key" ON "tutor_tags" ("tenant_id", "key");

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Busca full-text (MOD-TUTOR-06)
-- ═══════════════════════════════════════════════════════════════════════════
-- O vetor é mantido por trigger, e não pela aplicação: assim ele continua correto
-- para linhas escritas por migration, por job de importação ou à mão no psql.
-- Pesos: nome e nome social em 'A', razão social em 'B' — quem busca "mari" no
-- balcão quer a Maria antes da "Marina Comércio de Rações Ltda".

CREATE OR REPLACE FUNCTION tutors_search_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW."search_vector" :=
    setweight(to_tsvector('portuguese', unaccent(coalesce(NEW."full_name", ''))), 'A') ||
    setweight(to_tsvector('portuguese', unaccent(coalesce(NEW."social_name", ''))), 'A') ||
    setweight(to_tsvector('portuguese', unaccent(coalesce(NEW."legal_name", ''))), 'B');
  RETURN NEW;
END;
$$;

CREATE TRIGGER tutors_search_vector_update
  BEFORE INSERT OR UPDATE OF "full_name", "social_name", "legal_name" ON "tutors"
  FOR EACH ROW EXECUTE FUNCTION tutors_search_trigger();

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Row Level Security
-- ═══════════════════════════════════════════════════════════════════════════
-- Toda tabela de negócio nova entra aqui e em `RLS_MODELS`, em src/client.ts.

ALTER TABLE "tutors" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tutors" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tutors"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "tutor_addresses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tutor_addresses" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tutor_addresses"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "tutor_tags" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tutor_tags" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tutor_tags"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "tutor_tag_assignments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tutor_tag_assignments" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tutor_tag_assignments"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "tutor_consents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tutor_consents" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tutor_consents"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "tutor_merge_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tutor_merge_log" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tutor_merge_log"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. Consentimento append-only (RN-05)
-- ═══════════════════════════════════════════════════════════════════════════
-- Mesma construção de `audit_logs`: REVOKE tira a permissão da role da aplicação,
-- o trigger barra qualquer um. Uma revogação que sobrescrevesse o opt-in anterior
-- destruiria a prova que defende o tenant perante a ANPD.

REVOKE UPDATE, DELETE ON "tutor_consents" FROM app_user, app_maintenance;
REVOKE UPDATE, DELETE ON "tutor_merge_log" FROM app_user, app_maintenance;

CREATE OR REPLACE FUNCTION tutor_consents_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'tutor_consents é append-only: % não é permitido', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER tutor_consents_append_only
  BEFORE UPDATE OR DELETE ON "tutor_consents"
  FOR EACH ROW EXECUTE FUNCTION tutor_consents_append_only();

CREATE TRIGGER tutor_merge_log_append_only
  BEFORE UPDATE OR DELETE ON "tutor_merge_log"
  FOR EACH ROW EXECUTE FUNCTION tutor_consents_append_only();
