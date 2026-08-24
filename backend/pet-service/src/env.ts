import { defineEnv, serviceEnvShape } from '@petshop/service-kit'
import { z } from 'zod'

/**
 * Configuração do pet-service, validada na subida.
 *
 * Nota sobre a porta: o PRD pets_03 aponta 3003, que já é do tutor-service (que por
 * sua vez saiu de 3002 porque essa é do frontend). O serviço fica em 3004 e o
 * gateway resolve por `PET_SERVICE_URL` — nenhum código depende do número em si.
 */

export const { loadEnv, resetEnvCache } = defineEnv('pet-service', {
  ...serviceEnvShape,
  PET_SERVICE_PORT: z.coerce.number().int().default(3004),

  /**
   * Storage das fotos (MOD-PET-04) — R2 pela API S3.
   *
   * Opcionais de propósito: o serviço sobe sem eles e só o álbum deixa de funcionar,
   * devolvendo 502 `ERR_PET_009`. Exigi-los na subida derrubaria o cadastro de pets
   * inteiro em um ambiente que ainda não configurou o bucket.
   */
  R2_ENDPOINT: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().default('petshop-media'),
  /** R2 ignora região, mas o assinador SigV4 do SDK exige uma. */
  R2_REGION: z.string().default('auto'),
})

export type Env = ReturnType<typeof loadEnv>
