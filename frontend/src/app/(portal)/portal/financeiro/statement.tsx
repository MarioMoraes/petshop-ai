'use client'

import { useState, useTransition } from 'react'
import {
  formatBRL,
  type PortalStatementEntry,
  type PortalStatementResponse,
} from '@petshop/shared-types'
import { Button, SectionHead } from '@/components/ui'
import { ReceiptIcon, WalletIcon } from '@/components/icons'
import { RowChip, RowItem, RowMeta, RowStack, RowText } from '../list'
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

  const head = (
    <SectionHead
      icon={<WalletIcon />}
      tone="icon-money"
      title="Lançamentos"
      description={
        entradas.length === 0
          ? 'Os atendimentos e os pagamentos aparecem aqui assim que forem registrados.'
          : undefined
      }
    />
  )

  if (entradas.length === 0) return <RowStack head={head} />

  return (
    <RowStack
      head={head}
      footer={
        <>
          {erro && <p className="text-danger text-sm">{erro}</p>}

          {restam > 0 && (
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              onClick={mais}
              busy={carregando}
              busyLabel="Carregando…"
            >
              Ver mais
            </Button>
          )}
        </>
      }
    >
      {entradas.map((entrada) => (
        <Linha key={entrada.id} entrada={entrada} timezone={inicial.timezone} />
      ))}
    </RowStack>
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
    <RowItem top>
      {/*
        O chip separa dinheiro que entrou de dinheiro que saiu pelo desenho, antes do
        sinal: a nota é o pagamento, a carteira é o atendimento lançado na conta. O tom é
        o mesmo nos dois — dinheiro é dinheiro —, e quem diz a direção continua sendo o
        sinal e o verde do valor.
      */}
      <RowChip icon={credito ? <ReceiptIcon /> : <WalletIcon />} tone="icon-money" />

      <RowText
        title={entrada.description}
        strike={entrada.reversed}
        hint={
          <>
            {data(entrada.occurredAt, timezone)}
            {entrada.petName && ` · ${entrada.petName}`}
            {entrada.reversed && ' · estornado'}
          </>
        }
      >
        {/*
          O recibo só existe onde houve pagamento. O link abre a rota do próprio Next,
          que busca a URL assinada no servidor e redireciona — um `<a>` apontando direto
          ao bucket exigiria a assinatura viajar até aqui e ficar no histórico do
          navegador.

          Ele continua um link dentro da linha, e não uma linha própria: a linha do
          extrato é leitura, e transformá-la inteira num download faria o dedo que rola a
          lista baixar PDF sem querer.
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
      </RowText>

      <RowMeta>
        <span
          className={
            entrada.reversed ? 'text-muted line-through' : credito ? 'text-success' : undefined
          }
        >
          {credito ? '+' : '−'}
          {formatBRL(Math.abs(entrada.amountCents))}
        </span>
      </RowMeta>
    </RowItem>
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
