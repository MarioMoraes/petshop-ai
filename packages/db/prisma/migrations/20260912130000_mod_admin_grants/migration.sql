-- MOD-ADMIN-02 — acesso de suporte consentido (PRD observabilidade_admin_14)
--
-- O `SUPER_ADMIN` recebe toda a matriz de permissões, e isso nunca foi suficiente para
-- ler a ficha de um cliente de um petshop: quem é controlador daquele dado é o
-- estabelecimento, e a plataforma é operadora (art. 5º, VI e VII da LGPD). O grant é a
-- forma de o controlador autorizar cada acesso, com motivo, prazo e registro — que é o
-- que o art. 39 pede do contrato entre os dois.

CREATE TYPE "SupportGrantStatus" AS ENUM (
  'REQUESTED',
  'ACTIVE',
  'DENIED',
  'EXPIRED',
  'REVOKED'
);

CREATE TABLE "support_access_grants" (
  "id"        UUID NOT NULL DEFAULT gen_random_uuid(),
  -- **Tem `tenant_id`, ao contrário de `platform_admins`.** O grant é do estabelecimento
  -- que autoriza: é ele quem precisa vê-lo na própria tela e revogá-lo quando quiser.
  "tenant_id" UUID NOT NULL,

  "admin_user_id" UUID NOT NULL,
  -- Em claro, e é o único campo do módulo que precisa ser: é o que o admin do petshop lê
  -- para decidir se aprova.
  "reason"        VARCHAR(300) NOT NULL,

  "status" "SupportGrantStatus" NOT NULL DEFAULT 'REQUESTED',

  "approved_by" UUID,
  "approved_at" TIMESTAMPTZ(6),
  -- Preenchido na aprovação, nunca no pedido: quem define o prazo é quem autoriza.
  "expires_at"  TIMESTAMPTZ(6),

  "revoked_by" UUID,
  "revoked_at" TIMESTAMPTZ(6),

  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "support_access_grants_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "support_access_grants"
  ADD CONSTRAINT "support_access_grants_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "support_access_grants"
  ADD CONSTRAINT "support_access_grants_admin_user_id_fkey"
  FOREIGN KEY ("admin_user_id") REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- RLS — o estabelecimento vê e revoga os próprios grants
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "support_access_grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "support_access_grants" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "support_access_grants"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

-- ═══════════════════════════════════════════════════════════════════════════
-- Índices
-- ═══════════════════════════════════════════════════════════════════════════

-- A tela do estabelecimento: os grants dele, por estado.
CREATE INDEX "support_access_grants_tenant_id_status_idx"
  ON "support_access_grants"("tenant_id", "status");

-- **O caminho quente**: "este suporte tem grant vivo neste tenant?", conferido uma vez
-- por requisição, sem cache (RN-03 — a revogação precisa valer no clique seguinte).
CREATE INDEX "idx_grants_vivos"
  ON "support_access_grants"("admin_user_id", "tenant_id", "expires_at")
  WHERE "status" = 'ACTIVE';

-- Um pedido aberto por suporte e tenant: pedir de novo enquanto o primeiro espera
-- resposta encheria a caixa do admin do petshop com a mesma coisa.
CREATE UNIQUE INDEX "idx_grants_pedido_aberto"
  ON "support_access_grants"("admin_user_id", "tenant_id")
  WHERE "status" IN ('REQUESTED', 'ACTIVE');

GRANT SELECT, INSERT, UPDATE, DELETE ON "support_access_grants" TO app_user, app_maintenance;
