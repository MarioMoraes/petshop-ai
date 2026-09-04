import { redirect } from 'next/navigation'
import {
  formatBRL,
  portalCreditCents,
  portalOwesCents,
  type PortalFinanceResponse,
  type PortalPackage,
} from '@petshop/shared-types'
import { Alert, Badge, Card } from '@/components/ui'
import { AlertTriangleIcon } from '@/components/icons'
import { PortalFrame } from '../frame'
import { Statement } from './statement'
import {
  PortalError,
  readOwnFinance,
  readOwnStatement,
  readPortalContext,
} from '@/lib/portal-api'

/**
 * Minha conta (MOD-PORTAL-08).
 *
 * A tela responde três perguntas, nesta ordem, que é a ordem em que o tutor as faz:
 * **quanto eu devo**, **o que eu já paguei** e **como eu pago**. Pacote com crédito
 * entra entre a primeira e a segunda, porque é dinheiro que já saiu do bolso dele.
 *
 * **Não há botão de pagar, e a ausência é deliberada** (AC-05). A v1 não tem meio de
 * pagamento integrado; um "pagar agora" que abrisse um diálogo pedindo para procurar o
 * petshop seria pior que o bloco honesto com a chave PIX e o horário de atendimento.
 */

export const dynamic = 'force-dynamic'

export default async function PortalFinanceiroPage({
  searchParams,
}: {
  searchParams: Promise<{ recibo?: string }>
}) {
  let context
  let finance: PortalFinanceResponse
  let statement

  try {
    ;[context, finance, statement] = await Promise.all([
      readPortalContext(),
      readOwnFinance(),
      readOwnStatement({ limit: 10 }),
    ])
  } catch (error) {
    if (error instanceof PortalError && error.status === 401) redirect('/portal/vincular')
    throw error
  }

  const { recibo } = await searchParams
  const deve = portalOwesCents(finance.balanceCents)
  const credito = portalCreditCents(finance.balanceCents)

  return (
    <PortalFrame
      tenantName={context.tenant.name}
      titulo="Minha conta"
      voltar={{ href: '/portal/inicio', label: 'Início' }}
    >
      {/*
        A volta do recibo que ainda não tem arquivo. O documento nasce depois do
        pagamento, fora da transação, e um link morto seria a pior resposta possível a
        quem clicou para guardar o comprovante.
      */}
      {recibo === 'preparo' && (
        <Alert tone="accent" icon={<AlertTriangleIcon />} title="Recibo em preparo" role="status">
          O documento está sendo gerado. Tente de novo em alguns instantes.
        </Alert>
      )}
      {recibo === 'erro' && (
        <Alert tone="danger" icon={<AlertTriangleIcon />} title="Não foi possível abrir o recibo">
          Tente novamente em instantes. Se continuar assim, fale com o{' '}
          {context.tenant.name}.
        </Alert>
      )}

      <BalanceCard finance={finance} deve={deve} credito={credito} />

      {finance.packages.length > 0 && (
        <PackagesCard packages={finance.packages} timezone={finance.timezone} />
      )}

      <Statement inicial={statement} />

      {deve > 0 && <HowToPayCard finance={finance} tenantName={context.tenant.name} />}
    </PortalFrame>
  )
}

/**
 * O saldo, dito na língua de quem lê.
 *
 * O número guardado segue a convenção da plataforma — negativo é dívida —, e **nenhuma
 * tela deveria repetir essa conta**: `portalOwesCents` e `portalCreditCents` existem
 * porque a versão anterior desta leitura, feita à mão no início do Portal, dizia "Sem
 * pendências" a quem devia.
 */
function BalanceCard({
  finance,
  deve,
  credito,
}: {
  finance: PortalFinanceResponse
  deve: number
  credito: number
}) {
  return (
    <Card>
      <p className="section-eyebrow">{deve > 0 ? 'Em aberto' : 'Sua conta'}</p>
      <p className={`mt-2 text-3xl font-semibold ${deve > 0 ? 'text-danger' : ''}`}>
        {deve > 0 ? formatBRL(deve) : credito > 0 ? formatBRL(credito) : 'Em dia'}
      </p>

      {deve > 0 && finance.oldestOpenDebitAt && (
        <p className="hint mt-2">
          O lançamento mais antigo em aberto é de{' '}
          {data(finance.oldestOpenDebitAt, finance.timezone)}.
        </p>
      )}

      {credito > 0 && (
        <p className="hint mt-2">
          Este valor entra como desconto no seu próximo atendimento.
        </p>
      )}

      {deve === 0 && credito === 0 && (
        <p className="hint mt-2">Nenhum valor em aberto por aqui.</p>
      )}
    </Card>
  )
}

/**
 * Os pacotes com crédito de pé (AC-04).
 *
 * A data de expiração vem **sempre**, e a regra de que o crédito não usado se perde vem
 * escrita junto. Dizê-la só na semana do vencimento seria avisar tarde: quem comprou
 * quatro banhos em janeiro precisa saber em janeiro até quando pode usá-los.
 */
function PackagesCard({
  packages,
  timezone,
}: {
  packages: PortalPackage[]
  timezone: string
}) {
  return (
    <Card>
      <p className="section-eyebrow">Seus pacotes</p>

      <ul className="mt-3 flex flex-col gap-3">
        {packages.map((pacote) => (
          <li key={pacote.id} className="border-line border-b pb-3 last:border-b-0 last:pb-0">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{pacote.name}</p>
                <p className="hint mt-0.5">
                  {pacote.creditsRemaining === 1
                    ? '1 crédito restante'
                    : `${pacote.creditsRemaining} créditos restantes`}
                  {pacote.petName && ` · ${pacote.petName}`}
                </p>
              </div>
              {pacote.expiringSoon && <Badge tone="danger">Vence logo</Badge>}
            </div>
            <p className="hint mt-1">Expira em {data(pacote.expiresAt, timezone)}.</p>
          </li>
        ))}
      </ul>

      <p className="hint mt-4">
        Crédito não usado até a data de expiração é perdido, e não é devolvido em
        dinheiro.
      </p>
    </Card>
  )
}

/**
 * AC-05 — o caminho real para pagar.
 *
 * Só aparece para quem deve: oferecer a chave PIX a quem está em dia é convidar a um
 * pagamento sem destino, que depois alguém do balcão tem de conciliar à mão.
 */
function HowToPayCard({
  finance,
  tenantName,
}: {
  finance: PortalFinanceResponse
  tenantName: string
}) {
  const { pixKey, phone, whatsapp, hours } = finance.howToPay
  const semNada = !pixKey && !phone && !whatsapp

  return (
    <Card>
      <p className="section-eyebrow">Como pagar</p>

      {pixKey && (
        <div className="mt-3">
          <p className="hint">Chave PIX</p>
          {/*
            `break-all` porque chave aleatória tem 36 caracteres sem espaço e estoura a
            largura de qualquer celular. Texto selecionável, e não um botão de copiar:
            copiar para a área de transferência exige JavaScript no cliente, e este
            cartão não tem outro motivo para deixar de ser servidor.
          */}
          <p className="mt-1 font-mono text-sm break-all select-all">{pixKey}</p>
        </div>
      )}

      {(phone || whatsapp) && (
        <div className="mt-4">
          <p className="hint">Falar com o {tenantName}</p>
          <p className="mt-1 text-sm font-medium">{whatsapp ?? phone}</p>
        </div>
      )}

      {hours.length > 0 && (
        <div className="mt-4">
          <p className="hint">Horário de atendimento</p>
          <ul className="mt-1 flex flex-col gap-0.5">
            {hours.map((linha) => (
              <li key={linha.label} className="text-sm">
                {linha.label}: {linha.value}
              </li>
            ))}
          </ul>
        </div>
      )}

      {semNada && (
        <p className="hint mt-3">
          Fale com o {tenantName} para combinar o pagamento.
        </p>
      )}
    </Card>
  )
}

function data(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone,
  }).format(new Date(instant))
}
