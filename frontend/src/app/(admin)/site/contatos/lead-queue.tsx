'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  SITE_LEAD_STATUSES,
  SITE_LEAD_STATUS_LABELS,
  formatPhoneBR,
  type SiteLead,
  type SiteLeadStatus,
} from '@petshop/shared-types'
import { Badge, Card, EmptyState, FormError } from '@/components/ui'
import { updateSiteLeadAction } from '../actions'

/**
 * A fila de trabalho da recepção.
 *
 * `NEW` no topo, e é o serviço que ordena — a fila é de trabalho, não de histórico.
 *
 * **O contato que já é cliente vem marcado.** A equipe precisa saber que não é
 * aquisição: é alguém que já tem ficha e não achou o WhatsApp. A checagem é por hash
 * do telefone e acontece no servidor; o visitante nunca soube que foi reconhecido.
 */

const TONE: Record<SiteLeadStatus, 'neutral' | 'accent' | 'success'> = {
  NEW: 'accent',
  CONTACTED: 'neutral',
  CONVERTED: 'success',
  DISCARDED: 'neutral',
}

interface Props {
  leads: SiteLead[]
  status: SiteLeadStatus | undefined
  canConvert: boolean
}

export function LeadQueue({ leads, status, canConvert }: Props) {
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="space-y-6">
      <FormError message={error} />

      <nav className="flex flex-wrap gap-2">
        <FilterLink label="Todos" href="/site/contatos" active={status === undefined} />
        {SITE_LEAD_STATUSES.map((option) => (
          <FilterLink
            key={option}
            label={SITE_LEAD_STATUS_LABELS[option]}
            href={`/site/contatos?status=${option}`}
            active={status === option}
          />
        ))}
      </nav>

      {leads.length === 0 ? (
        <EmptyState
          title="Nenhum contato por aqui"
          description="Quem preencher o formulário do site aparece nesta fila, com telefone e mensagem."
        />
      ) : (
        <ul className="space-y-3">
          {leads.map((lead) => (
            <LeadRow key={lead.id} lead={lead} canConvert={canConvert} onError={setError} />
          ))}
        </ul>
      )}
    </div>
  )
}

function FilterLink({
  label,
  href,
  active,
}: {
  label: string
  href: string
  active: boolean
}) {
  return (
    <Link
      href={href as '/site/contatos'}
      className={active ? 'btn btn-primary' : 'btn btn-ghost'}
      aria-current={active ? 'page' : undefined}
    >
      {label}
    </Link>
  )
}

function LeadRow({
  lead,
  canConvert,
  onError,
}: {
  lead: SiteLead
  canConvert: boolean
  onError: (message: string | null) => void
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  function move(status: Exclude<SiteLeadStatus, 'CONVERTED'>) {
    onError(null)
    startTransition(async () => {
      const result = await updateSiteLeadAction(lead.id, { status })
      if (!result.ok) {
        onError(result.message)
        return
      }
      router.refresh()
    })
  }

  const received = new Date(lead.createdAt).toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })

  return (
    <li>
      <Card className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">
              {lead.name}
              <span className="ml-2 align-middle">
                <Badge tone={TONE[lead.status]}>{SITE_LEAD_STATUS_LABELS[lead.status]}</Badge>
              </span>
              {lead.existingTutorId && (
                <span className="ml-2 align-middle">
                  <Badge tone="neutral">Já é cliente</Badge>
                </span>
              )}
            </p>
            <p className="hint mt-0.5">{received}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-sm">
            {lead.phone ? (
              <a href={`tel:${lead.phone}`} className="font-medium hover:underline">
                {formatPhoneBR(lead.phone)}
              </a>
            ) : (
              // A retenção apagou o PII: a linha fica para a estatística de quantos
              // contatos chegaram, sem os dados de quem nunca virou cliente.
              <span className="hint">contato removido pela retenção</span>
            )}
            {lead.email && <span className="hint">{lead.email}</span>}
          </div>
        </div>

        {lead.message && <p className="text-sm leading-relaxed text-muted">{lead.message}</p>}

        {lead.status !== 'CONVERTED' && (
          <div className="flex flex-wrap items-center gap-2">
            {lead.status === 'NEW' && (
              <button
                type="button"
                className="btn btn-ghost"
                disabled={pending}
                onClick={() => move('CONTACTED')}
              >
                Marcar como contatado
              </button>
            )}

            {/*
              A ficha é criada pelo MOD-TUTOR, com a detecção de duplicata que ele já
              tem — inclusive para o contato que já é cliente, que cai em 409 com os
              candidatos. Este módulo não cria cliente: fazê-lo duplicaria as regras de
              CPF, consentimento e dedupe num lugar onde ninguém iria procurá-las.
            */}
            {canConvert && lead.phone && (
              <Link
                href={`/tutores/novo?nome=${encodeURIComponent(lead.name)}&telefone=${encodeURIComponent(lead.phone)}&lead=${lead.id}`}
                className="btn btn-primary"
              >
                Criar cadastro
              </Link>
            )}

            {lead.status !== 'DISCARDED' && (
              <button
                type="button"
                className="btn btn-ghost text-danger"
                disabled={pending}
                onClick={() => move('DISCARDED')}
              >
                Descartar
              </button>
            )}
          </div>
        )}
      </Card>
    </li>
  )
}
