-- Os avisos da conta e o silêncio do estabelecimento suspenso.
--
-- Escrita à mão, como toda migration desde o MOD-TUTOR (ver README.md).
--
-- Uma linha só: o motivo de bloqueio que diz que o impedimento não é do tutor, e sim da
-- conta que ia falar com ele. Sem ele, uma mensagem barrada por suspensão apareceria no
-- painel de entregas como "sem consentimento" ou como falha, e o admin iria consertar o
-- cadastro de um cliente que não tem defeito nenhum.

ALTER TYPE "MessageBlockReason" ADD VALUE 'TENANT_INACTIVE';
