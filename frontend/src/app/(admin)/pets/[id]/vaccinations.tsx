'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  OTHER_VACCINE_KEY,
  VACCINATION_ORIGIN_LABELS,
  VACCINATION_STATUS_LABELS,
  VACCINATION_DUE_SOON_DAYS,
  addDays,
  suggestNextDose,
  vaccineCatalogFor,
  type ProductDetailResponse,
  type Vaccination,
  type VaccinationCard,
  type VaccinationOrigin,
  type VaccinationStatus,
} from '@petshop/shared-types'
import { Modal } from '@/components/modal'
import { useToast } from '@/components/toast'
import {
  Badge,
  Button,
  Card,
  CardHead,
  EmptyState,
  Field,
  FormError,
  Segmented,
} from '@/components/ui'
import { SyringeIcon } from '@/components/icons'
import { useFocusFirstError } from '@/components/use-focus-first-error'
import {
  createVaccinationAction,
  listSuppliesAction,
  voidVaccinationAction,
  type ActionFailure,
} from '../actions'

/**
 * A carteira de vacinação (MOD-PRONT-08).
 *
 * Duas portas, e a tela mostra só a que o perfil abre: a **aplicada fora** (a carteira de
 * papel, que a recepção transcreve) é de quem registra alergia; a **aplicada aqui** pede
 * `record:write` e o CRMV de quem está logado, e o servidor confere os dois.
 *
 * Nada se edita: o lançado errado é anulado com motivo e continua no histórico, riscado.
 *
 * Com estoque (Pro e `inventory:read`), a aplicada aqui escolhe a **dose do estoque**: o
 * lote e a validade passam a ser os do lote, e o servidor baixa uma unidade. Anular a
 * vacina devolve a dose.
 */

const STATUS_TONE: Record<VaccinationStatus, 'neutral' | 'accent' | 'success' | 'danger'> = {
  UP_TO_DATE: 'success',
  DUE_SOON: 'accent',
  OVERDUE: 'danger',
  UNKNOWN: 'neutral',
}

interface Props {
  petId: string
  petName: string
  speciesKey: string
  card: VaccinationCard
  /** `record:write_alerts` — registrar a aplicada fora e anulá-la. */
  canWriteAlerts: boolean
  /** `record:write` — registrar e anular a aplicada aqui. */
  canManageRecord: boolean
  /** Plano com estoque e `inventory:read`: a aplicada aqui pode baixar a dose do lote. */
  hasInventory: boolean
  /** Falecido e transferido não recebem registro novo. */
  editable: boolean
}

export function VaccinationsTab(props: Props) {
  const { card, canWriteAlerts, canManageRecord, editable } = props
  const [creating, setCreating] = useState(false)
  const [voiding, setVoiding] = useState<Vaccination | null>(null)

  const today = card.today
  const canCreate = editable && (canWriteAlerts || canManageRecord)
  const currentIds = new Set(card.current.map((dose) => dose.id))
  const past = card.history.filter((dose) => !currentIds.has(dose.id))

  const registrar = canCreate ? (
    <Button onClick={() => setCreating(true)}>Registrar vacina</Button>
  ) : undefined

  function canVoid(dose: Vaccination): boolean {
    if (dose.voidedAt) return false
    return dose.origin === 'INTERNAL' ? canManageRecord : canWriteAlerts || canManageRecord
  }

  return (
    <div className="space-y-5">
      {card.history.length === 0 ? (
        <EmptyState
          icon={<SyringeIcon />}
          tone="icon-pet"
          title="Nenhuma vacina registrada"
          description="Registre a vacina aplicada aqui ou transcreva a carteira que o tutor trouxe. Com a próxima dose marcada, o tutor recebe o lembrete antes do vencimento."
          action={registrar}
        />
      ) : (
        <>
          <Card className="space-y-4">
            <CardHead
              icon={<SyringeIcon />}
              tone="icon-pet"
              title="Carteira de vacinação"
              description={
                <span className="inline-flex items-center gap-2">
                  <Badge tone={STATUS_TONE[card.status]}>
                    {VACCINATION_STATUS_LABELS[card.status]}
                  </Badge>
                  <span>A dose vigente de cada vacina.</span>
                </span>
              }
              action={registrar}
            />
            {card.current.length === 0 ? (
              <p className="hint">Todas as doses registradas foram anuladas.</p>
            ) : (
              <ul className="divide-y divide-line">
                {card.current.map((dose) => (
                  <DoseRow
                    key={dose.id}
                    dose={dose}
                    today={today}
                    onVoid={canVoid(dose) ? () => setVoiding(dose) : undefined}
                  />
                ))}
              </ul>
            )}
          </Card>

          {past.length > 0 && (
            <Card className="space-y-4">
              <CardHead
                icon={<SyringeIcon />}
                tone="icon-pet"
                title="Doses anteriores"
                description="Superadas por uma dose mais nova ou anuladas."
              />
              <ul className="divide-y divide-line">
                {/* Sem Anular: a dose superada já não conta para o status, e um botão
                    escuro por linha de histórico pesava mais que a própria carteira. */}
                {past.map((dose) => (
                  <DoseRow key={dose.id} dose={dose} today={today} past onVoid={undefined} />
                ))}
              </ul>
            </Card>
          )}
        </>
      )}

      {creating && <RegisterDialog {...props} today={today} onClose={() => setCreating(false)} />}
      {voiding && (
        <VoidDialog petId={props.petId} dose={voiding} onClose={() => setVoiding(null)} />
      )}
    </div>
  )
}

function DoseRow({
  dose,
  today,
  past = false,
  onVoid,
}: {
  dose: Vaccination
  today: string
  past?: boolean
  onVoid: (() => void) | undefined
}) {
  const voided = dose.voidedAt !== null
  const overdue = !past && !voided && dose.nextDoseAt !== null && dose.nextDoseAt < today
  const soon =
    !past &&
    !voided &&
    !overdue &&
    dose.nextDoseAt !== null &&
    dose.nextDoseAt <= addDays(today, VACCINATION_DUE_SOON_DAYS)

  const origem =
    dose.origin === 'INTERNAL'
      ? [dose.vetName, dose.crmv && `CRMV ${dose.crmv}`].filter(Boolean).join(' · ')
      : dose.externalClinic
        ? `Aplicada em ${dose.externalClinic}`
        : VACCINATION_ORIGIN_LABELS.EXTERNAL
  const lote = [dose.manufacturer, dose.batch && `lote ${dose.batch}`].filter(Boolean).join(' · ')

  return (
    <li className="flex flex-wrap items-start justify-between gap-3 py-3">
      <div className={`min-w-0 space-y-0.5 ${voided ? 'opacity-60' : ''}`}>
        <p className="flex flex-wrap items-center gap-2 font-medium">
          <span className={voided ? 'line-through' : ''}>{dose.vaccineLabel}</span>
          {overdue && <Badge tone="danger">{VACCINATION_STATUS_LABELS.OVERDUE}</Badge>}
          {soon && <Badge tone="accent">{VACCINATION_STATUS_LABELS.DUE_SOON}</Badge>}
          {voided && <Badge>Anulada</Badge>}
        </p>
        <p className="text-sm text-muted">
          Aplicada em {formatDate(dose.appliedAt)}
          {dose.nextDoseAt ? ` · próxima dose em ${formatDate(dose.nextDoseAt)}` : ' · dose única'}
        </p>
        <p className="hint">{[origem, lote].filter(Boolean).join(' · ')}</p>
        {voided && dose.voidReason && <p className="hint">Motivo da anulação: {dose.voidReason}</p>}
      </div>
      {onVoid && <Button onClick={onVoid}>Anular</Button>}
    </li>
  )
}

// ─── Registrar ───────────────────────────────────────────────────────────────

function RegisterDialog({
  petId,
  petName,
  speciesKey,
  canManageRecord,
  canWriteAlerts,
  hasInventory,
  today,
  onClose,
}: Omit<Props, 'card' | 'editable'> & { today: string; onClose: () => void }) {
  const router = useRouter()
  const toast = useToast()
  const formRef = useRef<HTMLFormElement>(null)
  const [pending, startTransition] = useTransition()
  const [failure, setFailure] = useState<ActionFailure | null>(null)
  useFocusFirstError(formRef, failure)

  const catalog = vaccineCatalogFor(speciesKey)
  // Quem só tem `record:write` (sem `write_alerts`) não existe na matriz de hoje, mas a
  // tela não presume: a origem inicial é a que o perfil consegue gravar.
  const [origin, setOrigin] = useState<VaccinationOrigin>(
    canManageRecord && !canWriteAlerts ? 'INTERNAL' : 'EXTERNAL',
  )
  const [vaccineKey, setVaccineKey] = useState(catalog[0]?.key ?? OTHER_VACCINE_KEY)
  const [vaccineLabel, setVaccineLabel] = useState('')
  const [appliedAt, setAppliedAt] = useState(today)
  const [nextDoseAt, setNextDoseAt] = useState(
    catalog[0] ? suggestNextDose(today, catalog[0].intervalMonths) : '',
  )
  // A sugestão acompanha a vacina e a data até alguém mexer na próxima dose à mão.
  const [nextTouched, setNextTouched] = useState(false)
  const [manufacturer, setManufacturer] = useState('')
  const [batch, setBatch] = useState('')
  const [batchExpiresAt, setBatchExpiresAt] = useState('')
  const [externalClinic, setExternalClinic] = useState('')

  // A dose do estoque: os lotes com código dos insumos, carregados só quando a origem
  // "aplicada aqui" aparece — a aplicada fora não mexe em estoque.
  const [lotId, setLotId] = useState('')
  const [supplies, setSupplies] = useState<ProductDetailResponse[] | null>(null)
  const [suppliesFailed, setSuppliesFailed] = useState(false)
  const useStock = origin === 'INTERNAL' && hasInventory
  useEffect(() => {
    if (!useStock || supplies !== null) return
    void listSuppliesAction().then((response) => {
      if (response.ok) setSupplies(response.data.filter((product) => product.active))
      else {
        setSupplies([])
        setSuppliesFailed(true)
      }
    })
  }, [useStock, supplies])

  const stockLots = (supplies ?? []).flatMap((product) =>
    product.lots.filter((lot) => lot.batchCode !== 'SEM-LOTE').map((lot) => ({ product, lot })),
  )
  const chosen = useStock ? stockLots.find(({ lot }) => lot.id === lotId) : undefined

  function chooseLot(id: string) {
    setLotId(id)
    const found = stockLots.find(({ lot }) => lot.id === id)
    if (found) {
      setBatch(found.lot.batchCode)
      setBatchExpiresAt(found.lot.expiresAt ?? '')
    }
  }

  function suggest(key: string, applied: string) {
    if (nextTouched) return
    const entry = catalog.find((item) => item.key === key)
    setNextDoseAt(entry && applied ? suggestNextDose(applied, entry.intervalMonths) : '')
  }

  const errors = failure?.fieldErrors ?? {}

  function submit(event: React.FormEvent) {
    event.preventDefault()
    setFailure(null)
    startTransition(async () => {
      const base = {
        vaccineKey,
        ...(vaccineKey === OTHER_VACCINE_KEY ? { vaccineLabel } : {}),
        appliedAt,
        nextDoseAt: nextDoseAt || null,
        ...(manufacturer ? { manufacturer } : {}),
        ...(batch ? { batch } : {}),
      }
      const input =
        origin === 'INTERNAL'
          ? {
              ...base,
              origin,
              batchExpiresAt: batchExpiresAt || undefined,
              ...(chosen ? { lotId: chosen.lot.id } : {}),
            }
          : { ...base, origin, ...(externalClinic ? { externalClinic } : {}) }

      const result = await createVaccinationAction(petId, input)
      if (!result.ok) {
        setFailure(result)
        return
      }
      toast('Vacina registrada.')
      onClose()
      router.refresh()
    })
  }

  return (
    <Modal
      open
      onClose={onClose}
      icon={<SyringeIcon />}
      tone="icon-pet"
      eyebrow="Carteira de vacinação"
      title="Registrar vacina"
      subtitle={petName}
      busy={pending}
      footer={
        <>
          <Button variant="ghost" disabled={pending} onClick={onClose}>
            Cancelar
          </Button>
          <Button
            busy={pending}
            busyLabel="Registrando…"
            onClick={() => formRef.current?.requestSubmit()}
          >
            Registrar vacina
          </Button>
        </>
      }
    >
      <form ref={formRef} onSubmit={submit} className="space-y-5" noValidate>
        {failure && <FormError message={failure.message} />}

        {canManageRecord && canWriteAlerts && (
          <Segmented
            ariaLabel="Onde a vacina foi aplicada"
            options={[
              { value: 'EXTERNAL', label: VACCINATION_ORIGIN_LABELS.EXTERNAL },
              { value: 'INTERNAL', label: VACCINATION_ORIGIN_LABELS.INTERNAL },
            ]}
            value={origin}
            onChange={setOrigin}
            disabled={pending}
          />
        )}
        <p className="hint">
          {origin === 'INTERNAL'
            ? 'Assinada por você, com o seu CRMV. Lote, fabricante e validade são obrigatórios.'
            : 'Transcrita da carteira que o tutor trouxe. O lote é opcional.'}
        </p>

        {useStock && (
          <Field
            label="Dose do estoque"
            htmlFor="lotId"
            error={errors.lotId}
            hint={
              suppliesFailed
                ? 'Não conseguimos carregar o estoque. Registre com o lote digitado.'
                : chosen
                  ? 'Uma unidade sai deste lote ao registrar. Anular a vacina devolve a dose.'
                  : 'Escolha o lote de onde a dose saiu para baixá-la do estoque.'
            }
          >
            <select
              id="lotId"
              className="field"
              value={lotId}
              disabled={pending || supplies === null}
              aria-invalid={Boolean(errors.lotId)}
              onChange={(event) => chooseLot(event.target.value)}
            >
              <option value="">
                {supplies === null ? 'Carregando o estoque…' : 'Não baixar do estoque'}
              </option>
              {stockLots.map(({ product, lot }) => (
                <option
                  key={lot.id}
                  value={lot.id}
                  // Vencido na prateleira não vai para a seringa: o servidor recusaria.
                  disabled={lot.expired && product.tracksExpiry}
                >
                  {product.name} · Lote {lot.batchCode}
                  {lot.expiresAt && ` · vence ${formatDate(lot.expiresAt)}`}
                  {` · saldo ${lot.quantityOnHand.replace('.', ',')}`}
                  {lot.expired && ' · vencido'}
                </option>
              ))}
            </select>
          </Field>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Vacina" htmlFor="vaccineKey" error={errors.vaccineKey}>
            <select
              id="vaccineKey"
              className="field"
              value={vaccineKey}
              disabled={pending}
              aria-invalid={Boolean(errors.vaccineKey)}
              onChange={(event) => {
                setVaccineKey(event.target.value)
                suggest(event.target.value, appliedAt)
              }}
            >
              {catalog.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
              <option value={OTHER_VACCINE_KEY}>Outra</option>
            </select>
          </Field>

          {vaccineKey === OTHER_VACCINE_KEY && (
            <Field label="Nome da vacina" htmlFor="vaccineLabel" error={errors.vaccineLabel}>
              <input
                id="vaccineLabel"
                className="field"
                value={vaccineLabel}
                maxLength={60}
                disabled={pending}
                aria-invalid={Boolean(errors.vaccineLabel)}
                onChange={(event) => setVaccineLabel(event.target.value)}
              />
            </Field>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Aplicada em" htmlFor="appliedAt" error={errors.appliedAt}>
            <input
              id="appliedAt"
              type="date"
              className="field"
              value={appliedAt}
              max={today}
              disabled={pending}
              aria-invalid={Boolean(errors.appliedAt)}
              onChange={(event) => {
                setAppliedAt(event.target.value)
                suggest(vaccineKey, event.target.value)
              }}
            />
          </Field>
          <Field
            label="Próxima dose"
            htmlFor="nextDoseAt"
            error={errors.nextDoseAt}
            hint="Sugerida pelo intervalo da vacina. Em branco, é dose única e não gera lembrete."
          >
            <input
              id="nextDoseAt"
              type="date"
              className="field"
              value={nextDoseAt}
              min={appliedAt ? addDays(appliedAt, 1) : undefined}
              disabled={pending}
              aria-invalid={Boolean(errors.nextDoseAt)}
              onChange={(event) => {
                setNextTouched(true)
                setNextDoseAt(event.target.value)
              }}
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={origin === 'INTERNAL' ? 'Fabricante' : 'Fabricante (opcional)'}
            htmlFor="manufacturer"
            error={errors.manufacturer}
          >
            <input
              id="manufacturer"
              className="field"
              value={manufacturer}
              maxLength={80}
              disabled={pending}
              aria-invalid={Boolean(errors.manufacturer)}
              onChange={(event) => setManufacturer(event.target.value)}
            />
          </Field>
          <Field
            label={origin === 'INTERNAL' ? 'Lote' : 'Lote (opcional)'}
            htmlFor="batch"
            error={errors.batch}
          >
            <input
              id="batch"
              className="field"
              value={batch}
              maxLength={40}
              // Com dose do estoque, o lote é o do estoque: a carteira e o rastreio não
              // podem discordar do código.
              disabled={pending || Boolean(chosen)}
              aria-invalid={Boolean(errors.batch)}
              onChange={(event) => setBatch(event.target.value)}
            />
          </Field>
        </div>

        {origin === 'INTERNAL' ? (
          <Field
            label="Validade do lote"
            htmlFor="batchExpiresAt"
            error={errors.batchExpiresAt}
            hint="Lote vencido na data da aplicação é recusado."
          >
            <input
              id="batchExpiresAt"
              type="date"
              className="field"
              value={batchExpiresAt}
              disabled={pending || Boolean(chosen?.lot.expiresAt)}
              aria-invalid={Boolean(errors.batchExpiresAt)}
              onChange={(event) => setBatchExpiresAt(event.target.value)}
            />
          </Field>
        ) : (
          <Field
            label="Onde foi aplicada (opcional)"
            htmlFor="externalClinic"
            error={errors.externalClinic}
          >
            <input
              id="externalClinic"
              className="field"
              value={externalClinic}
              maxLength={120}
              placeholder="Clínica ou veterinário da carteira"
              disabled={pending}
              onChange={(event) => setExternalClinic(event.target.value)}
            />
          </Field>
        )}
      </form>
    </Modal>
  )
}

// ─── Anular ──────────────────────────────────────────────────────────────────

function VoidDialog({
  petId,
  dose,
  onClose,
}: {
  petId: string
  dose: Vaccination
  onClose: () => void
}) {
  const router = useRouter()
  const toast = useToast()
  const formRef = useRef<HTMLFormElement>(null)
  const [pending, startTransition] = useTransition()
  const [failure, setFailure] = useState<ActionFailure | null>(null)
  const [reason, setReason] = useState('')
  useFocusFirstError(formRef, failure)

  function submit(event: React.FormEvent) {
    event.preventDefault()
    setFailure(null)
    startTransition(async () => {
      const result = await voidVaccinationAction(petId, dose.id, { reason })
      if (!result.ok) {
        setFailure(result)
        return
      }
      toast('Vacina anulada.')
      onClose()
      router.refresh()
    })
  }

  return (
    <Modal
      open
      onClose={onClose}
      icon={<SyringeIcon />}
      tone="icon-pet"
      eyebrow="Anular vacina"
      title={dose.vaccineLabel}
      subtitle={`Aplicada em ${formatDate(dose.appliedAt)}. O registro continua no histórico, riscado.`}
      busy={pending}
      footer={
        <>
          <Button variant="ghost" disabled={pending} onClick={onClose}>
            Cancelar
          </Button>
          <Button
            busy={pending}
            busyLabel="Anulando…"
            onClick={() => formRef.current?.requestSubmit()}
          >
            Anular vacina
          </Button>
        </>
      }
    >
      <form ref={formRef} onSubmit={submit} className="space-y-4" noValidate>
        {failure && <FormError message={failure.message} />}
        <Field
          label="Motivo"
          htmlFor="reason"
          error={failure?.fieldErrors.reason}
          hint="Quem abrir a carteira depois vai ler isto."
        >
          <textarea
            id="reason"
            className="field min-h-24"
            value={reason}
            maxLength={500}
            autoFocus
            disabled={pending}
            aria-invalid={Boolean(failure?.fieldErrors.reason)}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
      </form>
    </Modal>
  )
}

// ─── Apoio ───────────────────────────────────────────────────────────────────

function formatDate(value: string): string {
  return value.split('-').reverse().join('/')
}
