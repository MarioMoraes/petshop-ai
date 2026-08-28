import { createEventPublisher } from '@petshop/service-kit'
import type { MessagingEventMap } from '@petshop/shared-types'
import { loadEnv } from '../env.js'
import { logger } from './logger.js'

/**
 * Eventos do relacionamento (PRD relacionamento_crm_08 §8).
 *
 * Nenhum deles carrega o corpo da mensagem. O texto tem nome, pet, horário e às vezes
 * valor devido no mesmo parágrafo, e um evento é a coisa mais copiada do sistema —
 * vai para a fila, para o DLX, para o log de quem consome. Quem precisa do corpo lê a
 * mensagem pela API, com permissão.
 */

export const { publishEvent, closeEvents } = createEventPublisher<MessagingEventMap>({
  logger,
  getUrl: () => loadEnv().RABBITMQ_URL,
  isDisabled: () => loadEnv().DISABLE_EVENTS,
})
