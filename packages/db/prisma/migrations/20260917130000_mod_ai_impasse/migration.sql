-- AC-03 de MOD-AI-05 — o impasse.
--
-- "Três turnos seguidos sem que nenhuma tool tenha sido chamada com sucesso" é uma
-- condição sobre a **sequência**, e o produto não tem onde guardá-la: `agent_tool_calls`
-- só nasce com a escrita em duas etapas, na fatia seguinte, e derivar o streak de
-- `agent_turns` exigiria uma coluna lá — que seria a mesma coisa, num lugar pior.
--
-- Um contador na conversa é o estado mínimo que responde à pergunta. Zera a cada turno em
-- que alguma consulta deu certo; chega a três e a conversa vai para gente.
ALTER TABLE "agent_conversations"
  ADD COLUMN "unresolved_streak" SMALLINT NOT NULL DEFAULT 0;
