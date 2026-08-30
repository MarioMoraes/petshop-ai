import type { MovementDay } from '@petshop/shared-types'
import { TrendingUpIcon } from '@/components/icons'

/**
 * O movimento dos últimos 7 dias.
 *
 * Substituiu o cartão "Atendimentos hoje" no topo do painel porque um número solto do
 * dia não responde à pergunta que o dono faz de manhã. "12 hoje" só quer dizer alguma
 * coisa ao lado dos outros seis dias: 12 depois de uma semana de 5 é movimento
 * subindo, 12 depois de uma semana de 20 é problema. O número de hoje continua na
 * faixa, em cartão próprio — o que mudou é que ele deixou de ser a primeira coisa.
 *
 * ## O molde
 *
 * É o cartão de métrica do `design/design-modelo.html` (Composição 2, "3× faster"):
 * chip, número grande, a palavra que ele conta e as barras. Daí vêm as barras de `w-5`
 * arredondadas por inteiro (`rounded-lg`), o `items-end` e o `gap-2` — e a ausência de
 * eixo: no molde as barras se apoiam no ar, sem linha de base.
 *
 * A legenda que o molde traz no pé ("Median time from idea to shipped") saiu a pedido:
 * o eixo de dias já diz qual é o período, e a média que ela carregava é conta que o
 * próprio gráfico mostra melhor. Sem ela o cartão termina no rótulo dos dias.
 *
 * O espaçamento vertical, esse, é o do painel (`mt-5` / `mt-1`) e não o do molde
 * (`mt-6` colado): o cartão divide a faixa com "Atendimentos hoje" e "Recebido hoje",
 * e a régua precisa ser a mesma nos três.
 *
 * ## As decisões do gráfico
 *
 * **Uma cor só, em dois degraus.** É série única — sete medidas da mesma coisa —, e
 * matiz diferente faria o olho ler duas categorias. O degrau forte é hoje: o dia ainda
 * está correndo, e a barra baixa às 9h não é queda de movimento. O rótulo em negrito
 * repete o recado num canal que sobrevive ao daltonismo.
 *
 * **O dia sem movimento aparece.** Barra zerada vira uma pastilha de 4px na cor da
 * linha, com o seu `0` em cima. Coluna ausente leria como "não há dado"; a pastilha diz
 * "houve o dia, não houve ninguém" — que é informação diferente, e é a que importa
 * numa segunda-feira fechada.
 *
 * A dica de hover é CSS puro (`group-hover`): o painel é Server Component, e um estado
 * de React aqui obrigaria a tela inteira a virar cliente para mostrar sete datas.
 */

/** A altura da barra mais alta. É o `76px` do molde, arredondado para a grade de 4. */
const PLOT_HEIGHT = 72
/** Piso da barra com movimento: com 1 atendimento contra um pico de 40, 2px sumiria. */
const MIN_BAR = 6
/** A pastilha do dia zerado. Menor que o piso, para não passar por movimento. */
const ZERO_BAR = 4
/** A linha do número em cima da barra: 11px em `leading-none`, mais os 4px do `mt-1`. */
const LABEL_HEIGHT = 15

export function MovementChart({
  days,
  today,
}: {
  days: MovementDay[]
  /** `YYYY-MM-DD` no fuso do estabelecimento — quem manda é o painel, não o relógio. */
  today: string
}) {
  const total = days.reduce((sum, day) => sum + day.total, 0)
  const max = days.reduce((peak, day) => Math.max(peak, day.total), 0)

  return (
    <div className="relative z-10">
      <span className="icon-chip icon-metric">
        <TrendingUpIcon />
      </span>

      {/*
        Figura grande em algarismos proporcionais: `tabular-nums` dá a todo dígito a
        largura do `0`, e a 36px isso deixa "121" com buracos. A tabular fica onde
        serve — nos números do eixo, que precisam alinhar entre si.
      */}
      <p className="mt-5 text-4xl font-semibold">{total.toLocaleString('pt-BR')}</p>
      <p className="mt-1 text-lg font-semibold">atendimentos</p>

      <div className="mt-6 flex items-end gap-2" aria-hidden="true">
        {days.map((day) => {
          const isToday = day.date === today
          const height =
            day.total === 0
              ? ZERO_BAR
              : Math.max(MIN_BAR, Math.round((day.total / max) * PLOT_HEIGHT))

          return (
            <div key={day.date} className="group/day relative flex flex-1 flex-col items-center">
              <div
                className={`pointer-events-none absolute bottom-full z-20 mb-2 hidden w-max max-w-[12rem] rounded-2xl bg-shell px-3 py-2 text-xs leading-relaxed text-white shadow-lg group-hover/day:block ${tooltipAnchor(day.date, days)}`}
              >
                {/*
                  Duas linhas, e não uma: numa faixa de três colunas o cartão tem ~330px
                  de área útil, e "segunda-feira, 24/08 · 9 atendimentos · 1 falta" numa
                  linha só estoura isso — o `overflow-hidden` do bloom corta as pontas e
                  a dica fica pela metade nos dois lados.
                */}
                <span className="block font-semibold">{shortDateOf(day.date)}</span>
                <span className="block tabular-nums text-white/70">{tooltipDetail(day)}</span>
              </div>

              {/*
                A coluna tem altura fixa e empilha do pé para cima (`justify-end`), então
                o número sobe junto com a barra em vez de ficar numa régua no alto do
                gráfico. Colado ali em cima ele viraria uma linha de números solta, que
                se lê como legenda e não como o valor daquela barra.

                A altura reservada é o traço mais alto MAIS a linha do número: sem essa
                folga, a barra do pico empurraria o próprio rótulo para fora.
              */}
              <span
                className="flex w-full flex-col items-center justify-end"
                style={{ height: PLOT_HEIGHT + LABEL_HEIGHT }}
              >
                <span
                  className={`text-[11px] leading-none tabular-nums ${
                    isToday ? 'font-semibold text-ink' : 'font-medium text-muted'
                  }`}
                >
                  {day.total}
                </span>

                <span
                  className={`mt-1 w-full max-w-[20px] rounded-lg ${
                    day.total === 0
                      ? 'bg-line'
                      : isToday
                        ? 'bg-chart-bar-strong'
                        : 'bg-chart-bar'
                  }`}
                  style={{ height }}
                />
              </span>

              <span
                className={`mt-2 text-[11px] ${
                  isToday ? 'font-semibold text-ink' : 'text-subtle'
                }`}
              >
                {shortDayOf(day.date)}
              </span>
            </div>
          )
        })}
      </div>

      {/* O gráfico para quem não o vê: os mesmos sete números, em tabela. */}
      <table className="sr-only">
        <caption>Atendimentos por dia nos últimos sete dias</caption>
        <thead>
          <tr>
            <th scope="col">Dia</th>
            <th scope="col">Atendimentos</th>
            <th scope="col">Concluídos</th>
            <th scope="col">Faltas</th>
          </tr>
        </thead>
        <tbody>
          {days.map((day) => (
            <tr key={day.date}>
              <th scope="row">{longDayOf(day.date)}</th>
              <td>{day.total}</td>
              <td>{day.completed}</td>
              <td>{day.noShow}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** "3 atendimentos · 1 falta" — o que o número em cima da barra não cabe dizer. */
function tooltipDetail(day: MovementDay): string {
  if (day.total === 0) return 'sem atendimentos'

  const partes = [`${day.total} atendimento${day.total === 1 ? '' : 's'}`]
  if (day.noShow > 0) partes.push(`${day.noShow} falta${day.noShow === 1 ? '' : 's'}`)

  return partes.join(' · ')
}

/**
 * A dica encosta na borda em vez de estourá-la nas pontas.
 *
 * Centralizada, a dica do primeiro e do último dia passaria da largura do cartão — e
 * o cartão tem `overflow-hidden` por causa do bloom, então o que passa é cortado.
 */
function tooltipAnchor(date: string, days: MovementDay[]): string {
  if (date === days[0]?.date) return 'left-0'
  if (date === days[days.length - 1]?.date) return 'right-0'
  return 'left-1/2 -translate-x-1/2'
}

/*
 * `YYYY-MM-DD` já é o dia civil do estabelecimento: o serviço fez a conversão de fuso.
 * Formatar em UTC ao meio-dia é o que impede o navegador de reconvertê-lo e devolver o
 * dia anterior para quem estiver a oeste.
 */

/** "Seg", "Ter" — o rótulo do eixo, sem o ponto que o `pt-BR` acrescenta. */
function shortDayOf(date: string): string {
  const label = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', timeZone: 'UTC' })
    .format(new Date(`${date}T12:00:00Z`))
    .replace('.', '')

  return label.charAt(0).toUpperCase() + label.slice(1)
}

/** "Seg, 25/08" — o cabeçalho da dica, que tem 12rem para caber. */
function shortDateOf(date: string): string {
  const dia = new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'UTC',
  }).format(new Date(`${date}T12:00:00Z`))

  return `${shortDayOf(date)}, ${dia}`
}

/** "segunda-feira, 25/08" — a versão por extenso, que a tabela do leitor de tela usa. */
function longDayOf(date: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    timeZone: 'UTC',
  }).format(new Date(`${date}T12:00:00Z`))
}
