import { createLogger } from '@petshop/service-kit'
import { loadEnv } from '../config/env.js'

/**
 * Pino, JSON estruturado (SPEC §8), correlacionado por `request_id` e `tenant_id`.
 * As métricas de negócio saem por aqui, no formato `{ metric, tenantId, value, unit }`.
 *
 * **A lista de redação é a união das listas dos serviços absorvidos, e cresce a cada
 * fatia.** A união é a direção segura: redigir demais custa contexto de depuração,
 * redigir de menos vaza PII.
 *
 * O MOD-SITE trouxe o lead — nome, telefone, e-mail, mensagem, IP e user-agent de
 * alguém que só perguntou o preço do banho e não tem relação nenhuma com o petshop
 * ainda. O MOD-TAXI trouxe o endereço residencial e as instruções de acesso, o dado
 * mais sensível do sistema e o único que chega ao celular de alguém fora do balcão.
 */

export const { loggerOptions, logger, recordMetric } = createLogger({
  service: 'petshop-app',
  level: loadEnv().LOG_LEVEL,
  redact: [
    'req.headers.cookie',
    '*.email',
    '*.phone',
    '*.name',
    '*.fullName',
    '*.message',
    '*.ipAddress',
    '*.userAgent',
    // MOD-TAXI (§9): endereço e instruções de acesso.
    '*.street',
    '*.number',
    '*.complement',
    '*.accessNotes',
    '*.notes',
    '*.latitude',
    '*.longitude',
  ],
})

export type { BusinessMetric } from '@petshop/service-kit'
