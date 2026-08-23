-- MOD-PET-04 — álbum de fotos (PRD pets_03 §3 e §4).
--
-- Divergência consciente do §4: o PRD nomeia o Cloudflare Images e a coluna
-- `cloudflare_image_id`. O storage escolhido foi o **R2** (questão 2 do §11), que é
-- object storage puro: as variantes são geradas por nós no upload e a coluna que
-- importa é `variants`, com a chave de cada objeto no bucket. Um id de serviço
-- externo não teria significado aqui.
--
-- Removido do diff gerado, como o `migrations/README.md` manda: o
-- `CREATE UNIQUE INDEX "tenants_slug_key"` e os `DROP INDEX` dos índices parciais
-- escritos à mão nas migrations anteriores.

-- Nada a fazer no consentimento: `IMAGE_USE` já existe como **canal** em
-- `ConsentChannel` desde o MOD-TUTOR (tutores_02 §4). RN-14 se resolve lendo a última
-- transição desse canal — a mesma linha que a tela de consentimento do tutor grava.

-- CreateEnum
CREATE TYPE "PhotoSource" AS ENUM ('STAFF', 'TUTOR', 'GROOMING_RESULT');

-- AlterTable
ALTER TABLE "pets" ADD COLUMN "cover_photo_id" UUID;

-- CreateTable
CREATE TABLE "pet_photos" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "pet_id" UUID NOT NULL,
    "variants" JSONB NOT NULL,
    "caption" VARCHAR(140),
    "taken_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" "PhotoSource" NOT NULL DEFAULT 'STAFF',
    "attendance_id" UUID,
    "marketing_use" BOOLEAN NOT NULL DEFAULT false,
    "size_bytes" INTEGER NOT NULL,
    "mime_type" VARCHAR(40) NOT NULL,
    "uploaded_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "pet_photos_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "pet_photos" ADD CONSTRAINT "pet_photos_pet_id_fkey" FOREIGN KEY ("pet_id") REFERENCES "pets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- Parte escrita à mão
-- ═══════════════════════════════════════════════════════════════════════════

-- A galeria é cronológica (§4) e ignora o que foi apagado.
CREATE INDEX "idx_pet_photos_pet" ON "pet_photos" ("pet_id", "taken_at" DESC)
  WHERE "deleted_at" IS NULL;

-- §10: `pet_storage_bytes_per_tenant` e a cota do AC-03 somam por tenant.
CREATE INDEX "idx_pet_photos_tenant" ON "pet_photos" ("tenant_id")
  WHERE "deleted_at" IS NULL;

-- O job `media-purge` procura o que foi apagado há mais de 30 dias para remover do
-- bucket — direito ao esquecimento do §9, que soft delete sozinho não cumpre.
CREATE INDEX "idx_pet_photos_purge" ON "pet_photos" ("deleted_at")
  WHERE "deleted_at" IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- Row Level Security
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "pet_photos" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pet_photos" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pet_photos"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());
