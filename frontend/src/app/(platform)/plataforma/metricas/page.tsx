import type { PlatformMetricPoint } from '@petshop/shared-types'
import { EmptyState, PageHeader } from '@/components/ui'
import { serverApi } from '@/lib/api'
import { ler, talvez } from '@/lib/platform'
import { Falha, PlataformaShell, SemAcesso } from '../frame'
import { numero } from '../formato'
import { Consulta } from './consulta'
import { JANELAS, type Janela } from './janelas'
import { Serie } from './serie'

/**
 * A série temporal (MOD-ADMIN-05).
 *
 * As mais de sessenta métricas do produto já eram emitidas e ninguém as somava:
 * `receivables_overdue_cents` era calculada toda madrugada, escrita numa linha de log e
 * perdida. A fatia 3 do módulo deu a elas um acumulador e uma tabela; esta tela é o lugar
 * onde alguém finalmente as lê.
 *
 * **O balde servido não é o guardado**, e a tela não escolhe: até dois dias vêm baldes de
 * cinco minutos, de dois a trinta a hora agregada, acima de trinta a série diária. Quem
 * decide é o backend, pela janela pedida — trinta dias em baldes de cinco minutos seriam
 * 8.640 pontos, que é uma lista e não um gráfico.
 *
 * **Sem métrica escolhida a tela não consulta nada.** `metric` é obrigatório na rota, e
 * chutar um nome padrão faria a primeira visita abrir num gráfico que ninguém pediu.
 */

export const dynamic = 'force-dynamic'

const HORA_MS = 60 * 60 * 1000
const DIA_MS = 24 * HORA_MS

/** Quanto cada janela recua. `13m` é o teto da série diária: treze meses, não doze. */
const RECUO: Record<Janela, number> = {
  '24h': DIA_MS,
  '7d': 7 * DIA_MS,
  '30d': 30 * DIA_MS,
  '13m': 396 * DIA_MS,
}

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function MetricasPage({ searchParams }: PageProps) {
  const params = await searchParams
  const metric = typeof params.metric === 'string' ? params.metric.trim().slice(0, 60) : ''
  const janela = janelaDe(params.janela)
  const groupBy = params.groupBy === 'tenant' ? 'tenant' : 'total'

  if (metric === '') {
    return (
      <PlataformaShell active="metricas">
        <div className="mx-auto max-w-5xl space-y-6">
          <Cabecalho />
          <Consulta metric="" janela={janela} groupBy={groupBy} />
          <EmptyState
            title="Escolha uma métrica"
            description="O nome é o mesmo que o código emite — messages_dispatched, job_failure_total, receivables_overdue_cents. O campo sugere as mais consultadas, e aceita qualquer uma."
          />
        </div>
      </PlataformaShell>
    )
  }

  const agora = Date.now()
  const leitura = await ler(
    serverApi().getPlatformMetrics({
      metric,
      from: new Date(agora - RECUO[janela]).toISOString(),
      to: new Date(agora).toISOString(),
      groupBy,
    }),
  )
  if (leitura.estado === 'fechado') return <SemAcesso />

  return (
    <PlataformaShell active="metricas">
      <div className="mx-auto max-w-5xl space-y-6">
        <Cabecalho />
        <Consulta metric={metric} janela={janela} groupBy={groupBy} />

        {leitura.estado === 'erro' ? (
          <Falha titulo="A série não veio" mensagem={leitura.mensagem} />
        ) : leitura.dado.points.length === 0 ? (
          <EmptyState
            title="Nenhuma amostra nesta janela"
            description="Ou a métrica não foi emitida no período, ou o nome não é o que o código escreve. O coletor drena de cinco em cinco minutos — o que aconteceu agora há pouco pode ainda não estar aqui."
          />
        ) : groupBy === 'tenant' ? (
          <PorEstabelecimento pontos={leitura.dado.points} metrica={metric} />
        ) : (
          <Serie serie={leitura.dado} />
        )}
      </div>
    </PlataformaShell>
  )
}

function Cabecalho() {
  return (
    <PageHeader
      eyebrow="Plataforma"
      title="Métricas"
      subtitle="A janela decide o tamanho do balde: cinco minutos até dois dias, hora até trinta, dia acima disso."
    />
  )
}

/**
 * O recorte por estabelecimento, somado na janela inteira.
 *
 * **Não é gráfico, e a razão não é preguiça**: `groupBy=tenant` devolve uma linha por
 * tenant *por balde*, e sobrepor trinta séries num cartão de 96px de altura produz uma
 * mancha em que nenhuma delas se lê. A pergunta que este recorte responde é "quem está
 * gerando isso", e essa é uma classificação — que é o que uma tabela ordenada faz.
 *
 * O nome do estabelecimento vem da lista do painel, em uma chamada a mais. Quando o id não
 * está lá — instalação com mais de cem tenants —, a tela mostra o começo do identificador
 * em vez de mentir um nome.
 */
async function PorEstabelecimento({
  pontos,
  metrica,
}: {
  pontos: PlatformMetricPoint[]
  metrica: string
}) {
  const somas = new Map<string, { sum: number; count: number; max: number }>()
  for (const ponto of pontos) {
    const chave = ponto.tenantId ?? 'plataforma'
    const atual = somas.get(chave) ?? { sum: 0, count: 0, max: 0 }
    somas.set(chave, {
      sum: atual.sum + ponto.sum,
      count: atual.count + ponto.count,
      max: Math.max(atual.max, ponto.max),
    })
  }

  const pagina = await talvez(serverApi().listPlatformTenants({ limit: 100 }))
  const nomes = new Map((pagina?.data ?? []).map((tenant) => [tenant.id, tenant.name]))

  const linhas = [...somas.entries()].sort((a, b) => b[1].sum - a[1].sum)

  return (
    <div className="card overflow-x-auto p-0">
      <table className="w-full min-w-[36rem] border-collapse text-sm">
        <caption className="sr-only">{metrica} por estabelecimento</caption>
        <thead>
          <tr className="border-b border-line">
            <th className="hint px-6 py-3 text-left font-medium">Estabelecimento</th>
            <th className="hint px-4 py-3 text-right font-medium">Soma</th>
            <th className="hint px-4 py-3 text-right font-medium">Amostras</th>
            <th className="hint px-6 py-3 text-right font-medium">Maior valor</th>
          </tr>
        </thead>
        <tbody>
          {linhas.map(([chave, valores]) => (
            <tr key={chave} className="border-b border-line last:border-b-0">
              <td className="px-6 py-3">
                {chave === 'plataforma' ? (
                  <span className="text-muted">Plataforma (sem estabelecimento)</span>
                ) : (
                  (nomes.get(chave) ?? (
                    <span className="font-mono text-xs">{chave.slice(0, 8)}</span>
                  ))
                )}
              </td>
              <td className="px-4 py-3 text-right font-medium tabular-nums">
                {numero(valores.sum)}
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-muted">
                {numero(valores.count)}
              </td>
              <td className="px-6 py-3 text-right tabular-nums text-muted">
                {numero(valores.max)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function janelaDe(valor: unknown): Janela {
  const aceitos = JANELAS.map((opcao) => opcao.value)
  return typeof valor === 'string' && (aceitos as string[]).includes(valor)
    ? (valor as Janela)
    : '24h'
}
