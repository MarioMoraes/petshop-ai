-- Decisão de negócio 8: agendamento online entra CONFIRMED por padrão; o tenant que
-- quiser triar liga esta chave e as solicitações do Portal viram PENDING com reserva
-- de 24h (AC-03 de MOD-AGENDA-06).
--
-- `DEFAULT false` deliberado: ligar aprovação para quem já opera seria mudar o
-- comportamento de um tenant existente sem que ninguém pedisse.
ALTER TABLE "tenant_settings"
  ADD COLUMN "online_booking_requires_approval" BOOLEAN NOT NULL DEFAULT false;
