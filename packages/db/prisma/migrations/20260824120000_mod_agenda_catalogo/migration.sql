-- MOD-AGENDA — fatia 1: catálogo de serviços, profissionais e bloqueios
-- PRD agenda_operacao_06 §4, sub-features 01 a 03.
--
-- SQL gerado por `prisma migrate diff` e podado à mão, como manda o README desta
-- pasta: o diff queria derrubar 15 índices escritos à mão (GIN, trigram, parciais) e
-- recriar `tenants_slug_key` por cima de `idx_tenants_slug`. Nada disso está aqui.

-- CreateEnum
CREATE TYPE "ServiceCategory" AS ENUM ('BATH', 'GROOMING', 'VET', 'VACCINE', 'OTHER');

-- CreateTable
CREATE TABLE "services" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "category" "ServiceCategory" NOT NULL,
    "description" VARCHAR(300),
    "base_duration_min" SMALLINT NOT NULL,
    "requires_vet" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_pricing" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "size_id" UUID NOT NULL,
    "price_cents" BIGINT NOT NULL,
    "duration_min" SMALLINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_pricing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "professionals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "user_id" UUID,
    "display_name" VARCHAR(60) NOT NULL,
    "role_key" VARCHAR(30) NOT NULL,
    "max_concurrent_pets" SMALLINT NOT NULL DEFAULT 1,
    "color" VARCHAR(7),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "professionals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "professional_services" (
    "professional_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idx_professional_service" PRIMARY KEY ("professional_id","service_id")
);

-- CreateTable
CREATE TABLE "professional_schedules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "professional_id" UUID NOT NULL,
    "weekday" SMALLINT NOT NULL,
    "starts_at_min" SMALLINT NOT NULL,
    "ends_at_min" SMALLINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "professional_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_blocks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "professional_id" UUID,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "reason" VARCHAR(120),
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calendar_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "services_tenant_id_active_idx" ON "services"("tenant_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "idx_service_pricing_unique" ON "service_pricing"("service_id", "size_id");

-- CreateIndex
CREATE INDEX "professionals_tenant_id_active_idx" ON "professionals"("tenant_id", "active");

-- CreateIndex
CREATE INDEX "professional_schedules_professional_id_weekday_idx" ON "professional_schedules"("professional_id", "weekday");

-- CreateIndex
CREATE INDEX "idx_blocks_window" ON "calendar_blocks"("tenant_id", "starts_at", "ends_at");

-- AddForeignKey
ALTER TABLE "service_pricing" ADD CONSTRAINT "service_pricing_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_pricing" ADD CONSTRAINT "service_pricing_size_id_fkey" FOREIGN KEY ("size_id") REFERENCES "sizes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "professional_services" ADD CONSTRAINT "professional_services_professional_id_fkey" FOREIGN KEY ("professional_id") REFERENCES "professionals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "professional_services" ADD CONSTRAINT "professional_services_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "professional_schedules" ADD CONSTRAINT "professional_schedules_professional_id_fkey" FOREIGN KEY ("professional_id") REFERENCES "professionals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_blocks" ADD CONSTRAINT "calendar_blocks_professional_id_fkey" FOREIGN KEY ("professional_id") REFERENCES "professionals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Row Level Security ──────────────────────────────────────────────────────
-- Toda tabela de negócio nova entra com RLS na mesma migration, e o nome do modelo
-- vai para `RLS_MODELS` em packages/db/src/client.ts (feito).
--
-- `FORCE` porque o dono da tabela escaparia da política sem ele — e as migrations
-- rodam como `postgres`, que é o dono.

ALTER TABLE "services" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "services" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "services"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "service_pricing" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "service_pricing" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "service_pricing"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "professionals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "professionals" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "professionals"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "professional_services" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "professional_services" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "professional_services"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "professional_schedules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "professional_schedules" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "professional_schedules"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "calendar_blocks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "calendar_blocks" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "calendar_blocks"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

-- ─── Grants ──────────────────────────────────────────────────────────────────
-- `app_user` é a aplicação (sem BYPASSRLS); `app_maintenance` roda os jobs
-- cross-tenant. Ambos precisam de grant explícito em tabela nova.

GRANT SELECT, INSERT, UPDATE, DELETE ON
  "services", "service_pricing", "professionals",
  "professional_services", "professional_schedules", "calendar_blocks"
  TO app_user, app_maintenance;

-- ─── Índices e restrições que o Prisma não declara ───────────────────────────

-- Nome de serviço é único por tenant, mas só entre os vivos: o soft delete tem de
-- poder conviver com um serviço novo de mesmo nome. Índice parcial, portanto.
CREATE UNIQUE INDEX "idx_services_tenant_name"
  ON "services" ("tenant_id", lower("name"))
  WHERE "deleted_at" IS NULL;

-- A jornada é lida por dia inteiro do tenant no cálculo de disponibilidade.
CREATE INDEX "idx_schedules_tenant_weekday"
  ON "professional_schedules" ("tenant_id", "weekday");

-- Faixa de jornada válida: fim depois do início, e ambos dentro do dia. A mesma
-- regra está no Zod; aqui ela é garantia, não validação — o 422 amigável vem de lá.
ALTER TABLE "professional_schedules"
  ADD CONSTRAINT "professional_schedules_window_check"
  CHECK ("starts_at_min" >= 0 AND "ends_at_min" <= 1440 AND "ends_at_min" > "starts_at_min");

ALTER TABLE "calendar_blocks"
  ADD CONSTRAINT "calendar_blocks_window_check"
  CHECK ("ends_at" > "starts_at");

-- Preço e duração não são negativos, e a duração cabe na grade de 15 min.
ALTER TABLE "service_pricing"
  ADD CONSTRAINT "service_pricing_values_check"
  CHECK ("price_cents" >= 0 AND "duration_min" > 0 AND "duration_min" % 15 = 0);

ALTER TABLE "professionals"
  ADD CONSTRAINT "professionals_capacity_check"
  CHECK ("max_concurrent_pets" >= 1);
