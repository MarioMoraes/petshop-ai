import Link from 'next/link'
import { titleCase } from '@petshop/shared-types'
import type { ReactNode } from 'react'
import { CalendarIcon, UsersIcon, WalletIcon } from '@/components/icons'
import { ButtonLink } from '@/components/links'
import { Card, PageHeader } from '@/components/ui'
import { portaoDoCaixa } from './relatorio-caixa'

/**
 * As opções dos Relatórios do Caixa: um cartão por recorte, como os demais relatórios.
 *
 * Os três somam o mesmo dinheiro — o que passou pela gaveta no período — e diferem na
 * pergunta: **quando** entrou, **como** entrou e **de quem**.
 */

export const dynamic = 'force-dynamic'

interface Opcao {
  href:
    | '/financeiro/relatorios/caixa/periodo'
    | '/financeiro/relatorios/caixa/forma-de-pagamento'
    | '/financeiro/relatorios/caixa/tutor'
  icon: ReactNode
  eyebrow: string
  title: string
  description: string
}

const OPCOES: Opcao[] = [
  {
    href: '/financeiro/relatorios/caixa/periodo',
    icon: <CalendarIcon />,
    eyebrow: 'Quando entrou',
    title: 'Caixa por período',
    description:
      'Dia a dia do período: vendas avulsas, pagamentos de tutor, sangrias e suprimentos. É o movimento da gaveta ao longo do mês.',
  },
  {
    href: '/financeiro/relatorios/caixa/forma-de-pagamento',
    icon: <WalletIcon />,
    eyebrow: 'Como entrou',
    title: 'Caixa por tipo de pagamento',
    description:
      'Quanto entrou em dinheiro, PIX, débito e crédito — para conferir com o extrato do banco e o da maquininha.',
  },
  {
    href: '/financeiro/relatorios/caixa/tutor',
    icon: <UsersIcon />,
    eyebrow: 'De quem entrou',
    title: 'Caixa por tutor',
    description:
      'Quem pagou no balcão no período, quantas vezes, quanto e de que forma. A venda avulsa fica de fora: ela não tem tutor.',
  },
]

export default async function RelatoriosCaixaPage() {
  const recusa = await portaoDoCaixa('Relatórios do Caixa')
  if (recusa) return recusa

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Financeiro"
        title="Relatórios do Caixa"
        subtitle="O dinheiro que passou pela gaveta, em três recortes. Todos abrem no mês corrente e aceitam qualquer período de até um ano."
        actions={
          <ButtonLink href="/financeiro/relatorios" variant="ghost">
            Voltar
          </ButtonLink>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        {OPCOES.map((opcao) => (
          <Link
            key={opcao.href}
            href={opcao.href}
            className="group rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <Card className="flex h-full flex-col transition-shadow group-hover:shadow-lg">
              <span className="icon-chip icon-money" aria-hidden="true">
                {opcao.icon}
              </span>
              <p className="section-eyebrow mt-4">{opcao.eyebrow}</p>
              <h2 className="section-title mt-1">{titleCase(opcao.title)}</h2>
              <p className="hint mt-2 flex-1">{opcao.description}</p>
              <p className="mt-5 text-sm font-medium text-accent">
                Abrir relatório <span aria-hidden="true">→</span>
              </p>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  )
}
