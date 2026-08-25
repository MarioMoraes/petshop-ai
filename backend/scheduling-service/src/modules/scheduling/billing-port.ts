import type { TenantTransaction } from '@petshop/db'
import type { BillingPort, CreditStatus } from './gates.js'

/**
 * A implementação real do `BillingPort` — o RN-11 ligado ao MOD-LEDGER.
 *
 * Lê `ledger_accounts` e `billing_settings` **direto**, sob `withTenant`, e não por
 * HTTP. É o mesmo acoplamento assumido que `findBlockingAlerts` já tem com as tabelas
 * do prontuário, pela razão que aquele comentário dá: uma chamada HTTP no caminho de
 * criação do agendamento abriria outra transação do outro lado — o que não ajuda em
 * consistência — e acrescentaria latência de rede a um gate que roda com o tutor na
 * frente do atendente.
 *
 * O que muda em relação ao padrão que estava aqui: `creditLimitCents` deixa de ser
 * sempre nulo. O petshop que configurou o limite em `/financeiro/configuracoes` passa a
 * ver o bloqueio acontecer.
 */

interface AccountRow {
  balance_cents: bigint | null
  credit_limit_cents: bigint | null
}

export const livePort: BillingPort = {
  async creditStatus(tx: TenantTransaction, tutorId: string): Promise<CreditStatus> {
    // Uma consulta só. O `LEFT JOIN` cobre os dois casos normais: tutor sem conta ainda
    // (RN-17 — ela nasce no primeiro lançamento) e tenant que nunca abriu a tela de
    // políticas. Nos dois, o resultado correto é "não deve nada, nada bloqueia".
    const rows = await tx.$queryRaw<AccountRow[]>`
      SELECT a.balance_cents, s.credit_limit_cents
        FROM (SELECT ${tutorId}::uuid AS tutor_id) AS t
        LEFT JOIN ledger_accounts a ON a.tutor_id = t.tutor_id
        LEFT JOIN billing_settings s ON s.tenant_id = current_tenant_id()
    `

    const row = rows[0]
    return {
      balanceCents: Number(row?.balance_cents ?? 0),
      creditLimitCents: row?.credit_limit_cents === null || row?.credit_limit_cents === undefined
        ? null
        : Number(row.credit_limit_cents),
    }
  },
}
