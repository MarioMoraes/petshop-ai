-- `@updatedAt` do Prisma é preenchido na aplicação. Sem default no banco, qualquer
-- escrita fora do Prisma — backfill, job de manutenção, seed em SQL cru — falharia
-- com violação de NOT NULL. O default não conflita: o Prisma continua enviando o
-- valor explicitamente nos updates.
ALTER TABLE "tenants"           ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "tenant_settings"   ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "users"             ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "memberships"       ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "invitations"       ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;
