'use client'

import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  WHATSAPP_STATUS_LABELS,
  type WhatsappConnection,
  type WhatsappInstanceStatus,
} from '@petshop/shared-types'
import { Alert, Badge, Card, SectionHead } from '@/components/ui'
import { AlertTriangleIcon, PhoneIcon, SpinnerIcon } from '@/components/icons'
import {
  connectWhatsappAction,
  disconnectWhatsappAction,
  getWhatsappConnectionAction,
  refreshWhatsappQrCodeAction,
} from '../config-actions'

/**
 * A conexão do WhatsApp do estabelecimento (MOD-CRM-01).
 *
 * Fica **acima** da chave geral, e a ordem é a das perguntas: a chave decide *se* o
 * petshop manda mensagem, este cartão decide *por onde*. Com ele desconectado, tudo
 * abaixo continua funcionando — só sai por e-mail —, e a tela precisa dizer isso em vez
 * de deixar o dono descobrir pelo cliente que não recebeu no WhatsApp.
 *
 * O QR **não** é guardado em lugar nenhum: ele vence em cerca de um minuto do lado do
 * provedor. Por isso o cartão pede um novo quando o tempo acaba, em vez de deixar na
 * tela um código que a pessoa vai tentar escanear em vão.
 */

/** AC-01: o QR na tela e o polling de três em três segundos. */
const POLL_INTERVAL_MS = 3_000

/**
 * AC-03: quanto tempo o QR fica de pé antes de a tela oferecer outro.
 *
 * Cinquenta segundos, e não sessenta: o provedor vence em torno de um minuto, e um
 * botão que aparece **depois** de o código morrer chega tarde — a pessoa já tentou.
 */
const QR_LIFETIME_MS = 50_000

interface Props {
  initial: WhatsappConnection
  /** Sem `crm:connect_channel` o cartão informa, mas não age (AC-06). */
  canConnect: boolean
}

export function WhatsappCard({ initial, canConnect }: Props) {
  const router = useRouter()
  const [connection, setConnection] = useState(initial)
  const [qrCode, setQrCode] = useState<string | null>(null)
  const [qrExpired, setQrExpired] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const status = connection.status
  const waitingScan = status === 'CONNECTING' && qrCode !== null

  // `useRef` para o estado anterior: quando o pareamento conclui a página precisa ser
  // recarregada uma vez — as automações abaixo passam a poder sair por WhatsApp —, e
  // sem esta comparação o `router.refresh()` rodaria a cada volta do polling.
  const previousStatus = useRef<WhatsappInstanceStatus>(initial.status)

  const apply = useCallback(
    (next: WhatsappConnection & { qrCode?: string | null }) => {
      setConnection(next)
      if (next.qrCode !== undefined && next.qrCode !== null) {
        setQrCode(next.qrCode)
        setQrExpired(false)
      }
      if (next.status !== 'CONNECTING') setQrCode(null)
      if (next.status === 'CONNECTED' && previousStatus.current !== 'CONNECTED') {
        router.refresh()
      }
      previousStatus.current = next.status
    },
    [router],
  )

  // ─── Polling enquanto o QR está na tela ────────────────────────────────────
  useEffect(() => {
    if (!waitingScan) return

    const timer = setInterval(() => {
      void getWhatsappConnectionAction().then((result) => {
        if (result.ok) apply(result.data)
      })
    }, POLL_INTERVAL_MS)

    // O QR morre sozinho; o polling não o renova. Quem pede outro é o dono, com um
    // clique — recriar sem ele pedir gastaria chamada ao provedor com a aba esquecida
    // aberta numa recepção a tarde inteira.
    const expiry = setTimeout(() => setQrExpired(true), QR_LIFETIME_MS)

    return () => {
      clearInterval(timer)
      clearTimeout(expiry)
    }
  }, [waitingScan, apply])

  function run(
    action: () => Promise<
      { ok: true; data: WhatsappConnection } | { ok: false; message: string }
    >,
  ) {
    setError(null)
    startTransition(async () => {
      const result = await action()
      if (!result.ok) {
        setError(result.message)
        return
      }
      apply(result.data)
    })
  }

  return (
    <Card tone="soft" className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <SectionHead
          icon={<PhoneIcon />}
          tone="icon-brand"
          eyebrow="Relacionamento"
          title="WhatsApp do estabelecimento"
          description={describe(connection)}
        />
        <Badge tone={badgeTone(status)}>{WHATSAPP_STATUS_LABELS[status]}</Badge>
      </div>

      {error && (
        <Alert tone="danger" icon={<AlertTriangleIcon />} title="Não deu certo">
          {error}
        </Alert>
      )}

      {status === 'DISCONNECTED' && (
        <Alert tone="danger" icon={<AlertTriangleIcon />} title="WhatsApp desconectado">
          As mensagens não estão sendo descartadas: elas ficam esperando e saem sozinhas
          quando você reconectar. Quem tem e-mail cadastrado continua recebendo por lá.
          {connection.lastError && <span className="block mt-1">{connection.lastError}</span>}
        </Alert>
      )}

      {status === 'BANNED' && (
        <Alert tone="danger" icon={<AlertTriangleIcon />} title="Número bloqueado pelo WhatsApp">
          O canal foi desligado e as mensagens passaram a sair por e-mail. Reconectar com
          o mesmo número tende a ser bloqueado de novo — vale falar com o suporte do
          WhatsApp antes de tentar.
          {connection.lastError && <span className="block mt-1">{connection.lastError}</span>}
        </Alert>
      )}

      {/* RN-06 — o aquecimento. Sem este aviso, "só saíram 30 hoje" parece defeito. */}
      {status === 'CONNECTED' && connection.warmupDaysLeft !== null && (
        <Alert tone="accent" icon={<SpinnerIcon />} title="Número em aquecimento" role="status">
          Nos primeiros dias o envio é limitado de propósito — hoje até{' '}
          {connection.effectiveDailyCap} mensagens. Número novo disparando muito é o que
          faz o WhatsApp bloquear. Faltam {connection.warmupDaysLeft}{' '}
          {connection.warmupDaysLeft === 1 ? 'dia' : 'dias'}.
        </Alert>
      )}

      {qrCode && (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-line bg-white p-6">
          {/* eslint-disable-next-line @next/next/no-img-element -- data URI vinda do
              provedor, sem host para o next/image otimizar. */}
          <img
            src={qrCode}
            alt="QR code para conectar o WhatsApp"
            className={`h-56 w-56 ${qrExpired ? 'opacity-30' : ''}`}
          />
          <p className="max-w-sm text-center text-sm text-muted">
            No celular do petshop, abra o WhatsApp e vá em{' '}
            <strong className="font-medium">Aparelhos conectados → Conectar aparelho</strong>.
          </p>
          {qrExpired && (
            <p className="text-sm text-muted">Este código expirou. Peça um novo abaixo.</p>
          )}
        </div>
      )}

      {canConnect ? (
        <div className="flex flex-wrap gap-3">
          {status === 'CONNECTED' ? (
            <button
              type="button"
              className="btn btn-ghost"
              disabled={pending}
              onClick={() => run(disconnectWhatsappAction)}
            >
              Desconectar
            </button>
          ) : waitingScan ? (
            <button
              type="button"
              className={qrExpired ? 'btn btn-primary' : 'btn btn-ghost'}
              disabled={pending}
              onClick={() => run(refreshWhatsappQrCodeAction)}
            >
              {pending ? 'Gerando…' : 'Gerar novo QR code'}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              disabled={pending}
              onClick={() => run(connectWhatsappAction)}
            >
              {pending ? 'Conectando…' : status === 'NOT_CONFIGURED' ? 'Conectar WhatsApp' : 'Reconectar'}
            </button>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted">
          Conectar o WhatsApp da empresa é uma ação do administrador do estabelecimento.
        </p>
      )}
    </Card>
  )
}

function describe(connection: WhatsappConnection): string {
  switch (connection.status) {
    case 'CONNECTED':
      return connection.phone
        ? `Conectado no número ${connection.phone}.`
        : 'Conectado. As mensagens saem pelo WhatsApp do petshop.'
    case 'CONNECTING':
      return 'Escaneie o código abaixo com o celular do petshop.'
    case 'DISCONNECTED':
      return 'A sessão caiu. Reconecte para voltar a enviar por WhatsApp.'
    case 'BANNED':
      return 'O WhatsApp bloqueou este número. Tudo está saindo por e-mail.'
    default:
      return 'Sem WhatsApp conectado — as mensagens saem por e-mail para quem tem endereço cadastrado.'
  }
}

function badgeTone(status: WhatsappInstanceStatus): 'neutral' | 'accent' | 'success' | 'danger' {
  if (status === 'CONNECTED') return 'success'
  if (status === 'CONNECTING') return 'accent'
  if (status === 'NOT_CONFIGURED') return 'neutral'
  return 'danger'
}
