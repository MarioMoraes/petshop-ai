-- MOD-PET — Cadastro de pets e tabelas de domínio (PRD pets_03 §4).
--
-- A primeira metade é o DDL gerado por `prisma migrate diff`. A segunda é escrita
-- à mão: índices parciais e de expressão, o trigger do `search_vector` e as
-- políticas RLS — inclusive a política **mista** do catálogo, que é a novidade
-- deste módulo. Ver `prisma/migrations/README.md`.
--
-- Removido do diff gerado, como o README manda:
--   · `CREATE UNIQUE INDEX "tenants_slug_key"`, que desfaria o índice parcial de
--     `*_rls_policies`;
--   · os `DROP INDEX` de `idx_tutors_search`, `idx_tutors_name_trgm`,
--     `idx_tutors_tenant_phone`, `idx_tags_tenant_key` e
--     `idx_consents_tutor_channel` — todos escritos à mão em `*_mod_tutor`.
--
-- Divergência consciente do §4: o PRD descreve a coluna `pets.microchip` cifrada e
-- ao mesmo tempo com índice único por tenant. As duas coisas não convivem — o
-- AES-GCM é não determinístico, e o mesmo microchip cifra diferente a cada
-- gravação. Vale aqui o par cifra/hash que o MOD-TUTOR já usa para CPF e telefone:
-- `microchip_encrypted` guarda o valor, `microchip_hash` sustenta a unicidade.


-- CreateEnum
CREATE TYPE "PetSex" AS ENUM ('MALE', 'FEMALE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "PetStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'DECEASED', 'TRANSFERRED_OUT');

-- CreateEnum
CREATE TYPE "BirthDatePrecision" AS ENUM ('EXACT', 'ESTIMATED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "PetTutorRole" AS ENUM ('PRIMARY', 'SECONDARY');

-- CreateTable
CREATE TABLE "species" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID,
    "key" VARCHAR(40) NOT NULL,
    "label" VARCHAR(60) NOT NULL,
    "sort_order" SMALLINT NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "species_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "breeds" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID,
    "species_id" UUID NOT NULL,
    "label" VARCHAR(80) NOT NULL,
    "normalized_label" VARCHAR(80) NOT NULL,
    "default_size_id" UUID,
    "grooming_notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "breeds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sizes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID,
    "key" VARCHAR(40) NOT NULL,
    "label" VARCHAR(60) NOT NULL,
    "weight_min_kg" DECIMAL(5,2) NOT NULL,
    "weight_max_kg" DECIMAL(5,2) NOT NULL,
    "sort_order" SMALLINT NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sizes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coats" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID,
    "key" VARCHAR(40) NOT NULL,
    "label" VARCHAR(60) NOT NULL,
    "grooming_time_factor" DECIMAL(3,2) NOT NULL DEFAULT 1.00,
    "sort_order" SMALLINT NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "species_id" UUID NOT NULL,
    "breed_id" UUID,
    "size_id" UUID NOT NULL,
    "coat_id" UUID,
    "sex" "PetSex" NOT NULL DEFAULT 'UNKNOWN',
    "birth_date" DATE,
    "birth_date_precision" "BirthDatePrecision" NOT NULL DEFAULT 'UNKNOWN',
    "weight_kg" DECIMAL(5,2),
    "neutered" BOOLEAN,
    "microchip_encrypted" TEXT,
    "microchip_hash" TEXT,
    "color" VARCHAR(40),
    "status" "PetStatus" NOT NULL DEFAULT 'ACTIVE',
    "deceased_at" DATE,
    "notes_encrypted" TEXT,
    "search_vector" tsvector,
    "last_attendance_at" TIMESTAMPTZ(6),
    "created_by" UUID,
    "updated_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "pets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pet_tutors" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "pet_id" UUID NOT NULL,
    "tutor_id" UUID NOT NULL,
    "role" "PetTutorRole" NOT NULL DEFAULT 'SECONDARY',
    "relationship" VARCHAR(40),
    "can_authorize_procedures" BOOLEAN NOT NULL DEFAULT true,
    "linked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unlinked_at" TIMESTAMPTZ(6),
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pet_tutors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pet_weights" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "pet_id" UUID NOT NULL,
    "weight_kg" DECIMAL(5,2) NOT NULL,
    "measured_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attendance_id" UUID,
    "measured_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pet_weights_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "breeds_species_id_idx" ON "breeds"("species_id");

-- AddForeignKey
ALTER TABLE "breeds" ADD CONSTRAINT "breeds_species_id_fkey" FOREIGN KEY ("species_id") REFERENCES "species"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "breeds" ADD CONSTRAINT "breeds_default_size_id_fkey" FOREIGN KEY ("default_size_id") REFERENCES "sizes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pets" ADD CONSTRAINT "pets_species_id_fkey" FOREIGN KEY ("species_id") REFERENCES "species"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pets" ADD CONSTRAINT "pets_breed_id_fkey" FOREIGN KEY ("breed_id") REFERENCES "breeds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pets" ADD CONSTRAINT "pets_size_id_fkey" FOREIGN KEY ("size_id") REFERENCES "sizes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pets" ADD CONSTRAINT "pets_coat_id_fkey" FOREIGN KEY ("coat_id") REFERENCES "coats"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pet_tutors" ADD CONSTRAINT "pet_tutors_pet_id_fkey" FOREIGN KEY ("pet_id") REFERENCES "pets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pet_tutors" ADD CONSTRAINT "pet_tutors_tutor_id_fkey" FOREIGN KEY ("tutor_id") REFERENCES "tutors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pet_weights" ADD CONSTRAINT "pet_weights_pet_id_fkey" FOREIGN KEY ("pet_id") REFERENCES "pets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- Parte escrita à mão
-- ═══════════════════════════════════════════════════════════════════════════
-- `pg_trgm` e `unaccent` já vieram com a migration do MOD-TUTOR.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Catálogo de domínio: unicidade separada para global e tenant
-- ═══════════════════════════════════════════════════════════════════════════
-- RN-02: o catálogo global (`tenant_id IS NULL`) é somente leitura para o tenant,
-- que pode criar os seus. São dois espaços de nome distintos, e por isso dois
-- índices parciais em vez de um único sobre `(tenant_id, key)` — que deixaria
-- passar duas linhas globais com a mesma chave, porque NULL nunca colide.

CREATE UNIQUE INDEX "idx_species_global_key" ON "species" ("key")
  WHERE "tenant_id" IS NULL;
CREATE UNIQUE INDEX "idx_species_tenant_key" ON "species" ("tenant_id", "key")
  WHERE "tenant_id" IS NOT NULL;

CREATE UNIQUE INDEX "idx_sizes_global_key" ON "sizes" ("key")
  WHERE "tenant_id" IS NULL;
CREATE UNIQUE INDEX "idx_sizes_tenant_key" ON "sizes" ("tenant_id", "key")
  WHERE "tenant_id" IS NOT NULL;

CREATE UNIQUE INDEX "idx_coats_global_key" ON "coats" ("key")
  WHERE "tenant_id" IS NULL;
CREATE UNIQUE INDEX "idx_coats_tenant_key" ON "coats" ("tenant_id", "key")
  WHERE "tenant_id" IS NOT NULL;

-- AC-03 de MOD-PET-03: a comparação de duplicata é sobre o rótulo normalizado.
CREATE UNIQUE INDEX "idx_breeds_global_norm" ON "breeds" ("species_id", "normalized_label")
  WHERE "tenant_id" IS NULL;
CREATE UNIQUE INDEX "idx_breeds_tenant_norm"
  ON "breeds" ("tenant_id", "species_id", "normalized_label")
  WHERE "tenant_id" IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Índices de pets (PRD pets_03 §4)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE INDEX "idx_pets_tenant" ON "pets" ("tenant_id") WHERE "deleted_at" IS NULL;
CREATE INDEX "idx_pets_tenant_status" ON "pets" ("tenant_id", "status")
  WHERE "deleted_at" IS NULL;

CREATE INDEX "idx_pets_search" ON "pets" USING GIN ("search_vector");
CREATE INDEX "idx_pets_name_trgm" ON "pets" USING GIN ("name" gin_trgm_ops);

-- RN-15: dois pets com o mesmo microchip são erro de digitação ou duplicata. O
-- soft delete libera o número de volta — senão um cadastro excluído por engano
-- impediria o recadastro do mesmo animal.
CREATE UNIQUE INDEX "idx_pets_tenant_microchip" ON "pets" ("tenant_id", "microchip_hash")
  WHERE "microchip_hash" IS NOT NULL AND "deleted_at" IS NULL;

-- Campanha de aniversário (MOD-CRM): a pergunta é "quem faz aniversário hoje",
-- então o índice é por mês e dia. RN-08: pet não ACTIVE fica fora por construção.
CREATE INDEX "idx_pets_birthday" ON "pets"
  ("tenant_id", (EXTRACT(MONTH FROM "birth_date")), (EXTRACT(DAY FROM "birth_date")))
  WHERE "status" = 'ACTIVE' AND "birth_date" IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Vínculo pet ↔ tutor (MOD-PET-02)
-- ═══════════════════════════════════════════════════════════════════════════
-- Os índices filtram por `unlinked_at IS NULL` porque o vínculo encerrado
-- permanece na tabela: é o histórico de quem respondeu pelo animal e quando.

CREATE INDEX "idx_pet_tutors_pet" ON "pet_tutors" ("pet_id") WHERE "unlinked_at" IS NULL;
CREATE INDEX "idx_pet_tutors_tutor" ON "pet_tutors" ("tutor_id") WHERE "unlinked_at" IS NULL;

-- RN-04: exatamente um responsável principal ativo por pet. O índice é a garantia
-- de verdade; a checagem no serviço existe só para o erro sair legível (AC-02).
CREATE UNIQUE INDEX "idx_pet_primary_tutor" ON "pet_tutors" ("pet_id")
  WHERE "role" = 'PRIMARY' AND "unlinked_at" IS NULL;

-- O mesmo tutor não se vincula duas vezes ao mesmo pet enquanto o vínculo vive.
CREATE UNIQUE INDEX "idx_pet_tutor_active" ON "pet_tutors" ("pet_id", "tutor_id")
  WHERE "unlinked_at" IS NULL;

CREATE INDEX "idx_pet_weights_pet" ON "pet_weights" ("pet_id", "measured_at" DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Busca de pets
-- ═══════════════════════════════════════════════════════════════════════════
-- O rótulo da raça entra no vetor porque "tem um golden marcado hoje?" é pergunta
-- de balcão. Pesos: nome em 'A', raça em 'B', cor em 'C'.
--
-- O trigger lê `breeds`, que tem RLS: como a política do catálogo libera a linha
-- global e a do próprio tenant, e é isso que o pet pode referenciar, a função roda
-- com os privilégios de quem invoca — sem `SECURITY DEFINER`, que abriria o
-- catálogo de outros tenants.

CREATE OR REPLACE FUNCTION pets_search_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  breed_label text := '';
BEGIN
  IF NEW."breed_id" IS NOT NULL THEN
    SELECT b."label" INTO breed_label FROM "breeds" b WHERE b."id" = NEW."breed_id";
  END IF;

  NEW."search_vector" :=
    setweight(to_tsvector('portuguese', unaccent(coalesce(NEW."name", ''))), 'A') ||
    setweight(to_tsvector('portuguese', unaccent(coalesce(breed_label, ''))), 'B') ||
    setweight(to_tsvector('portuguese', unaccent(coalesce(NEW."color", ''))), 'C');
  RETURN NEW;
END;
$$;

CREATE TRIGGER pets_search_vector_update
  BEFORE INSERT OR UPDATE OF "name", "color", "breed_id" ON "pets"
  FOR EACH ROW EXECUTE FUNCTION pets_search_trigger();

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. Row Level Security
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "pets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pets" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pets"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "pet_tutors" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pet_tutors" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pet_tutors"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "pet_weights" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pet_weights" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pet_weights"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

-- ─── Catálogo: política mista (PRD pets_03 §4, nota final) ───────────────────
-- O `USING` deixa o tenant **ler** o catálogo global; o `WITH CHECK` o obriga a
-- **escrever** apenas linhas suas. É o que impede um TENANT_ADMIN de editar uma
-- raça global — o 403 do AC-02 de MOD-PET-03 é a mensagem amigável dessa regra,
-- não a regra em si.
--
-- Sem contexto de tenant, `current_tenant_id()` é NULL: o global continua legível
-- e nenhuma linha de tenant aparece. É deliberado — o catálogo global não é
-- segredo de ninguém.

ALTER TABLE "species" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "species" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_catalog ON "species"
  USING ("tenant_id" IS NULL OR "tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "breeds" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "breeds" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_catalog ON "breeds"
  USING ("tenant_id" IS NULL OR "tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "sizes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sizes" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_catalog ON "sizes"
  USING ("tenant_id" IS NULL OR "tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "coats" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "coats" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_catalog ON "coats"
  USING ("tenant_id" IS NULL OR "tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());
