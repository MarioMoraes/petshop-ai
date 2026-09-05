'use client'

import { useState, useTransition } from 'react'
import {
  PORTAL_DELETION_RESPONSE_DAYS,
  type PortalDeletionRequest,
  type PortalMeDataResponse,
} from '@petshop/shared-types'
import { Alert, Card, Field, FormError } from '@/components/ui'
import { Modal } from '@/components/modal'
import { ShieldCheckIcon } from '@/components/icons'
import { pedirExclusao } from './actions'

/**
 * O pedido de exclusão dos dados (LGPD art. 18, V — AC-05 de MOD-PORTAL-09).
 *
 * **Discreto, e não escondido.** Fica no fim da tela, em texto e não em botão, porque é a
 * ação mais rara e a mais definitiva daqui. Mas está escrito com todas as letras: um
 * direito que só se exerce achando o link não é um direito exercível.
 *
 * **A tela promete o que o sistema cumpre.** Não diz "seus dados serão apagados" — diz que
 * o pedido vai para a equipe e que a resposta vem em quinze dias. O petshop pode ter nota
 * fiscal com prazo de guarda e conta em aberto, e nesses casos a resposta é uma recusa
 * fundamentada. Prometer o apagamento aqui produziria a reclamação seguinte.
 */
export function Exclusao({
  pedido,
  tenantName,
  onPedido,
}: {
  pedido: PortalDeletionRequest | null
  tenantName: string
  onPedido: (dados: PortalMeDataResponse) => void
}) {
  const [aberto, setAberto] = useState(false)
  const [motivo, setMotivo] = useState('')
  const [erro, setErro] = useState<string | null>(null)
  const [enviando, startTransition] = useTransition()

  function enviar(event: React.FormEvent) {
    event.preventDefault()
    setErro(null)

    startTransition(async () => {
      const resultado = await pedirExclusao(
        motivo.trim() ? { reason: motivo.trim() } : {},
      )
      if (!resultado.ok) {
        setErro(resultado.message)
        return
      }
      setAberto(false)
      setMotivo('')
      onPedido(resultado)
    })
  }

  if (pedido?.status === 'OPEN') {
    return (
      <Card>
        <p className="section-eyebrow">Pedido de exclusão</p>
        <Alert tone="accent" icon={<ShieldCheckIcon />} title="Em análise" role="status">
          Recebemos seu pedido em {data(pedido.requestedAt)}. O {tenantName} responde até{' '}
          {data(pedido.dueAt)}.
        </Alert>
      </Card>
    )
  }

  return (
    <Card>
      <p className="section-eyebrow">Pedido de exclusão</p>

      {/*
        O retorno de um pedido anterior continua na tela.
        Sem ele, quem teve o pedido recusado voltaria a pedir sem nunca saber por quê —
        e a fila da equipe receberia o mesmo caso outra vez.
      */}
      {pedido && (
        <Alert
          tone={pedido.status === 'REJECTED' ? 'danger' : 'accent'}
          icon={<ShieldCheckIcon />}
          title={pedido.status === 'REJECTED' ? 'Pedido anterior recusado' : 'Pedido atendido'}
          role="status"
        >
          {pedido.resolution ?? 'Sem detalhes registrados.'}
        </Alert>
      )}

      <p className="hint mt-3">
        Você pode pedir a exclusão dos seus dados. O pedido vai para a equipe do{' '}
        {tenantName}, que responde em até {PORTAL_DELETION_RESPONSE_DAYS} dias — cadastros
        com conta em aberto ou documento fiscal em guarda podem não ser apagados por
        inteiro.
      </p>

      {/*
        Ação destrutiva não vira botão primário: texto sublinhado, alcançável e longe do
        polegar que está salvando outra coisa. É a regra 8 do padrão de formulários
        aplicada fora do rodapé de um diálogo.
      */}
      <button
        type="button"
        className="text-subtle mt-3 text-sm underline underline-offset-4 hover:text-ink"
        onClick={() => setAberto(true)}
      >
        Pedir exclusão dos meus dados
      </button>

      <Modal
        open={aberto}
        onClose={() => setAberto(false)}
        busy={enviando}
        icon={<ShieldCheckIcon />}
        tone="icon-people"
        eyebrow="Privacidade"
        title="Pedir exclusão dos dados"
        subtitle={`A equipe do ${tenantName} responde em até ${PORTAL_DELETION_RESPONSE_DAYS} dias.`}
        footer={
          <>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setAberto(false)}
              disabled={enviando}
            >
              Cancelar
            </button>
            <button
              type="submit"
              form="portal-exclusao-form"
              className="btn btn-primary"
              disabled={enviando}
            >
              {enviando ? 'Enviando…' : 'Enviar pedido'}
            </button>
          </>
        }
      >
        <form
          id="portal-exclusao-form"
          className="flex flex-col gap-5"
          onSubmit={enviar}
          noValidate
        >
          <FormError message={erro} />

          <p className="hint">
            Nada é apagado agora. Seus agendamentos e sua conta seguem como estão até a
            equipe responder.
          </p>

          <Field
            label="Quer contar o motivo?"
            htmlFor="exclusao-motivo"
            hint="Opcional. Às vezes o que incomoda se resolve sem apagar nada — desligar as promoções, por exemplo."
          >
            <textarea
              id="exclusao-motivo"
              className="field"
              rows={3}
              value={motivo}
              onChange={(event) => setMotivo(event.target.value)}
              maxLength={500}
            />
          </Field>
        </form>
      </Modal>
    </Card>
  )
}

function data(iso: string): string {
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'long' }).format(
    new Date(iso),
  )
}
