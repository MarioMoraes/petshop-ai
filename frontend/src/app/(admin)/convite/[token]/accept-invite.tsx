'use client'

import { useState, useTransition } from 'react'
import { SignOutButton, useUser } from '@clerk/nextjs'
import { maskEmail, titleCase } from '@petshop/shared-types'
import type { AcceptInvitationResult, InvitationPreview } from '@petshop/shared-types'
import { EnsureActiveOrganization } from '@/components/ensure-active-organization'
import { Button, FormError } from '@/components/ui'
import { acceptInvitationAction } from './actions'

/**
 * O botão que transforma o link em acesso.
 *
 * O aceite tem duas metades: o vínculo no nosso banco, que a ação de servidor grava, e
 * a Organization ativa na sessão do Clerk, que só o cliente consegue trocar. Entre uma
 * e outra a pessoa está no limbo — membro do estabelecimento, com um token que ainda
 * não sabe disso. Daí a tela de "entrando…" em vez de um redirecionamento imediato: é
 * o `EnsureActiveOrganization` que leva ao painel, depois que o `setActive` volta.
 *
 * A tela também confere, antes do clique, se a conta da sessão é a que foi convidada.
 * A autoridade continua sendo o servidor (`acceptInvitation` compara os hashes); aqui
 * é só para que ninguém descubra que está na conta errada **depois** de apertar o
 * botão, que foi como esse erro apareceu na prática.
 */

export function AcceptInvite({ token, preview }: { token: string; preview: InvitationPreview }) {
  const [aceito, setAceito] = useState<AcceptInvitationResult | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const { isLoaded, user } = useUser()

  const emailDaSessao = user?.primaryEmailAddress?.emailAddress ?? null
  // A comparação é feita na forma mascarada porque é só ela que o servidor devolve —
  // o e-mail do convite não pode vazar para quem abriu o link. Máscaras diferentes
  // provam contas diferentes; máscaras iguais são um forte indício, não uma garantia,
  // e é justamente por isso que o botão nunca fica bloqueado por esta conferência.
  const contaDivergente =
    isLoaded && emailDaSessao !== null && maskEmail(emailDaSessao) !== preview.maskedEmail

  function aceitar() {
    setErro(null)
    startTransition(async () => {
      const result = await acceptInvitationAction(token)
      if (result.ok) setAceito(result.data)
      else setErro(result.message)
    })
  }

  if (aceito) {
    return (
      <div className="card px-6 py-10 text-center">
        <EnsureActiveOrganization slug={aceito.tenantSlug} redirectTo="/dashboard" />
        <h1 className="text-xl font-semibold">Tudo Certo, Bem-vindo!</h1>
        <p className="hint mt-3">
          Você agora faz parte do {aceito.tenantName} como {aceito.roleLabel}. Entrando…
        </p>
      </div>
    )
  }

  return (
    <div className="card px-6 py-10">
      <p className="hint text-center">Convite de equipe</p>
      <h1 className="mt-2 text-center text-2xl font-semibold leading-tight">
        {titleCase(`Você foi convidado para trabalhar no ${preview.tenantName}`)}
      </h1>

      <dl className="mt-8 space-y-3 text-sm">
        <div className="flex items-baseline justify-between gap-3 border-b border-line pb-3">
          <dt className="hint">Seu acesso</dt>
          <dd className="font-medium">{preview.roleLabel}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3 border-b border-line pb-3">
          <dt className="hint">Convite enviado para</dt>
          <dd className="font-medium">{preview.maskedEmail}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="hint">Válido até</dt>
          <dd className="font-medium">
            {new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'long' }).format(
              new Date(preview.expiresAt),
            )}
          </dd>
        </div>
      </dl>

      {contaDivergente && (
        <div className="mt-6 rounded-xl border border-amber-300/70 bg-amber-50/80 px-4 py-3 text-sm dark:border-amber-500/30 dark:bg-amber-500/10">
          <p className="font-medium">Você está conectado como {emailDaSessao}</p>
          <p className="hint mt-1">
            Este convite foi enviado para {preview.maskedEmail}. Saia e entre com a conta desse
            e-mail — o aceite só funciona por ela.
          </p>
          {/* Volta para este mesmo convite: sem sessão, o middleware manda para o
              cadastro e traz de volta pela `returnBackUrl`. */}
          <SignOutButton redirectUrl={`/convite/${token}`}>
            <button type="button" className="mt-3 font-medium underline underline-offset-4">
              Sair e entrar com outra conta
            </button>
          </SignOutButton>
        </div>
      )}

      <Button
        type="button"
        variant="accent"
        className="mt-8 w-full"
        busy={pending}
        onClick={aceitar}
        busyLabel="Entrando…"
      >
        Aceitar convite
      </Button>

      <p className="hint mt-4 text-center">
        {emailDaSessao && !contaDivergente
          ? `Você está conectado como ${emailDaSessao}.`
          : 'Entre com a conta do e-mail acima. Se você estiver em outra conta, troque pelo menu no topo antes de aceitar.'}
      </p>

      <FormError message={erro} />
    </div>
  )
}
