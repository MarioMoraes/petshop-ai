'use client'

import { useState, useTransition } from 'react'
import type { PortalMessage, PortalMessagesResponse } from '@petshop/shared-types'
import { SectionHead } from '@/components/ui'
import { InboxIcon, MailIcon, SmartphoneIcon } from '@/components/icons'
import { RowChip, RowItem, RowStack, RowText } from '../list'
import { carregarMensagens } from './actions'

/**
 * O histórico do que o petshop mandou (AC-01 de MOD-PORTAL-10).
 *
 * Client component pelo "ver mais", como o extrato: a primeira página vem renderizada
 * do servidor e as seguintes chegam por Server Action, sem recarregar a tela.
 *
 * **O que não está aqui não foi escondido por CSS.** Mensagem na fila, falha de
 * provedor e bloqueio por consentimento não são consultados no servidor — a garantia
 * do AC-02 mora na consulta, e um filtro nesta lista significaria que o dado chegou ao
 * celular do tutor antes de alguém decidir não mostrá-lo.
 */
export function Lista({ inicial }: { inicial: PortalMessagesResponse }) {
  const [mensagens, setMensagens] = useState(inicial.messages)
  const [page, setPage] = useState(inicial.page)
  const [erro, setErro] = useState<string | null>(null)
  const [carregando, startTransition] = useTransition()

  const restam = inicial.total - mensagens.length

  function mais() {
    setErro(null)
    startTransition(async () => {
      const resultado = await carregarMensagens(page + 1)
      if (!resultado.ok) {
        setErro(resultado.message)
        return
      }
      setMensagens((atuais) => [...atuais, ...resultado.messages])
      setPage(resultado.page)
    })
  }

  const head = (
    <SectionHead
      icon={<InboxIcon />}
      tone="icon-brand"
      title="Mensagens"
      description={
        mensagens.length === 0
          ? 'Confirmações de horário, lembretes e avisos do leva-e-traz aparecem aqui assim que forem enviados.'
          : undefined
      }
    />
  )

  if (mensagens.length === 0) return <RowStack head={head} />

  return (
    <RowStack
      head={head}
      footer={
        <>
          {erro && <p className="text-danger text-sm">{erro}</p>}

          {restam > 0 && (
            <button
              type="button"
              className="btn btn-ghost w-full"
              onClick={mais}
              disabled={carregando}
            >
              {carregando ? 'Carregando…' : 'Ver mais'}
            </button>
          )}
        </>
      }
    >
      {mensagens.map((mensagem) => (
        <Linha key={mensagem.id} mensagem={mensagem} timezone={inicial.timezone} />
      ))}
    </RowStack>
  )
}

const CANAL: Record<PortalMessage['channel'], string> = {
  WHATSAPP: 'WhatsApp',
  EMAIL: 'E-mail',
}

/**
 * O rótulo da categoria, e por que ele existe.
 *
 * O interruptor de promoções está logo abaixo desta lista, e sem a marca na linha quem
 * o desliga não sabe o que vai parar de chegar. `TRANSACTIONAL` e `OPERATIONAL` viram
 * a mesma palavra de propósito: a distinção entre "sobre um serviço contratado" e
 * "sobre a operação de hoje" é a base legal do envio, não algo que mude o que o tutor
 * faz ao ler.
 */
const CATEGORIA: Record<PortalMessage['category'], string> = {
  TRANSACTIONAL: 'Sobre seu atendimento',
  OPERATIONAL: 'Sobre seu atendimento',
  MARKETING: 'Novidades e promoções',
}

/**
 * O chip é o **canal**, e não a categoria.
 *
 * É o que a pessoa lembra: "aquilo veio no WhatsApp". A categoria já está escrita na
 * legenda, e precisa estar — é ela que liga a mensagem ao interruptor de promoções logo
 * abaixo da lista.
 */
function Linha({ mensagem, timezone }: { mensagem: PortalMessage; timezone: string }) {
  return (
    <RowItem top>
      <RowChip
        icon={mensagem.channel === 'EMAIL' ? <MailIcon /> : <SmartphoneIcon />}
        tone="icon-brand"
      />

      <RowText
        title={mensagem.subject ?? CATEGORIA[mensagem.category]}
        hint={`${data(mensagem.sentAt, timezone)} · ${CANAL[mensagem.channel]}${
          mensagem.subject ? ` · ${CATEGORIA[mensagem.category]}` : ''
        }`}
      >
        {/*
          `whitespace-pre-line` porque o corpo foi escrito com quebras de linha e é assim
          que ele chegou no WhatsApp. Colapsar tudo num parágrafo só faria a mensagem
          relida parecer outra mensagem.
        */}
        <span className="text-muted mt-1.5 block text-sm whitespace-pre-line">{mensagem.body}</span>
      </RowText>
    </RowItem>
  )
}

function data(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(new Date(instant))
}
