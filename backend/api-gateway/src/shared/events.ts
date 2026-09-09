import { createEventPublisher } from '@petshop/service-kit'
import type {
  AgendaEventMap,
  IdentityEventMap,
  LedgerEventMap,
  MessagingEventMap,
  PetEventMap,
  RecordEventMap,
  SiteEventMap,
  TaxiEventMap,
  TutorEventMap,
} from '@petshop/shared-types'
import { loadEnv } from '../config/env.js'
import { logger } from './logger.js'

/**
 * A publicação de eventos do processo.
 *
 * **O parâmetro de tipo é a união dos mapas de evento dos módulos hospedados, e cresce
 * a cada fatia da consolidação**: `SiteEventMap & PetEventMap & …`. Esquecer de
 * acrescentar o mapa do módulo novo não quebra o build — só faz o `publishEvent` dele
 * recusar a routing key, o que aparece no primeiro `pnpm typecheck`.
 *
 * Do MOD-SITE, `lead.recebido` sai desde já, mesmo sem consumidor que o transforme em
 * aviso: o evento é o registro de que a coisa aconteceu, e o dia em que o
 * messaging-service souber falar com destinatário interno o aviso liga sem tocar aqui.
 * Do MOD-TAXI, nenhum evento move dinheiro — a cobrança da corrida entra como item do
 * agendamento e o débito nasce do `atendimento.concluido` do MOD-AGENDA (RN-05).
 */

export const { publishEvent, closeEvents } = createEventPublisher<
  SiteEventMap &
    TaxiEventMap &
    MessagingEventMap &
    PetEventMap &
    TutorEventMap &
    IdentityEventMap &
    RecordEventMap &
    AgendaEventMap &
    LedgerEventMap
>({
  logger,
  getUrl: () => loadEnv().RABBITMQ_URL,
  isDisabled: () => loadEnv().DISABLE_EVENTS,
})
