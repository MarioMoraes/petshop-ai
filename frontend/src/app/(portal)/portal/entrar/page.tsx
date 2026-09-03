import { SignIn } from '@clerk/nextjs'
import { PortalFrame } from '../frame'
import { readPortalTenant } from '@/lib/portal-api'

/**
 * A entrada do tutor.
 *
 * `routing="hash"`, e não a rota catch-all que o Admin usa em `/sign-in/[[...sign-in]]`.
 * Os passos do Clerk — verificação, fator adicional, criação de conta — ficam no
 * fragmento da URL em vez de virarem caminhos próprios. A diferença é prática: com o
 * `typedRoutes` ligado, um `[[...rest]]` faz `/portal/entrar` deixar de ser um endereço
 * conhecido pelo TypeScript, e todo `redirect('/portal/entrar')` do módulo passa a não
 * compilar. Um fragmento resolve isso sem esconder nada de ninguém.
 *
 * Entrar e criar conta são a **mesma porta**: o tutor não sabe se "já tem cadastro" —
 * o cadastro que ele conhece é a ficha que o petshop tem dele, e essa é a etapa
 * seguinte, em `/portal/vincular`.
 */

export const dynamic = 'force-dynamic'

export default async function PortalSignInPage() {
  const tenant = await readPortalTenant().catch(() => null)

  return (
    <PortalFrame
      tenantName={tenant?.name ?? null}
      titulo="Acompanhe seus pets"
      descricao="Entre com o e-mail ou o telefone que você já usa no estabelecimento."
    >
      <SignIn routing="hash" signUpUrl="/portal/entrar" forceRedirectUrl="/portal" />
    </PortalFrame>
  )
}
