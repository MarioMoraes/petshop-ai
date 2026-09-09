import type { JobDefinition } from '@petshop/job-scheduler'
import { detectOverdue } from '../modules/ledger/credit.js'
import { expirePackages } from '../modules/ledger/packages.js'
import { reconcileAccounts } from '../modules/ledger/reconciliation.js'
import { retryPendingReceipts } from '../modules/ledger/receipts.js'

/**
 * A grade do financeiro.
 *
 * Os três primeiros rodam de madrugada, na janela de baixa que o §10 pede — e em
 * minutos diferentes de propósito: encadeadas no mesmo minuto, três varreduras
 * cross-tenant disputariam o pool do Prisma entre si.
 *
 * A ordem também importa. Expirar pacotes fecha compras; a reconciliação confere o que
 * sobrou; a inadimplência lê o resultado das duas. Rodar a inadimplência antes da
 * reconciliação marcaria contas cuja divergência ainda não foi detectada.
 *
 * **Os nomes são os mesmos de quando isto era serviço.** O lease é por nome, e renomear
 * faria réplicas velhas e novas rodarem o mesmo job em paralelo durante o deploy.
 */

export const ledgerJobs: JobDefinition[] = [
  {
    name: 'ledger.expire-packages',
    schedule: '0 3 * * *',
    run: (now) => expirePackages(now),
  },
  {
    name: 'ledger.reconcile',
    schedule: '15 3 * * *',
    run: (now) => reconcileAccounts(now),
  },
  {
    name: 'ledger.detect-overdue',
    schedule: '20 3 * * *',
    run: (now) => detectOverdue(now),
  },
  {
    // De dez em dez minutos, não de madrugada: um recibo que não saiu é um tutor
    // esperando o comprovante agora, não amanhã.
    name: 'ledger.retry-receipts',
    schedule: '*/10 * * * *',
    timeoutMs: 5 * 60_000,
    run: (now) => retryPendingReceipts(now),
  },
]
