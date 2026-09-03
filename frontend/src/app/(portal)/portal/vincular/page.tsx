import { redirect } from 'next/navigation'
import { auth } from '@clerk/nextjs/server'
import { PortalFrame } from '../frame'
import { readPortalTenant } from '@/lib/portal-api'
import { LinkForm } from './link-form'

/**
 * O segundo passo do acesso: casar a conta recém-criada com a ficha que o petshop já
 * tem (MOD-PORTAL-01).
 *
 * É uma etapa e não um cadastro. O tutor **já existe** no sistema — foi o balcão que o
 * cadastrou —, e o que falta é provar que a pessoa do outro lado é a dona daquele
 * contato. Criar ficha aqui produziria um "tutor" sem pet, sem histórico e sem relação
 * comercial, e deixaria qualquer um reivindicar o cadastro alheio digitando um e-mail.
 */

export const dynamic = 'force-dynamic'

export default async function VincularPage() {
  const { userId } = await auth()
  if (!userId) redirect('/portal/entrar')

  const tenant = await readPortalTenant().catch(() => null)

  return (
    <PortalFrame
      tenantName={tenant?.name ?? null}
      titulo="Confirme quem é você"
      descricao="Falta um passo para o seu acesso ficar pronto."
    >
      <LinkForm />
    </PortalFrame>
  )
}
