import { defineEnv, serviceEnvShape } from '@petshop/service-kit'
import { z } from 'zod'

/**
 * Configuração do portal-bff, validada na subida.
 *
 * A porta 3020 vem do PRD portal_tutor_09 §"Serviço Backend" — fora do bloco 3009-3013
 * de propósito, porque o Portal é superfície de outro público e não mais um serviço de
 * domínio. O gateway resolve por `PORTAL_BFF_URL`; nenhum código depende do número.
 *
 * `ENCRYPTION_KEK` vem do `serviceEnvShape` e **não é usada aqui**: o BFF não decifra
 * nada (RN-16), e os dados pessoais que ele exibe chegam já decifrados dos serviços de
 * domínio. Fica pelo shape comum, não por necessidade.
 */

export const { loadEnv, resetEnvCache } = defineEnv('portal-bff', {
  ...serviceEnvShape,
  PORTAL_BFF_PORT: z.coerce.number().int().default(3020),
  APP_DOMAIN: z.string().default('localhost:3002'),
  MESSAGING_SERVICE_URL: z.string().url().default('http://localhost:3010'),

  /**
   * O bucket das fotos, só para **assinar** o endereço de leitura (`lib/photo-urls.ts`).
   *
   * Opcionais pela mesma razão do pet-service, e a consequência aqui é ainda mais
   * branda: sem eles a ficha do pet vem sem retrato, e nada além disso deixa de
   * funcionar. Exigi-los na subida trancaria o Portal inteiro por causa de uma imagem.
   */
  R2_ENDPOINT: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().default('petshop-media'),
  /** R2 ignora região, mas o assinador SigV4 do SDK exige uma. */
  R2_REGION: z.string().default('auto'),
})

export type Env = ReturnType<typeof loadEnv>
