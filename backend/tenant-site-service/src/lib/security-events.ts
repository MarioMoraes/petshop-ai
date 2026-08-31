import { createSecurityEvents } from '@petshop/service-kit'
import { logger, recordMetric } from './logger.js'

/**
 * Eventos de segurança (MOD-SEC).
 *
 * O peso aqui é o da superfície pública: o formulário aberto ao mundo é o único
 * caminho anônimo de escrita do sistema inteiro. Estouro de rate limit e honeypot
 * preenchido viram registro — não porque cada um importe, mas porque o padrão deles
 * ao longo de um dia é o que diz se alguém está varrendo a instalação.
 */

export const recordSecurityEvent = createSecurityEvents({ logger, recordMetric })

export type { SecurityEventInput } from '@petshop/service-kit'
