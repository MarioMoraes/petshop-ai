import { ApiError } from '@petshop/api-client'
import { EmptyState, PageHeader } from '@/components/ui'
import { ButtonLink } from '@/components/links'
import { carregarMe, serverApi } from '@/lib/api'
import { SiteForm } from './site-form'
import { PlanoIndisponivel, temRecurso } from '@/components/plano-indisponivel'

/**
 * A tela do site (MOD-SITE-01 e 03).
 *
 * A ordem é a das perguntas de quem chega aqui: **o site está no ar?**, depois *o que
 * ele diz*, depois *o que ele mostra*. Começar pelos textos ofereceria o ajuste fino de
 * uma página que talvez nem esteja publicada — e ela nasce despublicada de propósito:
 * publicar é decisão, não padrão que o cliente descobre quando alguém acha a página.
 *
 * Quem tem só `site:read_leads` — a recepção — não configura nada aqui e é mandado aos
 * contatos, que é o trabalho dela.
 */

export const dynamic = 'force-dynamic'

export default async function SitePage() {
  // O plano antes de qualquer chamada: a página renderiza em paralelo com o layout, e
  // pedir a API primeiro traria o 402 para dentro da tela (ver `plano-indisponivel.tsx`).
  const sessao = await carregarMe()
  if (!temRecurso(sessao, 'SITE')) return <PlanoIndisponivel me={sessao} feature="SITE" />

  const me = await carregarMe()

  if (!me.permissions.includes('site:manage')) {
    return (
      <>
        <PageHeader title="Site" />
        <EmptyState
          title="Os contatos ficam na outra tela"
          description="Configurar e publicar a página é do administrador. O que chega pelo formulário do site está em Contatos."
          action={<ButtonLink href="/site/contatos">Ver contatos</ButtonLink>}
        />
      </>
    )
  }

  const preview = await serverApi()
    .getSitePreview()
    .catch((error: unknown) => {
      if (error instanceof ApiError) return error
      throw error
    })

  return (
    <>
      <PageHeader
        title="Site"
        subtitle={
          preview instanceof ApiError
            ? 'O serviço não respondeu'
            : preview.published
              ? 'A página está no ar'
              : 'A página ainda não foi publicada'
        }
        actions={
          <>
            <ButtonLink href="/site/galeria" variant="link">
              Fotos
            </ButtonLink>
            <ButtonLink href="/site/contatos" variant="link">
              Contatos
            </ButtonLink>
          </>
        }
      />

      {preview instanceof ApiError ? (
        <EmptyState title="Não foi possível carregar o site" description={preview.message} />
      ) : (
        <SiteForm preview={preview} />
      )}
    </>
  )
}
