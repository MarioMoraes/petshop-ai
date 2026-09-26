'use client'

import { useRouter } from 'next/navigation'
import { useTransition, type ReactNode } from 'react'
import { ButtonLink } from '@/components/links'
import { Button } from '@/components/ui'

/**
 * Os filtros dos relatórios de cobrança.
 *
 * O estado vive na **URL**, e não em `useState`, pela mesma razão do painel de
 * mensagens: o filtro é a pergunta que alguém está fazendo, e uma pergunta que não cabe
 * num link não pode ser mandada para quem vai responder. É também o que faz o botão de
 * PDF ser um `<a>` honesto — ele aponta para a mesma pergunta, na outra forma.
 *
 * Cartão branco: aqui há campos, mas o cartão não é uma ficha de cadastro — é a barra de
 * recorte de uma tela de leitura, e o `tone="soft"` de `docs/design-formularios.md`
 * marcaria como formulário o que é filtro.
 */

/**
 * As telas que usam esta barra — contas a receber, recebidas por dia e os três do
 * caixa. Literal por causa de `typedRoutes`.
 */
type ReportPath =
  | '/financeiro/relatorios/contas-a-receber'
  | '/financeiro/relatorios/recebidas-por-dia'
  | '/financeiro/relatorios/caixa/periodo'
  | '/financeiro/relatorios/caixa/forma-de-pagamento'
  | '/financeiro/relatorios/caixa/tutor'

interface Props {
  /** Para onde o `router.push` vai. Os campos montam a query. */
  basePath: ReportPath
  /** Endereço do PDF **com os filtros correntes já aplicados**. Sem ele, sem botão. */
  pdfHref?: string
  children: ReactNode
  /** Sobe o `submit` do formulário; os campos são `name`d e o browser monta a query. */
  onSubmitLabel?: string
}

export function ReportFilters({ basePath, pdfHref, children, onSubmitLabel = 'Aplicar' }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  return (
    <form
      className="card flex flex-wrap items-end gap-4 p-5"
      onSubmit={(event) => {
        event.preventDefault()
        const data = new FormData(event.currentTarget)
        const search = new URLSearchParams()
        for (const [key, value] of data.entries()) {
          if (typeof value === 'string' && value !== '') search.set(key, value)
        }
        startTransition(() => router.push(`${basePath}?${search.toString()}`))
      }}
    >
      {children}

      <div className="ml-auto flex items-center gap-2">
        <Button type="submit" busy={pending} busyLabel="Carregando…">
          {onSubmitLabel}
        </Button>
        {/*
         * `<a>` e não `<button>`: o PDF é um endereço, e um link pode ser aberto em
         * outra aba, copiado ou mandado para quem vai imprimir. `download` deixa o
         * navegador salvar em vez de abrir o visor por cima da tela que a pessoa
         * estava lendo — o `content-disposition` da rota já diz o mesmo, e os dois
         * juntos cobrem os navegadores que ignoram um ou outro.
         */}
        {pdfHref && (
          <a href={pdfHref} download className="btn btn-primary">
            Baixar PDF
          </a>
        )}
      </div>
    </form>
  )
}

/** Volta à aba de relatórios. Sempre no mesmo canto. */
export function BackToRelatorios() {
  return <ButtonLink href="/financeiro/relatorios">Voltar</ButtonLink>
}
