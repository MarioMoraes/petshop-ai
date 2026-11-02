-- MOD-IDENT-10 AC-02: encerramento com retenção legal.
-- terminated_at abre a janela de 30 dias em que o console ainda reabre a conta;
-- purged_at marca que a anonimização do D+30 passou, e daí não há volta.
ALTER TABLE "tenants"
  ADD COLUMN "terminated_at" TIMESTAMPTZ(6),
  ADD COLUMN "purged_at" TIMESTAMPTZ(6),
  ADD COLUMN "termination_reason" VARCHAR(500);
