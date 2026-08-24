import { createEventPublisher } from '@petshop/service-kit'
import type { RecordEventMap } from '@petshop/shared-types'
import { loadEnv } from '../env.js'
import { logger } from './logger.js'

/** Publicação dos eventos do prontuário (PRD prontuario_04 §8). */

export const { publishEvent, closeEvents } = createEventPublisher<RecordEventMap>({
  logger,
  getUrl: () => loadEnv().RABBITMQ_URL,
  isDisabled: () => loadEnv().DISABLE_EVENTS,
})
