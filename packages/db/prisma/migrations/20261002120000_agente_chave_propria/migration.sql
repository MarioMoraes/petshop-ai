-- MOD-AI — a chave do provedor passa a ser do estabelecimento.
--
-- Escrita à mão, como toda migration desde o MOD-TUTOR (ver README.md).
--
-- Até aqui o agente respondia com a chave da Anthropic da instalação, e a PetShop AI pagava
-- o consumo de todos. Agora cada petshop cadastra a sua em Configurações › Integrações, e
-- sem ela o agente responde como desligado. A chave é cifrada com a DEK do tenant, como
-- todo segredo por tenant; a tela só recebe os quatro últimos caracteres.
--
-- `api_key_error` guarda a recusa do provedor no meio de uma conversa — a chave revogada
-- no painel da Anthropic só aparece assim, e a tela precisa dizer por que o agente parou.

ALTER TABLE "agent_settings"
  ADD COLUMN "api_key_encrypted" TEXT,
  ADD COLUMN "api_key_last4" VARCHAR(4),
  ADD COLUMN "api_key_verified_at" TIMESTAMPTZ(6),
  ADD COLUMN "api_key_error" VARCHAR(300);
