-- MOD-SEC — Segurança e Compliance (PRD seguranca_compliance_13)
--
-- Quatro mudanças, todas pequenas, e nenhuma tabela nova. O módulo não constrói
-- estrutura: ele abre o que já era escrito e nunca lido, e fecha o que crescia sem fim.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. MOD-SEC-02 — o evento da recusa por segundo fator
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TYPE "SecurityEventType" ADD VALUE IF NOT EXISTS 'MFA_REQUIRED';

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. MOD-SEC-03 — a carência, escrita no papel e não na pessoa
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "memberships" ADD COLUMN "mfa_grace_until" TIMESTAMPTZ(6);

-- AC-01: quem já é administrador ganha o prazo a partir de agora. Sem este backfill a
-- regra valeria no instante do deploy para toda a base — que é exatamente o que a
-- carência existe para evitar.
UPDATE "memberships"
   SET "mfa_grace_until" = now() + interval '7 days'
 WHERE "role_key" = 'TENANT_ADMIN'
   AND "status" = 'ACTIVE';

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. MOD-SEC-04 e MOD-SEC-08 — os índices da leitura e do expurgo
-- ═══════════════════════════════════════════════════════════════════════════

CREATE INDEX "audit_logs_tenant_id_actor_user_id_created_at_idx"
  ON "audit_logs"("tenant_id", "actor_user_id", "created_at" DESC);

-- O expurgo é cross-tenant por definição e varre por data pura. Um índice que começa
-- por `tenant_id` não serve a ele.
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");
CREATE INDEX "security_events_created_at_idx" ON "security_events"("created_at");

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. MOD-SEC-08 — a única exceção ao append-only, nomeada
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `audit_logs` nasceu com duas camadas: o REVOKE tira a permissão da role da aplicação,
-- e o trigger barra qualquer um — inclusive `app_maintenance` e o dono da tabela. Isso
-- estava certo enquanto nada podia apagar; com a retenção de 24 meses, uma das duas
-- portas precisa abrir.
--
-- Abre a menor: `DELETE`, só para `app_maintenance`, que é a role sem porta de rede e
-- usada apenas por job. `UPDATE` continua barrado para **todos**, inclusive ela — uma
-- trilha de que se apaga o antigo ainda é trilha; uma em que se corrige o registrado,
-- não. É a diferença entre expurgo e falsificação, e ela precisa estar no schema, não
-- na disciplina de quem escreve o job.

GRANT DELETE ON "audit_logs" TO app_maintenance;

CREATE OR REPLACE FUNCTION audit_logs_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_user = 'app_maintenance' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_logs é append-only: % não é permitido para %', TG_OP, current_user
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- `security_events` nunca teve REVOKE nem trigger, então o expurgo dela já podia rodar.
-- O que faltava era o contrário: nada impedia **corrigir** um evento de segurança. Um
-- registro de tentativa que pode ser editado não prova nada.
REVOKE UPDATE ON "security_events" FROM app_user, app_maintenance;
