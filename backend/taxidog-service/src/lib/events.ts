import { createEventPublisher } from '@petshop/service-kit'
import type { TaxiEventMap } from '@petshop/shared-types'
import { loadEnv } from '../env.js'
import { logger } from './logger.js'

/**
 * Publicação dos eventos do Taxi Dog (PRD taxi_dog_07 §8).
 *
 * Nenhum deles move dinheiro: a cobrança da corrida entra como item do agendamento e
 * o débito nasce do `atendimento.concluido` do MOD-AGENDA (RN-05). O que sai daqui é
 * o que o MOD-CRM precisa para falar com o tutor.
 */

export const { publishEvent, closeEvents } = createEventPublisher<TaxiEventMap>({
  logger,
  getUrl: () => loadEnv().RABBITMQ_URL,
  isDisabled: () => loadEnv().DISABLE_EVENTS,
})
