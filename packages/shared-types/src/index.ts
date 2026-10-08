import { z } from 'zod'

/**
 * As mensagens do Zod, ditas aqui e não só pelo pacote.
 *
 * O `zod` declara `"sideEffects": false`, e o build de produção do Next descarta a linha
 * em que ele próprio carrega o idioma: em produção **toda** validação dizia "Invalid
 * input" — o motivo curto, o número fora da faixa, o campo vazio —, e no `pnpm dev` a
 * mesma tela dizia o que estava errado. Este pacote não declara `sideEffects`, então a
 * chamada abaixo sobrevive ao bundler, e vale para todo schema do processo.
 */
z.config(z.locales.en())

export * from './agent.js'
export * from './br-documents.js'
export * from './crm.js'
export * from './document.js'
export * from './errors.js'
export * from './events.js'
export * from './identity.js'
export * from './import.js'
export * from './inventory.js'
export * from './ledger.js'
export * from './messaging.js'
export * from './messaging-seed.js'
export * from './money.js'
export * from './pending.js'
export * from './permissions.js'
export * from './pet.js'
export * from './portal.js'
export * from './scheduling.js'
export * from './scheduling-seed.js'
export * from './platform.js'
export * from './plans.js'
export * from './security.js'
export * from './cash.js'
export * from './site.js'
export * from './record.js'
export * from './slug.js'
export * from './subscription.js'
export * from './taxi.js'
export * from './terms.js'
export * from './text.js'
export * from './timezone.js'
export * from './tutor.js'
export * from './vaccination.js'
