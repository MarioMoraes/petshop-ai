'use client'

import { useEffect } from 'react'
import { useOrganizationList } from '@clerk/nextjs'
import { useRouter } from 'next/navigation'

/**
 * Ativa a Organization do usuário na sessão do Clerk.
 *
 * A Organization é criada pelo backend durante o provisionamento (MOD-IDENT-01), o
 * que a torna existente mas não *ativa* na sessão que já estava aberta. Sem
 * `setActive`, o token continua sem `org_id` e o gateway não consegue resolver o
 * tenant — o usuário ficaria preso vendo o wizard do zero.
 *
 * Com um vínculo só, ativa direto. Com vários, a escolha é do usuário
 * (MOD-IDENT-05, `switch-tenant`).
 */
export function EnsureActiveOrganization() {
  const router = useRouter()
  const { isLoaded, setActive, userMemberships } = useOrganizationList({
    userMemberships: { infinite: true },
  })

  useEffect(() => {
    if (!isLoaded || !setActive) return

    const memberships = userMemberships.data ?? []
    if (memberships.length !== 1) return

    const organization = memberships[0]?.organization
    if (!organization) return

    void setActive({ organization: organization.id }).then(() => router.refresh())
  }, [isLoaded, setActive, userMemberships.data, router])

  return null
}
