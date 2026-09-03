'use client'

import { useState, useTransition } from 'react'
import type { PortalTimelineEntry, PortalTimelineResponse } from '@petshop/shared-types'
import { Card } from '@/components/ui'
import { carregarMais } from './actions'

/**
 * O histórico do pet (MOD-PORTAL-04).
 *
 * A resposta à pergunta que faz o tutor ligar hoje: "quando foi o último banho?". Por
 * isso é uma lista do mais recente para o mais antigo, e não um calendário — ninguém
 * abre isto para navegar no tempo, abre para ver o topo.
 *
 * Client component por um motivo só: o "ver mais". A primeira página vem do servidor,
 * já renderizada; as seguintes chegam por Server Action, sem recarregar a tela. Rolagem
 * infinita ficou de fora de propósito — no 4G ela dispara buscas que ninguém pediu.
 *
 * O atendimento anulado **aparece**, e riscado. Ele existiu no dia em que o tutor levou
 * o pet ali, e uma linha do tempo que o esconde faz o tutor duvidar de tudo o que a
 * tela mostra.
 */
export function Timeline({
  petId,
  inicial,
  timezone,
  nome,
}: {
  petId: string
  inicial: PortalTimelineResponse
  timezone: string
  nome: string
}) {
  const [entradas, setEntradas] = useState(inicial.entries)
  const [cursor, setCursor] = useState(inicial.nextCursor)
  const [erro, setErro] = useState<string | null>(null)
  const [carregando, startTransition] = useTransition()

  function mais() {
    if (!cursor) return
    setErro(null)
    startTransition(async () => {
      const resultado = await carregarMais(petId, cursor)
      if (!resultado.ok) {
        setErro(resultado.message)
        return
      }
      setEntradas((atuais) => [...atuais, ...resultado.entries])
      setCursor(resultado.nextCursor)
    })
  }

  if (entradas.length === 0) {
    return (
      <Card>
        <p className="section-eyebrow">Histórico</p>
        <p className="hint mt-3">
          O {nome} ainda não tem atendimento registrado. Assim que ele passar por aqui, o
          que foi feito aparece nesta lista.
        </p>
      </Card>
    )
  }

  return (
    <Card>
      <p className="section-eyebrow">Histórico</p>

      <ol className="mt-4 flex flex-col">
        {entradas.map((entrada) => (
          <Entrada key={entrada.id} entrada={entrada} timezone={timezone} />
        ))}
      </ol>

      {erro && <p className="text-danger mt-3 text-sm">{erro}</p>}

      {cursor && (
        <button
          type="button"
          className="btn btn-ghost mt-4 w-full"
          onClick={mais}
          disabled={carregando}
        >
          {carregando ? 'Carregando…' : 'Ver atendimentos anteriores'}
        </button>
      )}
    </Card>
  )
}

function Entrada({ entrada, timezone }: { entrada: PortalTimelineEntry; timezone: string }) {
  const anulado = entrada.voidedAt !== null

  return (
    <li className="border-line flex gap-4 border-b py-4 last:border-0 last:pb-0">
      {/*
        A data à esquerda, em coluna fixa: é por ela que o olho desce a lista, e um
        marcador que muda de largura conforme o mês obriga a reler a cada linha.
      */}
      <div className="w-14 shrink-0 pt-0.5">
        <p className="text-sm font-semibold">{diaEMes(entrada.startedAt, timezone)}</p>
        <p className="text-subtle text-xs">{ano(entrada.startedAt, timezone)}</p>
      </div>

      <div className="min-w-0 flex-1">
        <p className={`font-medium ${anulado ? 'text-subtle line-through' : ''}`}>
          {entrada.services.length > 0 ? entrada.services.join(', ') : rotuloTipo(entrada.type)}
        </p>

        {anulado && (
          <p className="text-subtle mt-0.5 text-xs">
            Registro cancelado pelo estabelecimento em {dataCurta(entrada.voidedAt!, timezone)}
          </p>
        )}

        {!anulado && (
          <>
            {entrada.professional && (
              <p className="text-subtle text-sm">com {entrada.professional}</p>
            )}

            {entrada.weightKg !== null && (
              <p className="text-subtle text-sm">Pesou {entrada.weightKg} kg</p>
            )}

            {entrada.notes.map((nota, indice) => (
              <p key={indice} className="text-muted mt-2 text-sm">
                {nota}
              </p>
            ))}

            {entrada.photoUrls.length > 0 && (
              <div className="mt-3 flex gap-2 overflow-x-auto">
                {entrada.photoUrls.map((url) => (
                  // eslint-disable-next-line @next/next/no-img-element -- URL assinada e efêmera; o otimizador do Next a buscaria de novo depois de vencida.
                  <img
                    key={url}
                    src={url}
                    alt=""
                    className="size-20 shrink-0 rounded-xl object-cover"
                    loading="lazy"
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </li>
  )
}

/** Rótulo de reserva: o atendimento sem item lançado ainda precisa dizer o que foi. */
function rotuloTipo(tipo: string): string {
  const rotulos: Record<string, string> = {
    GROOMING: 'Tosa',
    BATH: 'Banho',
    VET_CONSULT: 'Consulta veterinária',
    VACCINE: 'Vacina',
    PROCEDURE: 'Procedimento',
    DAYCARE: 'Creche',
    OTHER: 'Atendimento',
  }
  return rotulos[tipo] ?? 'Atendimento'
}

function diaEMes(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('pt-BR', { timeZone, day: '2-digit', month: 'short' })
    .format(new Date(iso))
    .replace('.', '')
}

function ano(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('pt-BR', { timeZone, year: 'numeric' }).format(new Date(iso))
}

function dataCurta(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('pt-BR', { timeZone, dateStyle: 'short' }).format(new Date(iso))
}
