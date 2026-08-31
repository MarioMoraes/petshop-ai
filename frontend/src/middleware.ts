import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'
import { NextResponse, type NextFetchEvent, type NextRequest } from 'next/server'
import { routeFor, SITE_PREFIX } from '@/lib/host'

/**
 * Roteamento por host, e depois por estado da conta.
 *
 * **A ordem importa e é a mudança de risco desta fatia** (AC-02 de MOD-SITE-11): antes,
 * a única pergunta era "esta rota é pública?", e tudo o mais ia para o login. Agora a
 * primeira pergunta é **de que host veio**, porque o mesmo processo Next atende três
 * públicos:
 *
 * ```
 * petshopdojoao.{dominio}/          site público    → sem autenticação
 * petshopdojoao.{dominio}/portal    Portal do Tutor → gate próprio (MOD-PORTAL)
 * app.{dominio}                     Admin da equipe → como sempre foi
 * ```
 *
 * O site é servido por **reescrita**, não por redirecionamento: o visitante continua
 * vendo `petshopdojoao.{dominio}/` na barra, e o Next renderiza `/s/petshopdojoao`.
 * Um redirecionamento poria o caminho interno no endereço, no histórico e no que o
 * cliente manda pelo WhatsApp.
 *
 * Inverter essa ordem por engano ou expõe o Admin no host de todo tenant, ou tranca o
 * site atrás de um login — e nenhum dos dois aparece em produção até ser tarde. A
 * decisão em si mora em `lib/host.ts`, testada em `host.test.ts` e
 * `admin-routes.test.ts`; aqui só se executa o que ela mandou.
 *
 * O `clerkMiddleware` **não roda** para o site público: a página anônima não tem por
 * que pagar o custo do handshake nem carregar cookie de sessão nenhum.
 */

const isPublicRoute = createRouteMatcher(['/sign-in(.*)', '/sign-up(.*)', '/api/health'])

/**
 * Lido em tempo de execução, não `NEXT_PUBLIC_`: o prefixo público seria inlinado no
 * build e amarraria a imagem a uma instalação. O padrão de desenvolvimento não tem
 * subdomínio, então tudo cai no Admin — o comportamento anterior a esta mudança.
 */
const APP_DOMAIN = process.env.APP_DOMAIN ?? 'localhost:3002'

/**
 * Caddy termina o TLS e conversa com o Next em HTTP, então `nextUrl.protocol` diria
 * `http:` e o 301 devolveria o visitante a uma URL sem cifra. O esquema vem do
 * domínio: só uma instalação local não é HTTPS.
 */
const REDIRECT_PROTOCOL = APP_DOMAIN.startsWith('localhost') ? 'http:' : 'https:'

/** O Admin como sempre foi: quem não tem sessão vai ao login, quem tem não fica nele. */
const withClerk = clerkMiddleware(async (auth, request) => {
  const { userId } = await auth()

  if (!userId && !isPublicRoute(request)) {
    return (await auth()).redirectToSignIn({ returnBackUrl: request.url })
  }

  if (userId && isPublicRoute(request)) {
    return NextResponse.redirect(new URL('/', request.url))
  }

  return NextResponse.next()
})

export default function middleware(request: NextRequest, event: NextFetchEvent) {
  const host = request.headers.get('host') ?? ''
  const decision = routeFor(host, request.nextUrl.pathname, APP_DOMAIN)

  if (decision.action === 'redirect') {
    // A URL é montada do zero, e não copiada de `nextUrl`. Copiando, a porta interna
    // em que o Next atende atrás do Caddy (3002) viajaria junto — o setter `.host` do
    // WHATWG só troca a porta se o valor trouxer uma, e `app.meupetshop.com.br` não
    // traz. O visitante receberia um endereço com porta que a borda não publica.
    // Caminho e query são preservados: o link salvo continua levando ao mesmo lugar.
    const { pathname, search } = request.nextUrl
    const target = new URL(`${REDIRECT_PROTOCOL}//${decision.host}${pathname}${search}`)
    return NextResponse.redirect(target, decision.permanent ? 301 : 307)
  }

  // O caminho interno do site não é endereço de ninguém — nem no host do tenant, nem
  // no do Admin. Reescrever para uma rota inexistente é o 404 do Next sem inventar
  // uma página de erro própria.
  if (decision.action === 'notFound') {
    return NextResponse.rewrite(new URL('/404-nao-encontrado', request.url))
  }

  // O site do petshop: sem sessão, sem Clerk, sem cookie. O `clerkMiddleware` **não
  // roda** aqui — a página anônima não tem por que pagar o handshake.
  if (decision.action === 'site') {
    const { pathname, search } = request.nextUrl
    const suffix = pathname === '/' ? '' : pathname
    return NextResponse.rewrite(
      new URL(`${SITE_PREFIX}/${decision.slug}${suffix}${search}`, request.url),
    )
  }

  // Portal segue sem o gate da equipe: ele ganha o próprio quando o MOD-PORTAL
  // existir; hoje as rotas não existem e o Next responde 404, que é a resposta
  // honesta para uma área que ainda não foi construída.
  if (decision.action !== 'admin') return NextResponse.next()

  return withClerk(request, event)
}

export const config = {
  matcher: [
    // Tudo, menos arquivos estáticos e internos do Next.
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
}
