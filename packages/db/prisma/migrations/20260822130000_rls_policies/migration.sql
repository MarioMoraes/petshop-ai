-- MOD-IDENT-07 — Isolamento RLS, papéis do Postgres, índices únicos parciais e
-- trilha de auditoria append-only.
--
-- Escrita à mão: nada aqui é expressável em schema.prisma. Ver
-- prisma/migrations/README.md antes de gerar uma migration nova com `migrate dev`.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Papéis da aplicação
-- ═══════════════════════════════════════════════════════════════════════════
-- `app_user`        — usada pela API. SEM BYPASSRLS: as políticas abaixo valem
--                     para o backend, que é o ponto do AC-01.
-- `app_maintenance` — jobs cross-tenant (relatórios de plataforma, anonimização).
--                     COM BYPASSRLS. Jamais usar em requisição de usuário (AC-03).
--
-- ATENÇÃO: as senhas abaixo servem só ao ambiente local. Em staging e produção,
-- rode `ALTER ROLE app_user PASSWORD '...'` com o valor vindo do secret manager
-- logo após aplicar as migrations.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN PASSWORD 'app_user';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_maintenance') THEN
    CREATE ROLE app_maintenance LOGIN PASSWORD 'app_maintenance' BYPASSRLS;
  END IF;
END
$$;

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO app_user, app_maintenance', current_database());
END
$$;

GRANT USAGE ON SCHEMA public TO app_user, app_maintenance;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user, app_maintenance;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user, app_maintenance;

-- Tabelas criadas por migrations futuras já nascem acessíveis.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user, app_maintenance;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user, app_maintenance;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Índices únicos parciais (PRD identidade_tenancy_01 §4)
-- ═══════════════════════════════════════════════════════════════════════════
-- O Prisma só sabe declarar unicidade total; a unicidade correta é parcial, para
-- que um slug volte a ficar livre depois do soft delete e para que um usuário
-- removido possa ser readmitido no mesmo tenant.

DROP INDEX IF EXISTS "tenants_slug_key";
CREATE UNIQUE INDEX "idx_tenants_slug" ON "tenants" ("slug") WHERE "deleted_at" IS NULL;

CREATE INDEX "idx_tenants_status" ON "tenants" ("status") WHERE "deleted_at" IS NULL;

CREATE UNIQUE INDEX "idx_memberships_tenant_user"
  ON "memberships" ("tenant_id", "user_id")
  WHERE "status" <> 'REMOVED';

CREATE INDEX "idx_memberships_user_active"
  ON "memberships" ("user_id")
  WHERE "status" = 'ACTIVE';

CREATE UNIQUE INDEX "idx_invitations_pending"
  ON "invitations" ("tenant_id", "email_hash")
  WHERE "status" = 'PENDING';

CREATE INDEX "idx_invitations_expires"
  ON "invitations" ("expires_at")
  WHERE "status" = 'PENDING';

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Row Level Security
-- ═══════════════════════════════════════════════════════════════════════════
-- `FORCE` faz a política valer inclusive para o dono da tabela. Superusuários
-- continuam passando por cima — por isso a API nunca conecta como superusuário.
--
-- `NULLIF(current_setting('app.tenant_id', true), '')::uuid`:
--   · o segundo argumento `true` faz a função devolver NULL em vez de erro
--     quando a variável não foi setada;
--   · o NULLIF protege contra o valor vazio, que quebraria o cast para uuid.
-- Sem contexto, a comparação vira NULL e a política nega tudo — que é o
-- comportamento exigido pelo AC-03 ("o retorno é vazio").

CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid;
$$;

-- `tenants` isola pela própria PK.
ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tenants"
  USING ("id" = current_tenant_id())
  WITH CHECK ("id" = current_tenant_id());

ALTER TABLE "tenant_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tenant_settings"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "memberships" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "memberships"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invitations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "invitations"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "tenant_role_overrides" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_role_overrides" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tenant_role_overrides"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "data_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "data_keys" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "data_keys"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

-- `audit_logs` e `security_events` aceitam `tenant_id` nulo para ações de
-- plataforma. Essas linhas ficam invisíveis à role da aplicação por construção:
-- só `app_maintenance` (BYPASSRLS) as enxerga.
ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "audit_logs"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

ALTER TABLE "security_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "security_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "security_events"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

-- Tabelas deliberadamente SEM RLS, por não terem dono de tenant:
--   · users, roles, permissions, role_permissions — globais (RN-01, RN-05).
--   · job_leases, job_runs — plataforma (`20260826090000_jobs_e_recibos`). Um job varre
--     todos os tenants por definição; amarrá-lo a um contexto negaria o que ele é.

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Trilha de auditoria append-only (PRD §9)
-- ═══════════════════════════════════════════════════════════════════════════
-- Duas camadas: o REVOKE tira a permissão da role da aplicação; o trigger
-- barra qualquer um — inclusive `app_maintenance` e o dono da tabela.

REVOKE UPDATE, DELETE ON "audit_logs" FROM app_user, app_maintenance;

CREATE OR REPLACE FUNCTION audit_logs_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs é append-only: % não é permitido', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only();
