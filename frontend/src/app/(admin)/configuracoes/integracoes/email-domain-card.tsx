'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { EMAIL_DOMAIN_STATUS_LABELS, type EmailDomainResponse } from '@petshop/shared-types'
import { Alert, Badge, Button, Card, Field, FormError, SectionHead } from '@/components/ui'
import { AlertTriangleIcon, GlobeIcon } from '@/components/icons'
import { useToast } from '@/components/toast'
import { removeEmailDomainAction, setEmailDomainAction, verifyEmailDomainAction } from './actions'

/**
 * O domínio de e-mail próprio: o tutor recebe de `contato@meupetshop.com.br`, e não do
 * endereço da PetShop AI.
 *
 * O domínio é registrado na conta de e-mail da plataforma; o petshop só publica os
 * registros de DNS que esta tela mostra, onde registrou o domínio. **Até o DNS verificar,
 * nada muda no envio** — o e-mail continua saindo pelo endereço da plataforma, e a tela
 * diz isso, porque "cadastrei e não mudou" parece defeito.
 *
 * A verificação acontece sozinha (uma varredura de meia em meia hora, por 72 horas); o
 * "Verificar agora" existe para quem acabou de publicar e não quer esperar.
 */

interface Props {
  data: EmailDomainResponse
  /** `tenant:configure`. Sem ela o cartão só informa. */
  canEdit: boolean
}

export function EmailDomainCard({ data, canEdit }: Props) {
  const router = useRouter()
  const toast = useToast()
  const current = data.domain
  const [domain, setDomain] = useState(current?.domain ?? '')
  const [localPart, setLocalPart] = useState(current?.localPart ?? 'contato')
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const [saving, startSave] = useTransition()
  const [verifying, startVerify] = useTransition()
  const [removing, startRemove] = useTransition()
  const busy = saving || verifying || removing

  function save() {
    setError(null)
    setFieldErrors({})
    startSave(async () => {
      const result = await setEmailDomainAction({
        domain: domain.trim(),
        localPart: localPart.trim() || undefined,
      })
      if (!result.ok) {
        setError(result.message)
        setFieldErrors(result.fieldErrors)
        return
      }
      if (result.data.domain) {
        setDomain(result.data.domain.domain)
        setLocalPart(result.data.domain.localPart)
      }
      toast('Domínio salvo.')
      router.refresh()
    })
  }

  function verify() {
    setError(null)
    startVerify(async () => {
      const result = await verifyEmailDomainAction()
      if (!result.ok) {
        setError(result.message)
        return
      }
      toast(
        result.data.domain?.status === 'VERIFIED'
          ? 'Domínio verificado.'
          : 'Ainda não verificou. O DNS pode levar algumas horas.',
      )
      router.refresh()
    })
  }

  function remove() {
    setError(null)
    startRemove(async () => {
      const result = await removeEmailDomainAction()
      if (!result.ok) {
        setError(result.message)
        return
      }
      setConfirmingRemove(false)
      setDomain('')
      setLocalPart('contato')
      toast('Domínio removido.')
      router.refresh()
    })
  }

  const changed =
    domain.trim().toLowerCase() !== (current?.domain ?? '') ||
    localPart.trim().toLowerCase() !== (current?.localPart ?? 'contato')

  return (
    <Card tone="soft" className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <SectionHead
          icon={<GlobeIcon />}
          tone="icon-system"
          eyebrow="E-mail"
          title="De qual endereço o e-mail sai"
          description={describe(data)}
        />
        {current && (
          <Badge
            tone={
              current.status === 'VERIFIED'
                ? 'success'
                : current.status === 'FAILED'
                  ? 'danger'
                  : 'accent'
            }
          >
            {EMAIL_DOMAIN_STATUS_LABELS[current.status]}
          </Badge>
        )}
      </div>

      {current?.status === 'FAILED' && (
        <Alert tone="danger" icon={<AlertTriangleIcon />} title="O DNS não verificou">
          Confira se os registros abaixo estão publicados exatamente como aparecem — o nome e o
          valor inteiros — e clique em Verificar agora. Enquanto isso, os e-mails saem pelo endereço
          da PetShop AI.
        </Alert>
      )}

      <FormError message={error} />

      {data.available && canEdit && (
        <div className="grid gap-4 sm:grid-cols-[1fr_2fr]">
          <Field label="Endereço" htmlFor="localPart" error={fieldErrors.localPart}>
            <input
              id="localPart"
              className="field"
              maxLength={64}
              value={localPart}
              disabled={busy}
              onChange={(event) => setLocalPart(event.target.value)}
            />
          </Field>
          <Field
            label="Domínio"
            htmlFor="emailDomain"
            hint="Só o domínio, como meupetshop.com.br. Ele precisa ser do petshop."
            error={fieldErrors.domain}
          >
            <input
              id="emailDomain"
              className="field"
              maxLength={253}
              placeholder="meupetshop.com.br"
              value={domain}
              disabled={busy}
              onChange={(event) => setDomain(event.target.value)}
            />
          </Field>
        </div>
      )}

      {current && current.status !== 'VERIFIED' && current.records.length > 0 && (
        <div className="space-y-3">
          <p className="text-sm">
            Publique estes registros no DNS do domínio, no painel de onde ele foi registrado
            (Registro.br, Cloudflare, GoDaddy…). Copie cada valor inteiro.
          </p>
          <div className="card overflow-x-auto p-0">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Tipo</th>
                  <th>Nome</th>
                  <th>Valor</th>
                  <th className="text-right">Prioridade</th>
                  <th>Situação</th>
                </tr>
              </thead>
              <tbody>
                {current.records.map((record) => (
                  <tr key={`${record.type}-${record.name}-${record.value}`}>
                    <td className="font-medium">{record.type}</td>
                    <td className="font-mono text-xs break-all select-all">{record.name}</td>
                    <td className="max-w-[28rem] font-mono text-xs break-all select-all">
                      {record.value}
                    </td>
                    <td className="text-right tabular-nums">{record.priority ?? '—'}</td>
                    <td>{record.verified ? 'Encontrado' : 'Pendente'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {data.available && canEdit && (
        <>
          {confirmingRemove ? (
            <Alert tone="danger" icon={<AlertTriangleIcon />} title="Remover o domínio?">
              Os e-mails voltam a sair pelo endereço da PetShop AI na hora. Para usar o domínio de
              novo, será preciso cadastrá-lo e verificar o DNS outra vez.
              <span className="mt-3 flex flex-wrap gap-3">
                <Button type="button" busy={removing} onClick={remove} busyLabel="Removendo…">
                  Sim, remover
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={removing}
                  onClick={() => setConfirmingRemove(false)}
                >
                  Cancelar
                </Button>
              </span>
            </Alert>
          ) : (
            <div className="flex flex-wrap gap-3">
              <Button
                type="button"
                busy={saving}
                disabled={!changed || domain.trim() === '' || verifying || removing}
                onClick={save}
                busyLabel="Salvando…"
              >
                {current ? 'Salvar' : 'Cadastrar domínio'}
              </Button>
              {current && current.status !== 'VERIFIED' && (
                <Button
                  type="button"
                  busy={verifying}
                  disabled={saving || removing}
                  onClick={verify}
                  busyLabel="Verificando…"
                >
                  Verificar agora
                </Button>
              )}
              {current && (
                <Button type="button" disabled={busy} onClick={() => setConfirmingRemove(true)}>
                  Remover
                </Button>
              )}
            </div>
          )}
        </>
      )}

      {data.available && !canEdit && !current && (
        <p className="text-sm text-muted">
          Cadastrar o domínio de e-mail é uma ação do administrador do estabelecimento.
        </p>
      )}
    </Card>
  )
}

function describe(data: EmailDomainResponse): string {
  const current = data.domain
  if (!data.available) {
    return 'O domínio próprio não está disponível nesta instalação. Os e-mails saem pelo endereço da PetShop AI.'
  }
  if (!current) {
    return 'Hoje o e-mail ao tutor sai pelo endereço da PetShop AI. Com o domínio do petshop, ele chega como contato@seupetshop.com.br.'
  }
  if (current.status === 'VERIFIED') {
    return `Os e-mails ao tutor saem de ${current.fromAddress}.`
  }
  return `Assim que o DNS verificar, os e-mails passam a sair de ${current.fromAddress}. A conferência é automática, por até 72 horas; até lá, eles saem pelo endereço da PetShop AI.`
}
