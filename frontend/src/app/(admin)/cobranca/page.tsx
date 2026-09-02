import Link from 'next/link'
import type { ReactNode } from 'react'
import { ReceiptIcon, WalletIcon } from '@/components/icons'
import { Card, PageHeader } from '@/components/ui'

/**
 * O menu da Cobrança: um cartão por relatório.
 *
 * Cartão, e não uma lista de links, porque são só dois e cada um precisa de uma frase
 * para não ser escolhido por engano — "contas a receber" e "contas recebidas" são duas
 * palavras de diferença e respondem a perguntas opostas. O cartão tem espaço para
 * explicar; um item de lista, não.
 *
 * Cartão **branco**: aqui se lê e se escolhe, não se digita. O `tone="soft"` é da ficha
 * de formulário (`docs/design-formularios.md`, regra 1), e usá-lo aqui gastaria o sinal
 * que separa as duas coisas.
 */

interface Relatorio {
  /** União literal, e não `string`: com `typedRoutes`, é o que o `Link` aceita. */
  href: '/cobranca/contas-a-receber' | '/cobranca/recebidas-por-dia'
  icon: ReactNode
  eyebrow: string
  title: string
  description: string
}

const RELATORIOS: Relatorio[] = [
  {
    href: '/cobranca/contas-a-receber',
    icon: <WalletIcon />,
    eyebrow: 'O que falta entrar',
    title: 'Contas a receber',
    description:
      'Quem está com débito em aberto, há quantos dias e quanto. Traz o telefone de cada tutor e separa a dívida por faixa de atraso — é a folha de quem vai cobrar.',
  },
  {
    href: '/cobranca/recebidas-por-dia',
    icon: <ReceiptIcon />,
    eyebrow: 'O que já entrou',
    title: 'Contas recebidas por dia',
    description:
      'Quanto entrou em cada dia do período, dividido por forma de pagamento. É o fechamento do caixa: dinheiro de um lado, maquininha e PIX do outro.',
  },
]

export default function CobrancaPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Financeiro"
        title="Cobrança"
        subtitle="Os dois relatórios do dinheiro: o que falta entrar e o que já entrou. Cada um abre em tela e sai em PDF."
      />

      <div className="grid gap-4 sm:grid-cols-2">
        {RELATORIOS.map((relatorio) => (
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
              <h2 className="section-title mt-1">{relatorio.title}</h2>
              <p className="hint mt-2 flex-1">{relatorio.description}</p>
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
