import { defineEnv, serviceEnvShape } from '@petshop/service-kit'
import { z } from 'zod'

/**
 * Configuração do scheduling-service, validada na subida.
 *
 * Nota sobre a porta: o PRD agenda_operacao_06 não fixa uma, e a numeração real
 * segue a ordem de implementação — 3000 gateway, 3001 identidade, 3002 frontend,
 * 3003 tutores, 3004 pets, 3005 prontuário, **3006 agenda**. O gateway resolve por
 * `SCHEDULING_SERVICE_URL`; nenhum código depende do número.
 */

export const { loadEnv, resetEnvCache } = defineEnv('scheduling-service', {
  ...serviceEnvShape,
  SCHEDULING_SERVICE_PORT: z.coerce.number().int().default(3006),
})

export type Env = ReturnType<typeof loadEnv>
