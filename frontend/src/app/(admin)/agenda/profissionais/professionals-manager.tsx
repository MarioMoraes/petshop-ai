'use client'

import { useState, useTransition } from 'react'
import { BR_UFS, type ProfessionalResponse, type ServiceResponse } from '@petshop/shared-types'
import { Badge, Button, Card, EmptyState, Field } from '@/components/ui'
import {
  createProfessionalAction,
  replaceScheduleAction,
  updateProfessionalAction,
  type ActionFailure,
} from '../actions'

/**
 * Gestão de profissionais.
 *
 * A jornada é editada como faixas por dia, e não como "entra às X, sai às Y, almoça
 * de A a B": o almoço é o **vão** entre duas faixas. Modelar o intervalo como campo
 * quebra no primeiro caso de duas pausas, e a agenda passaria a oferecer horário em
 * que ninguém está.
 */

/** Quem pode ser ligado a uma ficha. `null` é quem não tem `team:read`. */
export interface TeamOption {
  userId: string
  fullName: string
  roleLabel: string
}

interface Props {
  professionals: ProfessionalResponse[]
  services: ServiceResponse[]
  team: TeamOption[] | null
}

const ROLES = [
  { key: 'BATHER', label: 'Banhista' },
  { key: 'GROOMER', label: 'Tosador' },
  { key: 'VET', label: 'Veterinário' },
  { key: 'DRIVER', label: 'Motorista' },
] as const

type RoleKey = (typeof ROLES)[number]['key']

/** Domingo primeiro, para casar com a coluna `weekday` (0 = domingo). */
const WEEKDAY_LABELS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado']

function minutesToTime(total: number): string {
  const hours = Math.floor(total / 60)
  const minutes = total % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

function timeToMinutes(value: string): number {
  const [hours, minutes] = value.split(':')
  return Number(hours) * 60 + Number(minutes)
}

export function ProfessionalsManager({ professionals, services, team }: Props) {
  const [editing, setEditing] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [failure, setFailure] = useState<ActionFailure | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [pending, startTransition] = useTransition()

  function run(
    action: () => Promise<{ ok: true; data: unknown } | ActionFailure>,
    onDone?: (data: unknown) => void,
  ) {
    setFailure(null)
    setWarnings([])
    startTransition(async () => {
      const result = await action()
      if (result.ok) onDone?.(result.data)
      else setFailure(result)
    })
  }

  if (professionals.length === 0 && !creating) {
    return (
      <EmptyState
        title="Ninguém cadastrado ainda"
        description="A agenda precisa saber quem atende para oferecer horários. Cada pessoa tem a própria jornada e os serviços que executa."
        action={
          <Button type="button" onClick={() => setCreating(true)}>
            Cadastrar profissional
          </Button>
        }
      />
    )
  }

  return (
    <div className="space-y-4">
      {failure && (
        <div className="card border-danger/40 px-5 py-4" role="alert">
          <p className="font-medium">{failure.message}</p>
          {failure.appointments && failure.appointments.length > 0 && (
            <ul className="hint mt-2 space-y-1">
              {failure.appointments.slice(0, 5).map((item) => (
                <li key={item.id}>
                  {new Date(item.startsAt).toLocaleString('pt-BR', {
                    dateStyle: 'short',
                    timeStyle: 'short',
                  })}{' '}
                  — {item.petName}
                </li>
              ))}
              {failure.appointments.length > 5 && (
                <li>e mais {failure.appointments.length - 5}…</li>
              )}
            </ul>
          )}
        </div>
      )}

      {warnings.length > 0 && (
        <div className="card border-warning/40 px-5 py-4" role="status">
          <p className="font-medium">Jornada salva, com uma observação</p>
          <ul className="hint mt-1 space-y-1">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}

      {professionals.map((person) => (
        <ProfessionalRow
          key={person.id}
          person={person}
          services={services}
          team={team}
          professionals={professionals}
          expanded={editing === person.id}
          pending={pending}
          onToggle={() => setEditing(editing === person.id ? null : person.id)}
          onSaveSchedule={(windows) =>
            run(
              () => replaceScheduleAction(person.id, { windows }),
              (data) => {
                setEditing(null)
                const result = data as { warnings?: string[] }
                setWarnings(result.warnings ?? [])
              },
            )
          }
          onPatch={(patch) => run(() => updateProfessionalAction(person.id, patch))}
        />
      ))}

      {creating ? (
        <NewProfessionalForm
          pending={pending}
          onCancel={() => setCreating(false)}
          onSubmit={(input) =>
            run(
              () => createProfessionalAction(input),
              () => setCreating(false),
            )
          }
        />
      ) : (
        <Button type="button" onClick={() => setCreating(true)}>
          Adicionar profissional
        </Button>
      )}
    </div>
  )
}

// ─── Linha do profissional ───────────────────────────────────────────────────

interface WindowDraft {
  key: string
  weekday: number
  startsAtMin: number
  endsAtMin: number
}

function ProfessionalRow({
  person,
  services,
  team,
  professionals,
  expanded,
  pending,
  onToggle,
  onSaveSchedule,
  onPatch,
}: {
  person: ProfessionalResponse
  services: ServiceResponse[]
  team: TeamOption[] | null
  professionals: ProfessionalResponse[]
  expanded: boolean
  pending: boolean
  onToggle: () => void
  onSaveSchedule: (windows: { weekday: number; startsAtMin: number; endsAtMin: number }[]) => void
  onPatch: (patch: Record<string, unknown>) => void
}) {
  const [windows, setWindows] = useState<WindowDraft[]>(() =>
    person.schedule.map((item) => ({ key: crypto.randomUUID(), ...item })),
  )

  const invalid = windows.filter((window) => window.endsAtMin <= window.startsAtMin)
  const activeServices = services.filter((service) => service.active)
  const roleLabel = ROLES.find((role) => role.key === person.roleKey)?.label ?? person.roleKey
  const linkedName = person.userId
    ? (team?.find((member) => member.userId === person.userId)?.fullName ?? null)
    : null

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">{person.displayName}</h2>
            <Badge tone="neutral">{roleLabel}</Badge>
            {person.maxConcurrentPets > 1 && (
              <Badge tone="accent">{person.maxConcurrentPets} pets por vez</Badge>
            )}
            {!person.active && <Badge tone="neutral">Inativo</Badge>}
            {person.active && person.schedule.length === 0 && (
              <Badge tone="danger">Sem jornada</Badge>
            )}
            {/* MOD-DOC-05: sem registro, o veterinário não emite receituário — e o
                lugar de descobrir isso é aqui, não na hora de prescrever. */}
            {person.roleKey === 'VET' && person.crmv && person.crmvState && (
              <Badge tone="neutral">
                CRMV {person.crmv}/{person.crmvState}
              </Badge>
            )}
            {person.active && person.roleKey === 'VET' && !person.crmv && (
              <Badge tone="danger">Sem CRMV</Badge>
            )}
            {/* O receituário procura a ficha **do usuário logado**: CRMV numa ficha sem
                usuário é um registro que ninguém consegue usar. */}
            {person.active && person.roleKey === 'VET' && !person.userId && (
              <Badge tone="danger">Sem usuário</Badge>
            )}
          </div>
          <p className="hint mt-1">
            {person.serviceIds.length === 0
              ? 'Nenhum serviço habilitado'
              : `${person.serviceIds.length} de ${activeServices.length} serviços`}
            {linkedName && ` · Usuário: ${linkedName}`}
          </p>
        </div>

        <div className="flex shrink-0 gap-2">
          <Button type="button" variant={expanded ? 'ghost' : 'primary'} onClick={onToggle}>
            {expanded ? 'Fechar' : 'Editar'}
          </Button>
          <Button
            type="button"
            busy={pending}
            onClick={() => onPatch({ active: !person.active })}
            busyLabel="Salvando…"
          >
            {person.active ? 'Desativar' : 'Reativar'}
          </Button>
        </div>
      </div>

      {expanded && (
        <div className="mt-5 space-y-6 border-t border-line pt-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Pets por vez"
              htmlFor={`capacidade-${person.id}`}
              hint="Quantos atendimentos essa pessoa toca ao mesmo tempo."
            >
              <input
                id={`capacidade-${person.id}`}
                type="number"
                className="field w-28"
                min={1}
                max={20}
                defaultValue={person.maxConcurrentPets}
                onBlur={(event) => {
                  const value = Math.max(1, Number(event.target.value) || 1)
                  if (value !== person.maxConcurrentPets) onPatch({ maxConcurrentPets: value })
                }}
              />
            </Field>

            {team && (
              <UserField
                person={person}
                team={team}
                professionals={professionals}
                pending={pending}
                onPatch={onPatch}
              />
            )}
          </div>

          {person.roleKey === 'VET' && <CrmvFields person={person} onPatch={onPatch} />}

          <fieldset>
            <legend className="label">Serviços que executa</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {activeServices.map((service) => {
                const enabled = person.serviceIds.includes(service.id)
                return (
                  <button
                    key={service.id}
                    type="button"
                    disabled={pending}
                    aria-pressed={enabled}
                    className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
                      enabled
                        ? 'border-accent bg-accent/10 text-fg'
                        : 'border-line text-subtle hover:text-fg'
                    }`}
                    onClick={() =>
                      onPatch({
                        serviceIds: enabled
                          ? person.serviceIds.filter((id) => id !== service.id)
                          : [...person.serviceIds, service.id],
                      })
                    }
                  >
                    {service.name}
                  </button>
                )
              })}
            </div>
          </fieldset>

          <fieldset>
            <legend className="label">Jornada</legend>
            <p className="hint mb-3">
              Duas faixas no mesmo dia é como se marca o almoço: o intervalo é o vão entre elas.
            </p>

            <div className="space-y-2">
              {windows.map((window) => (
                <div
                  key={window.key}
                  className="flex flex-wrap items-center gap-3 rounded-2xl border border-line px-4 py-3"
                >
                  <select
                    className="field w-36"
                    value={window.weekday}
                    aria-label="Dia da semana"
                    onChange={(event) =>
                      setWindows((current) =>
                        current.map((item) =>
                          item.key === window.key
                            ? { ...item, weekday: Number(event.target.value) }
                            : item,
                        ),
                      )
                    }
                  >
                    {WEEKDAY_LABELS.map((label, index) => (
                      <option key={label} value={index}>
                        {label}
                      </option>
                    ))}
                  </select>

                  <input
                    type="time"
                    className="field w-32"
                    value={minutesToTime(window.startsAtMin)}
                    aria-label="Início"
                    onChange={(event) =>
                      setWindows((current) =>
                        current.map((item) =>
                          item.key === window.key
                            ? { ...item, startsAtMin: timeToMinutes(event.target.value) }
                            : item,
                        ),
                      )
                    }
                  />
                  <span className="hint">às</span>
                  <input
                    type="time"
                    className="field w-32"
                    value={minutesToTime(window.endsAtMin)}
                    aria-label="Fim"
                    onChange={(event) =>
                      setWindows((current) =>
                        current.map((item) =>
                          item.key === window.key
                            ? { ...item, endsAtMin: timeToMinutes(event.target.value) }
                            : item,
                        ),
                      )
                    }
                  />

                  <Button
                    type="button"
                    onClick={() =>
                      setWindows((current) => current.filter((item) => item.key !== window.key))
                    }
                    aria-label="Remover faixa"
                  >
                    Remover
                  </Button>
                </div>
              ))}
            </div>

            <Button
              type="button"
              className="mt-3"
              onClick={() =>
                setWindows((current) => [
                  ...current,
                  { key: crypto.randomUUID(), weekday: 1, startsAtMin: 480, endsAtMin: 1080 },
                ])
              }
            >
              Adicionar faixa
            </Button>

            {invalid.length > 0 && (
              <p className="error-text mt-3" role="alert">
                O horário de término deve ser depois do início.
              </p>
            )}

            <div className="mt-5 flex justify-end">
              <Button
                type="button"
                busy={pending}
                disabled={invalid.length > 0}
                onClick={() =>
                  onSaveSchedule(
                    windows.map(({ weekday, startsAtMin, endsAtMin }) => ({
                      weekday,
                      startsAtMin,
                      endsAtMin,
                    })),
                  )
                }
                busyLabel="Salvando…"
              >
                Salvar jornada
              </Button>
            </div>
          </fieldset>
        </div>
      )}
    </Card>
  )
}

/**
 * Quem, da equipe, **é** esta ficha.
 *
 * O espelho do papel (RN-06 do MOD-IDENT) liga sozinho a ficha de mesmo nome; este campo
 * é para o resto — "Sônia" cadastrada na agenda e "Sonia Moraes" no convite. Sem o
 * vínculo, o veterinário não emite receituário: quem assina é quem está logado, e o
 * sistema procura a ficha dele por aqui.
 *
 * Quem já está ligado a outra ficha aparece **desabilitado**, com o nome da ficha, em vez
 * de sumir: sumido, o administrador procuraria a pessoa na lista e concluiria que ela
 * não é da equipe. O servidor recusa o par de todo jeito.
 */
function UserField({
  person,
  team,
  professionals,
  pending,
  onPatch,
}: {
  person: ProfessionalResponse
  team: TeamOption[]
  professionals: ProfessionalResponse[]
  pending: boolean
  onPatch: (patch: Record<string, unknown>) => void
}) {
  const fichaDe = new Map(
    professionals
      .filter((other) => other.id !== person.id && other.userId)
      .map((other) => [other.userId as string, other.displayName]),
  )

  return (
    <Field
      label="Usuário do sistema"
      htmlFor={`usuario-${person.id}`}
      hint={
        person.roleKey === 'VET'
          ? 'O veterinário só emite receituário logado com o usuário escolhido aqui.'
          : 'Quem, da equipe, é esta pessoa quando entra no sistema.'
      }
    >
      <select
        id={`usuario-${person.id}`}
        className="field"
        disabled={pending}
        value={person.userId ?? ''}
        onChange={(event) => onPatch({ userId: event.target.value || null })}
      >
        <option value="">Nenhum — não entra no sistema</option>
        {team.map((member) => {
          const outra = fichaDe.get(member.userId)
          return (
            <option key={member.userId} value={member.userId} disabled={Boolean(outra)}>
              {member.fullName} ({member.roleLabel}){outra ? ` — já é "${outra}"` : ''}
            </option>
          )
        })}
      </select>
    </Field>
  )
}

/**
 * O registro no conselho (MOD-DOC-05).
 *
 * Só aparece para o veterinário: banhista e motorista não têm CRMV, e um campo vazio
 * em toda ficha ensina a equipe a ignorá-lo.
 *
 * Os dois campos são salvos **juntos**, num clique explícito, e não no `onBlur` de cada
 * um como os demais desta tela. Metade do registro é recusada pelo servidor, e um
 * `onBlur` por campo mandaria o número sozinho e mostraria um erro para quem estava
 * apenas indo digitar a UF.
 */
function CrmvFields({
  person,
  onPatch,
}: {
  person: ProfessionalResponse
  onPatch: (patch: Record<string, unknown>) => void
}) {
  const [numero, setNumero] = useState(person.crmv ?? '')
  const [uf, setUf] = useState(person.crmvState ?? '')

  const mudou = numero.trim() !== (person.crmv ?? '') || uf.trim() !== (person.crmvState ?? '')
  const pelaMetade = Boolean(numero.trim()) !== Boolean(uf.trim())

  return (
    <fieldset>
      <legend className="label">Registro no conselho</legend>
      <p className="hint mb-3">
        Sem CRMV, o sistema recusa a emissão de receituário — é o registro que vai impresso no
        papel, e ele identifica quem assina.
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <Field label="Número" htmlFor={`crmv-${person.id}`}>
          <input
            id={`crmv-${person.id}`}
            className="field w-40"
            maxLength={20}
            value={numero}
            onChange={(event) => setNumero(event.target.value)}
          />
        </Field>

        <Field label="UF" htmlFor={`crmv-uf-${person.id}`}>
          <select
            id={`crmv-uf-${person.id}`}
            className="field w-24"
            value={uf}
            onChange={(event) => setUf(event.target.value)}
          >
            <option value="">—</option>
            {BR_UFS.map((sigla) => (
              <option key={sigla} value={sigla}>
                {sigla}
              </option>
            ))}
          </select>
        </Field>

        <Button
          type="button"
          disabled={!mudou || pelaMetade}
          onClick={() =>
            onPatch({
              crmv: numero.trim() || null,
              crmvState: uf.trim() || null,
            })
          }
        >
          Salvar registro
        </Button>
      </div>

      {pelaMetade && (
        <p className="error-text mt-3" role="alert">
          Número e UF andam juntos: um sem o outro não identifica ninguém.
        </p>
      )}
    </fieldset>
  )
}

// ─── Novo profissional ───────────────────────────────────────────────────────

function NewProfessionalForm({
  pending,
  onCancel,
  onSubmit,
}: {
  pending: boolean
  onCancel: () => void
  onSubmit: (input: unknown) => void
}) {
  const [displayName, setDisplayName] = useState('')
  const [roleKey, setRoleKey] = useState<RoleKey>('BATHER')
  const [maxConcurrentPets, setMax] = useState(1)

  return (
    <Card>
      <h2 className="text-lg font-semibold">Novo profissional</h2>
      <p className="hint mt-1">
        A jornada e os serviços são definidos depois de criar, na própria linha.
      </p>

      <div className="mt-5 grid gap-4 sm:grid-cols-3">
        <Field label="Nome" htmlFor="novo-prof-nome">
          <input
            id="novo-prof-nome"
            className="field"
            maxLength={60}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </Field>

        <Field label="Função" htmlFor="novo-prof-papel">
          <select
            id="novo-prof-papel"
            className="field"
            value={roleKey}
            onChange={(event) => setRoleKey(event.target.value as RoleKey)}
          >
            {ROLES.map((role) => (
              <option key={role.key} value={role.key}>
                {role.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Pets por vez" htmlFor="novo-prof-capacidade">
          <input
            id="novo-prof-capacidade"
            type="number"
            className="field"
            min={1}
            max={20}
            value={maxConcurrentPets}
            onChange={(event) => setMax(Math.max(1, Number(event.target.value) || 1))}
          />
        </Field>
      </div>

      <div className="mt-6 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancelar
        </Button>
        <Button
          type="button"
          busy={pending}
          disabled={displayName.trim().length < 2}
          onClick={() =>
            onSubmit({
              displayName: displayName.trim(),
              roleKey,
              maxConcurrentPets,
              serviceIds: [],
            })
          }
          busyLabel="Criando…"
        >
          Criar
        </Button>
      </div>
    </Card>
  )
}
