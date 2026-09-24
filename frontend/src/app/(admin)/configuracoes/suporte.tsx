'use client'

import { useState, useTransition } from 'react'
import type { SupportGrantResponse } from '@petshop/shared-types'
import { Alert, Button, Card, EmptyState, FormError, SectionHead, Segmented } from '@/components/ui'
import { Modal } from '@/components/modal'
import { AlertTriangleIcon, ShieldCheckIcon } from '@/components/icons'
import {
  approveSupportAccessAction,
  denySupportAccessAction,
  revokeSupportAccessAction,
} from './actions'

/**
 * O acesso da equipe PetShop AI à base deste estabelecimento (MOD-ADMIN-02).
 *
 * **Esta tela é o que faz o mecanismo existir.** O grant já estava inteiro no backend —
 * pedido, prazo, revogação, trilha e a recusa de escrita na porta —, e sem um lugar onde
 * alguém clicasse "autorizar", nada disso podia acontecer: o suporte pedia e ninguém
 * respondia. Um consentimento que só o `curl` consegue dar não é consentimento.
 *
 * O recorte de permissão é o do backend, e ele é deliberadamente desigual: **ver** os
 * pedidos exige `tenant:read_settings`, que quem opera o balcão tem, porque o histórico é
 * metade do valor do mecanismo; **autorizar** exige `tenant:configure`, porque abrir a
 * base a alguém de fora é decisão de quem administra a conta.
 *
 * Cartão branco e não `tone="soft"`: é lista para ler, e a autorização abre em `<Modal>` —
 * regra 1 e regra 8 de `docs/design-formularios.md`.
 */

/** Os prazos que a tela oferece. O teto real é do servidor, e ele recusa o que passar. */
const PRAZOS = [
  { value: '4' as const, label: '4 horas' },
  { value: '24' as const, label: '24 horas' },
  { value: '72' as const, label: '72 horas' },
]

type Prazo = (typeof PRAZOS)[number]['value']

export interface AcessoSuporteProps {
  grants: SupportGrantResponse[]
  /** `tenant:configure`. Sem ela a tela mostra o histórico e não oferece ação nenhuma. */
  canEdit: boolean
}

export function AcessoSuporte({ grants, canEdit }: AcessoSuporteProps) {
  const [lista, setLista] = useState(grants)

  function substituir(id: string, patch: Partial<SupportGrantResponse>) {
    setLista((atual) => atual.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  }

  const pendentes = lista.filter((item) => item.status === 'REQUESTED')
  const ativos = lista.filter((item) => item.status === 'ACTIVE' && !venceu(item))
  const historico = lista.filter(
    (item) => item.status !== 'REQUESTED' && (item.status !== 'ACTIVE' || venceu(item)),
  )

  return (
    <div className="space-y-6">
      <Card>
        <SectionHead
          icon={<ShieldCheckIcon />}
          tone="icon-system"
          eyebrow="Suporte"
          title="Acesso da equipe PetShop AI"
          description="Ninguém de fora do seu estabelecimento lê os seus dados sem esta autorização. Quando o suporte precisa ver a base para resolver um chamado, ele pede aqui, com motivo e prazo — e o acesso é somente de leitura, sempre."
        />

        {pendentes.length === 0 && ativos.length === 0 ? (
          <div className="mt-6">
            <EmptyState
              icon={<ShieldCheckIcon />}
              tone="icon-system"
              title="Nenhum acesso pedido ou ativo"
              description="Enquanto esta lista estiver vazia, nenhuma pessoa da PetShop AI consegue abrir a ficha de um cliente seu."
            />
          </div>
        ) : (
          <div className="mt-6 flex flex-col gap-4">
            {pendentes.map((grant) => (
              <Pedido
                key={grant.id}
                grant={grant}
                canEdit={canEdit}
                onMudou={(patch) => substituir(grant.id, patch)}
              />
            ))}
            {ativos.map((grant) => (
              <Ativo
                key={grant.id}
                grant={grant}
                canEdit={canEdit}
                onMudou={(patch) => substituir(grant.id, patch)}
              />
            ))}
          </div>
        )}
      </Card>

      {historico.length > 0 && (
        <Card>
          <p className="section-eyebrow">Histórico</p>
          <div className="mt-4 flex flex-col gap-3">
            {historico.map((grant) => (
              <div key={grant.id} className="text-sm">
                <p className="font-medium">
                  {grant.requestedBy.fullName}
                  <span className="text-subtle ml-2 font-normal">
                    {desfecho(grant)} · pedido em {quando(grant.requestedAt)}
                  </span>
                </p>
                <p className="hint">“{grant.reason}”</p>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  )
}

/** O pedido esperando resposta: autorizar com prazo, ou recusar. */
function Pedido({
  grant,
  canEdit,
  onMudou,
}: {
  grant: SupportGrantResponse
  canEdit: boolean
  onMudou: (patch: Partial<SupportGrantResponse>) => void
}) {
  const [aberto, setAberto] = useState(false)
  const [prazo, setPrazo] = useState<Prazo>('24')
  const [erro, setErro] = useState<string | null>(null)
  const [pendente, startTransition] = useTransition()

  function autorizar(event: React.FormEvent) {
    event.preventDefault()
    setErro(null)

    startTransition(async () => {
      const resultado = await approveSupportAccessAction(grant.id, Number(prazo))
      if (!resultado.ok) {
        setErro(resultado.message)
        return
      }
      setAberto(false)
      onMudou(resultado.data)
    })
  }

  function recusar() {
    setErro(null)
    startTransition(async () => {
      const resultado = await denySupportAccessAction(grant.id)
      if (!resultado.ok) {
        setErro(resultado.message)
        return
      }
      onMudou({ status: 'DENIED' })
    })
  }

  return (
    <div className="rounded-xl border border-line p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">{grant.requestedBy.fullName} pediu acesso</p>
          <p className="hint">Em {quando(grant.requestedAt)} · aguardando sua resposta</p>
        </div>
        {canEdit && (
          <div className="flex items-center gap-2">
            <Button
              type="button"
              className="h-9"
              onClick={recusar}
              busy={pendente}
              busyLabel="Recusando…"
            >
              Recusar
            </Button>
            <Button
              type="button"
              className="h-9"
              onClick={() => setAberto(true)}
              disabled={pendente}
            >
              Autorizar
            </Button>
          </div>
        )}
      </div>

      {/*
        O motivo aparece na linha, e não dentro do diálogo: é o texto que decide se o
        acesso vale a pena, e quem lê a fila precisa dele **antes** de abrir a janela.
      */}
      <p className="text-muted mt-3 text-sm">“{grant.reason}”</p>

      {!canEdit && (
        <p className="hint mt-3">Só quem administra a conta autoriza acesso do suporte.</p>
      )}

      {/*
        O erro da recusa aparece na linha; o da autorização, dentro do diálogo. São o mesmo
        estado, e mostrá-lo nos dois lugares ao mesmo tempo faria a mensagem piscar atrás do
        véu enquanto a janela já a exibe.
      */}
      {!aberto && <FormError message={erro} />}

      <Modal
        open={aberto}
        onClose={() => setAberto(false)}
        busy={pendente}
        icon={<ShieldCheckIcon />}
        tone="icon-system"
        eyebrow="Suporte"
        title={`Autorizar ${grant.requestedBy.fullName}`}
        subtitle="Leitura apenas, pelo prazo que você escolher. Você pode encerrar antes a qualquer momento."
        footer={
          <>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setAberto(false)}
              disabled={pendente}
            >
              Cancelar
            </Button>
            <Button
              type="submit"
              form={`autorizar-${grant.id}`}
              busy={pendente}
              busyLabel="Autorizando…"
            >
              Autorizar acesso
            </Button>
          </>
        }
      >
        <form
          id={`autorizar-${grant.id}`}
          className="flex flex-col gap-5"
          onSubmit={autorizar}
          noValidate
        >
          <FormError message={erro} />

          <p className="text-muted text-sm">“{grant.reason}”</p>

          <Segmented
            options={PRAZOS}
            value={prazo}
            onChange={setPrazo}
            disabled={pendente}
            ariaLabel="Prazo do acesso"
          />

          <p className="hint">
            Passado o prazo, o acesso se encerra sozinho — não há renovação automática. Cada ficha
            que o suporte abrir fica registrada na trilha de auditoria, com o horário e a tela.
          </p>
        </form>
      </Modal>
    </div>
  )
}

/** O acesso em vigor: quanto falta e o botão que o encerra na hora. */
function Ativo({
  grant,
  canEdit,
  onMudou,
}: {
  grant: SupportGrantResponse
  canEdit: boolean
  onMudou: (patch: Partial<SupportGrantResponse>) => void
}) {
  const [erro, setErro] = useState<string | null>(null)
  const [pendente, startTransition] = useTransition()

  function encerrar() {
    setErro(null)
    startTransition(async () => {
      const resultado = await revokeSupportAccessAction(grant.id)
      if (!resultado.ok) {
        setErro(resultado.message)
        return
      }
      onMudou({ status: 'REVOKED' })
    })
  }

  return (
    <div className="rounded-xl border border-line p-4">
      <Alert
        tone="accent"
        icon={<AlertTriangleIcon />}
        title={`${grant.requestedBy.fullName} está com acesso de leitura`}
        role="status"
      >
        Autorizado em {quando(grant.approvedAt)} · vence {quando(grant.expiresAt)}.
      </Alert>

      <p className="text-muted mt-3 text-sm">“{grant.reason}”</p>

      <FormError message={erro} />

      {/*
        Encerrar é a ação destrutiva desta linha, e por isso não fica ao lado de nenhuma
        principal: é texto no pé, alcançável e longe do polegar (regra 8).
      */}
      {canEdit && (
        <Button
          type="button"
          className="mt-3 px-3 py-1 text-xs"
          onClick={encerrar}
          busy={pendente}
          busyLabel="Encerrando…"
        >
          Encerrar o acesso agora
        </Button>
      )}
    </div>
  )
}

/**
 * Um grant `ACTIVE` cujo prazo já passou é histórico, não acesso vivo.
 *
 * O status só vira `EXPIRED` quando alguém o toca; quem confere o prazo de verdade é a
 * porta, a cada requisição. A tela faz a mesma conta para não anunciar como vigente um
 * acesso que o backend já recusa.
 */
function venceu(grant: SupportGrantResponse): boolean {
  return grant.expiresAt !== null && new Date(grant.expiresAt).getTime() <= Date.now()
}

function desfecho(grant: SupportGrantResponse): string {
  if (grant.status === 'DENIED') return 'recusado'
  if (grant.status === 'REVOKED') return 'encerrado'
  return 'expirado'
}

function quando(iso: string | null): string {
  if (!iso) return '—'
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso))
}
