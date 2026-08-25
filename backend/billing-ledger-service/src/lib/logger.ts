import { createLogger } from '@petshop/service-kit'
import { loadEnv } from '../env.js'

/**
 * Pino, JSON estruturado (SPEC §8). As métricas de negócio do PRD
 * financeiro_tutor_05 §10 saem por aqui, no formato `{ metric, tenantId, value, unit }`.
 */

export const { loggerOptions, logger, recordMetric } = createLogger({
  service: 'billing-ledger-service',
  level: loadEnv().LOG_LEVEL,
  // `internalNotes` e `notes` são os dois campos que o §9 manda cifrar por conterem
  // juízo de valor sobre o tutor; `proofUrl` pode exibir dado bancário de terceiro.
  // Nada disso tem por que aparecer em log de aplicação.
  redact: [
    '*.internalNotes',
    '*.internalNotesEncrypted',
    '*.notes',
    '*.notesEncrypted',
    '*.proofUrl',
    '*.proofUrlEncrypted',
    '*.suspensionReason',
    '*.fullName',
    '*.phone',
  ],
})

export type { BusinessMetric } from '@petshop/service-kit'
