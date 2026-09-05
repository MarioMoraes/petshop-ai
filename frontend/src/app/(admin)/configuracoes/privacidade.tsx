'use client'

import Link from 'next/link'
import { useState, useTransition } from 'react'
import {
  formatBRL,
  type DeletionRequestResponse,
  type DeletionRequestStatus,
} from '@petshop/shared-types'
import { Alert, Card, EmptyState, Field, FormError, SectionHead, Segmented } from '@/components/ui'
import { Modal } from '@/components/modal'
import { AlertTriangleIcon, ShieldCheckIcon } from '@/components/icons'
import { resolveDeletionRequestAction } from './actions'

/**
 * A fila de pedidos de exclusão de dados (LGPD art. 18, V — AC-05 de MOD-PORTAL-09).
 *
 * **Esta tela é a razão de a tabela existir.** O critério de aceite diz "registrado e
 * encaminhado à equipe", e registro sem fila que alguém veja é registro no vazio: o pedido
 * cairia num log que ninguém abre, o prazo do art. 19 correria sozinho, e o titular
 * ficaria olhando para uma tela do Portal que prometeu resposta.
 *
 * **Responder não apaga.** O botão registra o desfecho e a frase que o tutor lê; a
 * anonimização continua sendo a ação da ficha, com as travas de débito aberto e agenda
 * futura. Por isso cada linha mostra o **saldo**: é o dado que muda a resposta, e quem
 * decide precisa vê-lo antes de prometer, não depois.
 *
 * Cartão branco e não `tone="soft"`: é lista para ler, e o formulário de resposta abre em
 * `<Modal>` — regra 1 e regra 8 de `docs/design-formularios.md`.
 */
export function Privacidade({ pedidos }: { pedidos: DeletionRequestResponse[] }) {
  const [lista, setLista] = useState(pedidos)

  function substituir(atualizado: DeletionRequestResponse) {
    setLista((atual) =>
      atual.map((item) => (item.id === atualizado.id ? atualizado : item)),
    )
  }

  const abertos = lista.filter((item) => item.status === 'OPEN')
  const respondidos = lista.filter((item) => item.status !== 'OPEN')

  return (
    <div className="space-y-6">
      <Card>
        <SectionHead
          icon={<ShieldCheckIcon />}
          tone="icon-system"
          eyebrow="Privacidade"
          title="Pedidos de exclusão de dados"
          description="O titular pode pedir a exclusão pelo Portal, e a lei dá 15 dias para a resposta. Responder aqui registra a decisão — apagar o cadastro continua sendo a anonimização, na ficha do tutor."
        />

        {abertos.length === 0 ? (
          <div className="mt-6">
            <EmptyState
              title="Nenhum pedido esperando"
              description="Quando um cliente pedir a exclusão dos dados pelo Portal, o pedido aparece aqui e no sino da topbar."
            />
          </div>
        ) : (
          <div className="mt-6 flex flex-col gap-4">
            {abertos.map((pedido) => (
              <Pedido key={pedido.id} pedido={pedido} onRespondido={substituir} />
            ))}
          </div>
        )}
      </Card>

      {respondidos.length > 0 && (
        <Card>
          <p className="section-eyebrow">Já respondidos</p>
          <div className="mt-4 flex flex-col gap-3">
            {respondidos.map((pedido) => (
              <div key={pedido.id} className="text-sm">
                <p className="font-medium">
                  {pedido.tutorName}
                  <span className="text-subtle ml-2 font-normal">
                    {pedido.status === 'DONE' ? 'atendido' : 'recusado'} em{' '}
                    {data(pedido.respondedAt)}
                  </span>
                </p>
                {pedido.resolution && <p className="hint">{pedido.resolution}</p>}
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  )
}

function Pedido({
  pedido,
  onRespondido,
}: {
  pedido: DeletionRequestResponse
  onRespondido: (pedido: DeletionRequestResponse) => void
}) {
  const [aberto, setAberto] = useState(false)
  const [desfecho, setDesfecho] = useState<Exclude<DeletionRequestStatus, 'OPEN'>>('DONE')
  const [resposta, setResposta] = useState('')
  const [erro, setErro] = useState<string | null>(null)
  const [salvando, startTransition] = useTransition()

  const deve = pedido.balanceCents < 0
  const vencido = new Date(pedido.dueAt).getTime() < Date.now()

  function enviar(event: React.FormEvent) {
    event.preventDefault()
    setErro(null)

    startTransition(async () => {
      const resultado = await resolveDeletionRequestAction(pedido.id, {
        outcome: desfecho,
        resolution: resposta.trim(),
      })
      if (!resultado.ok) {
        setErro(resultado.message)
        return
      }
      setAberto(false)
      onRespondido(resultado.data)
    })
  }

  return (
    <div className="rounded-xl border border-line p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">
            <Link href={`/tutores/${pedido.tutorId}`} className="hover:underline">
              {pedido.tutorName}
            </Link>
          </p>
          <p className="hint">
            Pedido em {data(pedido.requestedAt)} · responder até {data(pedido.dueAt)}
          </p>
        </div>

        <button type="button" className="btn btn-primary h-9" onClick={() => setAberto(true)}>
          Responder
        </button>
      </div>

      {pedido.reason && (
        <p className="text-muted mt-3 text-sm">“{pedido.reason}”</p>
      )}

      {/*
        O saldo devedor é a informação que muda a resposta, e por isso aparece na linha e
        não dentro do diálogo: quem lê a fila precisa saber, antes de abrir, que este caso
        não é um "atender e pronto".
      */}
      {deve && (
        <div className="mt-3">
          <Alert
            tone="danger"
            icon={<AlertTriangleIcon />}
            title={`Conta em aberto: ${formatBRL(-pedido.balanceCents)}`}
            role="status"
          >
            Cadastro com débito ou documento fiscal em guarda não pode ser anonimizado por
            inteiro. Registre a recusa explicando o motivo — o titular lê esta resposta no
            Portal.
          </Alert>
        </div>
      )}

      {vencido && !deve && (
        <div className="mt-3">
          <Alert
            tone="danger"
            icon={<AlertTriangleIcon />}
            title="Prazo de resposta vencido"
            role="status"
          >
            A lei dá 15 dias para responder o titular.
          </Alert>
        </div>
      )}

      <Modal
        open={aberto}
        onClose={() => setAberto(false)}
        busy={salvando}
        icon={<ShieldCheckIcon />}
        tone="icon-system"
        eyebrow="Privacidade"
        title={`Responder ${pedido.tutorName}`}
        subtitle="O que você escrever aqui aparece para o titular no Portal."
        footer={
          <>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setAberto(false)}
              disabled={salvando}
            >
              Cancelar
            </button>
            <button
              type="submit"
              form={`resposta-${pedido.id}`}
              className="btn btn-primary"
              disabled={salvando || resposta.trim().length < 3}
            >
              {salvando ? 'Registrando…' : 'Registrar resposta'}
            </button>
          </>
        }
      >
        <form
          id={`resposta-${pedido.id}`}
          className="flex flex-col gap-5"
          onSubmit={enviar}
          noValidate
        >
          <FormError message={erro} />

          <Segmented
            options={[
              { value: 'DONE', label: 'Atendido' },
              { value: 'REJECTED', label: 'Recusado' },
            ]}
            value={desfecho}
            onChange={setDesfecho}
            disabled={salvando}
            ariaLabel="Desfecho do pedido"
          />

          {/*
            A frase que impede o mal-entendido mais caro desta tela: marcar "atendido" não
            executa nada. A anonimização é a ação da ficha, e é ela que apaga.
          */}
          <p className="hint">
            {desfecho === 'DONE'
              ? 'Marque como atendido depois de anonimizar o cadastro na ficha do tutor. Este botão registra a decisão, não apaga os dados.'
              : 'Explique o motivo com clareza: é esta frase que o titular lê, e é ela que sustenta a recusa se ele questionar.'}
          </p>

          <Field label="Resposta ao titular" htmlFor={`texto-${pedido.id}`}>
            <textarea
              id={`texto-${pedido.id}`}
              className="field"
              rows={4}
              value={resposta}
              onChange={(event) => setResposta(event.target.value)}
              maxLength={1000}
              required
            />
          </Field>
        </form>
      </Modal>
    </div>
  )
}

function data(iso: string | null): string {
  if (!iso) return '—'
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short' }).format(
    new Date(iso),
  )
}
