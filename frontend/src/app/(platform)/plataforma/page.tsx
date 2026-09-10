import Link from 'next/link'
import type { DependencyHealth, JobHealth, PlatformAlert } from '@petshop/shared-types'
import { AlertTriangleIcon, HeartPulseIcon } from '@/components/icons'
import { Badge, Card, PageHeader, SectionHead } from '@/components/ui'
import { serverApi } from '@/lib/api'
import { ler, talvez } from '@/lib/platform'
import { Falha, PlataformaShell, SemAcesso } from './frame'
import { daqui, desde, duracao, hora, quando } from './formato'

/**
 * A saúde da plataforma (MOD-ADMIN-04) — a entrada do console.
 *
 * A tela responde à pergunta que a equipe faz de manhã: *o que quebrou desde ontem*. Ela
 * é a razão de o módulo existir — `job_runs` acumula desde a primeira fatia do produto e
 * até aqui ninguém a lia; um `ledger.reconcile` que falhava três noites seguidas só
 * aparecia semanas depois, como divergência de saldo que já tinha contaminado extrato.
 *
 * **A rota nunca falha por dependência fora do ar**: o estado vem no corpo, e uma linha
 * vermelha diz mais que um 503 numa tela cujo trabalho é justamente mostrar o que caiu.
 * O que a tela precisa tratar é a recusa da sessão e a queda do próprio processo.
 *
 * Os alertas que **estão acesos** vêm junto, no topo. Eles moram na tela de Alertas, com
 * histórico e filtro; aqui aparecem só os `FIRING`, porque quem abre a saúde quer saber
 * se há incêndio antes de ler o painel inteiro.
 */

export const dynamic = 'force-dynamic'

export default async function SaudePage() {
  const leitura = await ler(serverApi().getPlatformHealth())
  if (leitura.estado === 'fechado') return <SemAcesso />

  const alertas =
    leitura.estado === 'ok'
      ? ((await talvez(serverApi().listPlatformAlerts({ status: 'FIRING', limit: 20 })))?.items ??
        [])
      : []

  return (
    <PlataformaShell active="saude">
      <div className="mx-auto max-w-5xl space-y-6">
        <PageHeader
          eyebrow="Plataforma"
          title="Saúde"
          subtitle={
            leitura.estado === 'ok'
              ? `Verificado às ${hora(leitura.dado.checkedAt)}`
              : 'A plataforma não respondeu'
          }
        />

        {leitura.estado === 'erro' ? (
          <Falha titulo="A plataforma não respondeu" mensagem={leitura.mensagem} />
        ) : (
          <>
            {alertas.length > 0 && <Acesos alertas={alertas} />}
            <Dependencias itens={leitura.dado.dependencies} />
            <Jobs itens={leitura.dado.jobs} />
            <Fila itens={leitura.dado.messages} />
          </>
        )}
      </div>
    </PlataformaShell>
  )
}

/** Os alertas acesos agora. Cartão de aviso, e não lista: são para interromper a leitura. */
function Acesos({ alertas }: { alertas: PlatformAlert[] }) {
  return (
    <Card>
      <SectionHead
        icon={<AlertTriangleIcon />}
        tone="icon-pet"
        eyebrow="Agora"
        title={alertas.length === 1 ? 'Um alerta aceso' : `${alertas.length} alertas acesos`}
        description="A regra viu a condição valendo em duas avaliações seguidas. Enquanto estiver aqui, ela continua valendo."
      />

      <ul className="mt-5 flex flex-col gap-3">
        {alertas.map((alerta) => (
          <li
            key={alerta.id}
            className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line pb-3 last:border-b-0 last:pb-0"
          >
            <span className="min-w-0">
              <span className="block text-sm font-medium">{alerta.ruleLabel}</span>
              <span className="hint block">
                {alerta.tenant ? alerta.tenant.name : 'Plataforma'} · desde{' '}
                {quando(alerta.firedAt ?? alerta.firstSeenAt)}
              </span>
            </span>
            <span className="shrink-0 tabular-nums text-sm font-semibold text-danger">
              {alerta.value.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}
            </span>
          </li>
        ))}
      </ul>

      <p className="hint mt-4">
        <Link href="/plataforma/alertas" className="underline underline-offset-2">
          Ver todos os alertas
        </Link>
      </p>
    </Card>
  )
}

/** O nome da dependência como a equipe a chama; o enum é do código, não da tela. */
const DEPENDENCIA: Record<DependencyHealth['name'], string> = {
  postgres: 'Postgres',
  redis: 'Redis',
  rabbitmq: 'RabbitMQ',
  gotenberg: 'Gotenberg',
}

/**
 * As quatro dependências.
 *
 * **`DISABLED` não é vermelho**, e a distinção é o que mantém a cor confiável: o processo
 * sobe com Redis, broker e Gotenberg desligados em instalação mínima, e pintar os três de
 * vermelho ensinaria a equipe a ignorar a cor no dia em que ela importasse.
 */
function Dependencias({ itens }: { itens: DependencyHealth[] }) {
  return (
    <Card>
      <SectionHead
        icon={<HeartPulseIcon />}
        tone="icon-health"
        eyebrow="Infraestrutura"
        title="Dependências"
        description="A sonda roda no momento em que esta tela é aberta. Desligado por configuração não é falha."
      />

      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {itens.map((item) => (
          <div key={item.name} className="rounded-2xl border border-line px-4 py-3">
            <div className="flex items-center gap-2">
              <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${pontoDe(item.state)}`} />
              <p className="text-sm font-medium">{DEPENDENCIA[item.name]}</p>
            </div>
            <p className="hint mt-1 tabular-nums">
              {item.state === 'DISABLED'
                ? 'desligado'
                : item.state === 'DOWN'
                  ? 'fora do ar'
                  : item.latencyMs !== null
                    ? `${item.latencyMs} ms`
                    : 'no ar'}
            </p>
            {item.error && <p className="error-text mt-1 break-words">{item.error}</p>}
          </div>
        ))}
      </div>
    </Card>
  )
}

function pontoDe(state: DependencyHealth['state']): string {
  if (state === 'UP') return 'bg-success'
  if (state === 'DOWN') return 'bg-danger'
  return 'bg-line'
}

const ESTADO_JOB: Record<JobHealth['state'], { rotulo: string; tom: 'neutral' | 'success' | 'danger' | 'accent' }> = {
  OK: { rotulo: 'ok', tom: 'success' },
  FAILING: { rotulo: 'falhando', tom: 'danger' },
  STALE: { rotulo: 'parado', tom: 'danger' },
  NEVER_RUN: { rotulo: 'nunca rodou', tom: 'neutral' },
}

/**
 * A grade de jobs.
 *
 * Tabela de verdade: são colunas de tempo que só se comparam alinhadas — o que se procura
 * aqui é a linha que destoa das outras dezoito.
 *
 * A ordem põe o que dói primeiro. Um job parado no meio de uma lista alfabética de
 * dezenove é exatamente o que ninguém vê.
 */
function Jobs({ itens }: { itens: JobHealth[] }) {
  const ordenados = [...itens].sort((a, b) => peso(b) - peso(a) || a.name.localeCompare(b.name))
  const doentes = itens.filter((job) => job.state === 'FAILING' || job.state === 'STALE').length

  return (
    <Card>
      <SectionHead
        icon={<AlertTriangleIcon />}
        tone="icon-time"
        eyebrow="Grade"
        title={`Jobs (${itens.length})`}
        description={
          doentes === 0
            ? 'Nenhum job falhando ou parado. "Parado" é três vezes o intervalo do próprio cron, e não um número fixo de minutos.'
            : `${doentes} ${doentes === 1 ? 'job pede' : 'jobs pedem'} atenção. "Parado" é três vezes o intervalo do próprio cron.`
        }
      />

      <div className="mt-5 -mx-6 overflow-x-auto sm:-mx-8">
        <table className="w-full min-w-[46rem] border-collapse text-sm">
          <thead>
            <tr className="border-y border-line">
              <th className="hint px-6 py-3 text-left font-medium sm:px-8">Job</th>
              <th className="hint px-4 py-3 text-left font-medium">Grade</th>
              <th className="hint px-4 py-3 text-left font-medium">Estado</th>
              <th className="hint px-4 py-3 text-right font-medium">Última</th>
              <th className="hint px-4 py-3 text-right font-medium">Duração</th>
              <th className="hint px-6 py-3 text-right font-medium sm:px-8">Próxima</th>
            </tr>
          </thead>
          <tbody>
            {ordenados.map((job) => (
              <tr key={job.name} className="border-b border-line last:border-b-0">
                <td className="px-6 py-3 sm:px-8">
                  <span className="font-medium">{job.name}</span>
                  {job.lastError && (
                    <span className="error-text mt-0.5 block max-w-[22rem] truncate" title={job.lastError}>
                      {job.lastError}
                    </span>
                  )}
                  {/*
                    O lease preso é o único lugar do produto onde uma réplica que morreu
                    no meio do job aparece: o lease vence sozinho, a passada seguinte
                    segue normalmente e nada no log diz que alguém caiu segurando o job.
                  */}
                  {job.stuckLease && (
                    <span className="error-text mt-0.5 block">
                      lease preso por {job.stuckLease.holder} até{' '}
                      {quando(job.stuckLease.leaseUntil)}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-muted">{job.schedule}</td>
                <td className="px-4 py-3">
                  <Badge tone={ESTADO_JOB[job.state].tom}>{ESTADO_JOB[job.state].rotulo}</Badge>
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {job.lastRunAt ? (
                    <span title={quando(job.lastRunAt)}>{desde(job.lastRunAt)}</span>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-muted">
                  {duracao(job.lastDurationMs)}
                </td>
                <td className="px-6 py-3 text-right tabular-nums text-muted sm:px-8">
                  {daqui(job.nextRunAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

function peso(job: JobHealth): number {
  if (job.stuckLease) return 4
  if (job.state === 'FAILING') return 3
  if (job.state === 'STALE') return 2
  if (job.state === 'NEVER_RUN') return 1
  return 0
}

/** Quanto há na fila de saída, por status. É a profundidade que o alarme de fila mede. */
function Fila({ itens }: { itens: { status: string; count: number }[] }) {
  if (itens.length === 0) return null

  return (
    <Card>
      <SectionHead
        icon={<HeartPulseIcon />}
        tone="icon-metric"
        eyebrow="Mensageria"
        title="Fila de saída"
        description="O que o motor de mensagens tem em mãos agora, somando todos os estabelecimentos."
      />

      <div className="mt-5 flex flex-wrap gap-3">
        {itens.map((item) => (
          <div key={item.status} className="rounded-2xl border border-line px-4 py-3">
            <p className="hint">{item.status.toLowerCase()}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {item.count.toLocaleString('pt-BR')}
            </p>
          </div>
        ))}
      </div>
    </Card>
  )
}
