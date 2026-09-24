'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  formatBRL,
  formatCentsInput,
  parseBRLToCents,
  type ServicePackage,
  type ServiceResponse,
} from '@petshop/shared-types'
import { WalletIcon } from '@/components/icons'
import { Badge, Button, Card, CardHead, EmptyState, Field, FormError } from '@/components/ui'
import { createPackageAction, updatePackageAction } from '../actions'

/**
 * Catálogo de pacotes (MOD-LEDGER-07).
 *
 * A edição acontece **na linha**, sem diálogo: revisar preço, créditos e validade de
 * um pacote via modal seria hostil, e é o mesmo padrão que `/agenda/servicos` já usa.
 *
 * Desativar não apaga: as compras já feitas continuam valendo (o snapshot congelou
 * nome, serviços, créditos e preço no ato). Desativar só tira da vitrine.
 */

interface Props {
  packages: ServicePackage[]
  services: ServiceResponse[]
  defaultValidityDays: number
  canEdit: boolean
}

export function PackagesManager({ packages, services, defaultValidityDays, canEdit }: Props) {
  const [creating, setCreating] = useState(false)
  const router = useRouter()

  return (
    <div className="space-y-4">
      {packages.length === 0 && !creating ? (
        <EmptyState
          icon={<WalletIcon />}
          tone="icon-money"
          title="Nenhum pacote cadastrado"
          description="Um pacote é a venda de N execuções de um serviço com desconto, consumidas ao longo da validade. É o que faz o cliente voltar."
          {...(canEdit
            ? {
                action: (
                  <Button type="button" onClick={() => setCreating(true)}>
                    Criar o primeiro pacote
                  </Button>
                ),
              }
            : {})}
        />
      ) : (
        <>
          {canEdit && !creating && (
            <Button type="button" onClick={() => setCreating(true)}>
              Novo pacote
            </Button>
          )}

          {creating && (
            <PackageForm
              services={services}
              defaultValidityDays={defaultValidityDays}
              onDone={() => {
                setCreating(false)
                router.refresh()
              }}
              onCancel={() => setCreating(false)}
            />
          )}

          <ul className="space-y-3">
            {packages.map((pkg) => (
              <PackageRow key={pkg.id} pkg={pkg} services={services} canEdit={canEdit} />
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

function PackageRow({
  pkg,
  services,
  canEdit,
}: {
  pkg: ServicePackage
  services: ServiceResponse[]
  canEdit: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()

  function toggleActive() {
    setError(null)
    startTransition(async () => {
      const result = await updatePackageAction(pkg.id, { active: !pkg.active })
      if (result.ok) router.refresh()
      else setError(result.message)
    })
  }

  if (editing) {
    return (
      <li>
        <PackageForm
          pkg={pkg}
          services={services}
          defaultValidityDays={pkg.validityDays}
          onDone={() => {
            setEditing(false)
            router.refresh()
          }}
          onCancel={() => setEditing(false)}
        />
      </li>
    )
  }

  /** O valor por execução é o número que decide a venda no balcão. */
  const perCredit = Math.round(pkg.priceCents / pkg.credits)

  return (
    <li>
      <Card>
        <FormError message={error} />

        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{pkg.name}</span>
              {!pkg.active && <Badge>Fora de venda</Badge>}
              {pkg.activePurchases > 0 && (
                <Badge tone="accent">
                  {pkg.activePurchases} ativo{pkg.activePurchases > 1 ? 's' : ''}
                </Badge>
              )}
            </div>
            <p className="hint mt-1">
              {pkg.credits} × {pkg.serviceNames.join(', ')} · vale {pkg.validityDays} dias
            </p>
          </div>

          <div className="text-right">
            <p className="font-semibold">{formatBRL(pkg.priceCents)}</p>
            <p className="hint">{formatBRL(perCredit)} por execução</p>
          </div>
        </div>

        {canEdit && (
          <div className="mt-3 flex gap-3">
            <button type="button" className="hint underline" onClick={() => setEditing(true)}>
              Editar
            </button>
            <button
              type="button"
              className="hint underline"
              disabled={pending}
              onClick={toggleActive}
            >
              {pkg.active ? 'Tirar de venda' : 'Voltar a vender'}
            </button>
          </div>
        )}

        {/* Descontinuar não cancela nada: quem já comprou continua com o crédito. */}
        {!pkg.active && pkg.activePurchases > 0 && (
          <p className="hint mt-2">
            As {pkg.activePurchases} compras ativas continuam valendo até serem usadas ou expirarem.
          </p>
        )}
      </Card>
    </li>
  )
}

function PackageForm({
  pkg,
  services,
  defaultValidityDays,
  onDone,
  onCancel,
}: {
  pkg?: ServicePackage
  services: ServiceResponse[]
  defaultValidityDays: number
  onDone: () => void
  onCancel: () => void
}) {
  const [name, setName] = useState(pkg?.name ?? '')
  const [serviceIds, setServiceIds] = useState<string[]>(pkg?.serviceIds ?? [])
  const [credits, setCredits] = useState(String(pkg?.credits ?? 4))
  const [price, setPrice] = useState(pkg ? formatCentsInput(pkg.priceCents) : '')
  const [validityDays, setValidityDays] = useState(String(pkg?.validityDays ?? defaultValidityDays))
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [pending, startTransition] = useTransition()

  const priceCents = parseBRLToCents(price)
  const creditsNumber = Number(credits)

  function toggleService(id: string) {
    setServiceIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    )
  }

  function submit() {
    setError(null)
    const errors: Record<string, string> = {}
    if (name.trim().length < 2) errors.name = 'Dê um nome que o balcão reconheça.'
    if (serviceIds.length === 0) errors.serviceIds = 'Escolha ao menos um serviço.'
    if (!Number.isInteger(creditsNumber) || creditsNumber < 1) {
      errors.credits = 'Informe quantas execuções o pacote dá.'
    }
    if (!priceCents || priceCents <= 0) errors.priceCents = 'Informe o preço do pacote.'

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors)
      return
    }
    setFieldErrors({})

    startTransition(async () => {
      const payload = {
        name: name.trim(),
        serviceIds,
        credits: creditsNumber,
        priceCents: priceCents!,
        validityDays: Number(validityDays) || defaultValidityDays,
        active: pkg?.active ?? true,
      }
      const result = pkg
        ? await updatePackageAction(pkg.id, payload)
        : await createPackageAction(payload)

      if (result.ok) onDone()
      else {
        setError(result.message)
        setFieldErrors(result.fieldErrors)
      }
    })
  }

  return (
    <Card>
      <CardHead
        icon={<WalletIcon />}
        tone="icon-money"
        title={pkg ? 'Editar pacote' : 'Novo pacote'}
      />
      {pkg && (
        <p className="hint mt-1">
          As compras já feitas não mudam: nome, serviços, créditos e preço foram congelados no ato
          da venda.
        </p>
      )}

      <FormError message={error} />

      <div className="mt-4 space-y-4">
        <Field
          label="Nome"
          htmlFor="pacote-nome"
          {...(fieldErrors.name ? { error: fieldErrors.name } : {})}
        >
          <input
            id="pacote-nome"
            className="field"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Ex.: 4 Banhos Porte Médio"
          />
        </Field>

        <Field
          label="Serviços cobertos"
          htmlFor="pacote-servicos"
          {...(fieldErrors.serviceIds ? { error: fieldErrors.serviceIds } : {})}
          hint="O crédito só cobre estes serviços — nunca por equivalência de valor."
        >
          <div id="pacote-servicos" className="flex flex-wrap gap-2">
            {services.length === 0 && (
              <p className="hint">Cadastre um serviço na agenda antes de criar o pacote.</p>
            )}
            {services.map((service) => {
              const selected = serviceIds.includes(service.id)
              return (
                <button
                  key={service.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => toggleService(service.id)}
                  className={`pill px-3 py-1 text-xs font-medium ${
                    selected ? 'bg-ink text-white' : 'bg-black/5 text-muted'
                  }`}
                >
                  {service.name}
                </button>
              )
            })}
          </div>
        </Field>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            label="Execuções"
            htmlFor="pacote-creditos"
            {...(fieldErrors.credits ? { error: fieldErrors.credits } : {})}
          >
            <input
              id="pacote-creditos"
              className="field"
              inputMode="numeric"
              value={credits}
              onChange={(event) => setCredits(event.target.value)}
            />
          </Field>

          <Field
            label="Preço do pacote"
            htmlFor="pacote-preco"
            {...(fieldErrors.priceCents ? { error: fieldErrors.priceCents } : {})}
            {...(priceCents && creditsNumber > 0
              ? { hint: `${formatBRL(Math.round(priceCents / creditsNumber))} por execução` }
              : {})}
          >
            <input
              id="pacote-preco"
              className="field"
              inputMode="decimal"
              value={price}
              onChange={(event) => setPrice(event.target.value)}
              placeholder="0,00"
            />
          </Field>

          <Field
            label="Validade (dias)"
            htmlFor="pacote-validade"
            hint="Crédito não usado expira e não é devolvido."
          >
            <input
              id="pacote-validade"
              className="field"
              inputMode="numeric"
              value={validityDays}
              onChange={(event) => setValidityDays(event.target.value)}
            />
          </Field>
        </div>
      </div>

      <div className="mt-4 flex gap-2">
        <Button type="button" busy={pending} onClick={submit} busyLabel="Salvando…">
          {pkg ? 'Salvar' : 'Criar pacote'}
        </Button>
        <Button type="button" variant="ghost" disabled={pending} onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </Card>
  )
}
