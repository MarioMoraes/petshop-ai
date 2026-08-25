'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  PAYMENT_METHOD_LABELS,
  formatBRL,
  formatCentsInput,
  parseBRLToCents,
  type BillingSettings,
  type PaymentMethod,
} from '@petshop/shared-types'
import { Card, Field, FormError } from '@/components/ui'
import { updateBillingSettingsAction } from '../actions'

/**
 * Políticas financeiras do estabelecimento.
 *
 * Cada bloco salva sozinho, como em `/configuracoes`: são decisões independentes, e
 * um botão "salvar tudo" faria o dono mexer no limite de crédito sem querer ao ajustar
 * a validade do pacote.
 *
 * A multa de no-show **não** está aqui — ela mora em Configurações → Políticas, junto
 * da janela de cancelamento, porque é a agenda que a calcula. Duplicá-la criaria duas
 * telas dizendo coisas diferentes sobre quanto se cobra de quem falta.
 */

interface Props {
  settings: BillingSettings
  receivables: {
    buckets: { '0_30d': number; '30_60d': number; '60d_plus': number }
    totalCents: number
  } | null
  canEdit: boolean
}

export function BillingSettingsForm({ settings, receivables, canEdit }: Props) {
  return (
    <div className="space-y-4">
      {receivables && <ReceivablesCard receivables={receivables} />}
      <CreditLimitCard settings={settings} canEdit={canEdit} />
      <PaymentMethodsCard settings={settings} canEdit={canEdit} />
      <PackagePolicyCard settings={settings} canEdit={canEdit} />
    </div>
  )
}

/** É o indicador que o dono do petshop abre primeiro. */
function ReceivablesCard({ receivables }: { receivables: NonNullable<Props['receivables']> }) {
  const overdue = receivables.buckets['30_60d'] + receivables.buckets['60d_plus']

  return (
    <Card>
      <h3 className="font-semibold">Contas a receber</h3>
      <dl className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div>
          <dt className="hint">Total em aberto</dt>
          <dd className="text-xl font-semibold">{formatBRL(receivables.totalCents)}</dd>
        </div>
        <div>
          <dt className="hint">Até 30 dias</dt>
          <dd className="font-medium">{formatBRL(receivables.buckets['0_30d'])}</dd>
        </div>
        <div>
          <dt className="hint">30 a 60 dias</dt>
          <dd className="font-medium">{formatBRL(receivables.buckets['30_60d'])}</dd>
        </div>
        <div>
          <dt className="hint">Mais de 60 dias</dt>
          <dd className={`font-medium ${receivables.buckets['60d_plus'] > 0 ? 'text-danger' : ''}`}>
            {formatBRL(receivables.buckets['60d_plus'])}
          </dd>
        </div>
      </dl>
      {overdue > 0 && (
        <p className="hint mt-3">
          {formatBRL(overdue)} vencidos há mais de 30 dias. É o dinheiro que já saiu em serviço
          e ainda não voltou.
        </p>
      )}
    </Card>
  )
}

function useSave() {
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  function save(input: Parameters<typeof updateBillingSettingsAction>[0]) {
    setError(null)
    setSaved(false)
    startTransition(async () => {
      const result = await updateBillingSettingsAction(input)
      if (result.ok) {
        setSaved(true)
        router.refresh()
      } else {
        setError(result.message)
      }
    })
  }

  return { save, error, saved, pending }
}

function SaveRow({
  pending,
  saved,
  onSave,
  disabled,
}: {
  pending: boolean
  saved: boolean
  onSave: () => void
  disabled?: boolean
}) {
  return (
    <div className="mt-4 flex items-center gap-3">
      <button
        type="button"
        className="btn btn-primary"
        disabled={pending || disabled}
        onClick={onSave}
      >
        {pending ? 'Salvando…' : 'Salvar'}
      </button>
      {saved && <span className="hint text-success">Salvo.</span>}
    </div>
  )
}

/**
 * RN-15 — o limite é **opt-in**.
 *
 * Vazio significa "não bloqueia nada", que é o padrão de instalação: o petshop novo
 * não deve descobrir a política recusando o agendamento de um cliente antigo.
 */
function CreditLimitCard({ settings, canEdit }: { settings: BillingSettings; canEdit: boolean }) {
  const [limit, setLimit] = useState(
    settings.creditLimitCents === null ? '' : formatCentsInput(settings.creditLimitCents),
  )
  const [overdueDays, setOverdueDays] = useState(String(settings.overdueDays))
  const { save, error, saved, pending } = useSave()

  return (
    <Card>
      <h3 className="font-semibold">Limite de crédito</h3>
      <p className="hint mt-1">
        Acima deste valor em aberto, o agendamento só passa com liberação de um administrador,
        registrada com justificativa. Em branco, nada é bloqueado — só o alerta aparece.
      </p>

      <FormError message={error} />

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="Limite" htmlFor="limite" hint="Em branco = sem bloqueio.">
          <input
            id="limite"
            className="field"
            inputMode="decimal"
            value={limit}
            disabled={!canEdit}
            onChange={(event) => setLimit(event.target.value)}
            placeholder="Sem limite"
          />
        </Field>

        <Field
          label="Dias até marcar inadimplência"
          htmlFor="overdue"
          hint="A tag entra e sai sozinha; ninguém a aplica à mão."
        >
          <input
            id="overdue"
            className="field"
            inputMode="numeric"
            value={overdueDays}
            disabled={!canEdit}
            onChange={(event) => setOverdueDays(event.target.value)}
          />
        </Field>
      </div>

      {canEdit && (
        <SaveRow
          pending={pending}
          saved={saved}
          onSave={() =>
            save({
              creditLimitCents: limit.trim() === '' ? null : (parseBRLToCents(limit) ?? null),
              overdueDays: Number(overdueDays) || settings.overdueDays,
            })
          }
        />
      )}
    </Card>
  )
}

function PaymentMethodsCard({
  settings,
  canEdit,
}: {
  settings: BillingSettings
  canEdit: boolean
}) {
  const [enabled, setEnabled] = useState<PaymentMethod[]>(settings.enabledPaymentMethods)
  const { save, error, saved, pending } = useSave()

  // Crédito de pacote não é escolha do balcão: ele é consumido pelo atendimento.
  const selectable = (Object.keys(PAYMENT_METHOD_LABELS) as PaymentMethod[]).filter(
    (key) => key !== 'PACKAGE_CREDIT',
  )

  function toggle(method: PaymentMethod) {
    setEnabled((current) =>
      current.includes(method)
        ? current.filter((item) => item !== method)
        : [...current, method],
    )
  }

  return (
    <Card>
      <h3 className="font-semibold">Formas de pagamento aceitas</h3>
      <p className="hint mt-1">
        O balcão só oferece o que estiver ligado aqui. Desligar evita que &ldquo;recebi no
        cartão&rdquo; seja registrado onde cartão nunca entrou.
      </p>

      <FormError message={error} />

      <div className="mt-4 flex flex-wrap gap-2">
        {selectable.map((method) => {
          const on = enabled.includes(method)
          return (
            <button
              key={method}
              type="button"
              aria-pressed={on}
              disabled={!canEdit}
              onClick={() => toggle(method)}
              className={`pill px-3 py-1.5 text-sm font-medium ${
                on ? 'bg-ink text-white' : 'bg-black/5 text-muted'
              } ${canEdit ? '' : 'cursor-not-allowed opacity-60'}`}
            >
              {PAYMENT_METHOD_LABELS[method]}
            </button>
          )
        })}
      </div>

      {enabled.length === 0 && (
        <p className="error-text mt-2" role="alert">
          Ao menos uma forma precisa ficar ligada — senão nenhum pagamento pode ser registrado.
        </p>
      )}

      {canEdit && (
        <SaveRow
          pending={pending}
          saved={saved}
          disabled={enabled.length === 0}
          onSave={() => save({ enabledPaymentMethods: enabled })}
        />
      )}
    </Card>
  )
}

function PackagePolicyCard({
  settings,
  canEdit,
}: {
  settings: BillingSettings
  canEdit: boolean
}) {
  const [validityDays, setValidityDays] = useState(String(settings.defaultPackageValidityDays))
  const [warnings, setWarnings] = useState(settings.packageExpiryWarningDays.join(', '))
  const { save, error, saved, pending } = useSave()

  return (
    <Card>
      <h3 className="font-semibold">Pacotes pré-pagos</h3>
      <p className="hint mt-1">
        Validade sugerida ao criar um pacote novo, e quando avisar o tutor antes de o crédito
        expirar. Expiração sem aviso prévio é falha de produto, não regra de negócio.
      </p>

      <FormError message={error} />

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="Validade padrão (dias)" htmlFor="validade-padrao">
          <input
            id="validade-padrao"
            className="field"
            inputMode="numeric"
            value={validityDays}
            disabled={!canEdit}
            onChange={(event) => setValidityDays(event.target.value)}
          />
        </Field>

        <Field
          label="Avisar com (dias de antecedência)"
          htmlFor="avisos"
          hint="Separados por vírgula. Ex.: 15, 3"
        >
          <input
            id="avisos"
            className="field"
            value={warnings}
            disabled={!canEdit}
            onChange={(event) => setWarnings(event.target.value)}
          />
        </Field>
      </div>

      {canEdit && (
        <SaveRow
          pending={pending}
          saved={saved}
          onSave={() =>
            save({
              defaultPackageValidityDays:
                Number(validityDays) || settings.defaultPackageValidityDays,
              packageExpiryWarningDays: warnings
                .split(',')
                .map((item) => Number(item.trim()))
                .filter((item) => Number.isInteger(item) && item >= 0),
            })
          }
        />
      )}
    </Card>
  )
}
