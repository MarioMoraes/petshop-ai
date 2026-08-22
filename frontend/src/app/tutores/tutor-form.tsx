'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  formatCEP,
  formatCPF,
  formatPhoneBR,
  type DuplicateCandidate,
  type TutorDetail,
} from '@petshop/shared-types'
import { Card, Field, FormError } from '@/components/ui'
import {
  checkDuplicatesAction,
  createTutorAction,
  lookupCepAction,
  updateTutorAction,
  type ActionResult,
} from './actions'

/**
 * Formulário de cadastro e edição de tutor.
 *
 * Três coisas acontecem antes do envio, e todas existem para o atendente não
 * descobrir problema depois de digitar tudo:
 *
 *   · o CEP preenche o endereço sozinho (MOD-TUTOR-03);
 *   · sair do campo nome dispara a busca por duplicata (AC-02 de MOD-TUTOR-02);
 *   · o 409 do servidor volta como alerta com ação, e não como erro genérico.
 */

interface Props {
  tutor?: TutorDetail
}

const EMPTY_ADDRESS = {
  zipCode: '',
  street: '',
  number: '',
  complement: '',
  district: '',
  city: '',
  state: '',
}

export function TutorForm({ tutor }: Props) {
  const router = useRouter()
  const isEditing = tutor !== undefined
  const [pending, startTransition] = useTransition()

  const [personType, setPersonType] = useState<'PF' | 'PJ'>(tutor?.personType ?? 'PF')
  const [fullName, setFullName] = useState(tutor?.fullName ?? '')
  const [socialName, setSocialName] = useState(tutor?.socialName ?? '')
  const [legalName, setLegalName] = useState(tutor?.legalName ?? '')
  const [document, setDocument] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState(tutor?.email ?? '')
  const [birthDate, setBirthDate] = useState(tutor?.birthDate ?? '')
  const [notes, setNotes] = useState(tutor?.notes ?? '')
  const [address, setAddress] = useState(EMPTY_ADDRESS)

  const [consents, setConsents] = useState({
    whatsapp: true,
    email: true,
    terms: false,
    imageUse: false,
  })

  const [result, setResult] = useState<ActionResult<TutorDetail> | null>(null)
  const [candidates, setCandidates] = useState<DuplicateCandidate[]>([])
  const [acknowledged, setAcknowledged] = useState(false)
  const [cepStatus, setCepStatus] = useState<'idle' | 'loading' | 'notfound'>('idle')

  const fieldErrors = result?.ok === false ? result.fieldErrors : {}

  // ─── CEP ───────────────────────────────────────────────────────────────────

  function handleCepBlur() {
    const digits = address.zipCode.replace(/\D/g, '')
    if (digits.length !== 8) return

    setCepStatus('loading')
    void lookupCepAction(digits).then((found) => {
      if (!found) {
        // ViaCEP fora do ar ou CEP inexistente dão no mesmo para quem está
        // preenchendo: segue no braço, que é o comportamento do AC.
        setCepStatus('notfound')
        return
      }
      setCepStatus('idle')
      setAddress((current) => ({
        ...current,
        street: found.street || current.street,
        district: found.district || current.district,
        city: found.city,
        state: found.state,
      }))
    })
  }

  // ─── Duplicatas ────────────────────────────────────────────────────────────

  function handleNameBlur() {
    if (fullName.trim().length < 3) return

    void checkDuplicatesAction({
      fullName,
      phone: phone || undefined,
      email: email || undefined,
      cpf: personType === 'PF' ? document || undefined : undefined,
      excludeTutorId: tutor?.id,
    }).then((found) => {
      setCandidates(found?.candidates.filter((c) => c.confidence !== 'LOW') ?? [])
    })
  }

  // ─── Envio ─────────────────────────────────────────────────────────────────

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setResult(null)

    const hasAddress = address.zipCode && address.street && address.number

    const payload = {
      personType,
      fullName,
      socialName: socialName || undefined,
      legalName: legalName || undefined,
      ...(personType === 'PF'
        ? { cpf: document || undefined }
        : { cnpj: document || undefined }),
      phone,
      email: email || undefined,
      birthDate: birthDate || undefined,
      notes: notes || undefined,
      ...(hasAddress
        ? {
            address: {
              ...address,
              complement: address.complement || undefined,
              isPrimary: true,
            },
          }
        : {}),
      consents,
      duplicateAcknowledged: acknowledged,
    }

    startTransition(async () => {
      const response = isEditing
        ? await updateTutorAction(tutor.id, {
            fullName,
            socialName: socialName || null,
            legalName: legalName || null,
            phone,
            email: email || null,
            birthDate: birthDate || null,
            notes: notes || null,
            ...(document ? (personType === 'PF' ? { cpf: document } : { cnpj: document }) : {}),
          })
        : await createTutorAction(payload)

      setResult(response)
      if (response.ok) router.push(`/tutores/${response.data.id}`)
    })
  }

  const blockingConflict = result?.ok === false ? result.existingTutor : undefined
  const serverDuplicates = result?.ok === false ? result.duplicates : undefined
  const visibleDuplicates = serverDuplicates ?? candidates

  return (
    <form onSubmit={handleSubmit} className="space-y-5" noValidate>
      {result?.ok === false && !blockingConflict && !serverDuplicates && (
        <FormError message={result.message} />
      )}

      {blockingConflict && (
        <div className="rounded-2xl bg-danger-soft px-5 py-4 text-sm" role="alert">
          <p className="font-medium text-danger">{result?.ok === false ? result.message : ''}</p>
          <p className="mt-1 text-muted">
            {blockingConflict.fullName} · {blockingConflict.phoneMasked}
          </p>
          <Link href={`/tutores/${blockingConflict.id}`} className="btn btn-primary mt-3">
            {blockingConflict.suggestedAction === 'REACTIVATE_EXISTING'
              ? 'Abrir e reativar cadastro'
              : 'Abrir cadastro existente'}
          </Link>
        </div>
      )}

      {visibleDuplicates && visibleDuplicates.length > 0 && !blockingConflict && (
        <div className="rounded-2xl bg-accent-soft px-5 py-4 text-sm" role="alert">
          <p className="font-medium text-accent-ink">Encontramos cadastros parecidos</p>
          <ul className="mt-2 space-y-1">
            {visibleDuplicates.map((candidate) => (
              <li key={candidate.id}>
                <Link href={`/tutores/${candidate.id}`} className="underline">
                  {candidate.fullName}
                </Link>{' '}
                <span className="text-muted">
                  · {candidate.phoneMasked} · {describeMatch(candidate)}
                </span>
              </li>
            ))}
          </ul>
          <label className="mt-3 flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            <span className="text-muted">
              Confirmo que é outra pessoa — pode ser outro responsável pelo mesmo pet.
            </span>
          </label>
        </div>
      )}

      <Card className="space-y-4">
        <div className="flex gap-2">
          {(['PF', 'PJ'] as const).map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => setPersonType(type)}
              aria-pressed={personType === type}
              disabled={isEditing}
              className={`pill px-4 py-1.5 text-sm font-medium ${
                personType === type ? 'bg-shell text-white' : 'bg-black/5 text-muted'
              }`}
            >
              {type === 'PF' ? 'Pessoa física' : 'Pessoa jurídica'}
            </button>
          ))}
        </div>

        <Field
          label={personType === 'PF' ? 'Nome completo' : 'Nome fantasia'}
          htmlFor="fullName"
          error={fieldErrors.fullName}
        >
          <input
            id="fullName"
            className="field"
            value={fullName}
            onChange={(event) => setFullName(event.target.value)}
            onBlur={handleNameBlur}
            aria-invalid={Boolean(fieldErrors.fullName)}
            required
          />
        </Field>

        {personType === 'PF' ? (
          <Field
            label="Nome social"
            htmlFor="socialName"
            error={fieldErrors.socialName}
            hint="Quando preenchido, é o nome que aparece em todas as telas e mensagens."
          >
            <input
              id="socialName"
              className="field"
              value={socialName}
              onChange={(event) => setSocialName(event.target.value)}
            />
          </Field>
        ) : (
          <Field label="Razão social" htmlFor="legalName" error={fieldErrors.legalName}>
            <input
              id="legalName"
              className="field"
              value={legalName}
              onChange={(event) => setLegalName(event.target.value)}
              aria-invalid={Boolean(fieldErrors.legalName)}
            />
          </Field>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={personType === 'PF' ? 'CPF' : 'CNPJ'}
            htmlFor="document"
            error={fieldErrors.cpf ?? fieldErrors.cnpj}
            hint={
              personType === 'PF' && !document
                ? 'Pode ficar para depois — o cadastro fica marcado como incompleto.'
                : undefined
            }
          >
            <input
              id="document"
              className="field"
              inputMode="numeric"
              value={personType === 'PF' ? formatCPF(document) : document}
              onChange={(event) => setDocument(event.target.value.replace(/\D/g, ''))}
              aria-invalid={Boolean(fieldErrors.cpf ?? fieldErrors.cnpj)}
            />
          </Field>

          <Field
            label="Telefone (WhatsApp)"
            htmlFor="phone"
            error={fieldErrors.phone}
            hint="É por aqui que saem os lembretes e o atendimento automático."
          >
            <input
              id="phone"
              className="field"
              inputMode="tel"
              value={formatPhoneBR(phone)}
              onChange={(event) => setPhone(event.target.value.replace(/\D/g, ''))}
              onBlur={handleNameBlur}
              aria-invalid={Boolean(fieldErrors.phone)}
              required
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="E-mail" htmlFor="email" error={fieldErrors.email}>
            <input
              id="email"
              type="email"
              className="field"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              aria-invalid={Boolean(fieldErrors.email)}
            />
          </Field>

          <Field label="Data de nascimento" htmlFor="birthDate" error={fieldErrors.birthDate}>
            <input
              id="birthDate"
              type="date"
              className="field"
              value={birthDate}
              onChange={(event) => setBirthDate(event.target.value)}
            />
          </Field>
        </div>
      </Card>

      {!isEditing && (
        <Card className="space-y-4">
          <h2 className="font-semibold">Endereço</h2>

          <div className="grid gap-4 sm:grid-cols-[160px_1fr]">
            <Field
              label="CEP"
              htmlFor="zipCode"
              hint={
                cepStatus === 'loading'
                  ? 'buscando…'
                  : cepStatus === 'notfound'
                    ? 'Não encontrado — preencha à mão.'
                    : undefined
              }
            >
              <input
                id="zipCode"
                className="field"
                inputMode="numeric"
                value={formatCEP(address.zipCode)}
                onChange={(event) =>
                  setAddress({ ...address, zipCode: event.target.value.replace(/\D/g, '') })
                }
                onBlur={handleCepBlur}
              />
            </Field>

            <Field label="Logradouro" htmlFor="street">
              <input
                id="street"
                className="field"
                value={address.street}
                onChange={(event) => setAddress({ ...address, street: event.target.value })}
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Número" htmlFor="number">
              <input
                id="number"
                className="field"
                value={address.number}
                onChange={(event) => setAddress({ ...address, number: event.target.value })}
              />
            </Field>
            <Field label="Complemento" htmlFor="complement">
              <input
                id="complement"
                className="field"
                value={address.complement}
                onChange={(event) => setAddress({ ...address, complement: event.target.value })}
              />
            </Field>
            <Field label="Bairro" htmlFor="district">
              <input
                id="district"
                className="field"
                value={address.district}
                onChange={(event) => setAddress({ ...address, district: event.target.value })}
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
            <Field label="Cidade" htmlFor="city">
              <input
                id="city"
                className="field"
                value={address.city}
                onChange={(event) => setAddress({ ...address, city: event.target.value })}
              />
            </Field>
            <Field label="UF" htmlFor="state">
              <input
                id="state"
                className="field"
                maxLength={2}
                value={address.state}
                onChange={(event) =>
                  setAddress({ ...address, state: event.target.value.toUpperCase() })
                }
              />
            </Field>
          </div>
        </Card>
      )}

      {!isEditing && (
        <Card className="space-y-3">
          <h2 className="font-semibold">Consentimento</h2>
          <p className="hint">
            Sem o aceite registrado não há lembrete, campanha nem atendimento automático.
          </p>

          <Consent
            label="Receber mensagens no WhatsApp"
            checked={consents.whatsapp}
            onChange={(value) => setConsents({ ...consents, whatsapp: value })}
          />
          <Consent
            label="Receber e-mails"
            checked={consents.email}
            onChange={(value) => setConsents({ ...consents, email: value })}
          />
          <Consent
            label="Autorizar uso de imagem do pet"
            checked={consents.imageUse}
            onChange={(value) => setConsents({ ...consents, imageUse: value })}
          />
          <Consent
            label="Aceitou os termos de uso e a política de privacidade"
            checked={consents.terms}
            onChange={(value) => setConsents({ ...consents, terms: value })}
            error={fieldErrors['consents.terms']}
          />
        </Card>
      )}

      <Card className="space-y-3">
        <Field
          label="Observações"
          htmlFor="notes"
          error={fieldErrors.notes}
          hint="Não registre dados de saúde do tutor aqui — este campo entra na exportação e na anonimização."
        >
          <textarea
            id="notes"
            className="field min-h-24"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
        </Field>
      </Card>

      <div className="flex items-center justify-end gap-3">
        <Link href={isEditing ? `/tutores/${tutor.id}` : '/tutores'} className="btn btn-ghost">
          Cancelar
        </Link>
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? 'Salvando…' : isEditing ? 'Salvar alterações' : 'Cadastrar tutor'}
        </button>
      </div>
    </form>
  )
}

function Consent({
  label,
  checked,
  onChange,
  error,
}: {
  label: string
  checked: boolean
  onChange: (value: boolean) => void
  error?: string
}) {
  return (
    <div>
      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="text-muted">{label}</span>
      </label>
      {error && (
        <p className="error-text mt-1" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

function describeMatch(candidate: DuplicateCandidate): string {
  const labels: Record<string, string> = {
    cpf: 'mesmo CPF',
    cnpj: 'mesmo CNPJ',
    phone: 'mesmo telefone',
    email: 'mesmo e-mail',
    name: 'nome parecido',
  }
  return candidate.matchedOn.map((key) => labels[key] ?? key).join(', ')
}
