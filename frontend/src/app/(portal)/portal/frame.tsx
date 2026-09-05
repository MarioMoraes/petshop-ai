import type { ReactNode } from 'react'
import Link from 'next/link'
import { Logo } from '@/components/ui'

/**
 * A moldura das telas do Portal.
 *
 * Uma coluna centrada e estreita, e não o `AppShell` do Admin: o tutor abre isto no
 * celular, de pé na calçada, para ver uma coisa só. Menu lateral, topbar e atalhos são
 * mobília de quem passa o dia na tela — aqui seriam peso a carregar no 4G para
 * atrapalhar o polegar.
 *
 * O nome do petshop vem antes da marca do produto: para o tutor, isto é o site do
 * lugar onde ele leva o cachorro, e não um sistema de gestão do qual ele nunca ouviu
 * falar.
 *
 * A navegação é **um link de volta, e só** (`voltar`). Um menu com três itens ocuparia,
 * em toda tela, o espaço da informação que a tela existe para dar; e o Portal é raso o
 * bastante para que voltar sempre chegue ao início em um ou dois toques.
 *
 * O "Sair" **não** mora aqui: ele é um atalho do Início, ao lado dos outros, e uma saída
 * própria da tela de vínculo. Repeti-lo no rodapé de toda tela daria a um botão raro a
 * mesma presença que a marca do produto.
 */
export function PortalFrame({
  tenantName,
  titulo,
  descricao,
  voltar,
  acao,
  children,
}: {
  tenantName?: string | null
  titulo: string
  descricao?: string
  /**
   * Para onde o "voltar" leva, e com que rótulo. Omitido, não há link.
   *
   * A união literal, e não `string`: `typedRoutes` do Next recusa href solto, e é ele
   * que transforma um link para uma tela que ninguém criou em erro de compilação em vez
   * de um 404 que só aparece em produção. Mesma escolha do `NavItem` do `AppShell`.
   */
  voltar?: {
    href: '/portal/inicio' | '/portal/pets' | '/portal/agendamentos' | '/portal/mensagens'
    label: string
  }
  /** Um botão à direita do título — a edição da ficha, por exemplo. */
  acao?: ReactNode
  children: ReactNode
}) {
  return (
    <main className="mx-auto flex min-h-[100svh] w-full max-w-[520px] flex-col gap-6 px-5 py-10">
      <header className="flex flex-col gap-1">
        {voltar ? (
          <Link href={voltar.href} className="section-eyebrow hover:text-ink w-fit transition-colors">
            ← {voltar.label}
          </Link>
        ) : (
          tenantName && <p className="section-eyebrow">{tenantName}</p>
        )}

        <div className="flex items-start justify-between gap-3">
          <h1 className="text-[1.75rem] leading-tight font-semibold">{titulo}</h1>
          {acao}
        </div>

        {descricao && <p className="hint">{descricao}</p>}
      </header>

      {children}

      <footer className="mt-auto flex justify-center pt-8 opacity-60">
        <Logo />
      </footer>
    </main>
  )
}
