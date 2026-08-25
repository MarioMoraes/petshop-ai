import { defineEnv, serviceEnvShape } from '@petshop/service-kit'
import { z } from 'zod'

/**
 * Configuração do billing-ledger-service, validada na subida.
 *
 * Nota sobre a porta: o PRD financeiro_tutor_05 diz 3005, mas essa já é do
 * `medical-record-service`. A numeração real segue a ordem de implementação —
 * 3000 gateway, 3001 identidade, 3002 frontend, 3003 tutores, 3004 pets,
 * 3005 prontuário, 3006 agenda, **3007 financeiro**. O gateway resolve por
 * `BILLING_LEDGER_SERVICE_URL`; nenhum código depende do número.
 */

export const { loadEnv, resetEnvCache } = defineEnv('billing-ledger-service', {
  ...serviceEnvShape,
  BILLING_LEDGER_SERVICE_PORT: z.coerce.number().int().default(3007),

  /**
   * Recibo em PDF (MOD-LEDGER-08).
   *
   * As duas pontas são **opcionais de propósito**: sem Gotenberg ou sem bucket, o
   * pagamento continua sendo registrado e só o comprovante fica pendente, esperando o
   * job de reprocesso. Exigi-las na subida derrubaria o financeiro inteiro em um
   * ambiente que ainda não configurou impressão de documento.
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
