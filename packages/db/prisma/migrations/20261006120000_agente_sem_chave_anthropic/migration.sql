-- MOD-AI — o provedor do agente passa a ser o Google Gemini, e a chave da Anthropic sai.
--
-- Escrita à mão, como toda migration desde o MOD-TUTOR (ver README.md).
--
-- Toda chave gravada até aqui é da Anthropic: o cadastro só aceitava `sk-ant-` e a
-- conferia na Anthropic antes de gravar. Deixá-las na linha faria o agente mandar uma
-- chave da Anthropic ao Google em toda mensagem, receber a recusa e pendurar na tela um
-- "o Google recusou a chave" que não diz o que de fato aconteceu. Sem chave, a tela diz
-- a verdade — "o agente precisa da chave do Google Gemini" — e as conversas vão para a
-- recepção até o petshop cadastrar a nova.
--
-- O filtro não olha o prefixo porque a chave está cifrada com a DEK do tenant; quem
-- garante que só sai chave da Anthropic é a ordem: esta migration roda antes de o
-- código que aceita a chave do Gemini subir.

UPDATE "agent_settings"
SET "api_key_encrypted" = NULL,
    "api_key_last4" = NULL,
    "api_key_verified_at" = NULL,
    "api_key_error" = NULL
WHERE "api_key_encrypted" IS NOT NULL;
