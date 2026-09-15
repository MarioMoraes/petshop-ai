'use client'

import { useEffect, useRef } from 'react'
import { addDays } from '@petshop/shared-types'
import { faixaDeDias } from '@/lib/agenda-dia'
import { Button } from '@/components/ui'

/**
 * A faixa de datas da Agenda do Dia.
 *
 * Eram três botões-fantasma — "← Anterior", "Hoje", "Próximo →" — e um seletor de
 * data. Funcionava e não dizia nada: para saber que dia da semana era o dia seguinte,
 * a recepção tinha de clicar e ler o cabeçalho.
 *
 * Sete pastilhas com o dia da semana em cima e o número embaixo entregam isso de
 * graça, e o gesto passa de "avançar um dia" para "aquele sábado". A faixa é
 * **centrada no dia escolhido**, e não alinhada à semana civil: numa quinta-feira o
 * que se quer ver é a quarta e a sexta, e uma faixa de domingo a sábado deixaria a
 * segunda seguinte fora da tela.
 *
 * As setas andam uma semana inteira, porque andar um dia já é clicar na pastilha ao
 * lado. O seletor nativo fica para o salto longo — a consulta de daqui a três meses —,
 * que é o único caso que a faixa não cobre.
 */
export function DateRail({
  date,
  today,
  onPick,
}: {
  date: string
  /** Hoje no fuso do estabelecimento, não o do navegador (RN-12). */
  today: string
  onPick: (date: string) => void
}) {
  const dias = faixaDeDias(date)
  const selecionada = useRef<HTMLButtonElement>(null)

  /*
   * Traz o dia escolhido para o meio do trilho.
   *
   * Num aparelho de 390px cabem cinco pastilhas das sete, e o trilho abre no dia mais
   * antigo — a tela do dia mostrava a agenda de hoje com a régua parada no sábado
   * retrasado. `block: 'nearest'` é o que impede a chamada de arrastar a página
   * inteira junto para acertar a horizontal.
   */
  useEffect(() => {
    selecionada.current?.scrollIntoView({ block: 'nearest', inline: 'center' })
  }, [date])

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      {/*
        `min-w-0` nos dois níveis: um filho de `flex` nasce com `min-width: auto` e se
        recusa a encolher abaixo do conteúdo, então o trilho com `overflow-x-auto`
        nunca rolava — ele empurrava a fila inteira para fora da tela e a seta da
        semana seguinte ficava cortada no aparelho de 390px.
      */}
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <button
          type="button"
          className="dialog-close"
          aria-label="Semana anterior"
          onClick={() => onPick(addDays(date, -7))}
        >
          <Chevron direction="left" />
        </button>

        {/*
          Rola sozinha no celular em vez de quebrar em duas linhas: sete pastilhas
          quebradas em 4 + 3 deixam de ler como uma régua de dias.
        */}
        <div className="flex min-w-0 gap-1 overflow-x-auto">
          {dias.map((dia) => {
            const selecionado = dia.date === date
            return (
              <button
                key={dia.date}
                ref={selecionado ? selecionada : undefined}
                type="button"
                aria-current={selecionado ? 'date' : undefined}
                aria-label={rotuloAcessivel(dia.date)}
                className={`day-pill ${selecionado ? 'day-pill-active' : ''} ${
                  dia.fimDeSemana && !selecionado ? 'opacity-70' : ''
                }`}
                onClick={() => onPick(dia.date)}
              >
                <span className="day-pill-weekday">{dia.inicial}</span>
                <span className="day-pill-number">{dia.numero}</span>
                {/* Espaço reservado sempre: sem ele as pastilhas dançam 4px. */}
                <span aria-hidden className={dia.date === today ? 'day-pill-dot' : 'h-1 w-1'} />
              </button>
            )
          })}
        </div>

        <button
          type="button"
          className="dialog-close"
          aria-label="Próxima semana"
          onClick={() => onPick(addDays(date, 7))}
        >
          <Chevron direction="right" />
        </button>
      </div>

      {/*
        No celular o seletor desce para a própria linha: dividindo a faixa com ele,
        sobravam duas pastilhas visíveis das sete, e a régua de dias deixava de ser
        régua.
      */}
      <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
        {date !== today && (
          <Button type="button" onClick={() => onPick(today)}>
            Hoje
          </Button>
        )}
        <input
          type="date"
          className="field field-inline"
          value={date}
          aria-label="Ir para uma data"
          onChange={(event) => event.target.value && onPick(event.target.value)}
        />
      </div>
    </div>
  )
}

/** O rótulo que o leitor de tela ouve — "D 30" não diz nada fora do contexto visual. */
function rotuloAcessivel(dateISO: string): string {
  return new Date(`${dateISO}T12:00:00Z`).toLocaleDateString('pt-BR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  })
}

function Chevron({ direction }: { direction: 'left' | 'right' }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={direction === 'left' ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7'} />
    </svg>
  )
}
