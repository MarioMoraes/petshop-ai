import { defineEnv, serviceEnvShape } from '@petshop/service-kit'
import { z } from 'zod'

/**
 * Configuração do medical-record-service, validada na subida.
 *
 * Nota sobre a porta: o PRD prontuario_04 aponta 3004, que já é do pet-service —
 * a mesma colisão que fez o tutor-service sair de 3002 para 3003. A numeração real
 * segue a ordem de implementação (3000 gateway, 3001 identidade, 3002 frontend,
 * 3003 tutores, 3004 pets, **3005 prontuário**) e o gateway resolve por
 * `MEDICAL_RECORD_SERVICE_URL` — nenhum código depende do número em si.
 */

export const { loadEnv, resetEnvCache } = defineEnv('medical-record-service', {
  ...serviceEnvShape,
  MEDICAL_RECORD_SERVICE_PORT: z.coerce.number().int().default(3005),
})

export type Env = ReturnType<typeof loadEnv>
