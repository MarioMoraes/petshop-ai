-- MOD-NOTIF-12: o convite de equipe passa pelo motor. Migration à parte porque o valor
-- novo de enum não pode ser usado na mesma transação que o cria — e o CHECK seguinte o usa.
ALTER TYPE "MessageOriginType" ADD VALUE 'INVITATION';
