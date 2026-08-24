import { createEventPublisher } from '@petshop/service-kit'
import type { PetEventMap } from '@petshop/shared-types'
import { loadEnv } from '../env.js'
import { logger } from './logger.js'

/** Publicação dos eventos de pet (PRD pets_03 §8). */

export const { publishEvent, closeEvents } = createEventPublisher<PetEventMap>({
  logger,
  getUrl: () => loadEnv().RABBITMQ_URL,
  isDisabled: () => loadEnv().DISABLE_EVENTS,
})
