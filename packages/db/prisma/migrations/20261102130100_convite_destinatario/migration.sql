-- MOD-NOTIF-12: o convidado é o único destinatário de equipe sem `user_id` — ele ainda
-- não tem conta. O CHECK aceita `USER` sem usuário **só** quando a mensagem nasce de um
-- convite; qualquer outro recado de equipe continua amarrado a um usuário.
-- `IS NOT DISTINCT FROM`, e não `=`: com `origin_type` nulo o `=` dá NULL, e CHECK nulo
-- deixa a linha passar.
ALTER TABLE "messages" DROP CONSTRAINT "messages_recipient_check";

ALTER TABLE "messages"
  ADD CONSTRAINT "messages_recipient_check" CHECK (
    ("direction" = 'INBOUND' AND "user_id" IS NULL) OR
    ("direction" = 'OUTBOUND' AND (
      ("recipient_kind" = 'TUTOR' AND "tutor_id" IS NOT NULL AND "user_id" IS NULL) OR
      ("recipient_kind" = 'USER'  AND "user_id"  IS NOT NULL AND "tutor_id" IS NULL) OR
      ("recipient_kind" = 'USER'  AND "user_id"  IS NULL AND "tutor_id" IS NULL
        AND "origin_type" IS NOT DISTINCT FROM 'INVITATION')
    ))
  );
