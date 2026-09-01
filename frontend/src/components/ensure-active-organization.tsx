'use client'

import { useEffect, useState } from 'react'
import type { Route } from 'next'
import { useOrganizationList } from '@clerk/nextjs'
import { useRouter } from 'next/navigation'
import { StoreIcon } from './icons'

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
 *
 * **Com dois ou mais vínculos e nenhum `slug`, pergunta.** Antes desta versão o
 * componente simplesmente não fazia nada nesse caso — e como quem chama exibia
 * "Preparando seu estabelecimento…" ao lado, a pessoa com dois petshops ficava nessa
 * frase para sempre, sem erro em lugar nenhum e sem nada para clicar. Escolher por ela
 * seria pior: entraria no estabelecimento errado sem ter dito nada.
 */
export function EnsureActiveOrganization({
  slug,
  redirectTo,
  waiting = false,
}: {
  /** Slug do estabelecimento a ativar. O slug do tenant é o mesmo da Organization. */
  slug?: string
  /** Para onde ir depois. Sem isto, apenas recarrega a página atual. */
  redirectTo?: Route
  /**
   * Quem chama já sabe que existe vínculo — e portanto que há o que esperar.
   *
   * A distinção importa porque o mesmo componente é usado acima do wizard de quem
   * ainda **não** tem estabelecimento nenhum: lá um "Preparando seu estabelecimento…"
   * apareceria por um instante, contradizendo a tela logo abaixo, que pede o nome do
   * petshop que a pessoa vai criar.
   */
  waiting?: boolean
} = {}) {
  const router = useRouter()
  const [escolhido, setEscolhido] = useState<string | null>(null)
  const { isLoaded, setActive, userMemberships } = useOrganizationList({
    userMemberships: { infinite: true },
  })

  const organizacoes = (userMemberships.data ?? []).map((m) => m.organization)
  // Escolher é sempre do usuário; daqui em diante só se ativa o que é inequívoco.
  const ambiguo = !slug && escolhido === null && organizacoes.length > 1

  useEffect(() => {
    if (!isLoaded || !setActive) return

    const alvo = slug ?? escolhido
    const organization = alvo
      ? organizacoes.find((org) => org.slug === alvo)
      : organizacoes.length === 1
        ? organizacoes[0]
        : undefined
    if (!organization) return

    void setActive({ organization: organization.id }).then(() => {
      if (redirectTo) router.replace(redirectTo)
      else router.refresh()
    })
    // `organizacoes` é derivado de `userMemberships.data` e ganha identidade nova a
    // cada render; a dependência é o dado, não o array recriado.
  }, [isLoaded, setActive, userMemberships.data, router, slug, redirectTo, escolhido])

  // Com `slug` quem chamou já tem a própria mensagem na tela (o aceite de convite diz
  // "Entrando…"); duplicar aqui seria falar duas vezes.
  if (slug) return null

  if (ambiguo) {
    return (
      <div className="card w-full max-w-md px-6 py-8">
        <h1 className="text-center text-xl font-semibold">Onde você quer entrar?</h1>
        <p className="hint mt-2 text-center">
          Você faz parte de mais de um estabelecimento. Depois dá para trocar pelo topo da
          tela.
        </p>
        <ul className="mt-6 space-y-2">
          {organizacoes.map((organization) => (
            <li key={organization.id}>
              <button
                type="button"
                onClick={() => setEscolhido(organization.slug)}
                className="flex w-full items-center gap-3 rounded-xl border border-line px-4 py-3 text-left transition hover:bg-black/[0.03]"
              >
                <span className="icon-tint icon-brand shrink-0">
                  <StoreIcon />
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {organization.name}
                </span>
                <span aria-hidden className="text-muted">
                  →
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    )
  }

  // Um vínculo só (ou ainda carregando, ou já escolhido): o efeito acima resolve, e o
  // que a pessoa vê enquanto isso é esta linha. Vale também para o vínculo que existe
  // no nosso banco e ainda não no Clerk — o tenant preso em `PROVISIONING`, que o job
  // de retry vai destravar (AC-03 de MOD-IDENT-01).
  return waiting ? <p className="hint">Preparando seu estabelecimento…</p> : null
}
