-- MOD-ESTOQUE, fatia 4 — alertas, posição e reconciliação (PRD estoque_16,
-- MOD-ESTOQUE-09/11/12).
--
-- Escrita à mão, como toda migration desde o MOD-TUTOR (ver README.md).
--
-- A fatia só precisa de uma coisa nova no banco: a janela do alerta de validade, que
-- até aqui era a constante `INVENTORY_EXPIRY_WARNING_DAYS`. Os alertas são leitura de
-- estado (AC-03 de MOD-ESTOQUE-09), a posição é leitura dos lotes e a reconciliação
-- compara duas colunas que já existem.
--
-- Tabela própria, e não coluna em `tenant_settings`: a configuração é do MOD-ESTOQUE, e
-- quem escreve `tenant_settings` é o MOD-IDENT. A linha ausente vale o padrão, então não
-- há backfill — o estabelecimento que nunca abriu a configuração lê 30 dias.

CREATE TABLE "inventory_settings" (
    "tenant_id" UUID NOT NULL,
    "expiry_warning_days" SMALLINT NOT NULL DEFAULT 30,
    "updated_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_settings_pkey" PRIMARY KEY ("tenant_id"),
    -- O mesmo intervalo do schema Zod. Zero desligaria o alerta sem dizer, e um ano
    -- acenderia todo lote da prateleira.
    CONSTRAINT "inventory_settings_expiry_warning_days_check"
      CHECK ("expiry_warning_days" BETWEEN 1 AND 180)
);

ALTER TABLE "inventory_settings" ADD CONSTRAINT "inventory_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE "inventory_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "inventory_settings"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON "inventory_settings" TO app_user, app_maintenance;
