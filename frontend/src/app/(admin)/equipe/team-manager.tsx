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
import { Alert, Badge, Button, Card, Field, FormError } from '@/components/ui'
import { AlertTriangleIcon, IdCardIcon, UsersIcon } from '@/components/icons'
import { Modal } from '@/components/modal'
import {
  changeMemberStatusAction,
  changeRoleAction,
  inviteMemberAction,
  removeMemberAction,
  resendInvitationAction,
  revokeInvitationAction,
  type BlockingAppointment,
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
  canRemove: boolean
}

export function TeamManager({
  members,
  invitations,
  currentUserId,
  plan,
  canInvite,
  canRemove,
}: Props) {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<AssignableRoleKey>('RECEPTIONIST')
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [novoConvite, setNovoConvite] = useState<InvitationResponse | null>(null)
  /** A quem o diálogo de remoção se refere. Nulo é diálogo fechado. */
  const [removendo, setRemovendo] = useState<TeamMember | null>(null)
  /**
   * Os agendamentos que recusaram uma troca de papel (RN-06 com RN-07).
   *
   * Tirar o papel operacional de quem tem agenda marcada é recusado como a remoção, e
   * pela mesma razão: a ficha da pessoa sairia da agenda com o banho de sábado no nome
   * dela. A lista desce no 409 porque a decisão — reatribuir ou cancelar — é de quem
   * está na tela.
   */
  const [bloqueiosDoPapel, setBloqueiosDoPapel] = useState<BlockingAppointment[] | null>(null)
  /**
   * Qual linha está esperando resposta.
   *
   * `pending` é um só para o componente inteiro: usá-lo como `busy` faria girar o botão
   * de **todas** as linhas a cada clique numa delas. Quem gira é a linha clicada; as
   * outras ficam `disabled`, que é a diferença entre "estou fazendo isto" e "espere".
   */
  const [emAcao, setEmAcao] = useState<string | null>(null)
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
    setBloqueiosDoPapel(null)
    startTransition(async () => {
      const result = await changeRoleAction(membershipId, novo)
      if (result.ok) {
        router.refresh()
        return
      }
      setError(result.message)
      setBloqueiosDoPapel(result.appointments ?? null)
    })
  }

  function trocarAcesso(membershipId: string, status: 'ACTIVE' | 'SUSPENDED') {
    setError(null)
    setEmAcao(membershipId)
    startTransition(async () => {
      const result = await changeMemberStatusAction(membershipId, status)
      if (result.ok) router.refresh()
      else setError(result.message)
      setEmAcao(null)
    })
  }

  return (
    <div className="space-y-8">
      {canInvite && (
        <Card>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold">Convidar Alguém</h2>
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

            <Button
              type="submit"
              variant="accent"
              className="mb-1"
              busy={pending}
              disabled={semAssento}
              busyLabel="Enviando…"
            >
              Enviar convite
            </Button>
          </form>

          {semAssento && (
            <p className="hint mt-3">
              Os assentos do plano acabaram. Cancele um convite pendente, remova alguém da equipe ou
              faça upgrade para convidar mais gente.
            </p>
          )}

          <FormError message={bloqueiosDoPapel && bloqueiosDoPapel.length > 0 ? null : error} />

          {bloqueiosDoPapel && bloqueiosDoPapel.length > 0 && (
            <div className="mt-4">
              <AgendamentosBloqueando itens={bloqueiosDoPapel} />
            </div>
          )}

          {novoConvite?.inviteUrl && (
            <LinkDoConvite email={novoConvite.email} url={novoConvite.inviteUrl} />
          )}
        </Card>
      )}

      <section>
        <h2 className="text-lg font-semibold">
          No Sistema{' '}
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

                  <div className="flex shrink-0 flex-wrap items-center gap-2">
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

                    {/*
                     * Suspender e remover só aparecem para quem tem `team:remove`, e
                     * nunca na própria linha: o serviço recusa com 403, e oferecer um
                     * botão que sempre falha é pior que não oferecer.
                     */}
                    {canRemove && member.userId !== currentUserId && (
                      <>
                        <Button
                          type="button"
                          busy={emAcao === member.id}
                          disabled={pending}
                          onClick={() =>
                            trocarAcesso(
                              member.id,
                              member.status === 'SUSPENDED' ? 'ACTIVE' : 'SUSPENDED',
                            )
                          }
                          busyLabel="Salvando…"
                        >
                          {member.status === 'SUSPENDED' ? 'Reativar' : 'Suspender'}
                        </Button>
                        <Button
                          type="button"
                          disabled={pending}
                          onClick={() => setRemovendo(member)}
                        >
                          Remover
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </Card>
            ))}
        </div>
      </section>

      {removendo && (
        <DialogoDeRemocao
          member={removendo}
          onClose={() => setRemovendo(null)}
          onDone={() => {
            setRemovendo(null)
            router.refresh()
          }}
        />
      )}

      {canInvite && pendentes.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold">
            Convites Pendentes <span className="text-subtle">({pendentes.length})</span>
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
                    <Button
                      type="button"
                      busy={pending}
                      onClick={() => reenviar(invitation.id)}
                      busyLabel="Reenviando…"
                    >
                      Reenviar
                    </Button>
                    <Button
                      type="button"
                      busy={pending}
                      onClick={() => revogar(invitation.id)}
                      busyLabel="Cancelando…"
                    >
                      Cancelar
                    </Button>
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
 * A confirmação de remover alguém da equipe (MOD-IDENT-05).
 *
 * `<Modal>` e não um painel dentro do cartão: é a regra 8 de
 * `docs/design-formularios.md` para o que responde a **uma linha de uma lista**.
 *
 * A ação principal é a destrutiva, e aqui isso é correto — a janela existe só para ela,
 * e não há campo nenhum a preencher. O que a regra proíbe é a destrutiva **ao lado** de
 * uma principal que não é ela.
 *
 * O 409 da agenda futura (RN-07) não é um erro a exibir e esquecer: ele vira a lista do
 * corpo, porque a decisão — reatribuir a outro profissional ou cancelar — é de quem está
 * na tela, e não do sistema.
 */
function DialogoDeRemocao({
  member,
  onClose,
  onDone,
}: {
  member: TeamMember
  onClose: () => void
  onDone: () => void
}) {
  const [erro, setErro] = useState<string | null>(null)
  const [bloqueios, setBloqueios] = useState<BlockingAppointment[] | null>(null)
  const [enviando, startTransition] = useTransition()

  function confirmar() {
    setErro(null)
    setBloqueios(null)
    startTransition(async () => {
      const result = await removeMemberAction(member.id)
      if (result.ok) {
        onDone()
        return
      }
      setErro(result.message)
      setBloqueios(result.appointments ?? null)
    })
  }

  return (
    <Modal
      open
      onClose={onClose}
      icon={<IdCardIcon />}
      tone="icon-people"
      eyebrow="Remover da equipe"
      title={member.fullName}
      subtitle={`${member.roleLabel} · entrou em ${formatarData(member.joinedAt)}`}
      busy={enviando}
      footer={
        <>
          <Button type="button" variant="ghost" disabled={enviando} onClick={onClose}>
            Manter o acesso
          </Button>
          <Button type="button" busy={enviando} onClick={confirmar} busyLabel="Removendo…">
            Confirmar remoção
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Alert tone="danger" icon={<AlertTriangleIcon />} title="O acesso termina na hora">
          A pessoa deixa de entrar no sistema imediatamente, e o histórico do que ela fez aqui
          continua no lugar. Para readmitir depois, é preciso enviar um convite novo.
        </Alert>

        <p className="text-sm">
          Se a saída é temporária — férias, licença —, <strong>suspender</strong> é o gesto certo:
          fecha a porta e devolve o acesso com um clique, sem gastar um convite.
        </p>

        {bloqueios && bloqueios.length > 0 && <AgendamentosBloqueando itens={bloqueios} />}

        <FormError message={bloqueios && bloqueios.length > 0 ? null : erro} />
      </div>
    </Modal>
  )
}

/**
 * O que precisa sair da agenda antes — a lista do 409.
 *
 * Serve às duas recusas que a agenda futura produz nesta tela, remover da equipe e tirar
 * o papel operacional. É a mesma decisão nas duas, e mostrá-la de dois jeitos diferentes
 * faria a segunda parecer outra coisa.
 */
function AgendamentosBloqueando({ itens }: { itens: BlockingAppointment[] }) {
  return (
    <div className="card-soft rounded-xl p-4">
      <p className="text-sm font-semibold">
        {itens.length === 1
          ? 'Há 1 agendamento futuro no nome desta pessoa'
          : `Há ${itens.length} agendamentos futuros no nome desta pessoa`}
      </p>
      <p className="hint mt-1">
        Reatribua a outro profissional ou cancele na agenda, e volte aqui depois.
      </p>
      <ul className="mt-3 space-y-1.5">
        {itens.map((agendamento) => (
          <li key={agendamento.id} className="text-sm">
            {formatarDataHora(agendamento.startsAt)} · {agendamento.petName} ·{' '}
            <span className="text-subtle">{agendamento.serviceLabel}</span>
          </li>
        ))}
      </ul>
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
        <Button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(url).then(() => setCopiado(true))
          }}
        >
          {copiado ? 'Copiado' : 'Copiar'}
        </Button>
      </div>
    </div>
  )
}

function formatarData(iso: string): string {
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short' }).format(new Date(iso))
}

/** Dia, mês e hora — o bastante para reconhecer o compromisso na agenda. */
function formatarDataHora(iso: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso))
}
