import { redirect } from 'next/navigation'
import { auth } from '@clerk/nextjs/server'
import { PortalError, readPortalContext } from '@/lib/portal-api'

/**
 * `/portal` — o desvio, e não uma tela.
 *
 * Três estados possíveis, e o tutor não precisa saber em qual está: sem sessão, vai ao
 * login; com sessão e sem ficha vinculada, vai ao vínculo; vinculado, vai ao início.
 *
 * A decisão mora aqui e não no middleware porque só o `GET /portal/v1/me` sabe
 * responder a pergunta do meio — "esta conta já é um tutor deste petshop?" —, e essa
 * resposta vem do banco, não do cookie.
 */

export const dynamic = 'force-dynamic'

export default async function PortalEntryPage() {
  const { userId } = await auth()
  if (!userId) redirect('/portal/entrar')

  try {
    await readPortalContext()
  } catch (error) {
    // 401 é o estado normal de quem acabou de criar a conta: existe no Clerk, ainda não
    // é tutor deste petshop. Qualquer outro erro sobe — página em branco por engolir
    // exceção é pior que a tela de erro do Next.
    if (error instanceof PortalError && error.status === 401) redirect('/portal/vincular')
    throw error
  }

  redirect('/portal/inicio')
}
