-- MOD-NOTIF fatia 1 — destinatário de dois tipos, anexo por referência e o retorno
-- do provedor (PRD notificacoes_email_12 §4).
--
-- Nenhuma linha existente é reescrita: `recipient_kind` nasce com DEFAULT 'TUTOR' e o
-- parque inteiro já satisfaz o CHECK. Migration que exige backfill de tabela de fila é
-- migration que trava o deploy (AC-05 de MOD-NOTIF-01).

CREATE TYPE "MessageRecipientKind" AS ENUM ('TUTOR', 'USER');

ALTER TABLE "messages"
  ALTER COLUMN "tutor_id" DROP NOT NULL,
  ADD COLUMN "recipient_kind" "MessageRecipientKind" NOT NULL DEFAULT 'TUTOR',
  ADD COLUMN "user_id" uuid,
  ADD COLUMN "document_id" uuid;

-- `RESTRICT`, e não `SET NULL`: o histórico do que se mandou a um ex-membro é
-- auditoria (AC-04 de MOD-NOTIF-01), e `SET NULL` deixaria a linha em 'USER' sem
-- `user_id`, violando o CHECK logo abaixo. `users` é tabela global — a FK de uma
-- tabela sob RLS para uma global é o que `memberships` já faz.
ALTER TABLE "messages"
  ADD CONSTRAINT "messages_user_id_fkey" FOREIGN KEY ("user_id")
    REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A garantia é de banco, não só de schema (AC-02 de MOD-NOTIF-01).
ALTER TABLE "messages"
  ADD CONSTRAINT "messages_recipient_check" CHECK (
    ("recipient_kind" = 'TUTOR' AND "tutor_id" IS NOT NULL AND "user_id" IS NULL) OR
    ("recipient_kind" = 'USER'  AND "user_id"  IS NOT NULL AND "tutor_id" IS NULL)
  );

CREATE INDEX "idx_messages_user" ON "messages" ("tenant_id", "user_id", "created_at" DESC);
