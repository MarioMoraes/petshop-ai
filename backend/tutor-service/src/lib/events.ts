import { createEventPublisher } from '@petshop/service-kit'
import type { TutorEventMap } from '@petshop/shared-types'
import { loadEnv } from '../env.js'
import { logger } from './logger.js'

/** Publicação dos eventos de tutor (PRD tutores_02 §8). */

export const { publishEvent, closeEvents } = createEventPublisher<TutorEventMap>({
  logger,
  getUrl: () => loadEnv().RABBITMQ_URL,
  isDisabled: () => loadEnv().DISABLE_EVENTS,
})
