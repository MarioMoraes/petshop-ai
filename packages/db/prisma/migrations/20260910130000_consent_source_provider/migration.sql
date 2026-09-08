-- AC-02 de MOD-NOTIF-10 — a reclamação de spam como origem de consentimento.
--
-- Separada da migration do MOD-NOTIF porque muda um enum do MOD-TUTOR, e não da
-- mensageria: quem escreve a linha continua sendo o tutor-service, que é o dono da
-- trilha jurídica. O messaging-service só publica `mensagem.reclamada`.
ALTER TYPE "ConsentSource" ADD VALUE IF NOT EXISTS 'PROVIDER';
