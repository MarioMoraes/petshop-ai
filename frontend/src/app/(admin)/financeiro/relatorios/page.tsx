import Link from 'next/link'
import { titleCase } from '@petshop/shared-types'
import type { ReactNode } from 'react'
import type { PermissionKey } from '@petshop/shared-types'
import { BanknoteIcon, ReceiptIcon, ShieldCheckIcon, WalletIcon } from '@/components/icons'
import { Card, EmptyState, PageHeader } from '@/components/ui'
import { carregarMe } from '@/lib/api'
import { FinanceiroTabs } from '../financeiro-tabs'

/**
 * A aba de relatórios do Financeiro: um cartão por relatório.
 *
 * Os dois da antiga Cobrança — o que falta entrar e o que já entrou — e o cartão do
 * caixa, que abre as três opções dele. Cartão, e não lista de links, porque "contas a
 * receber" e "contas recebidas" são duas palavras de diferença e respondem a perguntas
 * opostas: o cartão tem espaço para uma frase que evita a escolha errada.
 *
 * Cada cartão exige a sua permissão, e o que levaria a uma recusa não aparece: os de
 * cobrança são `finance:configure` (listam nome e telefone de quem deve); o do caixa,
 * `cash:read`, que a recepção tem.
 *
 * Cartão **branco**: aqui se lê e se escolhe, não se digita. O `tone="soft"` é da ficha
 * de formulário (`docs/design-formularios.md`, regra 1).
 */

export const dynamic = 'force-dynamic'

interface Relatorio {
  /** União literal, e não `string`: com `typedRoutes`, é o que o `Link` aceita. */
  href:
    | '/financeiro/relatorios/contas-a-receber'
    | '/financeiro/relatorios/recebidas-por-dia'
    | '/financeiro/relatorios/caixa'
  icon: ReactNode
  eyebrow: string
  title: string
  description: string
  cta: string
  requires: PermissionKey
}

const RELATORIOS: Relatorio[] = [
  {
    href: '/financeiro/relatorios/contas-a-receber',
    icon: <WalletIcon />,
    eyebrow: 'O que falta entrar',
    title: 'Contas a receber',
    description:
      'Quem está com débito em aberto, há quantos dias e quanto. Traz o telefone de cada tutor e separa a dívida por faixa de atraso — é a folha de quem vai cobrar.',
    cta: 'Abrir relatório',
    requires: 'finance:configure',
  },
  {
    href: '/financeiro/relatorios/recebidas-por-dia',
    icon: <ReceiptIcon />,
    eyebrow: 'O que já entrou',
    title: 'Contas recebidas por dia',
    description:
      'Quanto entrou em cada dia do período, dividido por forma de pagamento — com ou sem caixa aberto. Dinheiro de um lado, maquininha e PIX do outro.',
    cta: 'Abrir relatório',
    requires: 'finance:configure',
  },
  {
    href: '/financeiro/relatorios/caixa',
    icon: <BanknoteIcon />,
    eyebrow: 'O que passou pela gaveta',
    title: 'Relatórios do Caixa',
    description:
      'Vendas avulsas e pagamentos de tutor recebidos no caixa, por período, por forma de pagamento ou por tutor.',
    cta: 'Ver opções',
    requires: 'cash:read',
  },
]

export default async function RelatoriosPage() {
  const me = await carregarMe()
  const relatorios = RELATORIOS.filter((relatorio) => me.permissions.includes(relatorio.requires))

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Financeiro"
        title="Relatórios"
        subtitle="O dinheiro que falta entrar, o que já entrou e o que passou pelo balcão."
      />

      <FinanceiroTabs />

      {relatorios.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-3">
          {relatorios.map((relatorio) => (
            <Link
              key={relatorio.href}
              href={relatorio.href}
              className="group rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <Card className="flex h-full flex-col transition-shadow group-hover:shadow-lg">
                <span className="icon-chip icon-money" aria-hidden="true">
                  {relatorio.icon}
                </span>
                <p className="section-eyebrow mt-4">{relatorio.eyebrow}</p>
                <h2 className="section-title mt-1">{titleCase(relatorio.title)}</h2>
                <p className="hint mt-2 flex-1">{relatorio.description}</p>
                <p className="mt-5 text-sm font-medium text-accent">
                  {relatorio.cta} <span aria-hidden="true">→</span>
                </p>
              </Card>
            </Link>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<ShieldCheckIcon />}
          tone="icon-system"
          title="Nenhum relatório para o seu papel"
          description="Os relatórios financeiros são da recepção e do administrador."
        />
      )}
    </div>
  )
}
