'use client'

import { useState, useTransition } from 'react'
import type { PlatformTenant, PlatformTenantStatus } from '@petshop/shared-types'
import { Alert, Badge, FormError } from '@/components/ui'
import { Modal } from '@/components/modal'
import { AlertTriangleIcon, ShieldCheckIcon, StoreIcon } from '@/components/icons'
import { pedirAcessoAction } from '../actions'
import { bytes, dia, desde, numero } from '../formato'

/**
 * A lista de estabelecimentos (MOD-ADMIN-03 e 07).
 *
 * **Cada linha é um registro com forma própria** — nome, estado, seis contagens e, às
 * vezes, um erro de provisionamento —, e por isso é cartão com linhas e não tabela. A
 * tabela da saúde existe porque lá se comparam colunas de tempo entre dezenove jobs; aqui
 * ninguém compara o número de pets de um petshop com o do outro.
 *
 * **O que esta tela mostra sobre um tenant é tudo o que a plataforma vê sem autorização.**
 * Plano, estado, datas e contagens são informação sobre o estabelecimento; a ficha de um
 * tutor, ainda que a contagem diga que existe só um, continua atrás do grant do
 * MOD-ADMIN-02 — que é o que o botão desta tela pede, e não concede.
 */

const STATUS: Record<
  PlatformTenantStatus,
  { rotulo: string; tom: 'neutral' | 'accent' | 'success' | 'danger' }
> = {
  PROVISIONING: { rotulo: 'provisionando', tom: 'neutral' },
  PROVISIONING_FAILED: { rotulo: 'provisionamento falhou', tom: 'danger' },
  TRIAL: { rotulo: 'em teste', tom: 'accent' },
  ACTIVE: { rotulo: 'ativo', tom: 'success' },
  PAST_DUE: { rotulo: 'em atraso', tom: 'danger' },
  SUSPENDED: { rotulo: 'suspenso', tom: 'danger' },
  TERMINATED: { rotulo: 'encerrado', tom: 'neutral' },
}

const PLANO: Record<PlatformTenant['plan'], string> = {
  STARTER: 'Starter',
  PRO: 'Pro',
  ENTERPRISE: 'Enterprise',
}

export function Estabelecimentos({ itens }: { itens: PlatformTenant[] }) {
  const [pedindo, setPedindo] = useState<PlatformTenant | null>(null)
  /** Para quem já se pediu nesta sessão de tela: o botão não deve convidar duas vezes. */
  const [pedidos, setPedidos] = useState<string[]>([])

  return (
    <>
      <div className="card p-0">
        <ul>
          {itens.map((tenant) => (
            <li key={tenant.id} className="border-b border-line p-5 last:border-b-0 sm:p-6">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="icon-chip icon-chip-sm icon-brand shrink-0">
                      <StoreIcon />
                    </span>
                    <p className="text-base font-semibold">{tenant.name}</p>
                    <Badge tone={STATUS[tenant.status].tom}>{STATUS[tenant.status].rotulo}</Badge>
                    <Badge>{PLANO[tenant.plan]}</Badge>
                  </div>
                  <p className="hint mt-2">
                    {tenant.slug} · criado em {dia(tenant.createdAt)} ·{' '}
                    {tenant.onboardingCompletedAt
                      ? `configurado em ${dia(tenant.onboardingCompletedAt)}`
                      : 'ainda no wizard'}
                  </p>
                  {/*
                    "Última atividade" é proxy, e o rótulo diz isso de propósito: a fonte é
                    a trilha, que registra escrita. Um petshop que passou a semana só
                    consultando aparece parado, e quem lê precisa saber disso antes de
                    telefonar perguntando se o sistema quebrou.
                  */}
                  <p className="hint mt-1">
                    Última escrita {desde(tenant.lastActivityAt)}
                    {tenant.trialEndsAt && tenant.status === 'TRIAL'
                      ? ` · teste até ${dia(tenant.trialEndsAt)}`
                      : ''}
                  </p>
                </div>

                <div className="shrink-0">
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => setPedindo(tenant)}
                  >
                    {pedidos.includes(tenant.id) ? 'Pedir de novo' : 'Pedir acesso'}
                  </button>
                </div>
              </div>

              {tenant.provisioning && (
                <div className="mt-4">
                  <Alert
                    tone="danger"
                    icon={<AlertTriangleIcon />}
                    title={`Provisionamento falhou em ${tenant.provisioning.attempts} ${
                      tenant.provisioning.attempts === 1 ? 'tentativa' : 'tentativas'
                    }`}
                  >
                    {tenant.provisioning.lastError ??
                      'A última tentativa não deixou mensagem de erro.'}
                  </Alert>
                </div>
              )}

              <Uso tenant={tenant} />
            </li>
          ))}
        </ul>
      </div>

      <PedirAcesso
        tenant={pedindo}
        onClose={() => setPedindo(null)}
        onPedido={(id) => setPedidos((atual) => (atual.includes(id) ? atual : [...atual, id]))}
      />
    </>
  )
}

/** As seis contagens do MOD-ADMIN-07. Nenhuma delas identifica ninguém, nem quando é um. */
function Uso({ tenant }: { tenant: PlatformTenant }) {
  const numeros = [
    { rotulo: 'Tutores', valor: numero(tenant.usage.tutors) },
    { rotulo: 'Pets', valor: numero(tenant.usage.pets) },
    { rotulo: 'Atendimentos 30d', valor: numero(tenant.usage.attendances30d) },
    { rotulo: 'Mensagens no mês', valor: numero(tenant.usage.messagesThisMonth) },
    { rotulo: 'Documentos', valor: numero(tenant.usage.documents) },
    { rotulo: 'Fotos', valor: bytes(tenant.usage.photoBytes) },
  ]

  return (
    <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {numeros.map((item) => (
        <div key={item.rotulo} className="rounded-2xl border border-line px-3 py-2">
          <dt className="hint">{item.rotulo}</dt>
          <dd className="mt-0.5 text-lg font-semibold tabular-nums">{item.valor}</dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * O pedido de acesso.
 *
 * `<Modal>` e não painel dentro do cartão: é formulário que responde a **uma linha** de
 * uma lista, que é a regra 8 de `docs/design-formularios.md`. O tom do chip é o do
 * domínio desta tela — `icon-brand`, o mesmo do estabelecimento no menu.
 *
 * O texto do rodapé não é enfeite: quem escreve o motivo aqui costuma achar que está
 * abrindo a base, e o que ele está fazendo é pedir. Enquanto o administrador do petshop
 * não autorizar, nada muda — e é ele quem escolhe o prazo.
 */
function PedirAcesso({
  tenant,
  onClose,
  onPedido,
}: {
  tenant: PlatformTenant | null
  onClose: () => void
  onPedido: (tenantId: string) => void
}) {
  const [motivo, setMotivo] = useState('')
  const [erro, setErro] = useState<string | null>(null)
  const [feito, setFeito] = useState(false)
  const [pendente, startTransition] = useTransition()

  function fechar() {
    onClose()
    setMotivo('')
    setErro(null)
    setFeito(false)
  }

  function enviar(event: React.FormEvent) {
    event.preventDefault()
    if (!tenant) return
    setErro(null)

    startTransition(async () => {
      const resultado = await pedirAcessoAction(tenant.id, motivo)
      if (!resultado.ok) {
        setErro(resultado.message)
        return
      }
      onPedido(tenant.id)
      setFeito(true)
    })
  }

  return (
    <Modal
      open={tenant !== null}
      onClose={fechar}
      icon={<ShieldCheckIcon />}
      tone="icon-brand"
      eyebrow="Acesso de suporte"
      title={feito ? 'Pedido enviado' : 'Pedir acesso à base'}
      subtitle={tenant?.name}
      busy={pendente}
      footer={
        feito ? (
          <button type="button" className="btn btn-primary" onClick={fechar}>
            Fechar
          </button>
        ) : (
          <>
            <button type="button" className="btn btn-ghost" onClick={fechar} disabled={pendente}>
              Cancelar
            </button>
            <button
              type="submit"
              form="pedir-acesso"
              className="btn btn-primary"
              disabled={pendente}
            >
              {pendente ? 'Enviando…' : 'Enviar pedido'}
            </button>
          </>
        )
      }
    >
      {feito ? (
        <p className="text-sm text-muted">
          O administrador do estabelecimento vê o pedido na aba Suporte das Configurações
          dele. Enquanto ele não autorizar, nada da base fica visível — e o acesso, quando
          vier, é somente de leitura e com prazo.
        </p>
      ) : (
        <form id="pedir-acesso" onSubmit={enviar} className="flex flex-col gap-4">
          <FormError message={erro} />

          <div>
            <label className="label" htmlFor="motivo">
              Motivo
            </label>
            <textarea
              id="motivo"
              className="field"
              rows={3}
              maxLength={300}
              value={motivo}
              onChange={(event) => setMotivo(event.target.value)}
              placeholder="Chamado #482 — tutor relata que não recebeu o recibo do banho de sábado"
            />
            <p className="hint mt-1.5">
              É o texto que o administrador do petshop vai ler para decidir. Descreva o
              chamado, não a ação.
            </p>
          </div>
        </form>
      )}
    </Modal>
  )
}
