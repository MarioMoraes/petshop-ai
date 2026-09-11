-- MOD-AI fatia 2 — o agente responde (PRD agentes_ia_15, MOD-AI-02/03/05/07/08).
--
-- A fatia 1 abriu a porta de entrada e mandou tudo para a recepção. Esta liga o modelo
-- entre as duas coisas: ele lê a agenda, os pets e a situação financeira do tutor, e
-- responde — ou passa a conversa para gente, que continua sendo o destino de tudo o que
-- ele não resolve.

-- ═══════════════════════════════════════════════════════════════════════════
-- MOD-AI-07 — a configuração por tenant
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Um por tenant, como `messaging_settings` e `taxi_settings`. `enabled` nasce **falso**,
-- pela mesma razão que o motor de mensagens: ligar um robô que fala com o cliente em nome
-- do petshop é decisão de quem responde pelo número, não um padrão que se descobre pelo
-- cliente recebendo resposta automática.
CREATE TABLE "agent_settings" (
  "tenant_id" UUID NOT NULL,

  "enabled" BOOLEAN NOT NULL DEFAULT false,

  -- Hora local do estabelecimento, `HH:MM`. Fora da janela o agente não é chamado e a
  -- conversa vai para a fila com uma resposta de horário (AC-03 de MOD-AI-07).
  "opens_at"  VARCHAR(5) NOT NULL DEFAULT '08:00',
  "closes_at" VARCHAR(5) NOT NULL DEFAULT '19:00',

  -- O teto mensal de gasto com o provedor do modelo, em centavos (AC-02 de MOD-AI-08).
  -- R$ 500 é o padrão da questão em aberto nº 3 do §11, que segue sem decisão — o número
  -- está aqui, e não em constante, justamente para o petshop poder discordar dele.
  "monthly_cap_cents" INTEGER NOT NULL DEFAULT 50000,

  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "agent_settings_pkey" PRIMARY KEY ("tenant_id"),
  CONSTRAINT "agent_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  -- Janela invertida desligaria o agente o dia inteiro sem dizer que o fez.
  CONSTRAINT "agent_settings_window_check" CHECK ("opens_at" < "closes_at")
);

ALTER TABLE "agent_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "agent_settings"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON "agent_settings" TO app_user, app_maintenance;

-- ═══════════════════════════════════════════════════════════════════════════
-- RN-13 — o custo medido, e a unidade que o §4 do PRD não comporta
-- ═══════════════════════════════════════════════════════════════════════════
--
-- O §4 pede `cost_cents Int`. **Um turno custa uma fração de centavo**: com o prefixo em
-- cache, a conta de um turno típico fica na casa de três décimos de centavo. Em centavos
-- inteiros, todo turno arredondaria para zero — o teto mensal nunca seria alcançado, o
-- custo por conversa do painel de qualidade seria sempre R$ 0,00, e o módulo perderia
-- justamente a métrica que decide se ele se paga.
--
-- A unidade passa a ser o **milésimo de centavo**. O nome da coluna diz a unidade, que é
-- a única defesa contra alguém somar milésimos achando que são centavos.
ALTER TABLE "agent_conversations" RENAME COLUMN "cost_cents" TO "cost_millicents";

ALTER TABLE "agent_turns"
  ADD COLUMN "cost_millicents" INTEGER NOT NULL DEFAULT 0;

-- O gasto do mês sai da soma dos turnos, e não das conversas: conversa que atravessa a
-- virada do mês pertenceria a um mês só, e o teto do outro herdaria o gasto dela.
CREATE INDEX "idx_agent_turns_custo" ON "agent_turns" ("tenant_id", "created_at");

-- ═══════════════════════════════════════════════════════════════════════════
-- A fila interna de turnos (§8 do PRD: "o agente é acionado pelo webhook e pela fila")
-- ═══════════════════════════════════════════════════════════════════════════
--
-- **O modelo não pode ser chamado dentro do webhook.** A Evolution reenvia o que não
-- recebe 2xx rapidamente, e um turno com tools pode levar dezenas de segundos — a
-- mensagem seria reentregue enquanto a primeira ainda estivesse sendo respondida.
--
-- `pending_at` é as duas coisas ao mesmo tempo: **desde quando** há turno esperando
-- resposta, e a **posse** de quem está respondendo. Quem vai responder move o carimbo
-- para agora num `UPDATE` condicional — só um ganha —, e o zera ao terminar. Um processo
-- que morre no meio deixa o carimbo velho, e o varredor o recolhe. É o mesmo desenho do
-- lease do despacho de mensagens, que já sobreviveu a um deploy no meio da fila.
ALTER TABLE "agent_conversations"
  ADD COLUMN "pending_at" TIMESTAMPTZ(6);

CREATE INDEX "idx_agent_conv_pendente"
  ON "agent_conversations" ("pending_at")
  WHERE "pending_at" IS NOT NULL;
