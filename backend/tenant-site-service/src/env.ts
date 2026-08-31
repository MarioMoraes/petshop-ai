import { defineEnv, serviceEnvShape } from '@petshop/service-kit'
import { z } from 'zod'

/**
 * Configuração do tenant-site-service, validada na subida.
 *
 * A porta 3013 vem do PRD site_tenant_10; 3011 e 3012 ficam reservadas ao
 * portal-bff e ao que o MOD-PORTAL trouxer, para que a numeração continue seguindo o
 * PRD e não a ordem em que os serviços nasceram. O gateway resolve por
 * `SITE_SERVICE_URL` — nenhum código depende do número.
 *
 * `APP_DOMAIN` e `FRONTEND_INTERNAL_URL` são o par que fecha o laço da revalidação:
 * o serviço sabe montar a URL canônica de um tenant (`{slug}.{APP_DOMAIN}`) e sabe
 * onde bater para que o Next descarte a página em cache. `SITE_REVALIDATE_SECRET` é o
 * que impede qualquer um na rede de forçar re-render em massa.
 */

export const { loadEnv, resetEnvCache } = defineEnv('tenant-site-service', {
  ...serviceEnvShape,
  SITE_SERVICE_PORT: z.coerce.number().int().default(3013),
  APP_DOMAIN: z.string().default('localhost:3002'),
  FRONTEND_INTERNAL_URL: z.string().default('http://localhost:3002'),
  SITE_REVALIDATE_SECRET: z.string().default('dev-site-revalidate-secret'),

  // Mídia da galeria. O mesmo bucket do álbum do pet, em prefixo próprio.
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().default('petshop-media'),
  R2_REGION: z.string().default('auto'),
  R2_ENDPOINT: z.string().optional(),
})

export type Env = ReturnType<typeof loadEnv>
