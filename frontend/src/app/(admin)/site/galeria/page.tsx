import Link from 'next/link'
import { ApiError } from '@petshop/api-client'
import { AlertTriangleIcon, ShieldCheckIcon } from '@/components/icons'
import { EmptyState, PageHeader } from '@/components/ui'
import { carregarMe, serverApi } from '@/lib/api'
import { GalleryManager } from './gallery-manager'
import { PlanoIndisponivel, temRecurso } from '@/components/plano-indisponivel'

/**
 * A galeria do site (MOD-SITE-04).
 *
 * O teto de doze fotos é de produto, não técnico: uma página de petshop com quarenta
 * fotos é uma página que ninguém rola até o fim e que demora a carregar no 4G da
 * calçada.
 */

export const dynamic = 'force-dynamic'

export default async function SiteGalleryPage() {
  // O plano antes de qualquer chamada: a página renderiza em paralelo com o layout, e
  // pedir a API primeiro traria o 402 para dentro da tela (ver `plano-indisponivel.tsx`).
  const sessao = await carregarMe()
  if (!temRecurso(sessao, 'SITE')) return <PlanoIndisponivel me={sessao} feature="SITE" />

  const me = await carregarMe()

  if (!me.permissions.includes('site:manage')) {
    return (
      <>
        <PageHeader title="Fotos do site" />
        <EmptyState
          icon={<ShieldCheckIcon />}
          tone="icon-system"
          title="Esta tela é do administrador"
          description="As fotos que aparecem no site são configuradas por quem administra o estabelecimento."
        />
      </>
    )
  }

  const photos = await serverApi()
    .listSitePhotos()
    .then((response) => response.items)
    .catch((error: unknown) => {
      if (error instanceof ApiError) return error
      throw error
    })

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href="/site" className="hover:underline">
            ← Site
          </Link>
        }
        title="Fotos do site"
        subtitle="A primeira foto abre a página; as demais entram na galeria"
      />

      {photos instanceof ApiError ? (
        <EmptyState
          icon={<AlertTriangleIcon />}
          title="Não foi possível carregar as fotos"
          description={photos.message}
        />
      ) : (
        <GalleryManager photos={photos} />
      )}
    </>
  )
}
