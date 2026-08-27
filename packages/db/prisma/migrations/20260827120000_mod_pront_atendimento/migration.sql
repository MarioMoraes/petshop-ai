-- MOD-PRONT-01/09/10 — o atendimento.
--
-- Cria `attendances`, `attendance_items` e `attendance_notes`, mais a fase da foto
-- em `pet_photos` e o `WALK_IN` do encaixe em `AppointmentSource`.
--
-- Escrito à mão a partir do diff: o índice único **parcial** de `appointment_id`
-- (RN-13), o append-only de `attendance_notes`, o trigger de imutabilidade da RN-05
-- e as políticas RLS. Ver `prisma/migrations/README.md`.
--
-- Removido do diff gerado, como o README manda: 29 `DROP INDEX` de índices parciais
-- e de expressão que o Prisma não enxerga, o `ALTER COLUMN signed_amount_cents DROP
-- DEFAULT` (a coluna é GENERATED) e o `CREATE UNIQUE INDEX "tenants_slug_key"`.

-- CreateEnum
CREATE TYPE "AttendanceType" AS ENUM ('GROOMING', 'BATH', 'VET_CONSULT', 'VACCINE', 'PROCEDURE', 'DAYCARE', 'OTHER');

-- CreateEnum
CREATE TYPE "AttendanceOrigin" AS ENUM ('SCHEDULED', 'WALK_IN', 'RETROACTIVE');

-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('DRAFT', 'COMPLETED', 'VOIDED');

-- CreateEnum
CREATE TYPE "AttendanceNoteVisibility" AS ENUM ('INTERNAL', 'TUTOR_VISIBLE');

-- CreateEnum
CREATE TYPE "AttendanceNoteKind" AS ENUM ('ADDENDUM', 'OPERATIONAL');

-- CreateEnum
CREATE TYPE "AttendancePhase" AS ENUM ('BEFORE', 'AFTER');

-- AlterEnum
ALTER TYPE "AppointmentSource" ADD VALUE 'WALK_IN';

-- AlterTable
ALTER TABLE "pet_photos" ADD COLUMN     "attendance_phase" "AttendancePhase";

-- CreateTable
CREATE TABLE "attendances" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "pet_id" UUID NOT NULL,
    "tutor_id" UUID NOT NULL,
    "appointment_id" UUID,
    "type" "AttendanceType" NOT NULL,
    "origin" "AttendanceOrigin" NOT NULL DEFAULT 'SCHEDULED',
    "performed_by" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "finished_at" TIMESTAMPTZ(6),
    "observations_encrypted" TEXT,
    "weight_kg" DECIMAL(5,2),
    "status" "AttendanceStatus" NOT NULL DEFAULT 'DRAFT',
    "void_reason" TEXT,
    "voided_by" UUID,
    "voided_at" TIMESTAMPTZ(6),
    "editable_until" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "total_cents" BIGINT NOT NULL DEFAULT 0,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "attendance_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "label" VARCHAR(120) NOT NULL,
    "executed_by" UUID NOT NULL,
    "unit_price_cents" BIGINT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "total_price_cents" BIGINT NOT NULL,
    "notes" TEXT,
    "products_used" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_notes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "attendance_id" UUID NOT NULL,
    "kind" "AttendanceNoteKind" NOT NULL,
    "visibility" "AttendanceNoteVisibility" NOT NULL DEFAULT 'INTERNAL',
    "body_encrypted" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "author_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "attendances_tenant_id_pet_id_started_at_idx" ON "attendances"("tenant_id", "pet_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "attendances_tenant_id_performed_by_started_at_idx" ON "attendances"("tenant_id", "performed_by", "started_at" DESC);

-- CreateIndex
CREATE INDEX "attendance_items_tenant_id_attendance_id_idx" ON "attendance_items"("tenant_id", "attendance_id");

-- CreateIndex
CREATE INDEX "attendance_notes_tenant_id_attendance_id_created_at_idx" ON "attendance_notes"("tenant_id", "attendance_id", "created_at");

-- AddForeignKey
ALTER TABLE "attendances" ADD CONSTRAINT "attendances_pet_id_fkey" FOREIGN KEY ("pet_id") REFERENCES "pets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendances" ADD CONSTRAINT "attendances_tutor_id_fkey" FOREIGN KEY ("tutor_id") REFERENCES "tutors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendances" ADD CONSTRAINT "attendances_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_items" ADD CONSTRAINT "attendance_items_attendance_id_fkey" FOREIGN KEY ("attendance_id") REFERENCES "attendances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_notes" ADD CONSTRAINT "attendance_notes_attendance_id_fkey" FOREIGN KEY ("attendance_id") REFERENCES "attendances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- Parte escrita à mão
-- ═══════════════════════════════════════════════════════════════════════════

-- RN-13: um agendamento tem no máximo um atendimento vivo. É o índice que resolve a
-- corrida entre duas entregas do mesmo `atendimento.concluido` — o consumidor tenta
-- inserir e o banco recusa a segunda. O anulado sai do índice porque o registro
-- lançado no pet errado precisa poder ser refeito no lugar certo (AC-03 do §09).
CREATE UNIQUE INDEX "idx_attendances_appointment" ON "attendances" ("appointment_id")
  WHERE "appointment_id" IS NOT NULL AND "status" <> 'VOIDED';

-- "O que foi atendido no período" — relatório e métrica de negócio do §10.
CREATE INDEX "idx_attendances_tenant_date" ON "attendances" ("tenant_id", "started_at" DESC)
  WHERE "status" = 'COMPLETED';

-- MOD-PRONT-10: as fotos de antes e depois de um atendimento, lidas juntas.
CREATE INDEX "idx_pet_photos_attendance" ON "pet_photos" ("attendance_id")
  WHERE "attendance_id" IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- Imutabilidade (MOD-PRONT-09, RN-05)
-- ═══════════════════════════════════════════════════════════════════════════
-- A aplicação confere `editable_until` para devolver um 409 explicável; isto aqui é
-- para quem chega por fora dela. Fora da janela, a única escrita que passa é o
-- contador de adendo — o adendo é justamente o mecanismo de correção depois das 24h,
-- e um trigger que o barrasse tornaria o registro incorrigível em vez de imutável.
--
-- A anulação continua permitida: ela muda `status`, e a regra só vale enquanto o
-- status não muda. Anular não é editar — é registrar que o registro estava errado.

CREATE OR REPLACE FUNCTION prevent_attendance_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- O rascunho descartado pode sumir: ele nunca foi um fato. O resto, nunca.
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'ERR_PRONT_006: atendimento não é excluído — use anulação'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."status" = 'COMPLETED'
     AND OLD."editable_until" IS NOT NULL
     AND now() > OLD."editable_until"
     AND NEW."status" IS NOT DISTINCT FROM OLD."status"
     AND (to_jsonb(NEW) - 'version' - 'updated_at')
         IS DISTINCT FROM (to_jsonb(OLD) - 'version' - 'updated_at')
  THEN
    RAISE EXCEPTION 'ERR_PRONT_006: atendimento imutável após 24h — use adendo'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER prevent_attendance_mutation
  BEFORE UPDATE OR DELETE ON "attendances"
  FOR EACH ROW EXECUTE FUNCTION prevent_attendance_mutation();

-- ═══════════════════════════════════════════════════════════════════════════
-- Adendos append-only
-- ═══════════════════════════════════════════════════════════════════════════
-- Mesma construção de `audit_logs` e `tutor_consents`: o REVOKE tira a permissão da
-- role da aplicação, o trigger barra qualquer um. Um adendo editável não corrige
-- nada — só move o problema um nível acima.

REVOKE UPDATE, DELETE ON "attendance_notes" FROM app_user, app_maintenance;

CREATE OR REPLACE FUNCTION attendance_notes_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'attendance_notes é append-only: % não é permitido', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER attendance_notes_append_only
  BEFORE UPDATE OR DELETE ON "attendance_notes"
  FOR EACH ROW EXECUTE FUNCTION attendance_notes_append_only();

-- ═══════════════════════════════════════════════════════════════════════════
-- Row Level Security
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "attendances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendances" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "attendances"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "attendance_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendance_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "attendance_items"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "attendance_notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendance_notes" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "attendance_notes"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());
