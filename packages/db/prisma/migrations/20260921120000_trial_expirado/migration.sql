-- Camada comercial, fatia 3 — o fim do período de teste.
--
-- Estado próprio, e não `SUSPENDED` com um motivo ao lado: os dois bloqueiam a escrita da
-- mesma forma (RN-04 do MOD-IDENT), mas pedem frases diferentes a quem os lê. "Suspenso"
-- diz a um petshop que nunca pagou nada que ele deve alguma coisa; "o teste terminou" diz
-- o que aconteceu. O console da plataforma também filtra um do outro — quem não assinou
-- depois do teste é conversa comercial, quem parou de pagar é cobrança.
--
-- `ADD VALUE` não roda dentro de transação que use o valor, e nada aqui o usa.
ALTER TYPE "TenantStatus" ADD VALUE IF NOT EXISTS 'TRIAL_EXPIRED' AFTER 'TRIAL';

-- A varredura do job procura teste vencido de hora em hora. Parcial, porque só o `TRIAL`
-- interessa, e é uma fração pequena da tabela.
CREATE INDEX IF NOT EXISTS "idx_tenants_trial_ends_at"
  ON "tenants" ("trial_ends_at")
  WHERE "status" = 'TRIAL';
