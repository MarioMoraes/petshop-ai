'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  ENTRY_CATEGORY_LABELS,
  PAYMENT_METHOD_LABELS,
  PURCHASE_STATUS_LABELS,
  formatBRL,
  formatCentsInput,
  parseBRLToCents,
  type LedgerAccount,
  type LedgerEntry,
  type ManualEntryCategory,
  type PackagePurchase,
  type PaymentMethod,
  type PetResponse,
  type ServicePackage,
  type Statement,
} from '@petshop/shared-types'
import { Badge, Button, Card, EmptyState, Field, FormError } from '@/components/ui'
import {
  createEntryAction,
  loadReceiptAction,
  loadStatementAction,
  registerPaymentAction,
  reverseEntryAction,
  sellPackageAction,
} from './financeiro-actions'

/**
 * A conta corrente do tutor (MOD-LEDGER), dentro da ficha.
 *
 * Fica aqui, e não numa tela própria, porque é aqui que ela é usada: o atendente
 * abre o tutor com ele na frente do balcão, e "quanto ele deve" é a mesma pergunta
 * que "quem é ele". Uma tela de financeiro separada obrigaria a procurar o mesmo
 * cadastro duas vezes.
 *
 * As três ações — receber, lançar, vender pacote — abrem **em painel na própria
 * página**, não em modal. Não existe diálogo em lugar nenhum deste produto, e o
 * balcão precisa poder olhar o extrato enquanto digita o valor.
 */

interface Props {
  tutorId: string
  account: LedgerAccount
  statement: Statement
  packages: PackagePurchase[]
  catalog: ServicePackage[]
  pets: PetResponse[]
  can: { create: boolean; refund: boolean; credit: boolean }
}

type Panel = 'payment' | 'entry' | 'package' | null

/** O intervalo da tela vira consulta; sem datas, o papel cobre todo o histórico. */
function periodoNaUrl(from: string, to: string): string {
  const params = new URLSearchParams()
  if (from) params.set('from', from)
  if (to) params.set('to', to)
  const query = params.toString()
  return query ? `?${query}` : ''
}

export function FinanceiroTab({
  tutorId,
  account,
  statement,
  packages,
  catalog,
  pets,
  can,
}: Props) {
  const [panel, setPanel] = useState<Panel>(null)
  const [entries, setEntries] = useState(statement.data)
  const [summary, setSummary] = useState(statement.summary)
  const [total, setTotal] = useState(statement.total)
  const [page, setPage] = useState(statement.page)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  const totalPages = Math.max(1, Math.ceil(total / statement.limit))
  const activePackages = packages.filter((item) => item.status === 'ACTIVE')

  function reload(next: { page?: number; from?: string; to?: string } = {}) {
    setError(null)
    startTransition(async () => {
      const result = await loadStatementAction(tutorId, {
        page: next.page ?? page,
        ...((next.from ?? from) ? { from: next.from ?? from } : {}),
        ...((next.to ?? to) ? { to: next.to ?? to } : {}),
      })
      if (!result.ok) {
        setError(result.message)
        return
      }
      setEntries(result.data.data)
      setSummary(result.data.summary)
      setTotal(result.data.total)
      setPage(result.data.page)
    })
  }

  /** Toda ação que move dinheiro recarrega a página inteira: o saldo do cabeçalho,
   *  a lista de tutores e as tags automáticas mudam junto. */
  function afterMutation() {
    setPanel(null)
    router.refresh()
  }

  return (
    <div className="space-y-5">
      <FormError message={error} />

      <BalanceCard account={account} />

      {can.create && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => setPanel(panel === 'payment' ? null : 'payment')}>
            Registrar pagamento
          </Button>
          <Button type="button" onClick={() => setPanel(panel === 'entry' ? null : 'entry')}>
            Lançar {can.credit ? 'débito ou crédito' : 'débito'}
          </Button>
          {catalog.length > 0 && (
            <Button type="button" onClick={() => setPanel(panel === 'package' ? null : 'package')}>
              Vender pacote
            </Button>
          )}
        </div>
      )}

      {panel === 'payment' && (
        <PaymentPanel
          tutorId={tutorId}
          suggestedCents={account.openDebitsCents}
          onDone={afterMutation}
          onCancel={() => setPanel(null)}
        />
      )}
      {panel === 'entry' && (
        <EntryPanel
          tutorId={tutorId}
          canCredit={can.credit}
          onDone={afterMutation}
          onCancel={() => setPanel(null)}
        />
      )}
      {panel === 'package' && (
        <PackagePanel
          tutorId={tutorId}
          catalog={catalog}
          pets={pets}
          onDone={afterMutation}
          onCancel={() => setPanel(null)}
        />
      )}

      {activePackages.length > 0 && <PackagesCard purchases={activePackages} />}

      <Card>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h3 className="font-semibold">Extrato</h3>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="De" htmlFor="extrato-de">
              <input
                id="extrato-de"
                type="date"
                className="field"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
              />
            </Field>
            <Field label="Até" htmlFor="extrato-ate">
              <input
                id="extrato-ate"
                type="date"
                className="field"
                value={to}
                onChange={(event) => setTo(event.target.value)}
              />
            </Field>
            <Button
              type="button"
              busy={pending}
              onClick={() => reload({ page: 1 })}
              busyLabel="Filtrando…"
            >
              Filtrar
            </Button>
            {(from || to) && (
              <Button
                type="button"
                busy={pending}
                onClick={() => {
                  setFrom('')
                  setTo('')
                  reload({ page: 1, from: '', to: '' })
                }}
                busyLabel="Limpando…"
              >
                Limpar
              </Button>
            )}
            {/*
              Um link, e não um botão com ação: o resultado é um arquivo, e quem sabe
              baixar arquivo é o navegador. O intervalo é o **da tela** — o papel sai do
              mesmo recorte que está sendo lido, e não de um período que só o PDF conhece.
            */}
            <a
              href={`/tutores/${tutorId}/extrato${periodoNaUrl(from, to)}`}
              className="btn btn-primary"
            >
              Baixar PDF
            </a>
          </div>
        </div>

        {entries.length === 0 ? (
          <div className="mt-4">
            <EmptyState
              title="Sem movimentação"
              description={
                from || to
                  ? 'Nenhum lançamento neste período.'
                  : 'Este tutor ainda não tem lançamentos. Eles aparecem sozinhos quando um atendimento é concluído.'
              }
            />
          </div>
        ) : (
          <>
            <StatementSummary summary={summary} filtered={Boolean(from || to)} />

            <ul className="mt-4 divide-y divide-line">
              {entries.map((entry) => (
                <EntryRow
                  key={entry.id}
                  entry={entry}
                  tutorId={tutorId}
                  canRefund={can.refund}
                  onReversed={afterMutation}
                />
              ))}
            </ul>

            {totalPages > 1 && (
              <div className="mt-4 flex items-center justify-between">
                <Button
                  type="button"
                  busy={pending}
                  disabled={page <= 1}
                  onClick={() => reload({ page: page - 1 })}
                  busyLabel="Carregando…"
                >
                  ← Anteriores
                </Button>
                <span className="hint">
                  Página {page} de {totalPages}
                </span>
                <Button
                  type="button"
                  busy={pending}
                  disabled={page >= totalPages}
                  onClick={() => reload({ page: page + 1 })}
                  busyLabel="Carregando…"
                >
                  Seguintes →
                </Button>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  )
}

// ─── Saldo ───────────────────────────────────────────────────────────────────

/**
 * O saldo em destaque, com o sinal traduzido.
 *
 * "R$ -150,00" é ambíguo no balcão: quem está no vermelho, a loja ou o cliente? A
 * convenção do RN-02 é negativo = dívida, e a tela diz isso em palavras em vez de
 * confiar no sinal.
 */
function BalanceCard({ account }: { account: LedgerAccount }) {
  const inDebt = account.balanceCents < 0
  const hasCredit = account.balanceCents > 0

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="hint">
            {inDebt ? 'Em aberto' : hasCredit ? 'Crédito disponível' : 'Conta em dia'}
          </p>
          <p
            className={`mt-1 text-3xl font-semibold ${
              inDebt ? 'text-danger' : hasCredit ? 'text-success' : ''
            }`}
          >
            {formatBRL(Math.abs(account.balanceCents))}
          </p>
          {inDebt && account.openDebitsCount > 0 && (
            <p className="hint mt-1">
              {account.openDebitsCount} lançamento{account.openDebitsCount > 1 ? 's' : ''} em aberto
              {account.oldestOpenDebitAt &&
                `, o mais antigo de ${formatDate(account.oldestOpenDebitAt)}`}
            </p>
          )}
        </div>

        {account.needsReview && <Badge tone="danger">Conta em revisão de consistência</Badge>}
      </div>
    </Card>
  )
}

function StatementSummary({
  summary,
  filtered,
}: {
  summary: Statement['summary']
  filtered: boolean
}) {
  return (
    <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
      {filtered && (
        <div>
          <dt className="hint">Saldo anterior</dt>
          <dd className="font-medium">{formatBRL(summary.openingBalanceCents)}</dd>
        </div>
      )}
      <div>
        <dt className="hint">Débitos</dt>
        <dd className="font-medium text-danger">{formatBRL(summary.totalDebitsCents)}</dd>
      </div>
      <div>
        <dt className="hint">Créditos</dt>
        <dd className="font-medium text-success">{formatBRL(summary.totalCreditsCents)}</dd>
      </div>
      <div>
        <dt className="hint">Saldo</dt>
        <dd className="font-medium">{formatBRL(summary.closingBalanceCents)}</dd>
      </div>
    </dl>
  )
}

// ─── Linha do extrato ────────────────────────────────────────────────────────

function EntryRow({
  entry,
  tutorId,
  canRefund,
  onReversed,
}: {
  entry: LedgerEntry
  tutorId: string
  canRefund: boolean
  onReversed: () => void
}) {
  const [reversing, setReversing] = useState(false)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const isDebit = entry.direction === 'DEBIT'
  const isReversed = entry.status === 'REVERSED'
  // O resgate de pacote vale zero de propósito: ele existe para o uso aparecer no
  // extrato, não para cobrar.
  const isRedemption = entry.category === 'PACKAGE_REDEMPTION'
  const openCents = entry.amountCents - entry.settledCents

  function submit() {
    setError(null)
    startTransition(async () => {
      const result = await reverseEntryAction(tutorId, entry.id, reason)
      if (result.ok) onReversed()
      else setError(result.message)
    })
  }

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`font-medium ${isReversed ? 'text-subtle line-through' : ''}`}>
              {entry.description}
            </span>
            {isReversed && <Badge>Estornado</Badge>}
            {!isReversed && isDebit && !isRedemption && openCents === 0 && (
              <Badge tone="success">Quitado</Badge>
            )}
            {!isReversed && isDebit && openCents > 0 && entry.settledCents > 0 && (
              <Badge tone="accent">Parcial · falta {formatBRL(openCents)}</Badge>
            )}
          </div>
          <p className="hint mt-1">
            {formatDate(entry.occurredAt)} · {ENTRY_CATEGORY_LABELS[entry.category]}
          </p>
        </div>

        <div className="text-right">
          <p
            className={`font-semibold ${
              isRedemption ? 'text-subtle' : isDebit ? 'text-danger' : 'text-success'
            }`}
          >
            {isRedemption
              ? 'Pago com pacote'
              : `${isDebit ? '−' : '+'} ${formatBRL(entry.amountCents)}`}
          </p>
          <p className="hint">Saldo: {formatBRL(entry.balanceAfterCents)}</p>
        </div>
      </div>

      {/* RN-25: só o gestor estorna, e nunca o que já foi estornado. */}
      {canRefund && !isReversed && !isRedemption && (
        <div className="mt-2">
          {reversing ? (
            <div className="space-y-2">
              <FormError message={error} />
              <Field
                label="Motivo do estorno"
                htmlFor={`reverse-${entry.id}`}
                hint="Fica registrado no extrato ao lado do lançamento original."
              >
                <input
                  id={`reverse-${entry.id}`}
                  className="field"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="Ex.: cobrança em duplicidade"
                />
              </Field>
              <div className="flex gap-2">
                <Button
                  type="button"
                  busy={pending}
                  disabled={reason.trim().length < 3}
                  onClick={submit}
                  busyLabel="Estornando…"
                >
                  Confirmar estorno
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => setReversing(false)}
                >
                  Cancelar
                </Button>
              </div>
            </div>
          ) : (
            <button type="button" className="hint underline" onClick={() => setReversing(true)}>
              Estornar
            </button>
          )}
        </div>
      )}

      {/* O comprovante existe só para o crédito que entrou como pagamento. */}
      {entry.category === 'PAYMENT' && entry.sourceId && !isReversed && (
        <ReceiptLink paymentId={entry.sourceId} />
      )}
    </li>
  )
}

/**
 * O link do recibo.
 *
 * Busca sob demanda, no clique, e não junto do extrato: assinar a URL de cada
 * pagamento de uma página seria uma operação de cripto por linha para um link que
 * quase nunca é clicado. O botão vira o link depois da primeira busca.
 */
function ReceiptLink({ paymentId }: { paymentId: string }) {
  const [receipt, setReceipt] = useState<{ number: string; url: string | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function load() {
    setError(null)
    startTransition(async () => {
      const result = await loadReceiptAction(paymentId)
      if (!result.ok) {
        setError(result.message)
        return
      }
      setReceipt({ number: result.data.number, url: result.data.url })
      if (result.data.url) window.open(result.data.url, '_blank', 'noopener')
    })
  }

  if (receipt) {
    return (
      <p className="hint mt-2">
        {receipt.url ? (
          <a href={receipt.url} target="_blank" rel="noopener noreferrer" className="underline">
            Recibo {receipt.number}
          </a>
        ) : (
          // Recibo com número mas sem arquivo: o Gotenberg não respondeu e o job vai
          // tentar de novo. Dizer isso é melhor que um link que não abre.
          <>Recibo {receipt.number} — em preparo, tente de novo em instantes</>
        )}
      </p>
    )
  }

  return (
    <div className="mt-2">
      <button type="button" className="hint underline" disabled={pending} onClick={load}>
        {pending ? 'Buscando recibo…' : 'Recibo'}
      </button>
      {error && (
        <span className="hint ml-2 text-danger" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}

// ─── Pacotes ─────────────────────────────────────────────────────────────────

function PackagesCard({ purchases }: { purchases: PackagePurchase[] }) {
  return (
    <Card>
      <h3 className="font-semibold">Pacotes ativos</h3>
      <ul className="mt-3 space-y-2">
        {purchases.map((purchase) => {
          const daysLeft = Math.ceil(
            (new Date(purchase.expiresAt).getTime() - Date.now()) / 86_400_000,
          )
          return (
            <li key={purchase.id} className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-medium">{purchase.name}</p>
                <p className="hint">
                  {purchase.petName ? `${purchase.petName} · ` : ''}
                  {PURCHASE_STATUS_LABELS[purchase.status]}
                </p>
              </div>
              <div className="text-right">
                <p className="font-medium">
                  {purchase.creditsRemaining} de {purchase.creditsTotal} restante
                  {purchase.creditsRemaining === 1 ? '' : 's'}
                </p>
                {/* RN-09: a validade nunca pode ser surpresa. Quinze dias é quando o
                    aviso automático sai — na tela, o alerta começa junto. */}
                <p className={`hint ${daysLeft <= 15 ? 'text-danger' : ''}`}>
                  expira em {formatDate(purchase.expiresAt)}
                  {daysLeft <= 15 &&
                    daysLeft >= 0 &&
                    ` · ${daysLeft} dia${daysLeft === 1 ? '' : 's'}`}
                </p>
              </div>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

// ─── Painéis de ação ─────────────────────────────────────────────────────────

/**
 * Campo de dinheiro.
 *
 * Aceita o que o balcão digita — com ou sem "R$", vírgula ou ponto — e converte para
 * centavos na borda. O estado é a string, não o número: forçar a máscara a cada tecla
 * faria o cursor pular no meio da digitação.
 */
function MoneyField({
  id,
  label,
  value,
  onChange,
  error,
  hint,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  error?: string
  hint?: string
}) {
  return (
    <Field label={label} htmlFor={id} {...(error ? { error } : {})} {...(hint ? { hint } : {})}>
      <input
        id={id}
        className="field"
        inputMode="decimal"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="0,00"
      />
    </Field>
  )
}

function PaymentPanel({
  tutorId,
  suggestedCents,
  onDone,
  onCancel,
}: {
  tutorId: string
  suggestedCents: number
  onDone: () => void
  onCancel: () => void
}) {
  // O valor vem preenchido com o que está em aberto: é o pagamento que acontece em
  // nove de cada dez vezes, e digitá-lo de novo só cria oportunidade de errar.
  const [amount, setAmount] = useState(suggestedCents > 0 ? formatCentsInput(suggestedCents) : '')
  const [method, setMethod] = useState<PaymentMethod>('PIX_MANUAL')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [pending, startTransition] = useTransition()

  const amountCents = parseBRLToCents(amount)

  function submit() {
    setError(null)
    setFieldErrors({})
    if (!amountCents || amountCents <= 0) {
      setFieldErrors({ amountCents: 'Informe um valor maior que zero.' })
      return
    }

    startTransition(async () => {
      const result = await registerPaymentAction({
        tutorId,
        amountCents,
        method,
        receivedAt: new Date().toISOString(),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      })
      if (result.ok) {
        onDone()
        return
      }
      setError(result.message)
      setFieldErrors(result.fieldErrors)
    })
  }

  return (
    <Card>
      <h3 className="font-semibold">Registrar pagamento recebido</h3>
      <p className="hint mt-1">
        O dinheiro entra fora do sistema — no balcão, no PIX ou na maquininha. Aqui se registra o
        recebimento, que quita os lançamentos mais antigos primeiro.
      </p>

      <FormError message={error} />

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <MoneyField
          id="pagamento-valor"
          label="Valor recebido"
          value={amount}
          onChange={setAmount}
          {...(fieldErrors.amountCents ? { error: fieldErrors.amountCents } : {})}
          {...(suggestedCents > 0 && amountCents !== null && amountCents > suggestedCents
            ? { hint: `Sobra de ${formatBRL(amountCents - suggestedCents)} fica como crédito.` }
            : {})}
        />

        <Field label="Forma de pagamento" htmlFor="pagamento-forma">
          <select
            id="pagamento-forma"
            className="field"
            value={method}
            onChange={(event) => setMethod(event.target.value as PaymentMethod)}
          >
            {(Object.keys(PAYMENT_METHOD_LABELS) as PaymentMethod[])
              // Crédito de pacote não é forma de recebimento no balcão: ele é
              // consumido pelo atendimento, não digitado por alguém.
              .filter((key) => key !== 'PACKAGE_CREDIT')
              .map((key) => (
                <option key={key} value={key}>
                  {PAYMENT_METHOD_LABELS[key]}
                </option>
              ))}
          </select>
        </Field>
      </div>

      <div className="mt-4">
        <Field
          label="Observação (opcional)"
          htmlFor="pagamento-notas"
          hint="Visível só para a equipe."
        >
          <input
            id="pagamento-notas"
            className="field"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="Ex.: pagou com o PIX da esposa"
          />
        </Field>
      </div>

      <div className="mt-4 flex gap-2">
        <Button type="button" busy={pending} onClick={submit} busyLabel="Registrando…">
          Registrar pagamento
        </Button>
        <Button type="button" variant="ghost" disabled={pending} onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </Card>
  )
}

/** Categorias que o balcão pode lançar à mão. As demais nascem de um fato do sistema. */
const DEBIT_CATEGORIES: ManualEntryCategory[] = ['PRODUCT', 'SERVICE', 'ADJUSTMENT']
const CREDIT_CATEGORIES: ManualEntryCategory[] = ['DISCOUNT', 'ADJUSTMENT']

function EntryPanel({
  tutorId,
  canCredit,
  onDone,
  onCancel,
}: {
  tutorId: string
  canCredit: boolean
  onDone: () => void
  onCancel: () => void
}) {
  const [direction, setDirection] = useState<'DEBIT' | 'CREDIT'>('DEBIT')
  const [category, setCategory] = useState<ManualEntryCategory>('PRODUCT')
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')
  const [internalNotes, setInternalNotes] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [pending, startTransition] = useTransition()

  const categories = direction === 'DEBIT' ? DEBIT_CATEGORIES : CREDIT_CATEGORIES
  const amountCents = parseBRLToCents(amount)

  function switchDirection(next: 'DEBIT' | 'CREDIT') {
    setDirection(next)
    setCategory(next === 'DEBIT' ? 'PRODUCT' : 'DISCOUNT')
  }

  function submit() {
    setError(null)
    setFieldErrors({})
    if (!amountCents || amountCents <= 0) {
      setFieldErrors({ amountCents: 'Informe um valor maior que zero.' })
      return
    }
    if (description.trim().length < 3) {
      setFieldErrors({ description: 'Descreva o lançamento — o tutor lê isto no extrato.' })
      return
    }

    startTransition(async () => {
      const result = await createEntryAction({
        tutorId,
        direction,
        amountCents,
        category,
        description: description.trim(),
        ...(internalNotes.trim() ? { internalNotes: internalNotes.trim() } : {}),
      })
      if (result.ok) {
        onDone()
        return
      }
      setError(result.message)
      setFieldErrors(result.fieldErrors)
    })
  }

  return (
    <Card>
      <h3 className="font-semibold">Lançamento manual</h3>

      <FormError message={error} />

      {canCredit && (
        <div className="mt-3 flex gap-2" role="radiogroup" aria-label="Tipo de lançamento">
          {(['DEBIT', 'CREDIT'] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={direction === option}
              onClick={() => switchDirection(option)}
              className={`pill px-4 py-1.5 text-sm font-medium ${
                direction === option ? 'bg-ink text-white' : 'bg-black/5 text-muted'
              }`}
            >
              {option === 'DEBIT' ? 'Cobrar (débito)' : 'Creditar (desconto)'}
            </button>
          ))}
        </div>
      )}

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <MoneyField
          id="lancamento-valor"
          label="Valor"
          value={amount}
          onChange={setAmount}
          {...(fieldErrors.amountCents ? { error: fieldErrors.amountCents } : {})}
        />

        <Field label="Categoria" htmlFor="lancamento-categoria">
          <select
            id="lancamento-categoria"
            className="field"
            value={category}
            onChange={(event) => setCategory(event.target.value as ManualEntryCategory)}
          >
            {categories.map((key) => (
              <option key={key} value={key}>
                {ENTRY_CATEGORY_LABELS[key]}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="mt-4 space-y-4">
        <Field
          label="Descrição"
          htmlFor="lancamento-descricao"
          {...(fieldErrors.description ? { error: fieldErrors.description } : {})}
          hint="É o texto que o tutor lê no extrato."
        >
          <input
            id="lancamento-descricao"
            className="field"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Ex.: Ração Premium 3kg"
          />
        </Field>

        <Field
          label="Nota interna (opcional)"
          htmlFor="lancamento-nota"
          hint="Nunca aparece para o tutor."
        >
          <input
            id="lancamento-nota"
            className="field"
            value={internalNotes}
            onChange={(event) => setInternalNotes(event.target.value)}
          />
        </Field>
      </div>

      <div className="mt-4 flex gap-2">
        <Button type="button" busy={pending} onClick={submit} busyLabel="Lançando…">
          Lançar
        </Button>
        <Button type="button" variant="ghost" disabled={pending} onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </Card>
  )
}

function PackagePanel({
  tutorId,
  catalog,
  pets,
  onDone,
  onCancel,
}: {
  tutorId: string
  catalog: ServicePackage[]
  pets: PetResponse[]
  onDone: () => void
  onCancel: () => void
}) {
  const [packageId, setPackageId] = useState(catalog[0]?.id ?? '')
  // Um pet só: já vem escolhido. O vínculo é opcional no modelo, mas na prática o
  // pacote é sempre de um animal, e perguntar o óbvio é atrito.
  const [petId, setPetId] = useState(pets.length === 1 ? (pets[0]?.id ?? '') : '')
  const [method, setMethod] = useState<PaymentMethod>('PIX_MANUAL')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const selected = catalog.find((item) => item.id === packageId)

  function submit() {
    setError(null)
    startTransition(async () => {
      const result = await sellPackageAction({
        tutorId,
        packageId,
        ...(petId ? { petId } : {}),
        paymentMethod: method,
      })
      if (result.ok) {
        onDone()
        return
      }
      setError(result.message)
    })
  }

  return (
    <Card>
      <h3 className="font-semibold">Vender pacote</h3>

      <FormError message={error} />

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="Pacote" htmlFor="pacote-id">
          <select
            id="pacote-id"
            className="field"
            value={packageId}
            onChange={(event) => setPackageId(event.target.value)}
          >
            {catalog.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} — {formatBRL(item.priceCents)}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Pet" htmlFor="pacote-pet" hint="O crédito fica vinculado a este animal.">
          <select
            id="pacote-pet"
            className="field"
            value={petId}
            onChange={(event) => setPetId(event.target.value)}
          >
            <option value="">Sem vínculo com pet</option>
            {pets.map((pet) => (
              <option key={pet.id} value={pet.id}>
                {pet.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="mt-4">
        <Field label="Forma de pagamento" htmlFor="pacote-forma">
          <select
            id="pacote-forma"
            className="field"
            value={method}
            onChange={(event) => setMethod(event.target.value as PaymentMethod)}
          >
            {(Object.keys(PAYMENT_METHOD_LABELS) as PaymentMethod[])
              .filter((key) => key !== 'PACKAGE_CREDIT')
              .map((key) => (
                <option key={key} value={key}>
                  {PAYMENT_METHOD_LABELS[key]}
                </option>
              ))}
          </select>
        </Field>
      </div>

      {/* CDC art. 46: cláusula não informada é cláusula inválida. A validade e a
          ausência de reembolso aparecem **antes** da venda, não no extrato depois. */}
      {selected && (
        <p className="hint mt-4">
          {selected.credits} créditos de {selected.serviceNames.join(', ')} por{' '}
          {formatBRL(selected.priceCents)}. Vale {selected.validityDays} dias a partir de hoje;
          crédito não usado expira e não é devolvido.
        </p>
      )}

      <div className="mt-4 flex gap-2">
        <Button
          type="button"
          busy={pending}
          disabled={!packageId}
          onClick={submit}
          busyLabel="Vendendo…"
        >
          Confirmar venda
        </Button>
        <Button type="button" variant="ghost" disabled={pending} onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </Card>
  )
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString('pt-BR')
}
