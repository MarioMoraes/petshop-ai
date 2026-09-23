-- O segundo canal da confirmação do agendamento online.
--
-- Escrita à mão, como toda migration desde o MOD-TUTOR (ver README.md).
--
-- Quem marca pelo Portal ou pelo app recebe a confirmação pelo WhatsApp e, se o WhatsApp
-- não conseguir entregar, pelo e-mail. A queda acontece no **despacho**, minutos depois
-- do enfileiramento, e nessa hora as variáveis do template já não existem (RN-14: o que
-- se congela é o texto, não os dados). Por isso o texto do e-mail é renderizado junto
-- com o do WhatsApp e fica guardado aqui, cifrado como o corpo principal, até a mensagem
-- sair por um dos dois — e aí é apagado.
--
-- Nulo em toda mensagem que não pediu segundo canal, que é quase todas.

ALTER TABLE "messages" ADD COLUMN "fallback_subject_encrypted" TEXT;
ALTER TABLE "messages" ADD COLUMN "fallback_body_encrypted" TEXT;
