-- O preço dos planos, mudado pelo console da plataforma (camada comercial).
--
-- Escrita à mão, pelo mesmo motivo de toda migration desde o MOD-TUTOR (ver README.md).
--
-- **Duas coisas, e a segunda é o que torna a primeira segura.**
--
-- `plan_prices` é a tabela de preço vigente. Uma linha por plano, sem `tenant_id`: o preço
-- é da instalação, como `platform_admins` — e, pela mesma razão, **sem RLS**, porque não
-- há tenant a que isolá-la. O Enterprise não tem linha e nem pode ter: ele é sob consulta,
-- e um número aqui viraria uma tabela que a landing não mostra.
--
-- `tenant_subscriptions.price_cents` é o preço **contratado**, congelado na assinatura. Sem
-- ele, mudar a tabela reescreveria o que o cliente antigo lê na tela dele — ele continuaria
-- pagando R$ 299 no Asaas e vendo R$ 349 no Admin. É este o registro do grandfathering: a
-- tabela é o preço de quem chega, a coluna é o preço de quem já está.
--
-- O catálogo do código (`shared-types/plans.ts`) **não** deixa de existir: ele passa a ser
-- o padrão — o valor de partida de uma instalação nova e a reserva da landing, que é HTML
-- estático. Por isso a tabela nasce vazia, e não semeada: linha ausente significa "usa o
-- padrão", que é diferente de "alguém escolheu exatamente o padrão".

CREATE TABLE "plan_prices" (
    "plan" "Plan" NOT NULL,
    "price_cents" INTEGER NOT NULL,
    "price_yearly_cents" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Quem mexeu por último. A trilha da plataforma guarda a história; esta coluna só
    -- responde "quem foi o último" sem uma varredura em `audit_logs`.
    "updated_by" UUID,

    CONSTRAINT "plan_prices_pkey" PRIMARY KEY ("plan"),
    -- Preço zero ou negativo não é cortesia, é defeito: quem não paga é o Enterprise, que
    -- não tem linha, e a cortesia se dá pelo plano do estabelecimento.
    CONSTRAINT "plan_prices_positivos" CHECK ("price_cents" > 0 AND "price_yearly_cents" > 0)
);

ALTER TABLE "plan_prices"
  ADD CONSTRAINT "plan_prices_updated_by_fkey"
  FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE SET NULL;

-- O GRANT explícito fica pela mesma razão do `platform_admins`: um banco restaurado de
-- dump nem sempre traz os default privileges, e o sintoma é permissão negada em produção.
GRANT SELECT, INSERT, UPDATE, DELETE ON "plan_prices" TO app_user, app_maintenance;

-- ═══════════════════════════════════════════════════════════════════════════
-- O preço contratado
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "tenant_subscriptions"
  ADD COLUMN "price_cents" INTEGER,
  -- O preço que a descida agendada vai custar, fixado no dia em que foi agendada — que é
  -- o que já foi dito ao Asaas. Sem ele, uma renovação onze meses depois gravaria o preço
  -- de tabela daquele dia, que pode não ser o que o cliente foi cobrado.
  ADD COLUMN "scheduled_price_cents" INTEGER;

-- As assinaturas que já existem contrataram o preço do catálogo, que é o único que já
-- existiu até aqui. Sem este preenchimento elas leriam a tabela nova depois do primeiro
-- reajuste — que é exatamente o que a coluna existe para impedir.
UPDATE "tenant_subscriptions" SET "price_cents" = CASE
    WHEN "plan" = 'STARTER' AND "cycle" = 'YEARLY' THEN 143000
    WHEN "plan" = 'STARTER'                        THEN  14900
    WHEN "plan" = 'PRO'     AND "cycle" = 'YEARLY' THEN 287000
    WHEN "plan" = 'PRO'                            THEN  29900
END
WHERE "plan" IN ('STARTER', 'PRO');
