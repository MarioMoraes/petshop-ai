import 'server-only'
import {
  PublicSiteResponseSchema,
  type PublicSiteResponse,
  type SiteLeadInput,
} from '@petshop/shared-types'

/**
 * O cliente do módulo do site, para o SSR da página pública.
 *
 * Fala com o backend no mesmo endereço de `lib/api.ts`, no prefixo `/public/` — o ramo
 * anônimo, o único que responde sem sessão. Enquanto o site era um serviço à parte,
 * este cliente batia direto na porta dele para não abrir um ramo anônimo no gateway; a
 * consolidação tirou a porta separada, e o que protege a API continua sendo a mesma
 * coisa de sempre: **o backend não é publicado**. A borda (`infra/Caddyfile`) só
 * encaminha para o Next, e nem o gateway nem o módulo alcançam a internet.
 *
 * Não é `NEXT_PUBLIC_`, pela razão de `lib/api.ts`: quem chama é o servidor do Next,
 * pela rede interna, e o browser nunca vê este endereço.
 *
 * O `slug` viaja na querystring porque é o que a borda resolveu do host — e não um
 * header que o cliente pudesse forjar.
 */

const baseUrl = process.env.API_URL ?? 'http://localhost:3000'

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
 * Quanto tempo o envio espera pelo serviço antes de desistir.
 *
 * `fetch` **não tem timeout padrão**: sem isto, um serviço que aceita a conexão e não
 * responde — reiniciando, preso num lock, esperando o banco — deixa a Server Action
 * pendurada para sempre, e o botão do visitante fica em "Enviando…" até ele fechar a
 * aba. Falhar em 10 s com uma frase é muito melhor do que não falhar nunca.
 */
const TIMEOUT_MS = 10_000

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
        signal: AbortSignal.timeout(TIMEOUT_MS),
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
    // Cai aqui tanto a recusa de conexão quanto o estouro do `TIMEOUT_MS`. A frase é a
    // mesma nos dois casos: para quem está do outro lado, "o serviço não respondeu" e
    // "o serviço demorou demais" são a mesma notícia e pedem a mesma coisa.
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
