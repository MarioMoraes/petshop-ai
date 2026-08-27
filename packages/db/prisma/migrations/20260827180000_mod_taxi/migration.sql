-- MOD-TAXI — leva-e-traz (PRD taxi_dog_07 §4)
--
-- O que o Prisma gerou está abaixo, **podado**: o diff veio com 28 `DROP INDEX`,
-- o `ALTER COLUMN "signed_amount_cents" DROP DEFAULT` e o
-- `CREATE UNIQUE INDEX "tenants_slug_key"` de sempre. Nada disso foi pedido — ver
-- `migrations/README.md`.
--
-- O que **não** é expressável em `schema.prisma` vem depois, escrito à mão: as
-- políticas RLS, os índices parciais e o GIST de capacidade, o append-only da trilha
-- de status e o afrouxamento de um CHECK do MOD-AGENDA que o item de taxi violaria.

-- CreateEnum
CREATE TYPE "TaxiLeg" AS ENUM ('PICKUP', 'DROPOFF');

-- CreateEnum
CREATE TYPE "TaxiRideStatus" AS ENUM ('REQUESTED', 'ASSIGNED', 'EN_ROUTE', 'ARRIVED', 'ONBOARD', 'DELIVERED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TaxiPriceSource" AS ENUM ('ZONE', 'DEFAULT', 'MANUAL');

-- CreateEnum
CREATE TYPE "TaxiFailureReason" AS ENUM ('NO_ONE_HOME', 'WRONG_ADDRESS', 'PET_REFUSED', 'NO_SPACE', 'VEHICLE_ISSUE', 'OTHER');

-- CreateEnum
CREATE TYPE "TaxiCancelReason" AS ENUM ('TUTOR_REQUEST', 'APPOINTMENT_CANCELLED', 'APPOINTMENT_RESCHEDULED', 'PET_DECEASED', 'SHOP_REQUEST');

-- AlterEnum
ALTER TYPE "ServiceCategory" ADD VALUE 'TAXI';

-- CreateTable
CREATE TABLE "taxi_rides" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "pet_id" UUID NOT NULL,
    "tutor_id" UUID NOT NULL,
    "leg" "TaxiLeg" NOT NULL,
    "status" "TaxiRideStatus" NOT NULL DEFAULT 'REQUESTED',
    "window_starts_at" TIMESTAMPTZ(6) NOT NULL,
    "window_ends_at" TIMESTAMPTZ(6) NOT NULL,
    "driver_id" UUID,
    "vehicle_id" UUID,
    "address_id" UUID,
    "zip_code" VARCHAR(8) NOT NULL,
    "street_encrypted" TEXT NOT NULL,
    "number_encrypted" TEXT NOT NULL,
    "complement_encrypted" TEXT,
    "access_notes_encrypted" TEXT,
    "district" VARCHAR(80) NOT NULL,
    "city" VARCHAR(80) NOT NULL,
    "state" VARCHAR(2) NOT NULL,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "zone_id" UUID,
    "price_cents" BIGINT NOT NULL,
    "price_source" "TaxiPriceSource" NOT NULL DEFAULT 'DEFAULT',
    "appointment_item_id" UUID,
    "ready_at" TIMESTAMPTZ(6),
    "assigned_at" TIMESTAMPTZ(6),
    "en_route_at" TIMESTAMPTZ(6),
    "arrived_at" TIMESTAMPTZ(6),
    "onboard_at" TIMESTAMPTZ(6),
    "delivered_at" TIMESTAMPTZ(6),
    "failure_reason" "TaxiFailureReason",
    "cancel_reason" "TaxiCancelReason",
    "cancelled_at" TIMESTAMPTZ(6),
    "notes_encrypted" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "taxi_rides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "taxi_ride_status_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "ride_id" UUID NOT NULL,
    "from_status" "TaxiRideStatus",
    "to_status" "TaxiRideStatus" NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "driver_id" UUID,
    "by_user_id" UUID,
    "notes_encrypted" TEXT,

    CONSTRAINT "taxi_ride_status_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "taxi_vehicles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "plate" VARCHAR(8) NOT NULL,
    "label" VARCHAR(40) NOT NULL,
    "model" VARCHAR(40),
    "pet_capacity" SMALLINT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "taxi_vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "taxi_zones" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "zip_prefixes" TEXT[],
    "price_cents" BIGINT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "taxi_zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "taxi_settings" (
    "tenant_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "taxi_service_id" UUID,
    "default_price_cents" BIGINT NOT NULL DEFAULT 0,
    "block_outside_zones" BOOLEAN NOT NULL DEFAULT false,
    "charge_failed_pickup" BOOLEAN NOT NULL DEFAULT false,
    "default_window_minutes" SMALLINT NOT NULL DEFAULT 60,
    "unassigned_alert_hours" SMALLINT NOT NULL DEFAULT 12,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "taxi_settings_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateIndex
CREATE INDEX "idx_taxi_rides_appointment" ON "taxi_rides"("appointment_id");

-- CreateIndex
CREATE INDEX "idx_taxi_rides_tutor" ON "taxi_rides"("tenant_id", "tutor_id", "window_starts_at" DESC);

-- CreateIndex
CREATE INDEX "idx_taxi_ride_status_log_ride" ON "taxi_ride_status_log"("ride_id", "recorded_at");

-- CreateIndex
CREATE INDEX "taxi_vehicles_tenant_id_active_idx" ON "taxi_vehicles"("tenant_id", "active");

-- CreateIndex
CREATE INDEX "taxi_zones_tenant_id_active_idx" ON "taxi_zones"("tenant_id", "active");

-- AddForeignKey
ALTER TABLE "taxi_rides" ADD CONSTRAINT "taxi_rides_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "taxi_rides" ADD CONSTRAINT "taxi_rides_pet_id_fkey" FOREIGN KEY ("pet_id") REFERENCES "pets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "taxi_rides" ADD CONSTRAINT "taxi_rides_tutor_id_fkey" FOREIGN KEY ("tutor_id") REFERENCES "tutors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "taxi_rides" ADD CONSTRAINT "taxi_rides_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "professionals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "taxi_rides" ADD CONSTRAINT "taxi_rides_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "taxi_vehicles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "taxi_rides" ADD CONSTRAINT "taxi_rides_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "taxi_zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "taxi_ride_status_log" ADD CONSTRAINT "taxi_ride_status_log_ride_id_fkey" FOREIGN KEY ("ride_id") REFERENCES "taxi_rides"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "taxi_settings" ADD CONSTRAINT "taxi_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "taxi_settings" ADD CONSTRAINT "taxi_settings_taxi_service_id_fkey" FOREIGN KEY ("taxi_service_id") REFERENCES "services"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. RLS (MOD-IDENT-07)
-- ═══════════════════════════════════════════════════════════════════════════
-- As cinco tabelas têm `tenant_id`, inclusive a trilha de status: a história de uma
-- corrida é tão do tenant quanto a corrida. Os nomes também entram em `RLS_MODELS`,
-- em `packages/db/src/client.ts`, para a guarda de aplicação cobrir junto com o banco.

ALTER TABLE "taxi_rides" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "taxi_rides" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "taxi_rides"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "taxi_ride_status_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "taxi_ride_status_log" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "taxi_ride_status_log"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "taxi_vehicles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "taxi_vehicles" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "taxi_vehicles"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "taxi_zones" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "taxi_zones" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "taxi_zones"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "taxi_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "taxi_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "taxi_settings"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON
  "taxi_rides", "taxi_ride_status_log", "taxi_vehicles", "taxi_zones", "taxi_settings"
  TO app_user, app_maintenance;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. A trilha de status é append-only
-- ═══════════════════════════════════════════════════════════════════════════
-- Mesmo tratamento de `appointment_status_log`. Aqui pesa mais, não menos: "a que
-- horas o motorista disse que pegou o pet" é a pergunta de quem investiga um animal
-- que sumiu, e uma trilha editável não responde nada. O REVOKE cobre a aplicação; o
-- trigger cobre quem for dono da tabela.

REVOKE UPDATE, DELETE ON "taxi_ride_status_log" FROM app_user, app_maintenance;

CREATE OR REPLACE FUNCTION taxi_ride_status_log_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'taxi_ride_status_log é append-only (%).', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER taxi_ride_status_log_no_update
  BEFORE UPDATE OR DELETE ON "taxi_ride_status_log"
  FOR EACH ROW EXECUTE FUNCTION taxi_ride_status_log_append_only();

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Índices do §4 que o Prisma não declara
-- ═══════════════════════════════════════════════════════════════════════════

-- Painel do dia e rota do motorista: "as corridas de hoje, por motorista". Parcial
-- porque corrida terminada não aparece na rota, e mantê-la fora deixa o índice
-- pequeno depois de anos.
CREATE INDEX "idx_taxi_rides_day" ON "taxi_rides" ("tenant_id", "driver_id", "window_starts_at")
  WHERE "status" NOT IN ('CANCELLED', 'DELIVERED', 'FAILED');

-- Capacidade da van (RN-09): sobreposição de janelas do mesmo motorista.
--
-- `btree_gist` já foi criada pela migration do MOD-AGENDA; o IF NOT EXISTS é para
-- quem aplicar as migrations fora de ordem em um banco novo.
--
-- Como lá, é GIST sobre `tstzrange` e **não** `EXCLUDE USING GIST`: a van leva
-- vários pets ao mesmo tempo, então o conflito é `count(sobreposições) >= capacidade`
-- e não "existe sobreposição". A garantia vem da transação SERIALIZABLE.
--
-- `REQUESTED` fica fora da lista: corrida sem motorista não ocupa a van de ninguém.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE INDEX "idx_taxi_rides_window" ON "taxi_rides"
  USING GIST ("driver_id", tstzrange("window_starts_at", "window_ends_at"))
  WHERE "status" IN ('ASSIGNED', 'EN_ROUTE', 'ARRIVED', 'ONBOARD');

-- A fila "sem motorista" do painel e o job `taxi-unassigned-alert`.
CREATE INDEX "idx_taxi_rides_unassigned" ON "taxi_rides" ("tenant_id", "window_starts_at")
  WHERE "driver_id" IS NULL AND "status" = 'REQUESTED';

-- O varredor de corrida atrasada (`taxi-overdue-sweeper`).
CREATE INDEX "idx_taxi_rides_overdue" ON "taxi_rides" ("tenant_id", "window_ends_at")
  WHERE "status" IN ('ASSIGNED', 'EN_ROUTE', 'ARRIVED', 'ONBOARD');

-- AC-04 de MOD-TAXI-01: uma perna **viva** por agendamento. Parcial porque a corrida
-- cancelada ou frustrada fica no histórico e não pode impedir a segunda tentativa —
-- que é justamente o caso em que o tutor remarca a coleta depois da porta fechada.
CREATE UNIQUE INDEX "idx_taxi_rides_leg_alive" ON "taxi_rides" ("appointment_id", "leg")
  WHERE "status" NOT IN ('CANCELLED', 'FAILED');

-- Placa é única por tenant, entre as vivas. Parcial pelo mesmo motivo: a van vendida
-- some do seletor, mas a placa pode voltar em outro veículo.
CREATE UNIQUE INDEX "idx_taxi_vehicles_plate" ON "taxi_vehicles" ("tenant_id", "plate")
  WHERE "deleted_at" IS NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Restrições de integridade
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "taxi_rides"
  ADD CONSTRAINT "taxi_rides_window_check" CHECK ("window_ends_at" > "window_starts_at");

ALTER TABLE "taxi_rides"
  ADD CONSTRAINT "taxi_rides_price_check" CHECK ("price_cents" >= 0);

ALTER TABLE "taxi_zones"
  ADD CONSTRAINT "taxi_zones_price_check" CHECK ("price_cents" >= 0);

ALTER TABLE "taxi_zones"
  ADD CONSTRAINT "taxi_zones_prefixes_check" CHECK (array_length("zip_prefixes", 1) >= 1);

ALTER TABLE "taxi_vehicles"
  ADD CONSTRAINT "taxi_vehicles_capacity_check" CHECK ("pet_capacity" >= 1);

ALTER TABLE "taxi_settings"
  ADD CONSTRAINT "taxi_settings_price_check" CHECK ("default_price_cents" >= 0);

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. O CHECK do MOD-AGENDA que o item de taxi violaria
-- ═══════════════════════════════════════════════════════════════════════════
-- `appointment_items_values_check` exigia `duration_min > 0`, e faz sentido para
-- banho e tosa: item de agenda sem duração seria erro de cadastro.
--
-- O item de Taxi Dog é a exceção legítima (RN-06): ele cobra a corrida no mesmo
-- agendamento, mas o tempo gasto é do **motorista**, não do banhista. Somá-lo a
-- `ends_at` bloquearia a bancada por engano, então ele entra com `duration_min = 0`.
--
-- O CHECK passa a `>= 0`. A garantia de que serviço comum continua tendo duração
-- vem de `service_pricing.duration_min`, que já é `>= SCHEDULE_GRID_MIN` no schema
-- Zod e na origem de todo item que não é taxi.

ALTER TABLE "appointment_items" DROP CONSTRAINT "appointment_items_values_check";

ALTER TABLE "appointment_items"
  ADD CONSTRAINT "appointment_items_values_check"
  CHECK ("price_cents" >= 0 AND "duration_min" >= 0);
