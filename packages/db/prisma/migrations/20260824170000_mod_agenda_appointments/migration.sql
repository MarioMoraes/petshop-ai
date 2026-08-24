-- MOD-AGENDA — fatia 2: agendamentos
-- PRD agenda_operacao_06 §4 e §6.
--
-- SQL gerado por `prisma migrate diff` e podado à mão (README desta pasta): o diff
-- queria derrubar 15 índices escritos à mão e recriar `tenants_slug_key`.

-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('PENDING', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'RESCHEDULED');

-- CreateEnum
CREATE TYPE "AppointmentSource" AS ENUM ('STAFF', 'PORTAL', 'RECURRENCE', 'AI_AGENT');

-- CreateTable
CREATE TABLE "appointments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "pet_id" UUID NOT NULL,
    "tutor_id" UUID NOT NULL,
    "professional_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "status" "AppointmentStatus" NOT NULL DEFAULT 'CONFIRMED',
    "source" "AppointmentSource" NOT NULL DEFAULT 'STAFF',
    "total_cents" BIGINT NOT NULL,
    "checkin_at" TIMESTAMPTZ(6),
    "checkout_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "cancel_reason_encrypted" TEXT,
    "cancelled_late" BOOLEAN,
    "rescheduled_to_id" UUID,
    "acknowledged_alerts_by" UUID,
    "acknowledged_alerts_at" TIMESTAMPTZ(6),
    "credit_override_by" UUID,
    "credit_override_reason" TEXT,
    "notes_encrypted" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointment_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "label" VARCHAR(80) NOT NULL,
    "price_cents" BIGINT NOT NULL,
    "duration_min" SMALLINT NOT NULL,
    "added_at_checkout" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appointment_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointment_status_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "from_status" "AppointmentStatus",
    "to_status" "AppointmentStatus" NOT NULL,
    "changed_by" UUID,
    "reason" VARCHAR(200),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appointment_status_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "appointments_rescheduled_to_id_key" ON "appointments"("rescheduled_to_id");

-- CreateIndex
CREATE INDEX "idx_appointments_pet" ON "appointments"("pet_id", "starts_at" DESC);

-- CreateIndex
CREATE INDEX "idx_appointments_tutor" ON "appointments"("tenant_id", "tutor_id", "starts_at" DESC);

-- CreateIndex
CREATE INDEX "appointment_items_appointment_id_idx" ON "appointment_items"("appointment_id");

-- CreateIndex
CREATE INDEX "appointment_status_log_appointment_id_created_at_idx" ON "appointment_status_log"("appointment_id", "created_at");

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_pet_id_fkey" FOREIGN KEY ("pet_id") REFERENCES "pets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_tutor_id_fkey" FOREIGN KEY ("tutor_id") REFERENCES "tutors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_professional_id_fkey" FOREIGN KEY ("professional_id") REFERENCES "professionals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_rescheduled_to_id_fkey" FOREIGN KEY ("rescheduled_to_id") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_items" ADD CONSTRAINT "appointment_items_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_items" ADD CONSTRAINT "appointment_items_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_status_log" ADD CONSTRAINT "appointment_status_log_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Row Level Security ──────────────────────────────────────────────────────

ALTER TABLE "appointments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "appointments" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "appointments"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "appointment_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "appointment_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "appointment_items"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "appointment_status_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "appointment_status_log" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "appointment_status_log"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON
  "appointments", "appointment_items", "appointment_status_log"
  TO app_user, app_maintenance;

-- ─── A trilha de estado é append-only ────────────────────────────────────────
-- Mesmo tratamento de `audit_logs` e `tutor_consents`: "quando isso virou no-show e
-- quem decidiu" é pergunta que se faz meses depois, e uma trilha editável não
-- responde nada. REVOKE cobre a aplicação; o trigger cobre quem for dono da tabela.

REVOKE UPDATE, DELETE ON "appointment_status_log" FROM app_user, app_maintenance;

CREATE OR REPLACE FUNCTION appointment_status_log_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'appointment_status_log é append-only (%).', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER appointment_status_log_no_update
  BEFORE UPDATE OR DELETE ON "appointment_status_log"
  FOR EACH ROW EXECUTE FUNCTION appointment_status_log_append_only();

-- ─── Índices do §4 que o Prisma não declara ──────────────────────────────────

-- A consulta mais frequente do sistema: "o que tem hoje, por profissional". Parcial
-- porque cancelado e remarcado nunca aparecem na agenda do dia, e mantê-los fora do
-- índice o deixa pequeno mesmo depois de anos de operação.
CREATE INDEX "idx_appointments_day" ON "appointments" ("tenant_id", "professional_id", "starts_at")
  WHERE "status" NOT IN ('CANCELLED', 'RESCHEDULED');

-- Detecção de conflito e cálculo de capacidade (RN-13): sobreposição de janelas.
--
-- `btree_gist` é necessário para pôr `professional_id` (uuid) dentro de um índice
-- GIST: o GIST não tem opclass padrão para tipos escalares, só para os geométricos e
-- de intervalo. Sem a extensão, o CREATE INDEX abaixo falha com 42704.
--
-- É GIST sobre `tstzrange`, e **não** `EXCLUDE USING GIST`: a exclusão proibiria
-- qualquer sobreposição, e a capacidade paralela permite até `max_concurrent_pets`
-- (decisão 7 de negócio). A garantia de corrida vem da transação SERIALIZABLE; o
-- índice serve à velocidade da contagem.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE INDEX "idx_appointments_window" ON "appointments"
  USING GIST ("professional_id", tstzrange("starts_at", "ends_at"))
  WHERE "status" IN ('PENDING', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS');

-- O varredor de no-show procura por janela vencida sem check-in.
CREATE INDEX "idx_appointments_noshow" ON "appointments" ("tenant_id", "starts_at")
  WHERE "status" = 'CONFIRMED' AND "checkin_at" IS NULL;

-- Expiração da reserva de aprovação (AC-03 de MOD-AGENDA-06).
CREATE INDEX "idx_appointments_pending" ON "appointments" ("tenant_id", "created_at")
  WHERE "status" = 'PENDING';

-- ─── Restrições de integridade ───────────────────────────────────────────────

-- Janela válida. A mesma regra existe no serviço, que devolve o 422 amigável; aqui
-- ela é garantia contra escrita fora do caminho feliz.
ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_window_check" CHECK ("ends_at" > "starts_at");

ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_total_check" CHECK ("total_cents" >= 0);

ALTER TABLE "appointment_items"
  ADD CONSTRAINT "appointment_items_values_check"
  CHECK ("price_cents" >= 0 AND "duration_min" > 0);
