'use client'

import { useState, useTransition } from 'react'
import { formatBRL, type PortalStatementEntry, type PortalStatementResponse } from '@petshop/shared-types'
import { Card } from '@/components/ui'
import { carregarLancamentos } from './actions'

/**
 * O extrato (AC-01 e AC-03 de MOD-PORTAL-08).
 *
 * Client component pelo mesmo motivo do histórico do pet: o "ver mais". A primeira
 * página vem renderizada do servidor e as seguintes chegam por Server Action, sem
 * recarregar a tela.
 *
 * **A nota interna do lançamento não existe neste componente** — nem escondida por CSS,
 * nem filtrada num `map`. Ela não é consultada no servidor, e é lá que a garantia do
 * AC-02 tem de morar: um filtro na tela significaria o texto ter chegado ao celular.
 */
export function Statement({ inicial }: { inicial: PortalStatementResponse }) {
  const [entradas, setEntradas] = useState(inicial.entries)
  const [page, setPage] = useState(inicial.page)
  const [erro, setErro] = useState<string | null>(null)
  const [carregando, startTransition] = useTransition()

  const restam = inicial.total - entradas.length

  function mais() {
    setErro(null)
    startTransition(async () => {
      const resultado = await carregarLancamentos(page + 1)
      if (!resultado.ok) {
        setErro(resultado.message)
        return
      }
      setEntradas((atuais) => [...atuais, ...resultado.entries])
      setPage(resultado.page)
    })
  }

  if (entradas.length === 0) {
    return (
      <Card>
        <p className="section-eyebrow">Lançamentos</p>
        <p className="hint mt-3">
          Ainda não há movimentação na sua conta. Os atendimentos e os pagamentos
          aparecem aqui assim que forem registrados.
        </p>
      </Card>
    )
  }

  return (
    <Card>
      <p className="section-eyebrow">Lançamentos</p>

      <ol className="mt-3 flex flex-col">
        {entradas.map((entrada) => (
          <Linha key={entrada.id} entrada={entrada} timezone={inicial.timezone} />
        ))}
      </ol>

      {erro && <p className="text-danger mt-3 text-sm">{erro}</p>}

      {restam > 0 && (
        <button type="button" className="btn btn-ghost mt-4 w-full" onClick={mais} disabled={carregando}>
          {carregando ? 'Carregando…' : 'Ver mais'}
        </button>
      )}
    </Card>
  )
}

/**
 * Uma linha do extrato.
 *
 * O valor já vem com sinal do servidor — crédito positivo, débito negativo —, então a
 * tela não recombina `direction` com um valor absoluto. É uma conta a menos para errar
 * numa das duas listas.
 *
 * O lançamento estornado **aparece riscado** em vez de sumir: quem reclamou de uma
 * cobrança quer ver que ela foi desfeita, e um extrato que apaga o próprio erro faz
 * duvidar do resto.
 */
function Linha({ entrada, timezone }: { entrada: PortalStatementEntry; timezone: string }) {
  const credito = entrada.amountCents > 0

  return (
    <li className="border-line flex items-start justify-between gap-3 border-b py-3 last:border-b-0">
      <div className="min-w-0">
        <p className={`text-sm font-medium ${entrada.reversed ? 'text-muted line-through' : ''}`}>
          {entrada.description}
        </p>
        <p className="hint mt-0.5">
          {data(entrada.occurredAt, timezone)}
          {entrada.petName && ` · ${entrada.petName}`}
          {entrada.reversed && ' · estornado'}
        </p>

        {/*
          O recibo só existe onde houve pagamento. O link abre a rota do próprio Next,
          que busca a URL assinada no servidor e redireciona — um `<a>` apontando direto
          ao bucket exigiria a assinatura viajar até aqui e ficar no histórico do
          navegador.
        */}
        {entrada.paymentId && !entrada.reversed && (
          <a
            href={`/portal/financeiro/recibo/${entrada.paymentId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent-ink mt-1 inline-block text-xs font-medium hover:underline"
          >
            Baixar recibo
          </a>
        )}
      </div>

      <p
        className={`shrink-0 text-sm font-medium ${
          entrada.reversed ? 'text-muted line-through' : credito ? 'text-success' : ''
        }`}
      >
        {credito ? '+' : '−'}
        {formatBRL(Math.abs(entrada.amountCents))}
      </p>
    </li>
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
