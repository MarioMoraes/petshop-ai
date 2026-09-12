'use client'

import { useState, useTransition } from 'react'
import {
  SECURITY_EVENT_LABELS,
  type AuditLogEntry,
  type SecurityEventEntry,
  type SecurityEventSummary,
} from '@petshop/shared-types'
import { Button, Card, EmptyState, SectionHead, Segmented } from '@/components/ui'
import { AlertTriangleIcon, ShieldCheckIcon } from '@/components/icons'
import { loadAuditPageAction, loadSecurityEventsAction } from './actions'

/**
 * A trilha de auditoria e os eventos de segurança (MOD-SEC-06).
 *
 * **Aba própria, e não uma seção da Privacidade.** Aquela é a fila de pedidos de
 * exclusão, gateada por `tutor:delete`, e serve a quem atende o titular. Esta é gateada
 * por `audit:read` e serve a quem administra a equipe. Mesmo diretório, outro leitor.
 *
 * Cartão branco e lista de linhas: é conteúdo para ler, não ficha com campos. Os filtros
 * ficam em `Card tone="soft"`, que é a única parte com controle de entrada — regra 1 de
 * `docs/design-formularios.md`.
 */

type Periodo = '7' | '30' | '90'

const PERIODOS = [
  { value: '7' as const, label: '7 dias' },
  { value: '30' as const, label: '30 dias' },
  { value: '90' as const, label: '90 dias' },
]

/**
 * O catálogo de tradução das ações, **intencionalmente incompleto**.
 *
 * Uma ação sem tradução aparece com o código e não some da lista: uma trilha que esconde
 * o que não sabe explicar é pior que uma trilha feia. Cada módulo novo acrescenta as
 * suas linhas aqui quando a equipe começar a perguntar por elas.
 */
const ACOES: Record<string, string> = {
  'tutor.created': 'cadastrou um cliente',
  'tutor.updated': 'alterou o cadastro de um cliente',
  'tutor.anonymized': 'anonimizou o cadastro de um cliente',
  'tutor.deletion_requested': 'registrou um pedido de exclusão',
  'tutor.deletion_resolved': 'respondeu um pedido de exclusão',
  'tutor.merged': 'unificou dois cadastros',
  'pet.created': 'cadastrou um animal',
  'pet.updated': 'alterou a ficha de um animal',
  'pet.transferred': 'transferiu um animal de tutor',
  'membership.role_changed': 'alterou o perfil de alguém da equipe',
  'membership.suspended': 'suspendeu o acesso de alguém da equipe',
  'membership.reactivated': 'reativou o acesso de alguém da equipe',
  'membership.removed': 'removeu alguém da equipe',
  'session.tenant_switched': 'entrou neste estabelecimento vindo de outro',
  'invitation.created': 'convidou alguém para a equipe',
  'invitation.revoked': 'cancelou um convite',
  'invitation.accepted': 'entrou na equipe por convite',
  'tenant.created': 'criou o estabelecimento',
  'tenant.updated': 'alterou os dados do estabelecimento',
  'settings.updated': 'alterou as configurações',
  'auth.permission_denied': 'teve uma ação negada por falta de permissão',
}

function quando(iso: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso))
}

function desde(dias: Periodo): string {
  return new Date(Date.now() - Number(dias) * 86_400_000).toISOString()
}

export interface SegurancaProps {
  trilhaInicial: AuditLogEntry[]
  cursorInicial: string | null
  resumoInicial: SecurityEventSummary[]
}

export function Seguranca({ trilhaInicial, cursorInicial, resumoInicial }: SegurancaProps) {
  return (
    <div className="space-y-6">
      <Trilha itens={trilhaInicial} cursor={cursorInicial} />
      <Eventos resumo={resumoInicial} />
    </div>
  )
}

function Trilha({ itens, cursor }: { itens: AuditLogEntry[]; cursor: string | null }) {
  const [lista, setLista] = useState(itens)
  const [proximo, setProximo] = useState(cursor)
  const [periodo, setPeriodo] = useState<Periodo>('30')
  const [erro, setErro] = useState<string | null>(null)
  const [carregando, startTransition] = useTransition()

  function trocarPeriodo(valor: Periodo) {
    setPeriodo(valor)
    setErro(null)
    startTransition(async () => {
      const resultado = await loadAuditPageAction({ from: desde(valor) })
      if (!resultado.ok) return setErro(resultado.message)
      setLista(resultado.data.items)
      setProximo(resultado.data.nextCursor)
    })
  }

  function carregarMais() {
    if (!proximo) return
    setErro(null)
    startTransition(async () => {
      const resultado = await loadAuditPageAction({ from: desde(periodo), cursor: proximo })
      if (!resultado.ok) return setErro(resultado.message)
      setLista((atual) => [...atual, ...resultado.data.items])
      setProximo(resultado.data.nextCursor)
    })
  }

  return (
    <Card>
      <SectionHead
        icon={<ShieldCheckIcon />}
        tone="icon-system"
        eyebrow="Auditoria"
        title="Trilha de auditoria"
        description="Quem alterou o quê, e quando. O registro é imutável e guardado por 24 meses; dados pessoais saem dele já mascarados na gravação."
      />

      <div className="mt-6">
        <Segmented
          options={PERIODOS}
          value={periodo}
          onChange={trocarPeriodo}
          disabled={carregando}
          ariaLabel="Período da trilha"
        />
      </div>

      {erro && <p className="mt-4 text-sm text-danger">{erro}</p>}

      {lista.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            title="Nada registrado no período"
            description="Cada alteração de cadastro, perfil ou configuração aparece aqui assim que acontece."
          />
        </div>
      ) : (
        <ul className="mt-6 flex flex-col gap-3">
          {lista.map((linha) => (
            <li key={linha.id} className="rounded-xl border border-line p-4">
              <p className="text-sm font-medium">
                {linha.actorName ?? 'O sistema'}{' '}
                <span className="font-normal">{ACOES[linha.action] ?? linha.action}</span>
              </p>
              <p className="hint">
                {quando(linha.createdAt)}
                {linha.actorEmailMasked && ` · ${linha.actorEmailMasked}`}
                {linha.outcome === 'DENIED' && ' · negado'}
              </p>
            </li>
          ))}
        </ul>
      )}

      {proximo && (
        <Button
          type="button"
          variant="ghost"
          className="mt-4 h-9"
          onClick={carregarMais}
          busy={carregando}
          busyLabel="Carregando…"
        >
          Carregar mais
        </Button>
      )}
    </Card>
  )
}

/**
 * O resumo é fixo em trinta dias, e não tem seletor de período.
 *
 * A pergunta que esta seção responde é "está acontecendo alguma coisa agora?", e ela não
 * muda com a janela. O detalhe abre sob demanda porque a contagem é o que se lê todo dia
 * e a lista é o que se lê no dia em que a contagem assusta.
 */
function Eventos({ resumo }: { resumo: SecurityEventSummary[] }) {
  const [detalhe, setDetalhe] = useState<SecurityEventEntry[] | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [carregando, startTransition] = useTransition()

  const total = resumo.reduce((soma, linha) => soma + linha.count, 0)

  function abrirDetalhe() {
    setErro(null)
    startTransition(async () => {
      const resultado = await loadSecurityEventsAction({ from: desde('30') })
      if (!resultado.ok) return setErro(resultado.message)
      setDetalhe(resultado.data.items)
    })
  }

  return (
    <Card>
      <SectionHead
        icon={<AlertTriangleIcon />}
        tone="icon-system"
        eyebrow="Segurança"
        title="Eventos de segurança"
        description="Tentativas negadas nos últimos 30 dias. Uma linha isolada não diz nada; um padrão ao longo de um dia diz se alguém está tentando chegar onde não deve."
      />

      {erro && <p className="mt-4 text-sm text-danger">{erro}</p>}

      {total === 0 ? (
        <div className="mt-6">
          <EmptyState
            title="Nenhum evento no período"
            description="Acesso negado, assinatura inválida e tentativa de alcançar outro estabelecimento aparecem aqui."
          />
        </div>
      ) : (
        <>
          <ul className="mt-6 flex flex-col gap-2">
            {resumo.map((linha) => (
              <li
                key={linha.type}
                className="flex items-center justify-between rounded-xl border border-line px-4 py-3 text-sm"
              >
                <span>{SECURITY_EVENT_LABELS[linha.type]}</span>
                <span className="font-medium tabular-nums">{linha.count}</span>
              </li>
            ))}
          </ul>

          {detalhe === null ? (
            <Button
              type="button"
              variant="ghost"
              className="mt-4 h-9"
              onClick={abrirDetalhe}
              busy={carregando}
              busyLabel="Carregando…"
            >
              Ver as ocorrências
            </Button>
          ) : (
            <ul className="mt-4 flex flex-col gap-2">
              {detalhe.map((evento) => (
                <li key={evento.id} className="text-sm">
                  <p className="font-medium">{SECURITY_EVENT_LABELS[evento.type]}</p>
                  <p className="hint">
                    {quando(evento.createdAt)}
                    {evento.actorName && ` · ${evento.actorName}`}
                    {evento.targetId && ` · ${evento.targetId}`}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  )
}
