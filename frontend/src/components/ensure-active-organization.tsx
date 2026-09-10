'use client'

import { useEffect, useState } from 'react'
import type { Route } from 'next'
import { useOrganization, useOrganizationList } from '@clerk/nextjs'
import { useRouter } from 'next/navigation'
import { StoreIcon } from './icons'
import { Button } from '@/components/ui'

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
 * **Com dois ou mais vínculos e nenhum `slug`, pergunta.** Antes disso o componente
 * simplesmente não fazia nada nesse caso — e como quem chama exibia "Preparando seu
 * estabelecimento…" ao lado, a pessoa com dois petshops ficava nessa frase para
 * sempre, sem erro em lugar nenhum e sem nada para clicar. Escolher por ela seria
 * pior: entraria no estabelecimento errado sem ter dito nada.
 *
 * ## Organization que não é estabelecimento nosso
 *
 * Nem toda Organization do Clerk corresponde a um tenant. Basta o
 * `force_organization_selection` estar ligado na instância (ver
 * `docs/setup-clerk.md` §2) para o **próprio Clerk** pedir nome e slug a quem acaba
 * de se cadastrar e criar uma Organization sozinho — sem `publicMetadata`, sem tenant
 * do outro lado. Aconteceu de verdade em 2026-09-01.
 *
 * Duas defesas nasceram daí, e valem além daquela configuração:
 *
 * 1. `knownSlugs` — só se ativa (e só se oferece na escolha) Organization que tenha
 *    vínculo no **nosso** banco. Uma órfã é ignorada, e o wizard segue: ao criar o
 *    estabelecimento de verdade nasce a Organization certa, que aí é ativada.
 * 2. Nunca chamar `setActive` na Organization **já ativa**. Sem essa guarda, uma órfã
 *    ativa virava laço: ativa, `router.refresh()`, a página volta sem tenant, ativa de
 *    novo — recarregando para sempre, sem erro em lugar nenhum.
 */
/** Quantas vezes reperguntar ao Clerk pela lista de vínculos, e de quanto em quanto. */
const MAX_BUSCAS = 6
const INTERVALO_BUSCA_MS = 1200

export function EnsureActiveOrganization({
  slug,
  redirectTo,
  waiting = false,
  knownSlugs,
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
  /**
   * Slugs dos vínculos ativos do nosso banco, de `/v1/me`. Quem não estiver aqui não
   * é estabelecimento nosso e não entra na conta. Ausente, aceita qualquer uma — é o
   * que o aceite de convite precisa, porque lá o vínculo acabou de ser criado e a
   * resposta do `/v1/me` desta página ainda é a de antes.
   */
  knownSlugs?: readonly string[]
} = {}) {
  const router = useRouter()
  const [escolhido, setEscolhido] = useState<string | null>(null)
  const [buscas, setBuscas] = useState(0)
  const { organization: ativa } = useOrganization()
  const { isLoaded, setActive, userMemberships } = useOrganizationList({
    userMemberships: { infinite: true },
  })

  const organizacoes = (userMemberships.data ?? [])
    .map((m) => m.organization)
    .filter((org) => !knownSlugs || (org.slug !== null && knownSlugs.includes(org.slug)))

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

    // Já é a ativa: reativar não muda o token e o `refresh` seguinte traria a mesma
    // página, de novo e de novo.
    if (organization.id === ativa?.id) {
      if (redirectTo) router.replace(redirectTo)
      return
    }

    void setActive({ organization: organization.id }).then(() => {
      if (redirectTo) router.replace(redirectTo)
      else router.refresh()
    })
    // `organizacoes` é derivado de `userMemberships.data` e ganha identidade nova a
    // cada render; a dependência é o dado, não o array recriado.
  }, [
    isLoaded,
    setActive,
    userMemberships.data,
    router,
    slug,
    redirectTo,
    escolhido,
    ativa?.id,
    knownSlugs,
  ])

  /*
   * O vínculo existe do nosso lado e o Clerk ainda não o conhece: pede a lista de novo.
   *
   * **É a peça que faltava para o wizard terminar.** `POST /v1/tenants` cria a
   * Organization **pelo backend**, e o cliente do Clerk no navegador não é avisado — ele
   * carregou os vínculos quando a página montou, num momento em que o usuário não tinha
   * organização nenhuma. O `router.refresh()` do wizard atualiza o **servidor**, não o
   * estado do Clerk, então `userMemberships.data` continua vazio: não há o que ativar, o
   * token nunca ganha `org_id`, e "Preparando seu estabelecimento…" fica na tela para
   * sempre. Só um F5 resolvia, e ninguém adivinha isso.
   *
   * Poucas tentativas, espaçadas: a Organization já existe quando chegamos aqui, então é
   * questão de o cliente reler. Insistir sem teto transformaria uma falha real numa
   * consulta por segundo, para sempre — daí o limite e a mensagem honesta depois dele.
   */
  const esperandoOClerk =
    isLoaded && knownSlugs !== undefined && knownSlugs.length > 0 && organizacoes.length === 0
  const desistiu = esperandoOClerk && buscas >= MAX_BUSCAS

  useEffect(() => {
    if (!esperandoOClerk || buscas >= MAX_BUSCAS) return

    const alarme = setTimeout(() => {
      setBuscas((feitas) => feitas + 1)
      void userMemberships.revalidate?.()
    }, INTERVALO_BUSCA_MS)
    return () => clearTimeout(alarme)
  }, [esperandoOClerk, buscas, userMemberships])

  // Com `slug` quem chamou já tem a própria mensagem na tela (o aceite de convite diz
  // "Entrando…"); duplicar aqui seria falar duas vezes.
  if (slug) return null

  if (ambiguo) {
    return (
      <div className="card w-full max-w-md px-6 py-8">
        <h1 className="text-center text-xl font-semibold">Onde você quer entrar?</h1>
        <p className="hint mt-2 text-center">
          Você faz parte de mais de um estabelecimento. Depois dá para trocar pelo topo da tela.
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

  /*
   * As buscas acabaram e o Clerk continua sem o vínculo. Sobram dois casos reais: o
   * tenant preso em `PROVISIONING`, que ainda não tem Organization e depende do job de
   * retry (AC-03 de MOD-IDENT-01), e uma sessão que ficou velha demais para se corrigir
   * sozinha. Nos dois, recarregar é o que resolve — e dizer isso é melhor que deixar
   * "Preparando…" girando para sempre, que foi como este bug apareceu.
   */
  if (desistiu && waiting) {
    return (
      <div className="card w-full max-w-md px-6 py-8 text-center">
        <h1 className="text-xl font-semibold">Quase lá</h1>
        <p className="hint mt-3">
          Seu estabelecimento já foi criado, mas esta aba ainda está com a sessão antiga. Recarregue
          a página para entrar.
        </p>
        <Button
          type="button"
          variant="accent"
          className="mt-6"
          onClick={() => window.location.reload()}
        >
          Recarregar
        </Button>
      </div>
    )
  }

  // Um vínculo só (ou ainda carregando, ou já escolhido): os efeitos acima resolvem, e o
  // que a pessoa vê enquanto isso é esta linha.
  return waiting ? <p className="hint">Preparando seu estabelecimento…</p> : null
}
