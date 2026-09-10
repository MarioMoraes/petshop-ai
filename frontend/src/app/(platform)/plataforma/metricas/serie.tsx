import type { MetricBucketSize, PlatformMetricSeries } from '@petshop/shared-types'
import { numero, quando } from '../formato'

/**
 * A série, desenhada.
 *
 * **O molde é o cartão de métrica do `design/design-modelo.html`**, o mesmo de onde saiu o
 * gráfico de movimento do painel do Admin: barras arredondadas apoiadas no ar, sem eixo, e
 * o número grande em cima. O que muda é a densidade — lá são sete dias, aqui podem ser
 * duzentos e oitenta e oito baldes de cinco minutos —, e a densidade muda três coisas:
 *
 * 1. **A barra não tem largura fixa.** Ela é `flex-1` com piso de 2px: com sete pontos o
 *    gráfico se parece com o do painel, com trezentos ele vira uma faixa contínua, e nos
 *    dois casos o eixo do tempo ocupa a mesma largura.
 * 2. **O número não fica em cima de cada barra.** Com mais de vinte e quatro pontos não
 *    caberia; a dica de hover mostra o valor de um ponto por vez, e a soma da janela fica
 *    no topo do cartão.
 * 3. **O rótulo do eixo é o primeiro e o último balde**, e não um por coluna.
 *
 * **Uma cor só, em um degrau.** É série única — a mesma medida ao longo do tempo —, e um
 * segundo matiz faria o olho ler duas categorias. O balde vazio continua aparecendo como
 * pastilha na cor da linha, pela mesma razão do painel: "houve o intervalo, não houve
 * amostra" é informação diferente de "não há dado".
 */

/** A altura da barra mais alta, na régua de 4 do sistema. */
const PLOT_HEIGHT = 96
/** Piso da barra com amostra: um valor de 1 contra um pico de 4.000 sumiria. */
const MIN_BAR = 3
/** O balde sem amostra. Menor que o piso, para não passar por movimento. */
const ZERO_BAR = 2

const BALDE: Record<MetricBucketSize, string> = {
  FIVE_MIN: 'baldes de 5 minutos',
  HOUR: 'baldes de 1 hora',
  DAY: 'baldes de 1 dia',
}

export function Serie({ serie }: { serie: PlatformMetricSeries }) {
  const pontos = serie.points
  const soma = pontos.reduce((total, ponto) => total + ponto.sum, 0)
  const amostras = pontos.reduce((total, ponto) => total + ponto.count, 0)
  const pico = pontos.reduce((maior, ponto) => Math.max(maior, ponto.sum), 0)
  const p95 = pontos.reduce((maior, ponto) => Math.max(maior, ponto.p95), 0)

  return (
    <div className="card p-6 sm:p-8">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div className="min-w-0">
          <p className="text-3xl font-semibold tabular-nums">{numero(soma)}</p>
          <p className="mt-1 font-mono text-sm text-muted">{serie.metric}</p>
        </div>
        <p className="hint">
          {pontos.length} {BALDE[serie.bucketSize]} · {numero(amostras)}{' '}
          {amostras === 1 ? 'amostra' : 'amostras'}
        </p>
      </div>

      <div className="mt-6 flex items-end gap-[1px]" style={{ height: PLOT_HEIGHT }} aria-hidden>
        {pontos.map((ponto) => {
          const altura =
            ponto.sum <= 0 || pico <= 0
              ? ZERO_BAR
              : Math.max(MIN_BAR, Math.round((ponto.sum / pico) * PLOT_HEIGHT))

          return (
            <span
              key={`${ponto.bucket}-${ponto.tenantId ?? 'total'}`}
              /*
                `title` e não popover: o cartão é Server Component, e um estado de React
                aqui obrigaria a tela inteira a virar cliente para mostrar uma data.
              */
              title={`${quando(ponto.bucket)} · ${numero(ponto.sum)} (${ponto.count} ${
                ponto.count === 1 ? 'amostra' : 'amostras'
              }, p95 ${numero(ponto.p95)})`}
              className={`min-w-[2px] flex-1 rounded-sm ${
                ponto.sum > 0 ? 'bg-chart-bar' : 'bg-line'
              }`}
              style={{ height: altura }}
            />
          )
        })}
      </div>

      <div className="mt-2 flex justify-between">
        <span className="hint tabular-nums">{quando(serie.from)}</span>
        <span className="hint tabular-nums">{quando(serie.to)}</span>
      </div>

      <dl className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Numero rotulo="Soma da janela" valor={numero(soma)} />
        <Numero rotulo="Pico de um balde" valor={numero(pico)} />
        <Numero rotulo="Maior p95" valor={numero(p95)} />
        <Numero rotulo="Amostras" valor={numero(amostras)} />
      </dl>

      {/*
        O gráfico para quem não o vê. Só os vinte últimos baldes: uma tabela de trezentas
        linhas num leitor de tela é a mesma perda de sinal que a lista de 8.640 pontos que
        a escada de baldes existe para evitar.
      */}
      <table className="sr-only">
        <caption>Últimos baldes de {serie.metric}</caption>
        <thead>
          <tr>
            <th scope="col">Balde</th>
            <th scope="col">Soma</th>
            <th scope="col">Amostras</th>
            <th scope="col">p95</th>
          </tr>
        </thead>
        <tbody>
          {pontos.slice(-20).map((ponto) => (
            <tr key={`sr-${ponto.bucket}-${ponto.tenantId ?? 'total'}`}>
              <th scope="row">{quando(ponto.bucket)}</th>
              <td>{numero(ponto.sum)}</td>
              <td>{ponto.count}</td>
              <td>{numero(ponto.p95)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Numero({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div className="rounded-2xl border border-line px-3 py-2">
      <dt className="hint">{rotulo}</dt>
      <dd className="mt-0.5 text-lg font-semibold tabular-nums">{valor}</dd>
    </div>
  )
}
