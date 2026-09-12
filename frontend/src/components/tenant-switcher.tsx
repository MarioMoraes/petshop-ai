'use client'

import { useEffect, useRef, useState } from 'react'
import { useOrganizationList } from '@clerk/nextjs'
import { useRouter } from 'next/navigation'
import type { MeResponse } from '@petshop/shared-types'
import { switchTenantAction } from '@/lib/tenant-actions'
import { CheckIcon, ChevronDownIcon, StoreIcon } from './icons'

/**
 * Como trocar de estabelecimento, para quem trabalha em mais de um.
 *
 * Dizer **onde** se está é trabalho da marca no topo da lateral, que agora leva o
 * nome do petshop. Sobra a esta peça só a troca — e troca só existe com dois
 * vínculos ou mais. Com um, o componente não desenha nada: uma seta que abre uma
 * lista de um item seria um convite falso, e a etiqueta repetiria a lateral.
 *
 * Client component porque a troca é do lado do cliente: quem carrega o `org_id` é o
 * token do Clerk, e só o `setActive` do SDK o reescreve. A lista, essa, chega pronta
 * do servidor por props — os vínculos já vieram no `/v1/me` que a moldura buscou.
 *
 * **O servidor entra antes do `setActive`** (MOD-IDENT-05): `switchTenantAction` confere
 * o vínculo, registra a troca na trilha do destino e devolve o `clerkOrgId`. Antes dela,
 * a Organization era procurada na lista do SDK e, quando não estava lá, o clique não
 * fazia nada — sem erro, sem espera, sem nada.
 */

type Membership = MeResponse['memberships'][number]

export function TenantSwitcher({
  memberships,
  currentSlug,
}: {
  memberships: Membership[]
  /** Slug do estabelecimento aberto — o do tenant que o token resolveu. */
  currentSlug: string | null
}) {
  const router = useRouter()
  const [aberto, setAberto] = useState(false)
  const [trocando, setTrocando] = useState<string | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const caixa = useRef<HTMLDivElement>(null)
  const gatilho = useRef<HTMLButtonElement>(null)

  const { isLoaded, setActive, userMemberships } = useOrganizationList({
    userMemberships: { infinite: true },
  })

  // Vínculo suspenso ou removido não é lugar para onde ir: o gateway recusaria a
  // sessão logo depois da troca, e o usuário voltaria sem entender o que aconteceu.
  const ativos = memberships.filter((m) => m.status === 'ACTIVE')
  const atual = ativos.find((m) => m.tenantSlug === currentSlug) ?? null

  useEffect(() => {
    if (!aberto) return

    function aoTeclar(evento: KeyboardEvent) {
      if (evento.key !== 'Escape') return
      setAberto(false)
      gatilho.current?.focus()
    }

    function aoApontar(evento: PointerEvent) {
      const alvo = evento.target as Node
      if (caixa.current?.contains(alvo) || gatilho.current?.contains(alvo)) return
      setAberto(false)
    }

    document.addEventListener('keydown', aoTeclar)
    document.addEventListener('pointerdown', aoApontar)
    return () => {
      document.removeEventListener('keydown', aoTeclar)
      document.removeEventListener('pointerdown', aoApontar)
    }
  }, [aberto])

  // Um vínculo só (ou nenhum): não há para onde trocar, e o nome já está na lateral.
  if (ativos.length < 2) return null

  async function trocar(destino: Membership) {
    if (destino.tenantSlug === currentSlug) {
      setAberto(false)
      return
    }
    if (!setActive) return

    setErro(null)
    setTrocando(destino.tenantSlug)

    // O servidor primeiro: é ele que sabe se o vínculo está ativo, e é a viagem que
    // deixa a troca na trilha. Recusado, nada é ativado — o contrário deixaria a pessoa
    // num contexto que o gateway barraria na primeira tela.
    const conferido = await switchTenantAction(destino.tenantId)
    if (!conferido.ok) {
      setTrocando(null)
      setErro(conferido.message)
      return
    }

    /**
     * O `clerkOrgId` vem da resposta, e a lista do SDK é só reserva.
     *
     * O slug do tenant é o mesmo da Organization — é a igualdade que o provisionamento
     * garante (MOD-IDENT-01) —, mas a lista do SDK pode estar desatualizada em relação
     * ao que o backend acabou de confirmar. É a mesma defasagem que travava o fim do
     * wizard.
     */
    const organization =
      conferido.data.clerkOrgId ||
      (userMemberships.data ?? []).find((m) => m.organization.slug === destino.tenantSlug)
        ?.organization.id
    if (!organization) {
      setTrocando(null)
      setErro('Não conseguimos abrir este estabelecimento. Recarregue a página e tente de novo.')
      return
    }

    await setActive({ organization })
    setAberto(false)

    /*
     * Vai para o início, e não fica na tela atual. O endereço de agora pode ser o de
     * um registro do estabelecimento anterior (`/pets/{uuid}`, `/tutores/{uuid}`) —
     * e esse id não existe do outro lado: o RLS o esconde, e a pessoa cairia num 404
     * logo depois de trocar, sem ligar uma coisa à outra.
     */
    router.push('/dashboard')
    router.refresh()
  }

  return (
    <div className="relative min-w-0">
      <button
        ref={gatilho}
        type="button"
        onClick={() => setAberto((estava) => !estava)}
        aria-expanded={aberto}
        aria-haspopup="menu"
        className="flex min-w-0 items-center gap-2 rounded-full px-2 py-1.5 text-base font-medium transition hover:bg-black/5"
      >
        <span className="icon-tint icon-brand shrink-0">
          <StoreIcon size={20} />
        </span>
        <span className="truncate">{atual?.tenantName ?? 'Escolher estabelecimento'}</span>
        <span aria-hidden className="shrink-0 text-muted">
          <ChevronDownIcon />
        </span>
      </button>

      {aberto && (
        <div
          ref={caixa}
          role="menu"
          aria-label="Trocar de estabelecimento"
          /*
           * A mesma ancoragem dupla do sino de pendências, pelo mesmo motivo: num
           * aparelho estreito o popover cresceria para fora da tela, e transbordo
           * lateral não gera rolagem — o conteúdo seria cortado sem sinal nenhum.
           */
          className="card fixed left-4 right-4 top-16 z-30 overflow-hidden p-0 shadow-[0_1px_0_rgba(255,255,255,0.9)_inset,0_20px_50px_-24px_rgba(35,36,39,0.35)] sm:absolute sm:left-0 sm:right-auto sm:top-11 sm:w-72"
        >
          <p className="border-b border-line px-4 py-3 text-sm font-semibold">
            Seus estabelecimentos
          </p>
          {erro && (
            <p role="alert" className="border-b border-line px-4 py-3 text-sm text-danger">
              {erro}
            </p>
          )}
          <ul>
            {ativos.map((membership) => {
              const atualEste = membership.tenantSlug === currentSlug
              return (
                <li key={membership.tenantId} className="border-b border-line last:border-b-0">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void trocar(membership)}
                    // Enquanto o SDK não trouxe os vínculos do Clerk não há `id` para
                    // ativar; o botão clicaria em falso.
                    disabled={!isLoaded || trocando !== null}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-black/[0.03] disabled:opacity-60"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-ink">
                        {membership.tenantName}
                      </span>
                      <span className="hint block truncate">{membership.roleLabel}</span>
                    </span>
                    {trocando === membership.tenantSlug ? (
                      <span className="hint shrink-0">Entrando…</span>
                    ) : atualEste ? (
                      <span aria-label="Estabelecimento aberto" className="shrink-0 text-muted">
                        <CheckIcon />
                      </span>
                    ) : null}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
