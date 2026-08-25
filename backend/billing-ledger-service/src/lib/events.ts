import { createEventPublisher } from '@petshop/service-kit'
import type { LedgerEventMap } from '@petshop/shared-types'
import { loadEnv } from '../env.js'
import { logger } from './logger.js'

/** Publicação dos eventos do financeiro (PRD financeiro_tutor_05 §8). */

export const { publishEvent, closeEvents } = createEventPublisher<LedgerEventMap>({
  logger,
  getUrl: () => loadEnv().RABBITMQ_URL,
  isDisabled: () => loadEnv().DISABLE_EVENTS,
})
