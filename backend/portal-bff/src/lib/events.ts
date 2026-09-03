import { createEventPublisher } from '@petshop/service-kit'
import type { PortalEventMap } from '@petshop/shared-types'
import { loadEnv } from '../env.js'
import { logger } from './logger.js'

/** Publicação dos eventos do Portal (PRD portal_tutor_09 §8). */

export const { publishEvent, closeEvents } = createEventPublisher<PortalEventMap>({
  logger,
  getUrl: () => loadEnv().RABBITMQ_URL,
  isDisabled: () => loadEnv().DISABLE_EVENTS,
})
