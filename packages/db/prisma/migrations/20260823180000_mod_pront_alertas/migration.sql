-- MOD-PRONT-03/04/05 — alergias, temperamento e alertas médicos
-- (PRD prontuario_04 §3 e §4).
--
-- Este é o recorte de **segurança** do prontuário: o que a equipe precisa saber
-- antes de encostar no pet. O registro de atendimento (MOD-PRONT-01) fica para
-- quando MOD-AGENDA existir — ele nasce do check-out, e criar a tabela agora seria
-- inventar a forma do atendimento antes da agenda decidi-la.
--
-- Removido do diff gerado, como o `migrations/README.md` manda: o
-- `CREATE UNIQUE INDEX "tenants_slug_key"` e os `DROP INDEX` dos índices parciais
-- escritos à mão nas migrations anteriores.

-- CreateEnum
CREATE TYPE "ClinicalSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AllergyType" AS ENUM ('FOOD', 'PRODUCT', 'MEDICATION', 'ENVIRONMENTAL', 'OTHER');

-- CreateEnum
CREATE TYPE "TemperamentClassification" AS ENUM ('DOCILE', 'ANXIOUS', 'FEARFUL', 'REACTIVE', 'AGGRESSIVE', 'UNKNOWN');

-- CreateTable
CREATE TABLE "allergies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "pet_id" UUID NOT NULL,
    "type" "AllergyType" NOT NULL,
    "label" VARCHAR(120) NOT NULL,
    "severity" "ClinicalSeverity" NOT NULL,
    "reaction_encrypted" TEXT,
    "blocks_services" UUID[],
    "blocks_products" TEXT[],
    "diagnosed_at" DATE,
    "diagnosed_by" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "resolution_notes" TEXT,
    "deactivated_by" UUID,
    "deactivated_at" TIMESTAMPTZ(6),
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "allergies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "temperaments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "pet_id" UUID NOT NULL,
    "classification" "TemperamentClassification" NOT NULL,
    "contexts" TEXT[],
    "requires_muzzle" BOOLEAN NOT NULL DEFAULT false,
    "requires_two_handlers" BOOLEAN NOT NULL DEFAULT false,
    "notes_encrypted" TEXT,
    "observed_by" UUID,
    "observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "temperaments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "medical_alerts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "pet_id" UUID NOT NULL,
    "condition" VARCHAR(120) NOT NULL,
    "severity" "ClinicalSeverity" NOT NULL,
    "instructions_encrypted" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "resolution_notes" TEXT,
    "deactivated_by" UUID,
    "deactivated_at" TIMESTAMPTZ(6),
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "medical_alerts_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "allergies" ADD CONSTRAINT "allergies_pet_id_fkey" FOREIGN KEY ("pet_id") REFERENCES "pets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "temperaments" ADD CONSTRAINT "temperaments_pet_id_fkey" FOREIGN KEY ("pet_id") REFERENCES "pets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medical_alerts" ADD CONSTRAINT "medical_alerts_pet_id_fkey" FOREIGN KEY ("pet_id") REFERENCES "pets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- Parte escrita à mão
-- ═══════════════════════════════════════════════════════════════════════════

-- A consulta quente é sempre "quais alertas ativos deste pet": ela roda em toda
-- leitura de pet (RN-09 de pets_03), no agendamento e no check-in.
CREATE INDEX "idx_allergies_pet_active" ON "allergies" ("pet_id")
  WHERE "active" = true;
CREATE INDEX "idx_medical_alerts_pet_active" ON "medical_alerts" ("pet_id")
  WHERE "active" = true;

-- RN-15: exatamente um temperamento vigente por pet. O índice parcial é a garantia;
-- a transação do serviço rebaixa o anterior antes de inserir o novo.
CREATE UNIQUE INDEX "idx_temperament_current" ON "temperaments" ("pet_id")
  WHERE "is_current" = true;

-- RN-16: o histórico de risco é lido inteiro na ficha, do mais recente ao mais antigo.
CREATE INDEX "idx_temperaments_pet" ON "temperaments" ("pet_id", "observed_at" DESC);

-- RN-03: "este serviço esbarra em alguma alergia deste pet?" é pergunta do
-- agendamento, feita por serviço. GIN sobre o array responde sem varrer a tabela.
CREATE INDEX "idx_allergies_blocks_services" ON "allergies" USING GIN ("blocks_services");

-- Histórico completo por pet, incluindo o que foi desativado (AC-04).
CREATE INDEX "idx_allergies_pet" ON "allergies" ("pet_id", "created_at" DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- Row Level Security
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "allergies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "allergies" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "allergies"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "temperaments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "temperaments" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "temperaments"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "medical_alerts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "medical_alerts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "medical_alerts"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());
