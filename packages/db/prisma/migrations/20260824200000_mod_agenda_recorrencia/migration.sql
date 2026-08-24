-- MOD-AGENDA — fatia 3/4: recorrência e o vínculo da ocorrência com a série.
-- PRD agenda_operacao_06 §4, sub-feature 05.
--
-- SQL podado à mão, como as anteriores: o diff insiste em derrubar os índices
-- escritos à mão e recriar `tenants_slug_key`.

-- AlterTable
ALTER TABLE "appointments" ADD COLUMN     "recurrence_id" UUID;

-- CreateTable
CREATE TABLE "appointment_recurrences" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "pet_id" UUID NOT NULL,
    "professional_id" UUID NOT NULL,
    "rrule" VARCHAR(200) NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "until" TIMESTAMPTZ(6),
    "materialized_until" TIMESTAMPTZ(6),
    "service_ids" UUID[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appointment_recurrences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_recurrences_materialize" ON "appointment_recurrences"("tenant_id", "active", "materialized_until");

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_recurrence_id_fkey" FOREIGN KEY ("recurrence_id") REFERENCES "appointment_recurrences"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── Row Level Security ──────────────────────────────────────────────────────

ALTER TABLE "appointment_recurrences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "appointment_recurrences" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "appointment_recurrences"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON "appointment_recurrences"
  TO app_user, app_maintenance;

-- Só as três frequências que o AC-02 aceita. A restrição está no Zod, que devolve o
-- 422 amigável; aqui é garantia contra escrita fora do caminho feliz.
ALTER TABLE "appointment_recurrences"
  ADD CONSTRAINT "appointment_recurrences_freq_check"
  CHECK ("rrule" ~ 'FREQ=(DAILY|WEEKLY|MONTHLY)');

-- O job semanal procura séries ativas cujo horizonte materializado está vencendo.
CREATE INDEX "idx_appointments_recurrence" ON "appointments" ("recurrence_id", "starts_at")
  WHERE "recurrence_id" IS NOT NULL;
