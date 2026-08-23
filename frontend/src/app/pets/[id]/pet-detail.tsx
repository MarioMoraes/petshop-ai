'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { PetResponse, PetTutorRole } from '@petshop/shared-types'
import { Card, DataRow, FormError, Tabs } from '@/components/ui'
import {
  deletePetAction,
  linkTutorAction,
  revealMicrochipAction,
  unlinkTutorAction,
  updatePetTutorAction,
} from '../actions'
import { TutorPicker } from '../tutor-picker'

/**
 * Detalhe do pet em abas.
 *
 * A aba de prontuário existe e diz que o módulo ainda não chegou, em vez de sumir: o
 * atendente precisa saber que o dado *vai* estar ali, e uma aba vazia sem explicação
 * lê como "este pet não tem alergia nenhuma" — o que é perigoso de supor.
 */

interface Props {
  pet: PetResponse
  canUpdate: boolean
  canDelete: boolean
}

export function PetDetailView({ pet, canUpdate, canDelete }: Props) {
  const [tab, setTab] = useState('dados')

  return (
    <div className="space-y-5">
      {/*
        AC-04: o aviso de peso acompanha o cadastro, não só o momento de salvar. Fica
        no topo das abas porque vale para o pet inteiro, não para uma seção.
      */}
      {pet.warnings.map((warning) => (
        <div
          key={warning.code}
          className="rounded-2xl bg-accent-soft px-5 py-4 text-sm text-accent-ink"
          role="status"
        >
          {warning.message} — {pet.weightKg} kg com porte {pet.size.label}. Ajuste o porte se
          foi engano; se estiver certo, pode ignorar.
        </div>
      ))}

      <Tabs
        tabs={[
          { id: 'dados', label: 'Dados' },
          { id: 'responsaveis', label: `Responsáveis (${pet.tutors.length})` },
          { id: 'prontuario', label: 'Prontuário' },
        ]}
        active={tab}
        onSelect={setTab}
      />

      {tab === 'dados' && <DadosTab pet={pet} canUpdate={canUpdate} canDelete={canDelete} />}
      {tab === 'responsaveis' && <ResponsaveisTab pet={pet} canUpdate={canUpdate} canDelete={canDelete} />}
      {tab === 'prontuario' && (
        <Card>
          <p className="hint">
            Alergias, temperamento e histórico clínico chegam com o{' '}
            <span className="font-medium text-ink">MOD-PRONT</span>.
          </p>
        </Card>
      )}
    </div>
  )
}

// ─── Dados ───────────────────────────────────────────────────────────────────

function DadosTab({ pet, canUpdate, canDelete }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [microchip, setMicrochip] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const isTerminal = pet.status === 'DECEASED' || pet.status === 'TRANSFERRED_OUT'

  function reveal() {
    setError(null)
    startTransition(async () => {
      const result = await revealMicrochipAction(pet.id)
      if (result.ok) setMicrochip(result.data.microchip)
      else setError(result.message)
    })
  }

  function remove() {
    setError(null)
    startTransition(async () => {
      const result = await deletePetAction(pet.id)
      if (result.ok) router.push('/pets')
      else setError(result.message)
    })
  }

  return (
    <div className="space-y-5">
      <FormError message={error} />

      <Card>
        <dl>
          <DataRow label="Espécie">{pet.species.label}</DataRow>
          <DataRow label="Raça">{pet.breed?.label ?? '—'}</DataRow>
          <DataRow label="Porte">{pet.size.label}</DataRow>
          <DataRow label="Pelagem">{pet.coat?.label ?? '—'}</DataRow>
          <DataRow label="Sexo">{SEX_LABELS[pet.sex]}</DataRow>
          <DataRow label="Cor">{pet.color ?? '—'}</DataRow>
          <DataRow label="Nascimento">
            {pet.birthDate ? formatDate(pet.birthDate) : '—'}
            {pet.birthDatePrecision === 'ESTIMATED' && (
              <span className="hint"> · estimada</span>
            )}
          </DataRow>
          <DataRow label="Idade">{pet.ageLabel ?? 'Não informada'}</DataRow>
          <DataRow label="Peso">{pet.weightKg === null ? '—' : `${pet.weightKg} kg`}</DataRow>
          <DataRow label="Castrado">
            {pet.neutered === null ? 'Não informado' : pet.neutered ? 'Sim' : 'Não'}
          </DataRow>
          <DataRow label="Microchip">
            {pet.microchipMasked === null ? (
              '—'
            ) : microchip !== null ? (
              <span className="font-mono">{microchip}</span>
            ) : (
              <span className="flex items-center gap-3">
                <span className="font-mono">{pet.microchipMasked}</span>
                {canUpdate && (
                  <button
                    type="button"
                    className="btn btn-ghost px-3 py-1 text-xs"
                    disabled={pending}
                    onClick={reveal}
                  >
                    Ver completo
                  </button>
                )}
              </span>
            )}
          </DataRow>
          <DataRow label="Último atendimento">
            {pet.lastAttendanceAt ? formatDate(pet.lastAttendanceAt) : 'Nenhum ainda'}
          </DataRow>
        </dl>
      </Card>

      {pet.notes && (
        <Card>
          <h3 className="font-semibold">Observações</h3>
          <p className="hint mt-2 whitespace-pre-wrap">{pet.notes}</p>
        </Card>
      )}

      {!isTerminal && (
        <div className="flex flex-wrap items-center gap-3">
          {canUpdate && (
            <Link href={`/pets/${pet.id}/editar`} className="btn btn-primary">
              Editar
            </Link>
          )}
          {canDelete && (
            <button
              type="button"
              className="btn btn-ghost text-danger"
              disabled={pending}
              onClick={() => setConfirmingDelete((value) => !value)}
            >
              Excluir
            </button>
          )}
        </div>
      )}

      {confirmingDelete && (
        <Card className="space-y-3 border border-danger/20">
          <h3 className="font-semibold text-danger">Excluir {pet.name}?</h3>
          <p className="hint">
            O cadastro sai das listas e da agenda. O microchip volta a ficar livre, então o
            mesmo animal pode ser recadastrado se isto for um engano.
          </p>
          <div className="flex flex-wrap gap-3">
            <button type="button" className="btn btn-accent" disabled={pending} onClick={remove}>
              {pending ? 'Excluindo…' : 'Confirmar exclusão'}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setConfirmingDelete(false)}
            >
              Cancelar
            </button>
          </div>
        </Card>
      )}
    </div>
  )
}

// ─── Responsáveis (MOD-PET-02) ───────────────────────────────────────────────

function ResponsaveisTab({ pet, canUpdate, canDelete }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function run(action: () => Promise<{ ok: boolean; message?: string }>) {
    setError(null)
    startTransition(async () => {
      const result = await action()
      if (result.ok) router.refresh()
      else setError(result.message ?? 'Não foi possível concluir a operação.')
    })
  }

  const hasPrimary = pet.tutors.some((tutor) => tutor.role === 'PRIMARY')

  return (
    <div className="space-y-5">
      <FormError message={error} />

      {!hasPrimary && (
        <div className="rounded-2xl bg-accent-soft px-5 py-4 text-sm text-accent-ink">
          Este pet está sem responsável principal. Promova alguém — é para a conta dele que
          os serviços são lançados.
        </div>
      )}

      {pet.tutors.length === 0 ? (
        <Card>
          <p className="hint">
            Nenhum responsável vinculado. Acontece quando o único tutor foi anonimizado a
            pedido do titular: o pet e o histórico dele permanecem.
          </p>
        </Card>
      ) : (
        <ul className="space-y-2">
          {pet.tutors.map((link) => (
            <li key={link.linkId}>
              <Card className="space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                  <Link href={`/tutores/${link.tutorId}`} className="font-semibold hover:underline">
                    {link.fullName}
                  </Link>
                  <span className="hint">{link.phoneMasked}</span>
                  <span
                    className={`pill ml-auto px-3 py-1 text-xs font-medium ${
                      link.role === 'PRIMARY' ? 'bg-shell text-white' : 'bg-black/5 text-muted'
                    }`}
                  >
                    {link.role === 'PRIMARY' ? 'Principal' : 'Secundário'}
                  </span>
                </div>

                <p className="hint">
                  {link.relationship ? `${link.relationship} · ` : ''}
                  {link.canAuthorizeProcedures
                    ? 'Pode autorizar procedimentos'
                    : 'Não autoriza procedimentos'}
                  {' · desde '}
                  {formatDate(link.linkedAt)}
                </p>

                {canUpdate && (
                  <div className="flex flex-wrap gap-2">
                    <RoleButton
                      link={link}
                      pending={pending}
                      hasPrimary={hasPrimary}
                      onChange={(role) =>
                        run(() => updatePetTutorAction(pet.id, link.linkId, { role }))
                      }
                    />

                    <button
                      type="button"
                      className="btn btn-ghost px-3 py-1 text-xs"
                      disabled={pending}
                      onClick={() =>
                        run(() =>
                          updatePetTutorAction(pet.id, link.linkId, {
                            canAuthorizeProcedures: !link.canAuthorizeProcedures,
                          }),
                        )
                      }
                    >
                      {link.canAuthorizeProcedures
                        ? 'Retirar autorização'
                        : 'Permitir autorizar'}
                    </button>

                    {canDelete && (
                      <button
                        type="button"
                        className="btn btn-ghost px-3 py-1 text-xs text-danger"
                        disabled={pending}
                        onClick={() => run(() => unlinkTutorAction(pet.id, link.linkId))}
                      >
                        Desvincular
                      </button>
                    )}
                  </div>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}

      {canUpdate && (
        <Card className="space-y-3">
          <h3 className="font-semibold">Vincular outro responsável</h3>
          <p className="hint">
            Ambos passam a ver o pet no portal e podem agendar. O débito continua indo para o
            principal.
          </p>
          <TutorPicker
            label="Buscar tutor"
            excludeIds={pet.tutors.map((link) => link.tutorId)}
            onSelect={(tutor) =>
              run(() =>
                linkTutorAction(pet.id, {
                  tutorId: tutor.id,
                  // Quem chega depois entra como secundário; a troca de principal é
                  // explícita e move o responsável financeiro (RN-05).
                  role: hasPrimary ? 'SECONDARY' : 'PRIMARY',
                  canAuthorizeProcedures: true,
                }),
              )
            }
          />
        </Card>
      )}
    </div>
  )
}

/**
 * A troca de principal é em dois passos, e o botão diz qual está disponível.
 *
 * Promover direto com outro principal ativo devolve 409: a ordem é rebaixar o atual e
 * então promover. Fazer as duas coisas em silêncio trocaria o responsável financeiro
 * do pet sem ninguém ter pedido.
 */
function RoleButton({
  link,
  pending,
  hasPrimary,
  onChange,
}: {
  link: { role: PetTutorRole }
  pending: boolean
  hasPrimary: boolean
  onChange: (role: PetTutorRole) => void
}) {
  if (link.role === 'PRIMARY') {
    return (
      <button
        type="button"
        className="btn btn-ghost px-3 py-1 text-xs"
        disabled={pending}
        onClick={() => onChange('SECONDARY')}
        title="Rebaixar antes de promover outro responsável"
      >
        Deixar de ser principal
      </button>
    )
  }

  return (
    <button
      type="button"
      className="btn btn-ghost px-3 py-1 text-xs"
      disabled={pending || hasPrimary}
      onClick={() => onChange('PRIMARY')}
      title={
        hasPrimary
          ? 'Rebaixe o responsável principal atual antes de promover este'
          : undefined
      }
    >
      Tornar principal
    </button>
  )
}

const SEX_LABELS: Record<string, string> = {
  MALE: 'Macho',
  FEMALE: 'Fêmea',
  UNKNOWN: 'Não informado',
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString('pt-BR', { timeZone: 'UTC' })
}
