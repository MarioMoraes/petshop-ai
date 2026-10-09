-- A vacina aplicada aqui baixa a dose do estoque (MOD-PRONT-08 × MOD-ESTOQUE).
--
-- Só o valor novo da origem do movimento: a ligação entre a vacina e o lote é o próprio
-- movimento (`source_type = 'VACCINATION'`, `source_id` = a vacina), como o atendimento
-- já faz com `ATTENDANCE_ITEM`. Uma coluna `stock_lot_id` em `vaccinations` seria uma
-- segunda verdade sobre de onde a dose saiu.
ALTER TYPE "StockSourceType" ADD VALUE IF NOT EXISTS 'VACCINATION';
