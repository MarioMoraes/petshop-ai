-- O sino passa a avisar do agendamento que o tutor marcou no Portal.
--
-- É a primeira e única fonte do sino com estado de lido. As outras cinco são
-- consultas ao trabalho parado e caem sozinhas quando o trabalho é feito; um
-- agendamento já confirmado não tem o que resolver, então sem esta coluna o
-- contador nunca zeraria.

-- Por vínculo, e não por usuário: quem atende dois estabelecimentos tem duas caixas.
ALTER TABLE "memberships"
  ADD COLUMN "portal_bookings_seen_at" TIMESTAMPTZ(6);

-- Índice parcial — o Prisma só declara unicidade e índice total, então ele mora aqui
-- (ver o README desta pasta).
--
-- Serve as duas contagens do sino que recortam por origem: a fila da triagem
-- (`status = PENDING`) e a novidade (`created_at > visto em`). O `source = 'PORTAL'`
-- na cláusula é o que mantém o índice pequeno: o agendamento de balcão é a esmagadora
-- maioria das linhas e nenhuma das duas perguntas olha para ele.
CREATE INDEX "idx_appointments_portal_recentes"
  ON "appointments" ("tenant_id", "created_at" DESC)
  WHERE "source" = 'PORTAL';
