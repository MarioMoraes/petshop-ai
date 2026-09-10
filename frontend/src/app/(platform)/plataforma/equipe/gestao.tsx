'use client'

import { useState, useTransition } from 'react'
import type { PlatformAdminResponse } from '@petshop/shared-types'
import { Alert, Button, Card, FormError, SectionHead } from '@/components/ui'
import { Modal } from '@/components/modal'
import { AlertTriangleIcon, IdCardIcon } from '@/components/icons'
import { concederAction, revogarAction } from '../actions'
import { dia } from '../formato'

/**
 * Quem é da equipe da plataforma (MOD-ADMIN-01).
 *
 * **A lista existe para que a concessão não seja cega.** Conceder sem ver quem já tem é
 * como o segundo administrador vira o quarto sem ninguém notar — e este papel não é
 * membership de estabelecimento nenhum: ele alcança as nove rotas de `/platform/v1` em
 * todas as instalações do produto.
 *
 * Cartão branco: é lista para ler, e o formulário de concessão abre em `<Modal>`
 * (`docs/design-formularios.md`, regras 1 e 8). O tom do chip é `icon-people`, o de gente
 * em todo o produto.
 */

export function Equipe({ admins }: { admins: PlatformAdminResponse[] }) {
  const [lista, setLista] = useState(admins)
  const [concedendo, setConcedendo] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <SectionHead
            icon={<IdCardIcon />}
            tone="icon-people"
            eyebrow="Plataforma"
            title="Quem tem acesso"
            description="O papel não é vínculo com estabelecimento: ele abre o console inteiro, em todos os petshops da instalação."
          />
          <Button type="button" onClick={() => setConcedendo(true)}>
            Conceder
          </Button>
        </div>

        {erro && (
          <div className="mt-5">
            <FormError message={erro} />
          </div>
        )}

        <ul className="mt-6 flex flex-col">
          {lista.map((admin) => (
            <li
              key={admin.id}
              className="flex flex-wrap items-center justify-between gap-3 border-b border-line py-3 last:border-b-0"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium">{admin.fullName}</p>
                <p className="hint">
                  desde {dia(admin.grantedAt)}
                  {/*
                    A linha sem quem concedeu é a do bootstrap, e dizê-lo importa: ela
                    nasceu de uma variável de ambiente na subida, não de uma decisão de
                    alguém — e é a única da tabela que não tem autor.
                  */}
                  {admin.grantedBy === null ? ' · primeira linha, semeada na subida' : ''}
                </p>
              </div>

              <Revogar
                admin={admin}
                sozinho={lista.length <= 1}
                onErro={setErro}
                onRevogado={() => setLista((atual) => atual.filter((item) => item.id !== admin.id))}
              />
            </li>
          ))}
        </ul>

        {lista.length === 1 && (
          <div className="mt-5">
            <Alert
              tone="accent"
              icon={<AlertTriangleIcon />}
              title="Há uma pessoa só nesta lista"
              role="status"
            >
              O servidor recusa a revogação do último administrador — uma plataforma sem
              administrador não tem como voltar a ter um, porque conceder exige um vivo. Conceda a
              mais alguém antes de precisar.
            </Alert>
          </div>
        )}
      </Card>

      <Conceder
        aberto={concedendo}
        onClose={() => setConcedendo(false)}
        onConcedido={(admin) => setLista((atual) => [...atual, admin])}
      />
    </>
  )
}

function Revogar({
  admin,
  sozinho,
  onErro,
  onRevogado,
}: {
  admin: PlatformAdminResponse
  sozinho: boolean
  onErro: (mensagem: string | null) => void
  onRevogado: () => void
}) {
  const [confirmando, setConfirmando] = useState(false)
  const [pendente, startTransition] = useTransition()

  function revogar() {
    onErro(null)
    startTransition(async () => {
      const resultado = await revogarAction(admin.id)
      if (!resultado.ok) {
        onErro(resultado.message)
        setConfirmando(false)
        return
      }
      onRevogado()
    })
  }

  if (sozinho) {
    return <span className="hint shrink-0">único administrador</span>
  }

  if (!confirmando) {
    return (
      <Button
        type="button"
        variant="ghost"
        className="shrink-0"
        onClick={() => setConfirmando(true)}
      >
        Revogar
      </Button>
    )
  }

  return (
    <span className="flex shrink-0 items-center gap-2">
      <span className="hint">Tirar {admin.fullName.split(' ')[0]} da plataforma?</span>
      <Button
        type="button"
        variant="ghost"
        onClick={() => setConfirmando(false)}
        disabled={pendente}
      >
        Não
      </Button>
      <Button type="button" onClick={revogar} busy={pendente} busyLabel="Revogando…">
        Revogar
      </Button>
    </span>
  )
}

/**
 * A concessão.
 *
 * O e-mail é o identificador porque é o que a pessoa sabe dizer — o produto o converte em
 * hash antes de procurar, já que a coluna em claro não existe. E ela precisa **já ter
 * entrado no produto uma vez**: o espelho local nasce no primeiro acesso, e conceder a
 * quem nunca entrou criaria uma linha apontando para ninguém. A mensagem do servidor diz
 * exatamente isso, em vez de "usuário não encontrado".
 */
function Conceder({
  aberto,
  onClose,
  onConcedido,
}: {
  aberto: boolean
  onClose: () => void
  onConcedido: (admin: PlatformAdminResponse) => void
}) {
  const [email, setEmail] = useState('')
  const [erro, setErro] = useState<string | null>(null)
  const [pendente, startTransition] = useTransition()

  function fechar() {
    onClose()
    setEmail('')
    setErro(null)
  }

  function enviar(event: React.FormEvent) {
    event.preventDefault()
    setErro(null)

    startTransition(async () => {
      const resultado = await concederAction(email)
      if (!resultado.ok) {
        setErro(resultado.message)
        return
      }
      onConcedido(resultado.data)
      fechar()
    })
  }

  return (
    <Modal
      open={aberto}
      onClose={fechar}
      icon={<IdCardIcon />}
      tone="icon-people"
      eyebrow="Plataforma"
      title="Conceder acesso"
      subtitle="A pessoa passa a ver o console inteiro, em todos os estabelecimentos."
      busy={pendente}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={fechar} disabled={pendente}>
            Cancelar
          </Button>
          <Button type="submit" form="conceder" busy={pendente} busyLabel="Concedendo…">
            Conceder
          </Button>
        </>
      }
    >
      <form id="conceder" onSubmit={enviar} className="flex flex-col gap-4">
        <FormError message={erro} />

        <div>
          <label className="label" htmlFor="email">
            E-mail
          </label>
          <input
            id="email"
            type="email"
            className="field"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="pessoa@petshopai.com.br"
            autoComplete="off"
          />
          <p className="hint mt-1.5">
            Precisa ser o e-mail com que ela entrou no produto ao menos uma vez.
          </p>
        </div>
      </form>
    </Modal>
  )
}
