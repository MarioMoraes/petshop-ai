import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'

/**
 * Roteamento por estado da conta.
 *
 * O redirecionamento fino — qual etapa do wizard exibir — acontece na página, que
 * tem acesso à API. Aqui fica só o que dá para decidir a partir do token: quem não
 * está autenticado vai para o login, e quem já tem sessão não fica preso nele.
 */

const isPublicRoute = createRouteMatcher(['/sign-in(.*)', '/sign-up(.*)', '/api/health'])

export default clerkMiddleware(async (auth, request) => {
  const { userId } = await auth()

  if (!userId && !isPublicRoute(request)) {
    return (await auth()).redirectToSignIn({ returnBackUrl: request.url })
  }

  if (userId && isPublicRoute(request)) {
    return NextResponse.redirect(new URL('/', request.url))
  }

  return NextResponse.next()
})

export const config = {
  matcher: [
    // Tudo, menos arquivos estáticos e internos do Next.
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
}
