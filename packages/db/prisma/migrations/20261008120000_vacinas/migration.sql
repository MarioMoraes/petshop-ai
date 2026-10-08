-- MOD-PRONT-08 — a carteira de vacinação.
--
-- Escrita à mão, como manda `prisma/migrations/README.md`: o diff do Prisma traria de
-- volta os `DROP INDEX` dos parciais e não sabe escrever os CHECKs nem a RLS.

CREATE TYPE "VaccinationOrigin" AS ENUM ('INTERNAL', 'EXTERNAL');

CREATE TABLE "vaccinations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "pet_id" UUID NOT NULL,
    "attendance_id" UUID,
    "origin" "VaccinationOrigin" NOT NULL,
    "vaccine_key" VARCHAR(40) NOT NULL,
    "vaccine_label" VARCHAR(60) NOT NULL,
    "applied_at" DATE NOT NULL,
    "next_dose_at" DATE,
    "manufacturer" VARCHAR(80),
    "batch" VARCHAR(40),
    "batch_expires_at" DATE,
    "applied_by" UUID,
    "vet_name" VARCHAR(120),
    "crmv" VARCHAR(30),
    "external_clinic" VARCHAR(120),
    "void_reason" TEXT,
    "voided_by" UUID,
    "voided_at" TIMESTAMPTZ(6),
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vaccinations_pkey" PRIMARY KEY ("id"),

    -- A dose aplicada aqui é rastreável ou não é registro (RN-11): lote, fabricante,
    -- validade e quem aplicou, com CRMV. A aplicação valida antes; o CHECK é o fecho
    -- para o caminho que não passar por ela.
    CONSTRAINT "vaccinations_internal_traceable" CHECK (
      "origin" <> 'INTERNAL' OR (
        "batch" IS NOT NULL AND "manufacturer" IS NOT NULL AND "batch_expires_at" IS NOT NULL
        AND "applied_by" IS NOT NULL AND "crmv" IS NOT NULL
      )
    ),
    CONSTRAINT "vaccinations_next_dose_after_applied" CHECK (
      "next_dose_at" IS NULL OR "next_dose_at" > "applied_at"
    ),
    -- Anular sem motivo é apagar disfarçado.
    CONSTRAINT "vaccinations_void_has_reason" CHECK (
      "voided_at" IS NULL OR "void_reason" IS NOT NULL
    )
);

ALTER TABLE "vaccinations"
  ADD CONSTRAINT "vaccinations_pet_id_fkey"
  FOREIGN KEY ("pet_id") REFERENCES "pets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "vaccinations"
  ADD CONSTRAINT "vaccinations_attendance_id_fkey"
  FOREIGN KEY ("attendance_id") REFERENCES "attendances"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A carteira do pet, da dose mais recente para a mais antiga.
CREATE INDEX "vaccinations_tenant_id_pet_id_applied_at_idx"
  ON "vaccinations" ("tenant_id", "pet_id", "applied_at" DESC);

-- A varredura do lembrete (`crm/vaccines.ts`): só a dose viva com retorno marcado.
CREATE INDEX "idx_vaccinations_next_dose"
  ON "vaccinations" ("tenant_id", "next_dose_at")
  WHERE "next_dose_at" IS NOT NULL AND "voided_at" IS NULL;

ALTER TABLE "vaccinations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vaccinations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "vaccinations"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

-- O `GRANT ... ON ALL TABLES` da migration de RLS já rodou; tabela nova não é alcançada
-- por ele. O `app_maintenance` é quem varre os tenants no job do lembrete.
GRANT SELECT, INSERT, UPDATE, DELETE ON "vaccinations" TO app_user, app_maintenance;
