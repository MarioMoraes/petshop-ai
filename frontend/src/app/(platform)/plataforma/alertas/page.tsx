import Link from 'next/link'
import type { PlatformAlert, PlatformAlertStatusValue } from '@petshop/shared-types'
import { AlertTriangleIcon } from '@/components/icons'
import { Badge, EmptyState, PageHeader } from '@/components/ui'
import { serverApi } from '@/lib/api'
import { ler } from '@/lib/platform'
import { Falha, PlataformaShell, SemAcesso } from '../frame'
import { desde, numero, quando } from '../formato'

/**
 * Os alertas operacionais (MOD-ADMIN-06).
 *
 * **Esta tela não tem botão.** Não há como acender nem apagar um alerta à mão, e a
 * ausência é a decisão: quem os governa é a regra, avaliada pelo job de cinco em cinco
 * minutos, e um "resolver" aqui faria o painel discordar da condição que continua valendo.
 * O que se faz com um alerta aceso é consertar o que ele aponta.
 *
 * **`PENDING` é um estado de verdade, e não um rascunho.** A regra só acende com a
 * condição valendo em duas avaliações seguidas — a primeira grava o pendente. Um pendente
 * que passa é **apagado**, não vira resolvido: incidente que não existiu é ruído no
 * histórico.
 */

export const dynamic = 'force-dynamic'

const FILTROS = [
  { value: '', label: 'Todos' },
  { value: 'FIRING', label: 'Acesos' },
  { value: 'PENDING', label: 'Pendentes' },
  { value: 'RESOLVED', label: 'Resolvidos' },
] as const

const ESTADO: Record<
  PlatformAlertStatusValue,
  { rotulo: string; tom: 'neutral' | 'accent' | 'success' | 'danger' }
> = {
  PENDING: { rotulo: 'pendente', tom: 'neutral' },
  FIRING: { rotulo: 'aceso', tom: 'danger' },
  RESOLVED: { rotulo: 'resolvido', tom: 'success' },
}

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function AlertasPage({ searchParams }: PageProps) {
  const params = await searchParams
  const status = statusDe(params.status)

  const leitura = await ler(
    serverApi().listPlatformAlerts({ limit: 100, ...(status ? { status } : {}) }),
  )
  if (leitura.estado === 'fechado') return <SemAcesso />

  const itens = leitura.estado === 'ok' ? leitura.dado.items : []
  const acesos = itens.filter((alerta) => alerta.status === 'FIRING').length

  return (
    <PlataformaShell active="alertas">
      <div className="mx-auto max-w-5xl space-y-6">
        <PageHeader
          eyebrow="Plataforma"
          title="Alertas"
          subtitle={
            leitura.estado === 'ok'
              ? acesos === 0
                ? 'Nenhum alerta aceso agora.'
                : `${acesos} ${acesos === 1 ? 'alerta aceso' : 'alertas acesos'} neste recorte.`
              : 'A plataforma não respondeu'
          }
        />

        <nav className="flex flex-wrap gap-1" aria-label="Filtrar por estado">
          {FILTROS.map((filtro) => {
            const ativo = (status ?? '') === filtro.value
            return (
              <Link
                key={filtro.label}
                href={filtro.value ? `/plataforma/alertas?status=${filtro.value}` : '/plataforma/alertas'}
                aria-current={ativo ? 'page' : undefined}
                className={`btn btn-ghost px-3 py-1.5 text-sm ${ativo ? 'bg-card text-ink' : ''}`}
              >
                {filtro.label}
              </Link>
            )
          })}
        </nav>

        {leitura.estado === 'erro' ? (
          <Falha titulo="Os alertas não vieram" mensagem={leitura.mensagem} />
        ) : itens.length === 0 ? (
          <EmptyState
            title="Nada aqui"
            description={
              status === 'FIRING'
                ? 'Nenhuma regra acesa: fila andando, jobs rodando e dependências no ar.'
                : 'Nenhum alerta neste recorte. As quatro regras avaliam de cinco em cinco minutos.'
            }
          />
        ) : (
          <ul className="card p-0">
            {itens.map((alerta) => (
              <li key={alerta.id} className="border-b border-line p-5 last:border-b-0">
                <Linha alerta={alerta} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </PlataformaShell>
  )
}

function Linha({ alerta }: { alerta: PlatformAlert }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="icon-chip icon-chip-sm icon-pet shrink-0">
            <AlertTriangleIcon />
          </span>
          <p className="text-sm font-semibold">{alerta.ruleLabel}</p>
          <Badge tone={ESTADO[alerta.status].tom}>{ESTADO[alerta.status].rotulo}</Badge>
        </div>

        <p className="hint mt-2 font-mono text-xs">{alerta.rule}</p>

        <p className="hint mt-1">
          {alerta.tenant ? alerta.tenant.name : 'Plataforma'} · visto pela primeira vez em{' '}
          {quando(alerta.firstSeenAt)}
          {alerta.firedAt ? ` · acendeu em ${quando(alerta.firedAt)}` : ''}
          {alerta.resolvedAt ? ` · resolveu em ${quando(alerta.resolvedAt)}` : ''}
        </p>
      </div>

      <div className="shrink-0 text-right">
        <p className="text-lg font-semibold tabular-nums">{numero(alerta.value)}</p>
        {/*
          A última avaliação diz se o alerta está vivo: uma regra acesa cuja avaliação
          parou há uma hora não significa que a condição sumiu — significa que o job que a
          avalia parou, e isso é outro problema.
        */}
        <p className="hint">avaliado {desde(alerta.lastEvaluatedAt)}</p>
      </div>
    </div>
  )
}

function statusDe(valor: unknown): PlatformAlertStatusValue | undefined {
  return valor === 'FIRING' || valor === 'PENDING' || valor === 'RESOLVED' ? valor : undefined
}
