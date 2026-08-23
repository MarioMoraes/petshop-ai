'use client'

import { useEffect, useState } from 'react'
import { slugify, type SlugAvailability, type TenantResponse } from '@petshop/shared-types'
import { Card, Field } from '@/components/ui'
import { checkSlugAction, createTenantAction, saveStep1Action } from '../actions'
import type { StepProps } from '../wizard'

/**
 * Etapa 1 — dados do petshop.
 *
 * É a etapa que cria o tenant. O endereço (slug) é definitivo e vira o subdomínio,
 * então tem verificação de disponibilidade enquanto o usuário digita — descobrir que
 * o endereço está ocupado só ao enviar seria fricção logo no primeiro passo. A
 * checagem é conveniência: quem decide é o 409 do servidor (RN-08).
 */

export function StepIdentity({
  pending,
  fieldErrors,
  onSubmit,
  tenant,
}: StepProps & { tenant: TenantResponse | null }) {
  const isNew = tenant === null

  const [name, setName] = useState(tenant?.name ?? '')
  const [legalName, setLegalName] = useState(tenant?.legalName ?? '')
  const [cnpj, setCnpj] = useState('')
  const [slug, setSlug] = useState(tenant?.slug ?? '')
  const [slugTouched, setSlugTouched] = useState(!isNew)
  const [availability, setAvailability] = useState<SlugAvailability | null>(null)
  const [checking, setChecking] = useState(false)

  // Enquanto o usuário não mexer no endereço, ele acompanha o nome.
  const effectiveSlug = slugTouched ? slug : slugify(name)

  useEffect(() => {
    if (!isNew || effectiveSlug.length < 3) {
      setAvailability(null)
      return
    }

    // Espera a digitação parar: uma chamada por tecla inundaria o gateway.
    setChecking(true)
    const timer = setTimeout(() => {
      void checkSlugAction(effectiveSlug)
        .then(setAvailability)
        .finally(() => setChecking(false))
    }, 400)

    return () => {
      clearTimeout(timer)
      setChecking(false)
    }
  }, [effectiveSlug, isNew])

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()

    if (isNew) {
      onSubmit(() =>
        createTenantAction({
          name: name.trim(),
          slug: effectiveSlug,
          ...(legalName.trim() ? { legalName: legalName.trim() } : {}),
          ...(cnpj.replace(/\D/g, '') ? { cnpj: cnpj.replace(/\D/g, '') } : {}),
        }),
      )
      return
    }

    onSubmit(() =>
      saveStep1Action({ name: name.trim(), legalName: legalName.trim() || undefined }),
    )
  }

  return (
    <Card>
      <h1 className="text-2xl font-semibold sm:text-3xl">Vamos conhecer seu petshop</h1>
      <p className="hint mt-2">
        Esses dados aparecem para seus tutores no portal e nos documentos que o sistema emite.
      </p>

      <form className="mt-8 space-y-5" onSubmit={handleSubmit}>
        <Field label="Nome do petshop" htmlFor="name" error={fieldErrors.name}>
          <input
            id="name"
            className="field"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Petshop do João"
            required
            minLength={2}
            maxLength={120}
            aria-invalid={Boolean(fieldErrors.name)}
          />
        </Field>

        {isNew && (
          <Field
            label="Endereço do seu portal"
            htmlFor="slug"
            error={fieldErrors.slug}
            hint={slugHint(effectiveSlug, availability, checking)}
          >
            <div className="flex items-center gap-2">
              <input
                id="slug"
                className="field"
                value={effectiveSlug}
                onChange={(event) => {
                  setSlugTouched(true)
                  setSlug(slugify(event.target.value))
                }}
                placeholder="petshopdojoao"
                required
                aria-invalid={Boolean(fieldErrors.slug) || availability?.available === false}
              />
              <span className="hint whitespace-nowrap">.petshopai.app</span>
            </div>

            {availability && !availability.available && availability.suggestions.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="hint">Disponíveis:</span>
                {availability.suggestions.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    className="pill bg-accent-soft px-3 py-1 text-xs font-medium text-accent-ink transition hover:bg-accent hover:text-white"
                    onClick={() => {
                      setSlugTouched(true)
                      setSlug(suggestion)
                    }}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            )}
          </Field>
        )}

        <Field
          label="Razão social"
          htmlFor="legalName"
          error={fieldErrors.legalName}
          hint="Opcional. Aparece nos recibos."
        >
          <input
            id="legalName"
            className="field"
            value={legalName}
            onChange={(event) => setLegalName(event.target.value)}
            placeholder="João Pet Comércio LTDA"
            maxLength={160}
          />
        </Field>

        {isNew && (
          <Field
            label="CNPJ"
            htmlFor="cnpj"
            error={fieldErrors.cnpj}
            hint="Opcional. Guardado criptografado."
          >
            <input
              id="cnpj"
              className="field"
              value={cnpj}
              onChange={(event) => setCnpj(event.target.value)}
              placeholder="00.000.000/0000-00"
              inputMode="numeric"
              aria-invalid={Boolean(fieldErrors.cnpj)}
            />
          </Field>
        )}

        <div className="flex justify-end">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={pending || (isNew && availability?.available === false)}
          >
            {pending ? 'Salvando…' : 'Continuar'}
          </button>
        </div>
      </form>
    </Card>
  )
}

function slugHint(
  slug: string,
  availability: SlugAvailability | null,
  checking: boolean,
): string | undefined {
  if (slug.length < 3) return 'Pelo menos 3 caracteres, só letras minúsculas, números e hífen.'
  if (checking) return 'Verificando disponibilidade…'
  if (!availability) return undefined

  if (availability.available) return `${slug}.petshopai.app está livre.`
  if (availability.reason === 'RESERVED') return 'Este endereço é reservado pela plataforma.'
  if (availability.reason === 'INVALID') return 'Use apenas letras minúsculas, números e hífen.'
  return 'Este endereço já está em uso.'
}
