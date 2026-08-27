'use client'

import { useEffect } from 'react'
import type { Route } from 'next'
import { useOrganizationList } from '@clerk/nextjs'
import { useRouter } from 'next/navigation'

/**
 * Ativa a Organization do usuário na sessão do Clerk.
 *
 * A Organization é criada pelo backend — no provisionamento (MOD-IDENT-01) ou no
 * aceite de um convite (MOD-IDENT-06) —, o que a torna existente mas não *ativa* na
 * sessão que já estava aberta. Sem `setActive`, o token continua sem `org_id` e o
 * gateway não consegue resolver o tenant: o usuário ficaria preso vendo o wizard do
 * zero, com o vínculo pronto e invisível.
 *
 * Sem `slug`, ativa quando há um vínculo só — o caso de quem acabou de criar o
 * próprio petshop. Com `slug`, ativa aquele especificamente: quem aceita um convite
 * pode já trabalhar em outro estabelecimento, e aí "o único" não existe.
 */
export function EnsureActiveOrganization({
  slug,
  redirectTo,
}: {
  /** Slug do estabelecimento a ativar. O slug do tenant é o mesmo da Organization. */
  slug?: string
  /** Para onde ir depois. Sem isto, apenas recarrega a página atual. */
  redirectTo?: Route
} = {}) {
  const router = useRouter()
  const { isLoaded, setActive, userMemberships } = useOrganizationList({
    userMemberships: { infinite: true },
  })

  useEffect(() => {
    if (!isLoaded || !setActive) return

    const memberships = userMemberships.data ?? []
    const organization = slug
      ? memberships.find((membership) => membership.organization.slug === slug)?.organization
      : memberships.length === 1
        ? memberships[0]?.organization
        : undefined
    if (!organization) return

    void setActive({ organization: organization.id }).then(() => {
      if (redirectTo) router.replace(redirectTo)
      else router.refresh()
    })
  }, [isLoaded, setActive, userMemberships.data, router, slug, redirectTo])

  return null
}
