import { createEventPublisher } from '@petshop/service-kit'
import type { IdentityEventMap } from '@petshop/shared-types'
import { loadEnv } from '../env.js'
import { logger } from './logger.js'

/** Publicação dos eventos de identidade (PRD identidade_tenancy_01 §8). */

export const { publishEvent, closeEvents } = createEventPublisher<IdentityEventMap>({
  logger,
  getUrl: () => loadEnv().RABBITMQ_URL,
  isDisabled: () => loadEnv().DISABLE_EVENTS,
})
