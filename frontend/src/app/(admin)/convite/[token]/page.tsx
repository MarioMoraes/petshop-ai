import { UserButton } from '@clerk/nextjs'
import { ApiError } from '@petshop/api-client'
import type { InvitationPreview } from '@petshop/shared-types'
import { Logo, Shell } from '@/components/ui'
import { serverApi } from '@/lib/api'
import { AcceptInvite } from './accept-invite'

/**
 * MOD-IDENT-06 — a tela do convidado.
 *
 * É a única tela do produto feita para quem ainda não pertence a estabelecimento
 * nenhum, e por isso não usa o `AppShell`: não há menu a mostrar, porque não há nada
 * que essa pessoa possa fazer além de aceitar ou fechar a aba.
 *
 * Chegar aqui exige sessão — o middleware manda para o cadastro e traz de volta pela
 * `returnBackUrl`. É de propósito: o aceite precisa saber **quem** aceitou, e o
 * e-mail da conta tem de bater com o do convite.
 */

export const dynamic = 'force-dynamic'

export default async function ConvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params

  let preview: InvitationPreview | null = null
  let erro: string | null = null

  try {
    preview = await serverApi().previewInvitation(token)
  } catch (error) {
    erro =
      error instanceof ApiError
        ? error.message
        : 'Não conseguimos verificar este convite agora. Tente novamente em instantes.'
  }

  return (
    <Shell>
      <header className="flex items-center justify-between px-6 py-5 sm:px-10">
        <Logo />
        <UserButton />
      </header>

      <main className="flex flex-1 items-start justify-center px-4 pb-16 pt-4 sm:px-10">
        <div className="w-full max-w-md">
          {preview === null || preview.status !== 'PENDING' ? (
            <ConviteIndisponivel
              motivo={erro ?? motivoDe(preview?.status ?? 'EXPIRED')}
              tenantName={preview?.tenantName ?? null}
            />
          ) : (
            <AcceptInvite token={token} preview={preview} />
          )}
        </div>
      </main>
    </Shell>
  )
}

function motivoDe(status: InvitationPreview['status']): string {
  if (status === 'ACCEPTED') return 'Este convite já foi utilizado.'
  if (status === 'REVOKED') return 'Este convite foi cancelado por quem administra o petshop.'
  return 'Este convite expirou.'
}

function ConviteIndisponivel({
  motivo,
  tenantName,
}: {
  motivo: string
  tenantName: string | null
}) {
  return (
    <div className="card px-6 py-10 text-center">
      <h1 className="text-xl font-semibold">Convite indisponível</h1>
      <p className="hint mt-3">{motivo}</p>
      <p className="hint mt-3">
        Peça um convite novo a quem administra {tenantName ? `o ${tenantName}` : 'o petshop'} — o
        link chega por e-mail e vale por sete dias.
      </p>
    </div>
  )
}
