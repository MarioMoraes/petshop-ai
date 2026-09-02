-- RN-08 — o agrupamento por janela de 5 minutos.
--
-- A mensagem absorvida **não some**: ela vira `MERGED`, e o texto dela sai dentro da
-- irmã. O estado existe porque a alternativa era mentir no painel — `CANCELLED` diz
-- "alguém cancelou", e ninguém cancelou nada. É também o que mantém a idempotência: o
-- `dedupe_key` do evento absorvido continua gravado, então uma reentrega do broker
-- reconhece a duplicata em vez de concatenar o mesmo parágrafo de novo.
--
-- `ADD VALUE` dentro de transação é permitido do Postgres 12 em diante desde que o
-- valor não seja **usado** na mesma transação — não é.
ALTER TYPE "MessageStatus" ADD VALUE IF NOT EXISTS 'MERGED';

-- Quem absorveu quem. Sem FK: é referência para a mesma tabela e o mesmo tenant, e a
-- retenção do MOD-CRM-10 apaga corpos sem apagar linhas — não há o que cascatear.
ALTER TABLE "messages" ADD COLUMN "merged_into_id" UUID;
