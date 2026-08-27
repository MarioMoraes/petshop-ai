import { defineEnv, serviceEnvShape } from '@petshop/service-kit'
import { z } from 'zod'

/**
 * Configuração do taxidog-service, validada na subida.
 *
 * Nota sobre a porta: o plano antigo apontava 3007, que já é do
 * billing-ledger-service — a mesma colisão que empurrou o tutor-service de 3002 para
 * 3003 e o prontuário de 3004 para 3005. A numeração real segue a ordem de
 * implementação (3000 gateway, 3001 identidade, 3002 frontend, 3003 tutores,
 * 3004 pets, 3005 prontuário, 3006 agenda, 3007 financeiro, **3008 taxi dog**) e o
 * gateway resolve por `TAXIDOG_SERVICE_URL` — nenhum código depende do número.
 */

export const { loadEnv, resetEnvCache } = defineEnv('taxidog-service', {
  ...serviceEnvShape,
  TAXIDOG_SERVICE_PORT: z.coerce.number().int().default(3008),
})

export type Env = ReturnType<typeof loadEnv>
