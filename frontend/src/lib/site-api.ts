import 'server-only'
import {
  PublicSiteResponseSchema,
  type PublicSiteResponse,
  type SiteLeadInput,
} from '@petshop/shared-types'

/**
 * O cliente do `tenant-site-service`, para o SSR da página pública.
 *
 * **Não passa pelo gateway**, ao contrário de `lib/api.ts`. O gateway existe para
 * validar a sessão do Clerk e assinar o contexto para os serviços; a página do petshop
 * não tem sessão nenhuma para validar, e abrir no gateway um ramo anônimo publicaria a
 * API interna para o mundo. Quem fala com o serviço é o Next, pela rede interna, e o
 * browser nunca o alcança.
 *
 * O `slug` viaja na querystring porque é o que a borda resolveu do host — e não um
 * header que o cliente pudesse forjar.
 */

const baseUrl = process.env.SITE_SERVICE_URL ?? 'http://localhost:3013'

/** Distingue "não existe" de "o serviço caiu" — a página trata as duas diferente. */
export class SiteNotFoundError extends Error {}
export class SiteUnavailableError extends Error {}

/**
 * O payload da página.
 *
 * `revalidate: 600` põe a resposta no cache de dados do Next: a página é reconstruída
 * a cada dez minutos, e o serviço fora do ar continua servindo o que está em cache
 * (AC-04 de MOD-SITE-11) — o site tem SLO de 24/7 e o petshop opera em horário
 * comercial. A `tag` é o que a revalidação sob demanda usa quando o admin muda o
 * horário: o evento chega ao serviço, que chama `/api/site/revalidate`.
 */
export async function fetchPublicSite(slug: string): Promise<PublicSiteResponse> {
  let response: Response
  try {
    response = await fetch(`${baseUrl}/public/v1/site?slug=${encodeURIComponent(slug)}`, {
      next: { revalidate: 600, tags: [siteTag(slug)] },
    })
  } catch (error) {
    throw new SiteUnavailableError(`Falha ao consultar o site de ${slug}`, { cause: error })
  }

  if (response.status === 404) throw new SiteNotFoundError(slug)
  if (!response.ok) throw new SiteUnavailableError(`HTTP ${response.status}`)

  return PublicSiteResponseSchema.parse(await response.json())
}

export function siteTag(slug: string): string {
  return `site:${slug}`
}

export interface LeadResult {
  ok: boolean
  /** 429: o visitante insistiu. É a única recusa que a página explica. */
  throttled?: boolean
  message?: string
}

/**
 * Manda o formulário ao serviço.
 *
 * O IP do visitante viaja em `x-forwarded-for` porque o rate limit é por IP e, daqui
 * em diante, o único IP que o serviço veria é o do próprio Next.
 */
export async function submitLead(
  slug: string,
  input: SiteLeadInput,
  visitor: { ip: string; userAgent: string | null },
): Promise<LeadResult> {
  try {
    const response = await fetch(
      `${baseUrl}/public/v1/site/leads?slug=${encodeURIComponent(slug)}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': visitor.ip,
          ...(visitor.userAgent ? { 'user-agent': visitor.userAgent } : {}),
        },
        body: JSON.stringify(input),
        cache: 'no-store',
      },
    )

    if (response.status === 429) {
      return {
        ok: false,
        throttled: true,
        message: 'Você já enviou algumas mensagens. Tente de novo daqui a pouco.',
      }
    }

    if (!response.ok) {
      const problem = (await response.json().catch(() => null)) as { detail?: string } | null
      return { ok: false, message: problem?.detail ?? 'Não foi possível enviar. Tente de novo.' }
    }

    return { ok: true }
  } catch {
    return { ok: false, message: 'Não foi possível enviar agora. Tente de novo em instantes.' }
  }
}

/** Os bytes de uma foto da galeria, para o host do tenant repassar ao visitante. */
export async function fetchSitePhoto(
  slug: string,
  photoId: string,
): Promise<{ body: ArrayBuffer; contentType: string } | null> {
  const response = await fetch(
    `${baseUrl}/public/v1/site/photos/${photoId}?slug=${encodeURIComponent(slug)}`,
    { next: { revalidate: 3600, tags: [siteTag(slug)] } },
  ).catch(() => null)

  if (!response?.ok) return null

  return {
    body: await response.arrayBuffer(),
    contentType: response.headers.get('content-type') ?? 'image/webp',
  }
}
