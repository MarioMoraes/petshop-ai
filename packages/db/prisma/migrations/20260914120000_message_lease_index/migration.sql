-- ─────────────────────────────────────────────────────────────────────────────
-- A posse do worker, encontrável
-- ─────────────────────────────────────────────────────────────────────────────

-- `SENDING` é o estado que a mensagem ocupa enquanto o worker fala com o provedor:
-- segundos, e nunca mais que um punhado deles ao mesmo tempo. O varredor de posses
-- abandonadas (`messaging.reap-leases`) pergunta de cinco em cinco minutos quem está
-- ali há mais de dez, e sem índice essa pergunta varre a tabela inteira — que é o
-- histórico de todas as mensagens já enviadas.
--
-- Parcial pelo mesmo motivo do `idx_messages_dispatch`: o índice guarda a fração
-- minúscula que está em trânsito, e não o arquivo morto.
CREATE INDEX "idx_messages_lease" ON "messages" ("updated_at")
  WHERE "status" = 'SENDING';
