-- MOD-AI fatia 3 — a escrita em duas etapas (PRD agentes_ia_15, MOD-AI-04).
--
-- A fatia 2 deu ao agente as sete leituras. Esta lhe dá as três escritas — marcar,
-- cancelar e remarcar —, e o desenho inteiro existe para responder a uma pergunta que
-- não tem resposta boa em texto livre: **o cliente disse "sim" para quê?**
--
-- A resposta é uma linha de banco. O agente propõe e a proposta fica gravada com um
-- token; o "sim" do turno seguinte confirma **aquela** proposta, e não o que o modelo
-- lembrar de ter oferecido. Sem a linha, a confirmação seria a interpretação de uma
-- palavra de duas letras sobre um histórico que o próprio modelo resume.

-- ═══════════════════════════════════════════════════════════════════════════
-- Dois motivos de handoff a mais
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `OUT_OF_HOURS` fecha uma dívida da fatia 2: fora da janela do agente a conversa ia
-- para a fila com motivo `DISABLED`, e a recepção lia "o atendimento automático está
-- desligado" quando a verdade era "ainda não abriu". São duas situações diferentes para
-- quem abre a fila de manhã — uma pede configuração, a outra pede só responder.
--
-- `WRITE_FAILED` nasce com o AC-05 de MOD-AI-04: o tutor confirmou e o domínio recusou,
-- por inadimplência ou por qualquer outro gate. **O agente não insiste nem contorna** —
-- `canOverrideCredit` é sempre falso para ele, como é para o Portal —, e o que a recepção
-- precisa ver na fila é justamente que houve um pedido que não passou.
ALTER TYPE "AgentHandoffReason" ADD VALUE IF NOT EXISTS 'OUT_OF_HOURS';
ALTER TYPE "AgentHandoffReason" ADD VALUE IF NOT EXISTS 'WRITE_FAILED';

-- ═══════════════════════════════════════════════════════════════════════════
-- MOD-AI-04 — o registro do que o agente fez, e do que ele ainda só propôs
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Uma tabela para as duas coisas, e não duas: a pergunta do painel de qualidade é "o que
-- o agente fez nesta conversa", e uma consulta de leitura que falhou conta essa história
-- tanto quanto uma proposta que virou agendamento. O que separa as duas é o `status`.
CREATE TYPE "AgentToolCallStatus" AS ENUM (
  -- Leitura: aconteceu e acabou no mesmo turno.
  'EXECUTED',
  -- Escrita: proposta viva, esperando o "sim" do tutor.
  'PROPOSED',
  -- Escrita: confirmada, e a gravação aconteceu pela mesma função que o Portal usa.
  'CONFIRMED',
  -- O tutor pediu outra coisa antes de confirmar (AC-04).
  'SUPERSEDED',
  -- Passou do TTL sem confirmação (AC-03).
  'EXPIRED',
  -- A chamada foi tentada e o domínio ou a consulta recusou.
  'FAILED'
);

CREATE TABLE "agent_tool_calls" (
  "id"        UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,

  "conversation_id" UUID NOT NULL,

  -- Nulo enquanto a linha nasce **dentro** do turno, antes de a linha do turno existir:
  -- o turno só é gravado quando o modelo termina de falar, e a chamada de tool acontece
  -- no meio. O `runner` costura os dois na mesma transação em que grava o turno.
  "turn_id" UUID,

  -- O nome da tool, como o modelo a chamou. Sem FK para lista nenhuma: a lista de tools é
  -- código, e uma tool removida não deve apagar o registro de quando ela existiu.
  "tool" VARCHAR(40) NOT NULL,

  -- **Cifrado com a DEK do tenant** (§4). Carrega id de pet, data e horário escolhido —
  -- os mesmos dados das tabelas de origem, e sem motivo para estarem em claro aqui.
  "arguments_encrypted" TEXT NOT NULL,

  -- Em claro, e curto de propósito: "3 horários", "Pet não encontrado", "agendamento
  -- criado". É o que a recepção lê para entender a conversa, e o que o painel conta. O
  -- conteúdo que identifica alguém está do outro lado, cifrado.
  "result_summary" TEXT,

  "status" "AgentToolCallStatus" NOT NULL,

  -- Só nas propostas. Opaco, e conferido **dentro** da conversa: um token que valesse em
  -- qualquer conversa seria uma chave de escrita viajando pelo WhatsApp.
  "confirmation_token" VARCHAR(64),
  "expires_at"        TIMESTAMPTZ(6),

  -- Quando a proposta deixou de estar viva — confirmada, superada ou vencida.
  "resolved_at" TIMESTAMPTZ(6),

  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "agent_tool_calls_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agent_tool_calls_conversation_id_fkey" FOREIGN KEY ("conversation_id")
    REFERENCES "agent_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  -- `SET NULL` e não `CASCADE`: o expurgo do corpo de um turno não deve levar embora a
  -- contagem do que o agente fez, que é o que o painel de qualidade soma.
  CONSTRAINT "agent_tool_calls_turn_id_fkey" FOREIGN KEY ("turn_id")
    REFERENCES "agent_turns"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  -- Proposta é a única que tem token e prazo, e não existe proposta sem os dois.
  CONSTRAINT "agent_tool_calls_token_check" CHECK (
    ("status" <> 'PROPOSED') OR ("confirmation_token" IS NOT NULL AND "expires_at" IS NOT NULL)
  )
);

ALTER TABLE "agent_tool_calls" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_tool_calls" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "agent_tool_calls"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON "agent_tool_calls" TO app_user, app_maintenance;

-- **O AC-04 no banco, e não só no código.**
--
-- "Uma proposta viva por conversa" é a regra que faz o "sim" ter um antecedente só. Em
-- código ela seria uma leitura seguida de uma escrita, e duas mensagens do mesmo tutor
-- chegando juntas passariam pelas duas leituras antes de qualquer escrita. O índice é o
-- que torna a corrida impossível em vez de improvável.
CREATE UNIQUE INDEX "idx_agent_proposta_viva"
  ON "agent_tool_calls" ("conversation_id")
  WHERE "status" = 'PROPOSED';

-- O histórico de uma conversa, na ordem em que aconteceu: a tela da recepção e o
-- detalhe do painel leem por aqui.
CREATE INDEX "idx_agent_tool_calls_conv"
  ON "agent_tool_calls" ("conversation_id", "created_at");

-- O painel de qualidade (MOD-AI-09), que conta por período e por tool.
CREATE INDEX "idx_agent_tool_calls_periodo"
  ON "agent_tool_calls" ("tenant_id", "created_at");
