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
  '/crm',
  '/dashboard',
  '/equipe',
  '/financeiro',
  '/onboarding',
  '/pets',
  '/sign-in',
  '/site',
  '/sign-up',
  '/taxi',
  '/tutores',
] as const

/** O que o host do tenant serve, além do site público. */
export const PORTAL_PREFIX = '/portal'

/**
 * Onde o site do tenant mora de verdade, dentro do `src/app`.
 *
 * O visitante nunca vê este prefixo: `petshopdojoao.{dominio}/` é **reescrito** para
 * `/s/petshopdojoao`, e o endereço na barra continua sendo o do petshop. O segmento
 * existe porque um mesmo processo Next atende três públicos e a raiz já tem dono — a
 * entrada do Admin —; sem um caminho próprio, as duas páginas disputariam `app/page.tsx`
 * e o site não poderia ter política de cache própria (ISR de dez minutos).
 *
 * **Pedir `/s/...` diretamente é 404**, em qualquer host. Sem essa guarda,
 * `tenantA.{dominio}/s/tenantB` serviria o site do vizinho sob o endereço errado —
 * conteúdo duplicado para o buscador e confusão para quem lê a barra.
 */
export const SITE_PREFIX = '/s'

/**
 * Caminhos que passam sem gate nenhum, **em qualquer host**.
 *
 * `/api/health` é o que o orquestrador consulta. `/api/site/revalidate` é chamado pelo
 * `tenant-site-service` pela rede interna, com `Host: frontend:3002` — um host que
 * `resolveHost` classifica como Admin, e sem esta lista a chamada terminaria num
 * redirecionamento para a tela de login. O gate dele é o segredo compartilhado, na
 * própria rota.
 */
export const HEALTH_PATH = '/api/health'
export const SITE_REVALIDATE_PATH = '/api/site/revalidate'
const ALWAYS_PUBLIC: readonly string[] = [HEALTH_PATH, SITE_REVALIDATE_PATH]

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
  /**
   * O site público do tenant: passa sem autenticação nenhuma, reescrito para o
   * caminho onde a página mora. O `slug` vem daqui, e não de um header — quem decide
   * de que petshop se fala é a borda.
   */
  | { action: 'site'; slug: string }
  /** Passa sem autenticação nenhuma, sem reescrita. */
  | { action: 'public' }
  /** Caminho que não é endereço de ninguém: 404 sem chegar a rota nenhuma. */
  | { action: 'notFound' }
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
  if (ALWAYS_PUBLIC.includes(pathname)) return { action: 'public' }

  // O caminho interno do site não é endereço de ninguém: nem no host do tenant, onde
  // duplicaria a própria página sob a URL errada, nem no do Admin, onde publicaria o
  // site de qualquer tenant a quem soubesse o slug.
  if (matchesPrefix(pathname, SITE_PREFIX)) return { action: 'notFound' }

  const resolved = resolveHost(host, appDomain)
  if (resolved.kind === 'admin') return { action: 'admin' }

  const adminHost = `app.${appDomain}`

  if (matchesPrefix(pathname, PORTAL_PREFIX)) return { action: 'portal' }
  if (isAdminPath(pathname)) return { action: 'redirect', host: adminHost, permanent: true }

  /**
   * Tudo o mais no host do tenant é o site. O slug sai da resolução do host, e a
   * página vive em `/s/{slug}`; caminho que não existe lá dentro vira 404 do Next, e
   * não um 301 — redirecionamento permanente fica no cache do browser e amarraria uma
   * futura página do site a um destino errado, sem como desfazer.
   */
  // `kind === 'tenant'` garante o slug; a guarda existe para o TypeScript e para o
  // dia em que `resolveHost` ganhar um caminho novo.
  if (!resolved.slug) return { action: 'admin' }
  return { action: 'site', slug: resolved.slug }
}
