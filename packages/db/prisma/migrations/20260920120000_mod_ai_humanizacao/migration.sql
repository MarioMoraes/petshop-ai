-- MOD-AI — o atendimento humanizado (MOD-AI-07).
--
-- O agente nasceu com o tom do catálogo de mensagens do MOD-CRM: seco, sem emoji, sem
-- tentar soar íntimo. A regra é boa **onde nasceu** — disparo em massa que finge
-- intimidade é o que denuncia o robô —, e é a regra errada numa conversa em que o
-- cliente escreveu primeiro e está esperando resposta. Estas duas colunas movem a
-- decisão para quem responde pelo número.
--
-- O que elas **não** fazem é mexer no aviso de automação. Ele continua fora da mão do
-- tenant (§9 do PRD): a persona entra dentro da frase do aviso, e não no lugar dela.

-- O registro da conversa. `SOBRIO` é o comportamento de antes desta migration,
-- preservado como escolha em vez de apagado — há público que não quer conversa.
CREATE TYPE "AgentTone" AS ENUM ('SOBRIO', 'CORDIAL', 'CALOROSO');

ALTER TABLE "agent_settings"
  -- Primeiro nome, e por isso 24 e não 160: é o que cabe numa apresentação de WhatsApp
  -- ("Sou a Lia, o atendimento automático do Pet Feliz"). Um campo largo convidaria a
  -- escrever uma frase inteira aqui, que é como a persona acabaria comendo o aviso.
  ADD COLUMN "persona_name" VARCHAR(24),
  -- `CORDIAL` é o padrão **inclusive para quem já tem linha**: o default vale para as
  -- existentes, e é a mudança que este arquivo existe para fazer. Quem quiser o tom
  -- anterior escolhe `SOBRIO` na tela.
  ADD COLUMN "tone" "AgentTone" NOT NULL DEFAULT 'CORDIAL';

-- Nome em branco é nome ausente. Sem isto, `''` passaria pelo NOT NULL que não existe e
-- produziria "Sou , o atendimento automático do ..." — o tipo de defeito que só aparece
-- na frase que o cliente lê.
ALTER TABLE "agent_settings"
  ADD CONSTRAINT "agent_settings_persona_name_check"
  CHECK ("persona_name" IS NULL OR length(btrim("persona_name")) > 0);
