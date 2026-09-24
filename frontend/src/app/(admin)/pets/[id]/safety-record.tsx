'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  ALLERGY_TYPE_LABELS,
  SEVERITY_LABELS,
  TEMPERAMENT_CONTEXT_LABELS,
  TEMPERAMENT_CONTEXTS,
  TEMPERAMENT_LABELS,
  type Allergy,
  type AllergyType,
  type ClinicalSeverity,
  type MedicalAlert,
  type SafetyRecord,
  type TemperamentClassification,
  type TemperamentContext,
} from '@petshop/shared-types'
import { Button, Card, CardHead, Field, FormError, SectionHead } from '@/components/ui'
import { AlertTriangleIcon, HeartPulseIcon, PawPrintIcon } from '@/components/icons'
import {
  createAllergyAction,
  createMedicalAlertAction,
  recordTemperamentAction,
  updateAllergyAction,
  updateMedicalAlertAction,
} from '../actions'

/**
 * Prontuário de segurança (MOD-PRONT-03/04/05).
 *
 * A tela é ordenada por risco, não por tipo de registro: quem abre esta aba com o
 * pet na mesa quer saber o que pode dar errado, e a resposta pode vir de qualquer
 * uma das três origens. Por isso o bloco de alertas agregados fica no topo, e as
 * três seções detalhadas embaixo.
 *
 * Nada aqui apaga: desativar exige justificativa, e o desativado continua listado
 * em tom apagado. Um registro de segurança que some sem rastro é o defeito que o
 * módulo existe para impedir.
 */

interface Props {
  petId: string
  record: SafetyRecord
  /** `record:write_alerts` — recepção e veterinário registram. */
  canWriteAlerts: boolean
  /** `record:write` — só o veterinário e o administrador desativam. */
  canManageRecord: boolean
  /** `record:write_notes` — quem manuseia o animal observa o comportamento. */
  canWriteNotes: boolean
}

const SEVERITY_TONE: Record<ClinicalSeverity, string> = {
  CRITICAL: 'bg-danger/10 text-danger',
  HIGH: 'bg-accent-soft text-accent-ink',
  MEDIUM: 'bg-black/5 text-ink',
  LOW: 'bg-black/5 text-muted',
}

export function SafetyRecordTab({
  petId,
  record,
  canWriteAlerts,
  canManageRecord,
  canWriteNotes,
}: Props) {
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

  return (
    <div className="space-y-5">
      <FormError message={error} />

      {record.alerts.length === 0 ? (
        <Card>
          <p className="hint">
            Nenhum alerta ativo. Registre alergias, temperamento e condições médicas — é o que a
            equipe vê antes de encostar no pet.
          </p>
        </Card>
      ) : (
        <Card className="space-y-3">
          <CardHead
            icon={<AlertTriangleIcon />}
            tone="icon-pet"
            title="O que a equipe precisa saber"
          />
          <ul className="space-y-2">
            {record.alerts.map((alert, index) => (
              <li
                key={`${alert.type}-${index}`}
                className={`flex flex-wrap items-center gap-3 rounded-xl px-4 py-3 ${SEVERITY_TONE[alert.severity]}`}
              >
                <span className="font-medium">{alert.label}</span>
                <span className="ml-auto text-xs uppercase tracking-wide">
                  {SEVERITY_LABELS[alert.severity]}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <AllergySection
        petId={petId}
        allergies={record.allergies}
        canCreate={canWriteAlerts}
        canManage={canManageRecord}
        pending={pending}
        run={run}
      />

      <TemperamentSection
        petId={petId}
        record={record}
        canWrite={canWriteNotes}
        pending={pending}
        run={run}
      />

      <MedicalAlertSection
        petId={petId}
        alerts={record.medicalAlerts}
        canCreate={canWriteAlerts}
        canManage={canManageRecord}
        pending={pending}
        run={run}
      />
    </div>
  )
}

type Runner = (action: () => Promise<{ ok: boolean; message?: string }>) => void

// ─── Alergias (MOD-PRONT-03) ─────────────────────────────────────────────────

function AllergySection({
  petId,
  allergies,
  canCreate,
  canManage,
  pending,
  run,
}: {
  petId: string
  allergies: Allergy[]
  canCreate: boolean
  canManage: boolean
  pending: boolean
  run: Runner
}) {
  const [open, setOpen] = useState(false)
  const [type, setType] = useState<AllergyType>('PRODUCT')
  const [label, setLabel] = useState('')
  const [severity, setSeverity] = useState<ClinicalSeverity>('MEDIUM')
  const [reaction, setReaction] = useState('')
  const [deactivating, setDeactivating] = useState<string | null>(null)
  const [justification, setJustification] = useState('')

  const active = allergies.filter((allergy) => allergy.active)
  const inactive = allergies.filter((allergy) => !allergy.active)

  return (
    <Card tone="soft" className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <SectionHead
          icon={<AlertTriangleIcon />}
          tone="icon-pet"
          eyebrow="Prontuário"
          title="Alergias e restrições"
        />
        <span className="meta-pill">{active.length} ativas</span>
        {canCreate && (
          <Button
            type="button"
            variant={open ? 'ghost' : 'primary'}
            className="ml-auto px-3 py-1 text-xs"
            onClick={() => setOpen((value) => !value)}
          >
            {open ? 'Cancelar' : 'Registrar alergia'}
          </Button>
        )}
      </div>

      {open && (
        <div className="space-y-3 rounded-2xl bg-black/[0.02] p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Tipo" htmlFor="allergy-type">
              <select
                id="allergy-type"
                className="field"
                value={type}
                onChange={(event) => setType(event.target.value as AllergyType)}
              >
                {Object.entries(ALLERGY_TYPE_LABELS).map(([value, text]) => (
                  <option key={value} value={value}>
                    {text}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Severidade" htmlFor="allergy-severity">
              <select
                id="allergy-severity"
                className="field"
                value={severity}
                onChange={(event) => setSeverity(event.target.value as ClinicalSeverity)}
              >
                {Object.entries(SEVERITY_LABELS).map(([value, text]) => (
                  <option key={value} value={value}>
                    {text}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field label="Substância ou produto" htmlFor="allergy-label">
            <input
              id="allergy-label"
              className="field"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Ex.: Shampoo neutro marca X"
            />
          </Field>

          <Field
            label="Reação observada (opcional)"
            htmlFor="allergy-reaction"
            hint="Fica cifrada. Ajuda a equipe a reconhecer o quadro se acontecer de novo."
          >
            <textarea
              id="allergy-reaction"
              className="field"
              rows={2}
              value={reaction}
              onChange={(event) => setReaction(event.target.value)}
            />
          </Field>

          {severity === 'CRITICAL' && (
            <p className="hint text-danger">
              Severidade crítica bloqueia o agendamento dos serviços relacionados — só passa com
              autorização registrada.
            </p>
          )}

          <Button
            type="button"
            busy={pending}
            disabled={label.trim().length < 2}
            onClick={() =>
              run(async () => {
                const result = await createAllergyAction(petId, {
                  type,
                  label: label.trim(),
                  severity,
                  ...(reaction.trim() ? { reaction: reaction.trim() } : {}),
                })
                if (result.ok) {
                  setOpen(false)
                  setLabel('')
                  setReaction('')
                }
                return result
              })
            }
            busyLabel="Salvando…"
          >
            Registrar
          </Button>
        </div>
      )}

      {allergies.length === 0 ? (
        <p className="hint">Nenhuma alergia registrada.</p>
      ) : (
        <ul className="divide-y divide-black/5">
          {[...active, ...inactive].map((allergy) => (
            <li key={allergy.id} className="space-y-2 py-3">
              <div className="flex flex-wrap items-center gap-3">
                <span className={allergy.active ? 'font-medium' : 'text-muted line-through'}>
                  {allergy.label}
                </span>
                <span className="hint">{ALLERGY_TYPE_LABELS[allergy.type]}</span>
                <span
                  className={`pill px-3 py-1 text-xs font-medium ${SEVERITY_TONE[allergy.severity]}`}
                >
                  {SEVERITY_LABELS[allergy.severity]}
                </span>

                {canManage && allergy.active && (
                  <Button
                    type="button"
                    className="ml-auto px-3 py-1 text-xs"
                    disabled={pending}
                    onClick={() => {
                      setDeactivating(deactivating === allergy.id ? null : allergy.id)
                      setJustification('')
                    }}
                  >
                    Desativar
                  </Button>
                )}
              </div>

              {allergy.reaction && <p className="hint">{allergy.reaction}</p>}
              {!allergy.active && allergy.resolutionNotes && (
                <p className="hint">Desativada: {allergy.resolutionNotes}</p>
              )}

              {deactivating === allergy.id && (
                <div className="space-y-2 rounded-xl bg-black/[0.02] p-3">
                  <Field
                    label="Por que esta alergia deixou de valer?"
                    htmlFor={`justify-${allergy.id}`}
                    hint="A equipe vai confiar nisso. Fica na trilha de auditoria."
                  >
                    <textarea
                      id={`justify-${allergy.id}`}
                      className="field"
                      rows={2}
                      value={justification}
                      onChange={(event) => setJustification(event.target.value)}
                    />
                  </Field>
                  <Button
                    type="button"
                    variant="accent"
                    busy={pending}
                    disabled={justification.trim().length < 10}
                    onClick={() =>
                      run(async () => {
                        const result = await updateAllergyAction(petId, allergy.id, {
                          active: false,
                          resolutionNotes: justification.trim(),
                        })
                        if (result.ok) setDeactivating(null)
                        return result
                      })
                    }
                    busyLabel="Desativando…"
                  >
                    Confirmar
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

// ─── Temperamento (MOD-PRONT-04) ─────────────────────────────────────────────

function TemperamentSection({
  petId,
  record,
  canWrite,
  pending,
  run,
}: {
  petId: string
  record: SafetyRecord
  canWrite: boolean
  pending: boolean
  run: Runner
}) {
  const [open, setOpen] = useState(false)
  const [classification, setClassification] = useState<TemperamentClassification>('DOCILE')
  const [contexts, setContexts] = useState<TemperamentContext[]>([])
  const [notes, setNotes] = useState('')
  const [requiresMuzzle, setRequiresMuzzle] = useState(false)
  const [requiresTwoHandlers, setRequiresTwoHandlers] = useState(false)

  const { current, history, hadRiskHistory } = record.temperament
  const needsNotes = classification === 'AGGRESSIVE' || classification === 'REACTIVE'

  return (
    <Card tone="soft" className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <SectionHead
          icon={<PawPrintIcon />}
          tone="icon-pet"
          eyebrow="Prontuário"
          title="Temperamento"
        />
        {canWrite && (
          <Button
            type="button"
            variant={open ? 'ghost' : 'primary'}
            className="ml-auto px-3 py-1 text-xs"
            onClick={() => setOpen((value) => !value)}
          >
            {open ? 'Cancelar' : 'Registrar observação'}
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <span className="text-lg font-medium">
          {current ? TEMPERAMENT_LABELS[current.classification] : 'Não avaliado'}
        </span>
        {current?.requiresMuzzle && (
          <span className="pill bg-danger/10 px-3 py-1 text-xs text-danger">Exige focinheira</span>
        )}
        {current?.requiresTwoHandlers && (
          <span className="pill bg-danger/10 px-3 py-1 text-xs text-danger">
            Exige dois profissionais
          </span>
        )}
      </div>

      {/*
        RN-16: o histórico de risco nunca some em silêncio. Um pet dócil hoje que
        mordeu há dois anos continua sendo um pet que mordeu.
      */}
      {hadRiskHistory &&
        current &&
        !['AGGRESSIVE', 'REACTIVE'].includes(current.classification) && (
          <p className="rounded-xl bg-accent-soft px-4 py-3 text-sm text-accent-ink">
            Histórico: já apresentou reatividade em atendimentos anteriores.
          </p>
        )}

      {current?.notes && <p className="hint">{current.notes}</p>}

      {current && current.contexts.length > 0 && (
        <p className="hint">
          Contextos:{' '}
          {current.contexts
            .map((context) => TEMPERAMENT_CONTEXT_LABELS[context as TemperamentContext] ?? context)
            .join(', ')}
        </p>
      )}

      {open && (
        <div className="space-y-3 rounded-2xl bg-black/[0.02] p-4">
          <Field label="Classificação" htmlFor="temperament-class">
            <select
              id="temperament-class"
              className="field"
              value={classification}
              onChange={(event) =>
                setClassification(event.target.value as TemperamentClassification)
              }
            >
              {Object.entries(TEMPERAMENT_LABELS).map(([value, text]) => (
                <option key={value} value={value}>
                  {text}
                </option>
              ))}
            </select>
          </Field>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Em que situações</legend>
            <div className="flex flex-wrap gap-2">
              {TEMPERAMENT_CONTEXTS.map((context) => (
                <label
                  key={context}
                  className={`pill cursor-pointer px-3 py-1 text-xs ${
                    contexts.includes(context) ? 'bg-shell text-white' : 'bg-black/5 text-muted'
                  }`}
                >
                  {/*
                    Sem `.check`: esta caixa é invisível de propósito, e quem mostra o
                    estado é a pílula que a embrulha. Estilizar o átomo aqui seria pintar
                    algo que `sr-only` recorta — o padrão de `docs/design-formularios.md`
                    vale para a caixa que aparece, não para a que serve só de semântica.
                  */}
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={contexts.includes(context)}
                    onChange={() =>
                      setContexts((current) =>
                        current.includes(context)
                          ? current.filter((item) => item !== context)
                          : [...current, context],
                      )
                    }
                  />
                  {TEMPERAMENT_CONTEXT_LABELS[context]}
                </label>
              ))}
            </div>
          </fieldset>

          <Field
            label={needsNotes ? 'Contexto (obrigatório)' : 'Observação (opcional)'}
            htmlFor="temperament-notes"
            hint={
              needsNotes
                ? 'Descreva o que aconteceu — a equipe precisa saber o que evitar.'
                : undefined
            }
          >
            <textarea
              id="temperament-notes"
              className="field"
              rows={2}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </Field>

          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                className="check"
                type="checkbox"
                checked={requiresMuzzle}
                onChange={(event) => setRequiresMuzzle(event.target.checked)}
              />
              Exige focinheira
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                className="check"
                type="checkbox"
                checked={requiresTwoHandlers}
                onChange={(event) => setRequiresTwoHandlers(event.target.checked)}
              />
              Exige dois profissionais
            </label>
          </div>

          <Button
            type="button"
            busy={pending}
            disabled={needsNotes && notes.trim().length < 10}
            onClick={() =>
              run(async () => {
                const result = await recordTemperamentAction(petId, {
                  classification,
                  contexts,
                  requiresMuzzle,
                  requiresTwoHandlers,
                  ...(notes.trim() ? { notes: notes.trim() } : {}),
                })
                if (result.ok) {
                  setOpen(false)
                  setNotes('')
                  setContexts([])
                }
                return result
              })
            }
            busyLabel="Salvando…"
          >
            Registrar
          </Button>
        </div>
      )}

      {history.length > 1 && (
        <details>
          <summary className="hint cursor-pointer">Histórico ({history.length} registros)</summary>
          <ul className="mt-2 divide-y divide-black/5">
            {history.map((entry) => (
              <li key={entry.id} className="py-2">
                <span className="text-sm">{TEMPERAMENT_LABELS[entry.classification]}</span>
                <span className="hint"> · {formatDate(entry.observedAt)}</span>
                {entry.notes && <p className="hint">{entry.notes}</p>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  )
}

// ─── Alertas médicos (MOD-PRONT-05) ──────────────────────────────────────────

function MedicalAlertSection({
  petId,
  alerts,
  canCreate,
  canManage,
  pending,
  run,
}: {
  petId: string
  alerts: MedicalAlert[]
  canCreate: boolean
  canManage: boolean
  pending: boolean
  run: Runner
}) {
  const [open, setOpen] = useState(false)
  const [condition, setCondition] = useState('')
  const [severity, setSeverity] = useState<ClinicalSeverity>('MEDIUM')
  const [instructions, setInstructions] = useState('')
  const [deactivating, setDeactivating] = useState<string | null>(null)
  const [justification, setJustification] = useState('')

  const active = alerts.filter((alert) => alert.active)

  return (
    <Card tone="soft" className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <SectionHead
          icon={<HeartPulseIcon />}
          tone="icon-pet"
          eyebrow="Prontuário"
          title="Condições médicas"
        />
        <span className="meta-pill">{active.length} ativas</span>
        {canCreate && (
          <Button
            type="button"
            variant={open ? 'ghost' : 'primary'}
            className="ml-auto px-3 py-1 text-xs"
            onClick={() => setOpen((value) => !value)}
          >
            {open ? 'Cancelar' : 'Registrar condição'}
          </Button>
        )}
      </div>

      {open && (
        <div className="space-y-3 rounded-2xl bg-black/[0.02] p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Condição" htmlFor="alert-condition">
              <input
                id="alert-condition"
                className="field"
                value={condition}
                onChange={(event) => setCondition(event.target.value)}
                placeholder="Ex.: Cardiopatia"
              />
            </Field>

            <Field label="Severidade" htmlFor="alert-severity">
              <select
                id="alert-severity"
                className="field"
                value={severity}
                onChange={(event) => setSeverity(event.target.value as ClinicalSeverity)}
              >
                {Object.entries(SEVERITY_LABELS).map(([value, text]) => (
                  <option key={value} value={value}>
                    {text}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field
            label="Instrução para a execução"
            htmlFor="alert-instructions"
            hint="O que a equipe deve fazer diferente. Ex.: “não usar secador quente”."
          >
            <textarea
              id="alert-instructions"
              className="field"
              rows={2}
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
            />
          </Field>

          <Button
            type="button"
            busy={pending}
            disabled={condition.trim().length < 2}
            onClick={() =>
              run(async () => {
                const result = await createMedicalAlertAction(petId, {
                  condition: condition.trim(),
                  severity,
                  ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
                })
                if (result.ok) {
                  setOpen(false)
                  setCondition('')
                  setInstructions('')
                }
                return result
              })
            }
            busyLabel="Salvando…"
          >
            Registrar
          </Button>
        </div>
      )}

      {alerts.length === 0 ? (
        <p className="hint">Nenhuma condição registrada.</p>
      ) : (
        <ul className="divide-y divide-black/5">
          {alerts.map((alert) => (
            <li key={alert.id} className="space-y-2 py-3">
              <div className="flex flex-wrap items-center gap-3">
                <span className={alert.active ? 'font-medium' : 'text-muted line-through'}>
                  {alert.condition}
                </span>
                <span
                  className={`pill px-3 py-1 text-xs font-medium ${SEVERITY_TONE[alert.severity]}`}
                >
                  {SEVERITY_LABELS[alert.severity]}
                </span>

                {canManage && alert.active && (
                  <Button
                    type="button"
                    className="ml-auto px-3 py-1 text-xs"
                    disabled={pending}
                    onClick={() => {
                      setDeactivating(deactivating === alert.id ? null : alert.id)
                      setJustification('')
                    }}
                  >
                    Desativar
                  </Button>
                )}
              </div>

              {alert.instructions && <p className="hint">{alert.instructions}</p>}
              {!alert.active && alert.resolutionNotes && (
                <p className="hint">Desativada: {alert.resolutionNotes}</p>
              )}

              {deactivating === alert.id && (
                <div className="space-y-2 rounded-xl bg-black/[0.02] p-3">
                  <Field label="Justificativa" htmlFor={`justify-alert-${alert.id}`}>
                    <textarea
                      id={`justify-alert-${alert.id}`}
                      className="field"
                      rows={2}
                      value={justification}
                      onChange={(event) => setJustification(event.target.value)}
                    />
                  </Field>
                  <Button
                    type="button"
                    variant="accent"
                    busy={pending}
                    disabled={justification.trim().length < 10}
                    onClick={() =>
                      run(async () => {
                        const result = await updateMedicalAlertAction(petId, alert.id, {
                          active: false,
                          resolutionNotes: justification.trim(),
                        })
                        if (result.ok) setDeactivating(null)
                        return result
                      })
                    }
                    busyLabel="Desativando…"
                  >
                    Confirmar
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString('pt-BR')
}
