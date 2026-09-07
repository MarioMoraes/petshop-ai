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

  /**
   * Receituário em PDF (MOD-DOC-04).
   *
   * As duas pontas são **opcionais de propósito**, pelo mesmo motivo que no financeiro:
   * sem Gotenberg ou sem bucket, a prescrição continua sendo registrada e só o arquivo
   * fica pendente, esperando o job de reprocesso. Exigi-las na subida derrubaria o
   * prontuário inteiro em um ambiente que ainda não configurou impressão de documento.
   */
  GOTENBERG_URL: z.string().optional(),
  R2_ENDPOINT: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().default('petshop-media'),
  /** R2 ignora região, mas o assinador SigV4 do SDK exige uma. */
  R2_REGION: z.string().default('auto'),
})

export type Env = ReturnType<typeof loadEnv>
