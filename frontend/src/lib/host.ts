import { isReservedSlug } from '@petshop/shared-types'

/**
 * Roteamento por host (MOD-SITE-11, AC-01 e AC-02).
 *
 * A decisão de 2026-08-28 dividiu as superfícies **por público**, não por tenant:
 *
 * ```
 * petshopdojoao.{dominio}/          site público do petshop
 * petshopdojoao.{dominio}/portal    Portal do Tutor
 * app.{dominio}                     Admin da equipe
 * ```
 *
 * O motivo de o Admin sair para um host próprio é de segurança: o site público é a
 * superfície mais exposta do sistema — anônima, cacheada, com formulário aberto ao
 * mundo — e o cookie de sessão de quem opera o petshop não tem por que dividir origem
 * com ela.
 *
 * Este módulo é **função pura de propósito**: recebe host, caminho e domínio, e devolve
 * a decisão. O middleware só a executa. Errar aqui expõe o Admin ou tranca o site atrás
 * de um login, e nenhum dos dois é visível em produção até ser tarde — daí a lógica
 * viver longe do `NextRequest`, onde dá para exercitá-la de verdade.
 */

/**
 * As rotas do Admin, que mudaram de host.
 *
 * É a lista das pastas de `src/app` que exigem sessão de equipe. Manter isto correto é
 * o que separa "o Admin mudou de endereço" de "o Admin ficou público no host do
 * tenant": `admin-routes.test.ts` compara esta lista com o que existe no disco e falha
 * quando alguém cria uma tela nova sem passar por aqui.
 */
export const ADMIN_ROUTE_PREFIXES = [
  '/agenda',
  '/configuracoes',
  '/convite',
  '/dashboard',
  '/equipe',
  '/financeiro',
  '/onboarding',
  '/pets',
  '/sign-in',
  '/sign-up',
  '/taxi',
  '/tutores',
] as const

/** O que o host do tenant serve, além do site público. */
export const PORTAL_PREFIX = '/portal'

/** Sempre público, em qualquer host: é o que o orquestrador consulta. */
export const HEALTH_PATH = '/api/health'

export type HostKind = 'admin' | 'tenant'

export interface ResolvedHost {
  kind: HostKind
  /** O slug, quando o host é de um tenant. */
  slug: string | null
}

/**
 * De que host veio a requisição.
 *
 * **Host desconhecido cai em `admin`, e isso é deliberado.** Um domínio apontado para
 * este servidor por engano — ou de propósito — encontra a superfície que exige sessão,
 * não a que serve conteúdo. Entre falhar fechado e falhar aberto, numa decisão que
 * ninguém revisa depois, a escolha é fechado.
 *
 * Também é o que mantém o desenvolvimento funcionando: em `localhost:3002` não há
 * subdomínio, então tudo é Admin, exatamente como antes desta mudança.
 */
export function resolveHost(host: string, appDomain: string): ResolvedHost {
  const h = host.trim().toLowerCase()
  const domain = appDomain.trim().toLowerCase()

  if (h === '' || domain === '') return { kind: 'admin', slug: null }
  // O ápice é o host da plataforma, não de um tenant.
  if (h === domain) return { kind: 'admin', slug: null }
  if (!h.endsWith(`.${domain}`)) return { kind: 'admin', slug: null }

  const sub = h.slice(0, -(domain.length + 1))
  // `a.b.dominio` não é slug: slug não tem ponto (SLUG_REGEX).
  if (sub === '' || sub.includes('.')) return { kind: 'admin', slug: null }
  // `app`, `api`, `www`, `portal`… são da plataforma; nenhum tenant os tem.
  if (isReservedSlug(sub)) return { kind: 'admin', slug: null }

  return { kind: 'tenant', slug: sub }
}

export type RouteDecision =
  /** Segue o fluxo do Admin: exige sessão de equipe. */
  | { action: 'admin' }
  /** Passa sem autenticação nenhuma — o site público do tenant. */
  | { action: 'public' }
  /** Passa; o MOD-PORTAL traz o próprio gate, com a sessão do tutor. */
  | { action: 'portal' }
  /**
   * Vai para `app.{dominio}`, preservando caminho e query.
   *
   * `permanent` decide entre 301 e 307, e a diferença não é cosmética: o 301 fica no
   * cache do browser praticamente para sempre. Só as rotas que **de fato** mudaram de
   * endereço o recebem.
   */
  | { action: 'redirect'; host: string; permanent: boolean }

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

export function isAdminPath(pathname: string): boolean {
  return ADMIN_ROUTE_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix))
}

/**
 * O que fazer com esta requisição.
 *
 * No host do tenant o **301 é reservado às rotas do Admin**, que de fato mudaram de
 * endereço. Um caminho desconhecido segue como público e o Next responde 404 — e não
 * um 301, porque redirecionamento permanente fica no cache do browser e amarraria uma
 * futura página do site (`/sobre`, `/servicos`) a um destino errado, sem como
 * desfazer nos navegadores que já o guardaram.
 */
export function routeFor(host: string, pathname: string, appDomain: string): RouteDecision {
  if (pathname === HEALTH_PATH) return { action: 'public' }

  const resolved = resolveHost(host, appDomain)
  if (resolved.kind === 'admin') return { action: 'admin' }

  const adminHost = `app.${appDomain}`

  if (matchesPrefix(pathname, PORTAL_PREFIX)) return { action: 'portal' }
  if (isAdminPath(pathname)) return { action: 'redirect', host: adminHost, permanent: true }

  /**
   * A raiz é o único caminho que troca de dono. Hoje `app/page.tsx` é a entrada do
   * Admin; quando o MOD-SITE existir, ela passa a ser o site do petshop. Até lá vai
   * para o host do Admin — mas com **307**, porque um 301 ficaria no cache dos
   * navegadores e mandaria o visitante ao Admin mesmo depois de o site nascer, sem
   * como desfazer. Ao entregar o MOD-SITE, esta linha sai.
   */
  if (pathname === '/') return { action: 'redirect', host: adminHost, permanent: false }

  return { action: 'public' }
}
