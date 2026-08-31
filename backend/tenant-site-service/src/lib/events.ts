import { createEventPublisher } from '@petshop/service-kit'
import type { SiteEventMap } from '@petshop/shared-types'
import { loadEnv } from '../env.js'
import { logger } from './logger.js'

/**
 * Publicação dos eventos do site (PRD site_tenant_10 §8).
 *
 * `lead.recebido` sai desde já, mesmo sem consumidor que o transforme em aviso: o
 * evento é o registro de que a coisa aconteceu, e o dia em que o messaging-service
 * souber falar com destinatário interno o aviso liga sem tocar neste serviço.
 */

export const { publishEvent, closeEvents } = createEventPublisher<SiteEventMap>({
  logger,
  getUrl: () => loadEnv().RABBITMQ_URL,
  isDisabled: () => loadEnv().DISABLE_EVENTS,
})
