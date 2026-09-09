-- MOD-ADMIN-01 — o papel de plataforma (PRD observabilidade_admin_14)
--
-- `SUPER_ADMIN` está em `ROLE_PERMISSIONS` desde o MOD-IDENT-04 e nunca teve como ser
-- alcançado: o papel não é membership de tenant, e `memberships.role_key` era o único
-- lugar onde papel vivia. Esta tabela é o registro que faltava.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. A tabela — **sem `tenant_id`, e portanto sem RLS**
-- ═══════════════════════════════════════════════════════════════════════════
--
-- É deliberado, e é o que a torna diferente de tudo o mais que se cria neste banco. O
-- papel é da plataforma, não de um estabelecimento: uma política por `tenant_id`
-- esconderia a linha de todo mundo, inclusive de quem precisa lê-la para resolver a
-- própria sessão. Fica ao lado de `users`, `species` e dos demais cadastros globais, e
-- **não** entra em `RLS_MODELS` de `packages/db/src/client.ts`.

CREATE TABLE "platform_admins" (
  "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id"    UUID NOT NULL,
  -- Nulo só na linha de bootstrap: não havia quem concedesse.
  "granted_by" UUID,
  "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Revogação é soft: a linha fica, porque a trilha precisa dela.
  "revoked_at" TIMESTAMPTZ(6),
  "revoked_by" UUID,

  CONSTRAINT "platform_admins_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "platform_admins"
  ADD CONSTRAINT "platform_admins_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Um vínculo vivo por usuário
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Índice único **parcial**, e não `@unique` no schema: revogar e conceder de novo à
-- mesma pessoa é o caminho normal — o que não pode existir é a segunda linha viva. A
-- unicidade total impediria o histórico.

CREATE UNIQUE INDEX "idx_platform_admins_vivo"
  ON "platform_admins"("user_id") WHERE "revoked_at" IS NULL;

-- A leitura do caminho quente: "este usuário é da plataforma?", uma vez por sessão sem
-- Organization.
CREATE INDEX "platform_admins_user_id_idx" ON "platform_admins"("user_id");

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Privilégio explícito
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `ALTER DEFAULT PRIVILEGES` da migration de RLS já cobriria, porque a migration roda
-- como `postgres`. O GRANT explícito fica pela mesma razão que as migrations do
-- MOD-AGENDA o repetem: um banco restaurado de dump nem sempre traz os default
-- privileges, e o sintoma é permissão negada em produção, não em desenvolvimento.

GRANT SELECT, INSERT, UPDATE, DELETE ON "platform_admins" TO app_user, app_maintenance;
