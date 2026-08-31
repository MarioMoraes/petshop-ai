'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  ASSIGNABLE_ROLE_KEYS,
  PLAN_SEAT_LIMITS,
  ROLE_LABELS,
  type AssignableRoleKey,
  type InvitationResponse,
  type Plan,
  type TeamMember,
} from '@petshop/shared-types'
import { Badge, Card, Field, FormError } from '@/components/ui'
import { UsersIcon } from '@/components/icons'
import {
  changeRoleAction,
  inviteMemberAction,
  resendInvitationAction,
  revokeInvitationAction,
} from './actions'

/**
 * A lista da equipe e o convite, numa peça só.
 *
 * O link do convite aparece na tela depois de criado, e não só no e-mail. Não é
 * redundância: metade dos petshops vai mandar esse link pelo WhatsApp, e o e-mail
 * ainda pode ter caído em spam ou ter sido digitado errado. Quem convidou precisa de
 * algo para copiar sem depender da caixa de entrada de outra pessoa.
 *
 * Ele some ao recarregar a página, e isso é proposital: o servidor guarda só o hash do
 * token e não consegue reexibi-lo. Perdeu, reenvia — e o link antigo morre.
 */

interface Props {
  members: TeamMember[]
  invitations: InvitationResponse[]
  currentUserId: string
  plan: Plan
  canInvite: boolean
}

export function TeamManager({ members, invitations, currentUserId, plan, canInvite }: Props) {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<AssignableRoleKey>('RECEPTIONIST')
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [novoConvite, setNovoConvite] = useState<InvitationResponse | null>(null)
  const [pending, startTransition] = useTransition()

  const pendentes = invitations.filter((invitation) => invitation.status === 'PENDING')
  const limite = PLAN_SEAT_LIMITS[plan]
  const ocupados = members.filter((member) => member.status !== 'REMOVED').length + pendentes.length
  const semAssento = limite !== null && ocupados >= limite

  function convidar(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setFieldErrors({})
    setNovoConvite(null)

    startTransition(async () => {
      const result = await inviteMemberAction({ email: email.trim(), role })
      if (result.ok) {
        setEmail('')
        setNovoConvite(result.data)
        router.refresh()
      } else {
        setError(result.message)
        setFieldErrors(result.fieldErrors)
      }
    })
  }

  function reenviar(id: string) {
    setError(null)
    startTransition(async () => {
      const result = await resendInvitationAction(id)
      if (result.ok) {
        setNovoConvite(result.data)
        router.refresh()
      } else {
        setError(result.message)
      }
    })
  }

  function revogar(id: string) {
    setError(null)
    startTransition(async () => {
      const result = await revokeInvitationAction(id)
      if (result.ok) {
        setNovoConvite((atual) => (atual?.id === id ? null : atual))
        router.refresh()
      } else {
        setError(result.message)
      }
    })
  }

  function trocarPapel(membershipId: string, novo: AssignableRoleKey) {
    setError(null)
    startTransition(async () => {
      const result = await changeRoleAction(membershipId, novo)
      if (result.ok) router.refresh()
      else setError(result.message)
    })
  }

  return (
    <div className="space-y-8">
      {canInvite && (
        <Card>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold">Convidar alguém</h2>
            <p className="hint">
              {limite === null
                ? `${ocupados} ${ocupados === 1 ? 'pessoa' : 'pessoas'} · plano sem limite`
                : `${ocupados} de ${limite} ${limite === 1 ? 'assento' : 'assentos'} do plano`}
            </p>
          </div>

          <form onSubmit={convidar} className="mt-5 flex flex-wrap items-end gap-3">
            <div className="min-w-[15rem] flex-1">
              <Field label="E-mail" htmlFor="convite-email" error={fieldErrors.email}>
                <input
                  id="convite-email"
                  type="email"
                  className="field"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="pessoa@exemplo.com"
                  autoComplete="off"
                  required
                  disabled={pending || semAssento}
                  aria-invalid={fieldErrors.email ? true : undefined}
                />
              </Field>
            </div>

            <div className="min-w-[11rem]">
              <Field label="Perfil de acesso" htmlFor="convite-papel" error={fieldErrors.role}>
                <select
                  id="convite-papel"
                  className="field"
                  value={role}
                  onChange={(event) => setRole(event.target.value as AssignableRoleKey)}
                  disabled={pending || semAssento}
                >
                  {ASSIGNABLE_ROLE_KEYS.map((key) => (
                    <option key={key} value={key}>
                      {ROLE_LABELS[key]}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <button type="submit" className="btn btn-accent mb-1" disabled={pending || semAssento}>
              {pending ? 'Enviando…' : 'Enviar convite'}
            </button>
          </form>

          {semAssento && (
            <p className="hint mt-3">
              Os assentos do plano acabaram. Cancele um convite pendente, remova alguém da equipe
              ou faça upgrade para convidar mais gente.
            </p>
          )}

          <FormError message={error} />

          {novoConvite?.inviteUrl && (
            <LinkDoConvite email={novoConvite.email} url={novoConvite.inviteUrl} />
          )}
        </Card>
      )}

      <section>
        <h2 className="text-lg font-semibold">
          No sistema{' '}
          <span className="text-subtle">
            ({members.filter((member) => member.status !== 'REMOVED').length})
          </span>
        </h2>

        <div className="mt-4 space-y-3">
          {members
            .filter((member) => member.status !== 'REMOVED')
            .map((member) => (
              <Card key={member.id}>
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="icon-chip icon-people shrink-0">
                      <UsersIcon />
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">
                        {member.fullName}
                        {member.userId === currentUserId && (
                          <span className="text-subtle"> · você</span>
                        )}
                      </p>
                      <p className="hint mt-0.5">
                        Entrou em {formatarData(member.joinedAt)}
                        {member.status === 'SUSPENDED' && ' · acesso suspenso'}
                      </p>
                    </div>
                  </div>

                  {canInvite && member.userId !== currentUserId ? (
                    <select
                      className="field w-auto"
                      value={member.roleKey}
                      onChange={(event) =>
                        trocarPapel(member.id, event.target.value as AssignableRoleKey)
                      }
                      disabled={pending}
                      aria-label={`Perfil de ${member.fullName}`}
                    >
                      {ASSIGNABLE_ROLE_KEYS.map((key) => (
                        <option key={key} value={key}>
                          {ROLE_LABELS[key]}
                        </option>
                      ))}
                    </select>
                  ) : (
                    /*
                     * O próprio usuário não troca o próprio papel aqui: rebaixar-se
                     * sozinho é a via mais curta para um estabelecimento sem
                     * administrador, e o serviço recusaria com um 409 que não teria
                     * como ser desfeito pela mesma pessoa.
                     */
                    <Badge tone={member.roleKey === 'TENANT_ADMIN' ? 'accent' : 'neutral'}>
                      {member.roleLabel}
                    </Badge>
                  )}
                </div>
              </Card>
            ))}
        </div>
      </section>

      {canInvite && pendentes.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold">
            Convites pendentes <span className="text-subtle">({pendentes.length})</span>
          </h2>

          <div className="mt-4 space-y-3">
            {pendentes.map((invitation) => (
              <Card key={invitation.id}>
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{invitation.email}</p>
                    <p className="hint mt-0.5">
                      {invitation.roleLabel} · convite vale até {formatarData(invitation.expiresAt)}
                      {invitation.invitedByName && ` · enviado por ${invitation.invitedByName}`}
                    </p>
                  </div>

                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => reenviar(invitation.id)}
                      disabled={pending}
                    >
                      Reenviar
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost text-danger"
                      onClick={() => revogar(invitation.id)}
                      disabled={pending}
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

/**
 * O link, exibido uma vez.
 *
 * `readOnly` em vez de texto solto porque o gesto que se quer é selecionar tudo de
 * uma vez — e o botão de copiar não existe em navegador sem `clipboard`.
 */
function LinkDoConvite({ email, url }: { email: string; url: string }) {
  const [copiado, setCopiado] = useState(false)

  return (
    <div className="mt-5 rounded-xl border border-line bg-black/[0.02] p-4">
      <p className="text-sm font-medium">Convite enviado para {email}</p>
      <p className="hint mt-1">
        O link também pode ser entregue à mão — por WhatsApp, por exemplo. Ele só aparece agora:
        depois de sair desta tela, só reenviando.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <input
          className="field min-w-[15rem] flex-1 text-xs"
          value={url}
          readOnly
          onFocus={(event) => event.target.select()}
          aria-label="Link do convite"
        />
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            void navigator.clipboard?.writeText(url).then(() => setCopiado(true))
          }}
        >
          {copiado ? 'Copiado' : 'Copiar'}
        </button>
      </div>
    </div>
  )
}

function formatarData(iso: string): string {
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short' }).format(new Date(iso))
}
