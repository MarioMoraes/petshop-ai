'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  BILLING_METHOD_LABELS,
  BILLING_METHODS,
  PLAN_CATALOG,
  SELF_SERVICE_PLANS,
  formatBRL,
  type BillingMethod,
  type Plan,
  type SubscriptionView,
} from '@petshop/shared-types'
import { Alert, Button, Card, Field, FormError, SectionHead, Segmented } from '@/components/ui'
import { ReceiptIcon, SparkleIcon, WalletIcon } from '@/components/icons'
import { assinarAction, trocarPlanoAction } from './actions'

/**
 * A ficha da assinatura.
 *
 * Um tom só, `icon-system`, porque a tela mora em Configurações (regra 3 do padrão).
 * Cada bloco grava sozinho, como os painéis de configuração: escolher e pagar é uma ação,
 * trocar de plano é outra, e as duas nunca aparecem juntas.
 */

type SelfServicePlan = (typeof SELF_SERVICE_PLANS)[number]

interface Props {
  view: SubscriptionView
  /** A volta do checkout do cartão (`?retorno=`). */
  retorno: 'pago' | 'cancelado' | null
}

export function AssinaturaForm({ view, retorno }: Props) {
  const sub = view.subscription
  const assinada = sub?.status === 'ACTIVE' || sub?.status === 'PAST_DUE'
  const emAberto = sub?.paymentUrl && (sub.status === 'PENDING' || sub.status === 'PAST_DUE')

  return (
    <div className="space-y-6">
      {retorno === 'pago' && (
        <Alert tone="accent" role="status" icon={<SparkleIcon />} title="Pagamento enviado">
          A confirmação do Asaas costuma chegar em instantes. Se o plano ainda não mudou, recarregue
          a página em um minuto.
        </Alert>
      )}
      {retorno === 'cancelado' && (
        <Alert
          tone="accent"
          role="status"
          icon={<ReceiptIcon />}
          title="O pagamento não foi concluído"
        >
          Nada foi cobrado. Dá para tentar de novo, pelo cartão ou por PIX.
        </Alert>
      )}

      {!view.configured && (
        <Alert
          tone="accent"
          role="status"
          icon={<WalletIcon />}
          title="Cobrança ainda não configurada"
        >
          Esta instalação ainda não recebe pagamentos. Fale com a equipe PetShop AI para assinar.
        </Alert>
      )}

      {emAberto && sub && (
        <Card className="space-y-4">
          <SectionHead
            icon={<ReceiptIcon />}
            tone="icon-system"
            eyebrow="Pagamento"
            title={sub.status === 'PAST_DUE' ? 'Mensalidade em aberto' : 'Pagamento em andamento'}
            description={
              sub.status === 'PAST_DUE'
                ? `A mensalidade do plano ${PLAN_CATALOG[sub.plan].name} está vencida. Depois de ${view.graceDays} dias de atraso, o sistema fica só para consulta até o pagamento.`
                : `Plano ${PLAN_CATALOG[sub.plan].name} por ${BILLING_METHOD_LABELS[sub.method]}. O plano entra em vigor assim que o pagamento for confirmado.`
            }
          />
          {/* Link externo: a página de pagamento é do Asaas, e não uma rota do app. */}
          <a href={sub.paymentUrl ?? '#'} className="btn btn-primary">
            Abrir pagamento
          </a>
        </Card>
      )}

      {view.configured && !assinada && <Assinar view={view} />}
      {assinada && <TrocarPlano view={view} />}
    </div>
  )
}

function OpcoesDePlano({
  nome,
  valor,
  onChange,
  disabled,
}: {
  nome: string
  valor: SelfServicePlan
  onChange: (plano: SelfServicePlan) => void
  disabled: boolean
}) {
  return (
    <div className="space-y-2" role="radiogroup" aria-label="Plano">
      {SELF_SERVICE_PLANS.map((key) => {
        const plano = PLAN_CATALOG[key]
        return (
          <label key={key} className="option">
            <input
              type="radio"
              name={nome}
              className="check check-radio mt-px"
              checked={valor === key}
              disabled={disabled}
              onChange={() => onChange(key)}
            />
            <span className="min-w-0">
              <span className="option-text block">
                {plano.name} ·{' '}
                {plano.priceCents === null ? 'sob consulta' : `${formatBRL(plano.priceCents)}/mês`}
              </span>
              <span className="hint mt-0.5 block">{plano.pitch}</span>
            </span>
          </label>
        )
      })}
      <p className="hint">
        {PLAN_CATALOG.ENTERPRISE.name} é sob consulta: fale com a equipe PetShop AI.
      </p>
    </div>
  )
}

function planoInicial(plan: Plan): SelfServicePlan {
  return plan === 'PRO' || plan === 'ENTERPRISE' ? 'PRO' : 'STARTER'
}

/** Escolher o plano e o meio, e ir pagar. */
function Assinar({ view }: { view: SubscriptionView }) {
  const [plano, setPlano] = useState<SelfServicePlan>(
    planoInicial(view.subscription?.plan ?? view.plan),
  )
  const [metodo, setMetodo] = useState<BillingMethod>(view.subscription?.method ?? 'CREDIT_CARD')
  const [documento, setDocumento] = useState('')
  const [erro, setErro] = useState<string | null>(null)
  const [erros, setErros] = useState<Record<string, string>>({})
  const [pendente, startTransition] = useTransition()

  function enviar(event: React.FormEvent) {
    event.preventDefault()
    setErro(null)
    setErros({})

    startTransition(async () => {
      const resultado = await assinarAction({ plan: plano, method: metodo, cpfCnpj: documento })
      if (!resultado.ok) {
        setErro(resultado.message)
        setErros(resultado.fieldErrors)
        return
      }
      // A página de pagamento é do Asaas. Na mesma aba: a volta do checkout do cartão
      // cai de novo aqui, com `?retorno=`.
      window.location.assign(resultado.data.paymentUrl)
    })
  }

  return (
    <form onSubmit={enviar} className="space-y-5" noValidate>
      <FormError message={erro} />

      <Card tone="soft" className="space-y-5">
        <SectionHead
          icon={<SparkleIcon />}
          tone="icon-system"
          eyebrow="01 · Plano"
          title="Qual plano o estabelecimento assina"
        />
        <OpcoesDePlano nome="plano-assinar" valor={plano} onChange={setPlano} disabled={pendente} />
      </Card>

      <Card tone="soft" className="space-y-5">
        <SectionHead
          icon={<WalletIcon />}
          tone="icon-system"
          eyebrow="02 · Pagamento"
          title="Como pagar a mensalidade"
          description={
            metodo === 'CREDIT_CARD'
              ? 'Cobrança automática todo mês. O cartão é digitado na página segura do Asaas, e não passa pelo PetShop AI.'
              : 'Todo mês sai uma cobrança PIX, e o aviso chega por e-mail. O acesso segue enquanto a mensalidade estiver paga.'
          }
        />

        <div>
          <p className="label">Forma de pagamento</p>
          <div className="mt-2">
            <Segmented
              ariaLabel="Forma de pagamento"
              disabled={pendente}
              value={metodo}
              options={BILLING_METHODS.map((key) => ({
                value: key,
                label: BILLING_METHOD_LABELS[key],
              }))}
              onChange={setMetodo}
            />
          </div>
        </div>

        <Field
          label="CPF ou CNPJ de quem paga"
          htmlFor="cpfCnpj"
          error={erros.cpfCnpj}
          hint="O Asaas pede o documento para emitir a cobrança."
        >
          <input
            id="cpfCnpj"
            className="field"
            inputMode="numeric"
            autoComplete="off"
            value={documento}
            disabled={pendente}
            onChange={(event) => setDocumento(event.target.value)}
          />
        </Field>

        <div className="flex justify-end">
          <Button type="submit" busy={pendente} busyLabel="Abrindo o pagamento…">
            Ir para o pagamento
          </Button>
        </div>
      </Card>
    </form>
  )
}

/** Quem já assina troca de plano aqui; o valor novo vale para a cobrança em aberto e as próximas. */
function TrocarPlano({ view }: { view: SubscriptionView }) {
  const router = useRouter()
  const atual = planoInicial(view.plan)
  const [plano, setPlano] = useState<SelfServicePlan>(atual)
  const [erro, setErro] = useState<string | null>(null)
  const [feito, setFeito] = useState<string | null>(null)
  const [pendente, startTransition] = useTransition()

  function enviar(event: React.FormEvent) {
    event.preventDefault()
    setErro(null)
    setFeito(null)

    startTransition(async () => {
      const resultado = await trocarPlanoAction({ plan: plano })
      if (!resultado.ok) {
        setErro(resultado.message)
        return
      }
      setFeito(`Plano alterado para o ${PLAN_CATALOG[plano].name}.`)
      router.refresh()
    })
  }

  if (view.plan === 'ENTERPRISE') {
    return (
      <Card className="space-y-2">
        <SectionHead
          icon={<SparkleIcon />}
          tone="icon-system"
          eyebrow="Plano"
          title="Plano Enterprise"
          description="Mudanças no Enterprise são combinadas com a equipe PetShop AI."
        />
      </Card>
    )
  }

  return (
    <form onSubmit={enviar} noValidate>
      <Card tone="soft" className="space-y-5">
        <SectionHead
          icon={<SparkleIcon />}
          tone="icon-system"
          eyebrow="Plano"
          title="Trocar de plano"
          description="A troca vale na hora, para cima ou para baixo. O valor novo entra na cobrança em aberto e nas próximas; nada do que foi registrado se perde."
        />
        <FormError message={erro} />
        {feito && <p className="text-sm text-success">{feito}</p>}
        <OpcoesDePlano nome="plano-trocar" valor={plano} onChange={setPlano} disabled={pendente} />
        <div className="flex justify-end">
          <Button type="submit" busy={pendente} busyLabel="Salvando…" disabled={plano === atual}>
            Mudar para o {PLAN_CATALOG[plano].name}
          </Button>
        </div>
      </Card>
    </form>
  )
}
