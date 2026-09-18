'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  ANNUAL_DISCOUNT_PERCENT,
  BILLING_CYCLES,
  BILLING_CYCLE_LABELS,
  BILLING_METHOD_LABELS,
  BILLING_METHODS,
  PLAN_CATALOG,
  PLAN_ORDER,
  SELF_SERVICE_PLANS,
  annualSavingsCents,
  formatBRL,
  planPriceCents,
  type BillingCycle,
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
 *
 * **O ciclo — mensal ou anual — só aparece na hora de assinar**, porque é só ali que ele
 * é escolhido. Depois ele vira contexto: é o que muda o preço mostrado, a frase do meio
 * de pagamento e, no anual, as próprias regras da troca de plano.
 */

type SelfServicePlan = (typeof SELF_SERVICE_PLANS)[number]

interface Props {
  view: SubscriptionView
  /** A volta do checkout do cartão (`?retorno=`). */
  retorno: 'pago' | 'cancelado' | null
}

function porCiclo(valorCents: number, cycle: BillingCycle): string {
  return `${formatBRL(valorCents)}${cycle === 'YEARLY' ? '/ano' : '/mês'}`
}

function dia(iso: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  }).format(new Date(iso))
}

export function AssinaturaForm({ view, retorno }: Props) {
  const sub = view.subscription
  const assinada = sub?.status === 'ACTIVE' || sub?.status === 'PAST_DUE'
  // O link também carrega a diferença de uma subida de plano no anual e a cobrança do
  // período seguinte no PIX — as duas chegam com a assinatura ativa, e antes ficavam
  // invisíveis até virarem atraso.
  const emAberto = Boolean(sub?.paymentUrl) && sub?.status !== 'CANCELED'

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
            title={
              sub.status === 'PAST_DUE'
                ? 'Cobrança em atraso'
                : sub.status === 'PENDING'
                  ? 'Pagamento em andamento'
                  : 'Cobrança em aberto'
            }
            description={
              sub.status === 'PAST_DUE'
                ? `A cobrança do plano ${PLAN_CATALOG[sub.plan].name} está vencida. Depois de ${view.graceDays} dias de atraso, o sistema fica só para consulta até o pagamento.`
                : sub.status === 'PENDING'
                  ? `Plano ${PLAN_CATALOG[sub.plan].name} ${sub.cycle === 'YEARLY' ? 'anual' : 'mensal'} por ${BILLING_METHOD_LABELS[sub.method]}. O plano entra em vigor assim que o pagamento for confirmado.`
                  : 'Há uma cobrança aguardando pagamento. O acesso segue normal até o vencimento.'
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
  cycle,
  onChange,
  disabled,
}: {
  nome: string
  valor: SelfServicePlan
  cycle: BillingCycle
  onChange: (plano: SelfServicePlan) => void
  disabled: boolean
}) {
  return (
    <div className="space-y-2" role="radiogroup" aria-label="Plano">
      {SELF_SERVICE_PLANS.map((key) => {
        const plano = PLAN_CATALOG[key]
        const preco = planPriceCents(key, cycle)
        const economia = annualSavingsCents(key)
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
                {plano.name} · {preco === null ? 'sob consulta' : porCiclo(preco, cycle)}
              </span>
              <span className="hint mt-0.5 block">
                {plano.pitch}
                {cycle === 'YEARLY' && economia !== null
                  ? ` Economia de ${formatBRL(economia)} no ano.`
                  : ''}
              </span>
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

/** Escolher o plano, o ciclo e o meio, e ir pagar. */
function Assinar({ view }: { view: SubscriptionView }) {
  const [plano, setPlano] = useState<SelfServicePlan>(
    planoInicial(view.subscription?.plan ?? view.plan),
  )
  const [ciclo, setCiclo] = useState<BillingCycle>(view.subscription?.cycle ?? 'MONTHLY')
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
      const resultado = await assinarAction({
        plan: plano,
        method: metodo,
        cycle: ciclo,
        cpfCnpj: documento,
      })
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

        <div>
          <p className="label">Periodicidade</p>
          <div className="mt-2">
            <Segmented
              ariaLabel="Periodicidade"
              disabled={pendente}
              value={ciclo}
              options={BILLING_CYCLES.map((key) => ({
                value: key,
                label: BILLING_CYCLE_LABELS[key],
              }))}
              onChange={setCiclo}
            />
          </div>
          <p className="hint mt-2">
            {ciclo === 'YEARLY'
              ? `O ano inteiro pago de uma vez, com ${ANNUAL_DISCOUNT_PERCENT}% de desconto.`
              : `Cobrança todo mês. No anual, ${ANNUAL_DISCOUNT_PERCENT}% de desconto.`}
          </p>
        </div>

        <OpcoesDePlano
          nome="plano-assinar"
          valor={plano}
          cycle={ciclo}
          onChange={setPlano}
          disabled={pendente}
        />
      </Card>

      <Card tone="soft" className="space-y-5">
        <SectionHead
          icon={<WalletIcon />}
          tone="icon-system"
          eyebrow="02 · Pagamento"
          title={ciclo === 'YEARLY' ? 'Como pagar a anuidade' : 'Como pagar a mensalidade'}
          description={
            metodo === 'CREDIT_CARD'
              ? `Cobrança automática ${ciclo === 'YEARLY' ? 'uma vez por ano' : 'todo mês'}. O cartão é digitado na página segura do Asaas, e não passa pelo PetShop AI.`
              : `${ciclo === 'YEARLY' ? 'Uma vez por ano' : 'Todo mês'} sai uma cobrança PIX, e o aviso chega por e-mail. O acesso segue enquanto a assinatura estiver paga.`
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

/**
 * Quem já assina troca de plano aqui.
 *
 * **No mensal a troca é uma só coisa**; no anual ela tem dois sentidos que não se parecem,
 * e a tela precisa dizer qual está prestes a acontecer antes do clique — subir cobra a
 * diferença dos meses que faltam, descer espera a renovação.
 */
function TrocarPlano({ view }: { view: SubscriptionView }) {
  const router = useRouter()
  const sub = view.subscription!
  const anual = sub.cycle === 'YEARLY'
  const atual = planoInicial(view.plan)
  const agendado = sub.scheduledPlan
  const [plano, setPlano] = useState<SelfServicePlan>(atual)
  const [erro, setErro] = useState<string | null>(null)
  const [feito, setFeito] = useState<string | null>(null)
  const [pendente, startTransition] = useTransition()

  const desce = PLAN_ORDER.indexOf(plano) < PLAN_ORDER.indexOf(atual)
  const desfaz = plano === atual && agendado !== null
  const renovacao = sub.currentPeriodEndsAt ? dia(sub.currentPeriodEndsAt) : 'a renovação'

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
      setFeito(
        desfaz
          ? `A mudança agendada foi desfeita. O plano ${PLAN_CATALOG[atual].name} continua.`
          : anual && desce
            ? `Mudança para o ${PLAN_CATALOG[plano].name} agendada para ${renovacao}.`
            : `Plano alterado para o ${PLAN_CATALOG[plano].name}.`,
      )
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
    <form onSubmit={enviar} className="space-y-5" noValidate>
      {agendado && (
        <Alert
          tone="accent"
          role="status"
          icon={<SparkleIcon />}
          title={`Mudança para o ${PLAN_CATALOG[agendado].name} agendada`}
        >
          O plano {PLAN_CATALOG[atual].name} continua valendo até {renovacao}, que é o que a
          anuidade já paga cobre. Para desfazer, escolha o {PLAN_CATALOG[atual].name} abaixo e
          confirme.
        </Alert>
      )}

      <Card tone="soft" className="space-y-5">
        <SectionHead
          icon={<SparkleIcon />}
          tone="icon-system"
          eyebrow="Plano"
          title="Trocar de plano"
          description={
            anual
              ? `Subir de plano vale na hora e gera uma cobrança com a diferença dos meses que faltam até ${renovacao}. Descer vale a partir da renovação — o plano atual continua até lá, e nada do que foi registrado se perde.`
              : 'A troca vale na hora, para cima ou para baixo. O valor novo entra na cobrança em aberto e nas próximas; nada do que foi registrado se perde.'
          }
        />
        <FormError message={erro} />
        {feito && <p className="text-sm text-success">{feito}</p>}
        <OpcoesDePlano
          nome="plano-trocar"
          valor={plano}
          cycle={sub.cycle}
          onChange={setPlano}
          disabled={pendente}
        />
        <div className="flex justify-end">
          <Button
            type="submit"
            busy={pendente}
            busyLabel="Salvando…"
            disabled={plano === atual && !desfaz}
          >
            {desfaz
              ? `Manter o ${PLAN_CATALOG[atual].name}`
              : anual && desce
                ? `Agendar o ${PLAN_CATALOG[plano].name} para a renovação`
                : `Mudar para o ${PLAN_CATALOG[plano].name}`}
          </Button>
        </div>
      </Card>
    </form>
  )
}
