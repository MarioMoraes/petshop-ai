-- MOD-AI — o áudio recebido guarda a própria descrição, para a Evolution conseguir baixá-lo.
--
-- Escrita à mão, como toda migration desde o MOD-TUTOR (ver README.md).
--
-- O download pedia a mídia à Evolution só pelo id da mensagem, e a Evolution procura esse
-- id no banco dela — que não guarda mensagem nenhuma, de propósito
-- (`DATABASE_SAVE_DATA_NEW_MESSAGE=false`: o histórico é do produto, cifrado com a DEK do
-- tenant). Todo áudio respondia "Message not found" e ia para a recepção. A descrição que
-- o webhook já traz (url, chave de decifra) é suficiente para ela baixar sem o banco, e
-- mora aqui, cifrada como o corpo.

ALTER TABLE "messages" ADD COLUMN "media_encrypted" TEXT;
