-- MOD-CRM-12 — o texto é da campanha, e não do catálogo.
--
-- Escrita à mão, como toda migration desde o MOD-TUTOR (ver README.md).
--
-- Até aqui a campanha manual apontava para `campaign_broadcast`, um texto por
-- estabelecimento, editado em Mensagens › Textos. Duas campanhas seguidas dividiam a
-- mesma mensagem, e reescrevê-la para a de hoje reescrevia a que ficou agendada para a
-- semana que vem. Agora o texto nasce com a campanha.
--
-- Nulo é o comportamento anterior: a campanha usa o texto do catálogo. É o que mantém de
-- pé as campanhas que já existem, e a de reativação, que nasce do job.

ALTER TABLE "campaigns"
  ADD COLUMN "body" TEXT,
  ADD COLUMN "subject" VARCHAR(160);
