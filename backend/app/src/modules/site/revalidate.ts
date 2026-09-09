import { resolveTenantById } from '@petshop/db'
import { loadEnv } from '../../config/env.js'
import { logger } from '../../shared/logger.js'
import { invalidateSite } from '../../shared/redis.js'

/**
 * Avisa o Next para descartar a página em cache daquele host (AC-03 de MOD-SITE-11).
 *
 * Sem isso, o horário corrigido às 9h aparece ao meio-dia e a promessa central do
 * template alimentado por dados vira mentira — porque **não existe uma segunda cópia
 * do horário para manter**, mas existe uma segunda cópia da página.
 *
 * É best-effort de propósito: a página tem TTL de dez minutos de qualquer forma, e
 * derrubar uma publicação porque o frontend não respondeu trocaria um atraso de dez
 * minutos por um erro na cara do admin.
 *
 * O segredo compartilhado não protege dado nenhum — a página é pública. Protege
 * **custo**: sem ele, qualquer um na rede força re-render de todos os sites em laço.
 */
/**
 * Descarta as **duas** cópias da página: o payload no Redis do serviço e o HTML no
 * cache do Next.
 *
 * Toda escrita que muda o que a página mostra passa por aqui — texto, foto,
 * publicação — e também os eventos de outros módulos. Invalidar só o Redis deixaria o
 * Next servindo o HTML antigo por até dez minutos, e o admin veria a tela de
 * configuração dizendo uma coisa e o site dizendo outra.
 *
 * O slug vem de `resolveTenantById` porque nem todo chamador o tem em mãos, e é uma
 * consulta de plataforma barata e cacheada pelo Postgres.
 */
export async function refreshSite(tenantId: string): Promise<void> {
  const tenant = await resolveTenantById(tenantId)
  await invalidateSite(tenantId, tenant?.slug)
  if (tenant) await revalidateSite(tenant.slug)
}

export async function revalidateSite(slug: string): Promise<void> {
  const env = loadEnv()

  try {
    const response = await fetch(`${env.FRONTEND_INTERNAL_URL}/api/site/revalidate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-site-revalidate-secret': env.SITE_REVALIDATE_SECRET,
      },
      body: JSON.stringify({ slug }),
      // Cinco segundos, e não três: a primeira chamada depois de um deploy — ou a
      // primeira em desenvolvimento, quando o Next ainda compila a rota — chega a
      // levar quatro. Passar do teto aqui não quebra nada, só faz a página esperar o
      // TTL de dez minutos; é um atraso invisível que custaria caro para diagnosticar.
      signal: AbortSignal.timeout(5_000),
    })

    if (!response.ok) {
      logger.warn({ slug, status: response.status }, 'revalidação do site recusada')
    }
  } catch (error) {
    logger.warn({ err: error, slug }, 'falha ao revalidar o site')
  }
}
