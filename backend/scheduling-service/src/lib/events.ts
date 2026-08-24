import { createEventPublisher } from '@petshop/service-kit'
import type { AgendaEventMap } from '@petshop/shared-types'
import { loadEnv } from '../env.js'
import { logger } from './logger.js'

/** Publicação dos eventos da agenda (PRD agenda_operacao_06 §8). */

export const { publishEvent, closeEvents } = createEventPublisher<AgendaEventMap>({
  logger,
  getUrl: () => loadEnv().RABBITMQ_URL,
  isDisabled: () => loadEnv().DISABLE_EVENTS,
})
