-- MOD-AI fatia 1 — a porta de entrada que o canal nunca teve
-- (PRD agentes_ia_15 §4, MOD-AI-01, 02 e 06).
--
-- `MessageDirection.INBOUND` existe desde o MOD-NOTIF e **nenhuma linha do sistema
-- escrevia uma**: o webhook da Evolution tratava pareamento e conexão e descartava o
-- resto. Estas duas tabelas são o que falta para a mensagem recebida virar conversa, e a
-- conversa virar fila da recepção.
--
-- O agente de verdade — tools, provedor e custo — é a fatia seguinte. As colunas de
-- token e de custo já nascem aqui porque são do mesmo INSERT que o turno humano faz, e
-- acrescentá-las depois exigiria reescrever o caminho de escrita inteiro por causa de
-- três inteiros que começam em zero.

CREATE TYPE "AgentConversationStatus" AS ENUM ('ACTIVE', 'HANDOFF', 'ASSIGNED', 'CLOSED');

-- Os seis primeiros são os do §6 do PRD. Os quatro últimos não estão lá porque o §6
-- desenha a máquina do agente **respondendo**; nesta fatia todo caminho termina na
-- recepção, e sem dizer qual caminho foi a fila mostraria conversas idênticas.
CREATE TYPE "AgentHandoffReason" AS ENUM (
  'REQUESTED', 'SENTIMENT', 'UNRESOLVED', 'TOO_LONG', 'BUDGET', 'ERROR',
  'DISABLED', 'UNKNOWN_NUMBER', 'AMBIGUOUS', 'MEDIA'
);

CREATE TYPE "AgentTurnRole" AS ENUM ('TUTOR', 'AGENT', 'STAFF');
CREATE TYPE "AgentSentiment" AS ENUM ('POSITIVE', 'NEUTRAL', 'NEGATIVE');
CREATE TYPE "AgentInboundKind" AS ENUM ('TEXT', 'AUDIO', 'IMAGE', 'VIDEO', 'DOCUMENT', 'OTHER');

CREATE TABLE "agent_conversations" (
  "id"        UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,

  -- Nulo em dois casos legítimos: número sem ficha (AC-02 de MOD-AI-01) e número em
  -- duas fichas (AC-03). Nos dois a conversa existe e precisa ser respondida.
  "tutor_id" UUID,
  "channel"  "MessageChannel" NOT NULL DEFAULT 'WHATSAPP',

  -- A chave da conversa é o **telefone**, não o tutor: é o que reencontra a conversa
  -- viva quando a segunda mensagem chega de um número que o produto não conhece.
  "contact_encrypted" TEXT NOT NULL,
  "contact_hash"      CHAR(64) NOT NULL,

  "status"         "AgentConversationStatus" NOT NULL DEFAULT 'ACTIVE',
  "handoff_reason" "AgentHandoffReason",
  "handoff_at"     TIMESTAMPTZ(6),

  "assigned_to" UUID,
  "assigned_at" TIMESTAMPTZ(6),

  "cost_cents" INTEGER NOT NULL DEFAULT 0,
  "turn_count" INTEGER NOT NULL DEFAULT 0,

  "last_turn_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closed_at"    TIMESTAMPTZ(6),

  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "agent_conversations_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "agent_conversations"
  ADD CONSTRAINT "agent_conversations_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  -- `SET NULL`: a anonimização do titular (MOD-TUTOR-08) solta o vínculo e apaga o corpo
  -- dos turnos; a contagem sobrevive para o painel de qualidade.
  ADD CONSTRAINT "agent_conversations_tutor_id_fkey" FOREIGN KEY ("tutor_id")
    REFERENCES "tutors"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  -- Handoff sem motivo seria uma fila sem triagem: quem abre não saberia por que a
  -- conversa está ali, e a recepção abriria uma por uma para descobrir.
  --
  -- **Implicação, e não equivalência.** A conversa encerrada **guarda** o motivo pelo
  -- qual passou por gente: é o que distingue, no painel de qualidade, a que o agente
  -- resolveu sozinho da que a recepção teve de atender (AC-02 de MOD-AI-09). Um `=`
  -- aqui obrigaria a apagar essa história para poder fechar a conversa.
  ADD CONSTRAINT "agent_conversations_handoff_check" CHECK (
    "status" NOT IN ('HANDOFF', 'ASSIGNED') OR "handoff_reason" IS NOT NULL
  );

CREATE INDEX "idx_agent_conv_tenant_status"
  ON "agent_conversations" ("tenant_id", "status");

-- A fila da recepção, ordenada por espera (§4 do PRD).
CREATE INDEX "idx_agent_conv_fila"
  ON "agent_conversations" ("tenant_id", "last_turn_at")
  WHERE "status" = 'HANDOFF';

-- "Existe conversa viva deste número?" — uma vez por mensagem recebida. Por
-- `contact_hash`, e não por `tutor_id`, porque o número desconhecido também conversa.
CREATE INDEX "idx_agent_conv_contato_vivo"
  ON "agent_conversations" ("tenant_id", "contact_hash", "last_turn_at")
  WHERE "status" IN ('ACTIVE', 'HANDOFF', 'ASSIGNED');

ALTER TABLE "agent_conversations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_conversations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "agent_conversations"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

CREATE TABLE "agent_turns" (
  "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"       UUID NOT NULL,
  "conversation_id" UUID NOT NULL,

  "role"       "AgentTurnRole" NOT NULL,
  "kind"       "AgentInboundKind" NOT NULL DEFAULT 'TEXT',
  -- Sem FK: `messages` vive sob RLS no mesmo tenant, e a retenção do MOD-CRM apaga
  -- corpo sem apagar linha. O turno sobrevive à mensagem como o histórico sobrevive ao
  -- expurgo.
  "message_id" UUID,

  -- O campo mais sensível do módulo (§9): é o que o cliente resolveu escrever.
  "content_encrypted" TEXT NOT NULL,

  "input_tokens"      INTEGER NOT NULL DEFAULT 0,
  "output_tokens"     INTEGER NOT NULL DEFAULT 0,
  "cache_read_tokens" INTEGER NOT NULL DEFAULT 0,

  "sentiment" "AgentSentiment",
  "author_id" UUID,

  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "agent_turns_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "agent_turns"
  ADD CONSTRAINT "agent_turns_conversation_id_fkey" FOREIGN KEY ("conversation_id")
    REFERENCES "agent_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "idx_agent_turns_conv" ON "agent_turns" ("conversation_id", "created_at");

ALTER TABLE "agent_turns" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_turns" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "agent_turns"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON "agent_conversations", "agent_turns"
  TO app_user, app_maintenance;

-- ═══════════════════════════════════════════════════════════════════════════
-- AC-04 de MOD-AI-01 — a reentrega da Evolution
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Ela reenvia o que não recebe 2xx, e reenviar um `messages.upsert` já processado
-- criaria uma segunda linha `INBOUND` e um segundo turno da mesma frase. A barreira é do
-- **banco**, não do código: um `SELECT` antes do `INSERT` perde a corrida entre duas
-- entregas simultâneas, e é justamente em rajada que o provedor reentrega.
--
-- O nome é `idx_messages_inbound_provider` e não `idx_messages_provider` porque este
-- segundo já existe desde o MOD-CRM: é o índice **não** único, por `(provider,
-- provider_message_id)`, que casa o callback do provedor com a mensagem que saiu. São
-- duas perguntas diferentes sobre a mesma coluna, e as duas continuam valendo.
--
-- **Parcial em duas condições, e as duas são necessárias.** `provider_message_id` é nulo
-- em toda mensagem que ainda não saiu, e um índice único total impediria a segunda
-- mensagem a entrar na fila. E ele só vale para `INBOUND`: no `OUTBOUND` o id é o que o
-- provedor devolveu — informativo, de dois provedores diferentes, e sem promessa de
-- unicidade entre eles.
CREATE UNIQUE INDEX "idx_messages_inbound_provider"
  ON "messages" ("tenant_id", "provider_message_id")
  WHERE "provider_message_id" IS NOT NULL AND "direction" = 'INBOUND';

-- ═══════════════════════════════════════════════════════════════════════════
-- AC-02 de MOD-AI-01 — a mensagem recebida de um número sem ficha
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `messages_recipient_check` nasceu no MOD-NOTIF-01 para garantir **exatamente um
-- destinatário**, e ele era a pergunta certa enquanto toda mensagem saía daqui: ou vai
-- para um tutor, ou vai para um membro da equipe.
--
-- Mensagem que **chega** não tem destinatário nesse sentido — quem a recebeu foi o
-- número do petshop. E o AC-02 é explícito: o número sem ficha grava a linha `INBOUND`
-- com `tutor_id = NULL`, porque a conversa existe e a recepção precisa vê-la. Sem esta
-- mudança, a única saída seria não gravar a mensagem de quem ainda não é cliente, que é
-- justamente a que mais interessa a um petshop.
--
-- O que o CHECK continua garantindo do lado de entrada: `user_id` é sempre nulo. Recado
-- de trabalho para funcionário não chega pelo WhatsApp do estabelecimento.
ALTER TABLE "messages" DROP CONSTRAINT "messages_recipient_check";

ALTER TABLE "messages"
  ADD CONSTRAINT "messages_recipient_check" CHECK (
    ("direction" = 'INBOUND' AND "user_id" IS NULL) OR
    ("direction" = 'OUTBOUND' AND (
      ("recipient_kind" = 'TUTOR' AND "tutor_id" IS NOT NULL AND "user_id" IS NULL) OR
      ("recipient_kind" = 'USER'  AND "user_id"  IS NOT NULL AND "tutor_id" IS NULL)
    ))
  );
