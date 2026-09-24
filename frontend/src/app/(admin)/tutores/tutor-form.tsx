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
import {
  Alert,
  Button,
  Card,
  Choice,
  Field,
  FormActions,
  FormError,
  SectionHead,
  Segmented,
} from '@/components/ui'
import { useToast } from '@/components/toast'
import {
  AlertTriangleIcon,
  CakeIcon,
  CopyIcon,
  DocumentIcon,
  MailIcon,
  MapPinIcon,
  NoteIcon,
  PhoneIcon,
  ShieldCheckIcon,
  SpinnerIcon,
  UsersIcon,
} from '@/components/icons'
import { ButtonLink } from '@/components/links'
import {
  checkDuplicatesAction,
  createTutorAction,
  lookupCepAction,
  updateTutorAction,
  type ActionResult,
} from './actions'
import { convertSiteLeadAction } from '@/app/(admin)/site/actions'

/**
 * Formulário de cadastro e edição de tutor.
 *
 * Três coisas acontecem antes do envio, e todas existem para o atendente não
 * descobrir problema depois de digitar tudo:
 *
 *   · o CEP preenche o endereço sozinho (MOD-TUTOR-03);
 *   · sair do campo nome dispara a busca por duplicata (AC-02 de MOD-TUTOR-02);
 *   · o 409 do servidor volta como alerta com ação, e não como erro genérico.
 *
 * Sobre a forma: as quatro seções usam o mesmo tom de ícone (`icon-people`) de
 * propósito. Tom diz o TIPO do dado, e as quatro são o mesmo tipo — ficha do
 * tutor. Uma cor por seção transformaria a leitura vertical num confete e
 * sugeriria quatro domínios onde há um; com o violeta repetido, os chips viram
 * uma coluna que dá espinha ao formulário e a diferença fica por conta do
 * desenho, que é o que de fato muda de uma seção para a outra.
 */

interface Props {
  tutor?: TutorDetail
  /**
   * Cadastro que nasce de outra tela — hoje, o contato que chegou pelo site
   * (AC-02 de MOD-SITE-09).
   *
   * Só preenche o começo do formulário; a duplicata, o consentimento e o resto das
   * regras continuam sendo do MOD-TUTOR. Com `leadId`, o contato é marcado como
   * convertido depois que a ficha existe — e não antes, senão um cadastro
   * abandonado deixaria o contato fora da fila sem cliente nenhum do outro lado.
   */
  prefill?: { fullName?: string; phone?: string; leadId?: string }
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

const PERSON_TYPES = [
  { value: 'PF', label: 'Pessoa física' },
  { value: 'PJ', label: 'Pessoa jurídica' },
] as const

export function TutorForm({ tutor, prefill }: Props) {
  const router = useRouter()
  const toast = useToast()
  const isEditing = tutor !== undefined
  const [pending, startTransition] = useTransition()

  const [personType, setPersonType] = useState<'PF' | 'PJ'>(tutor?.personType ?? 'PF')
  const [fullName, setFullName] = useState(tutor?.fullName ?? prefill?.fullName ?? '')
  const [socialName, setSocialName] = useState(tutor?.socialName ?? '')
  const [legalName, setLegalName] = useState(tutor?.legalName ?? '')
  const [document, setDocument] = useState('')
  const [phone, setPhone] = useState(prefill?.phone ?? '')
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
      ...(personType === 'PF' ? { cpf: document || undefined } : { cnpj: document || undefined }),
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
      if (!response.ok) return

      // A conversão do contato acontece **depois** de a ficha existir, e a falha dela
      // não segura o cadastro: o tutor foi criado, e a fila do site pode ser
      // acertada depois. O contrário — marcar convertido antes — deixaria a fila
      // mentindo se o cadastro fosse abandonado.
      if (prefill?.leadId) {
        await convertSiteLeadAction(prefill.leadId, response.data.id)
      }

      toast(isEditing ? 'Cadastro atualizado.' : 'Tutor cadastrado.')
      router.push(`/tutores/${response.data.id}`)
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
        <Alert
          tone="danger"
          icon={<AlertTriangleIcon />}
          title={result?.ok === false ? result.message : ''}
        >
          <p>
            {blockingConflict.fullName} · {blockingConflict.phoneMasked}
          </p>
          <ButtonLink href={`/tutores/${blockingConflict.id}`} className="mt-3">
            {blockingConflict.suggestedAction === 'REACTIVATE_EXISTING'
              ? 'Abrir e reativar cadastro'
              : 'Abrir cadastro existente'}
          </ButtonLink>
        </Alert>
      )}

      {visibleDuplicates && visibleDuplicates.length > 0 && !blockingConflict && (
        <Alert tone="accent" icon={<CopyIcon />} title="Encontramos cadastros parecidos">
          <ul className="space-y-1">
            {visibleDuplicates.map((candidate) => (
              <li key={candidate.id}>
                <Link
                  href={`/tutores/${candidate.id}`}
                  className="font-medium text-ink underline decoration-line underline-offset-4 transition-colors hover:decoration-ink"
                >
                  {candidate.fullName}
                </Link>{' '}
                <span>
                  · {candidate.phoneMasked} · {describeMatch(candidate)}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-2 -ml-3.5">
            <Choice
              label="Confirmo que é outra pessoa — pode ser outro responsável pelo mesmo pet."
              checked={acknowledged}
              onChange={setAcknowledged}
            />
          </div>
        </Alert>
      )}

      <Card tone="soft" className="space-y-5">
        <SectionHead
          icon={<UsersIcon />}
          tone="icon-people"
          eyebrow="01 · Identificação"
          title="Quem é o tutor"
        />

        <Segmented
          ariaLabel="Tipo de pessoa"
          options={PERSON_TYPES}
          value={personType}
          onChange={setPersonType}
          disabled={isEditing}
        />

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
            <span className="field-wrap">
              <span className="field-lead">
                <DocumentIcon />
              </span>
              <input
                id="document"
                className="field"
                inputMode="numeric"
                value={personType === 'PF' ? formatCPF(document) : document}
                onChange={(event) => setDocument(event.target.value.replace(/\D/g, ''))}
                aria-invalid={Boolean(fieldErrors.cpf ?? fieldErrors.cnpj)}
              />
            </span>
          </Field>

          <Field
            label="Telefone (WhatsApp)"
            htmlFor="phone"
            error={fieldErrors.phone}
            hint="É por aqui que saem os lembretes e o atendimento automático."
          >
            <span className="field-wrap">
              <span className="field-lead">
                <PhoneIcon />
              </span>
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
            </span>
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="E-mail" htmlFor="email" error={fieldErrors.email}>
            <span className="field-wrap">
              <span className="field-lead">
                <MailIcon />
              </span>
              <input
                id="email"
                type="email"
                className="field"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                aria-invalid={Boolean(fieldErrors.email)}
              />
            </span>
          </Field>

          <Field label="Data de nascimento" htmlFor="birthDate" error={fieldErrors.birthDate}>
            <span className="field-wrap">
              <span className="field-lead">
                <CakeIcon />
              </span>
              <input
                id="birthDate"
                type="date"
                className="field"
                value={birthDate}
                onChange={(event) => setBirthDate(event.target.value)}
              />
            </span>
          </Field>
        </div>
      </Card>

      {!isEditing && (
        <Card tone="soft" className="space-y-5">
          <SectionHead
            icon={<MapPinIcon />}
            tone="icon-people"
            eyebrow="02 · Endereço"
            title="Onde ele está"
            description="Opcional para cadastrar, obrigatório para o Taxi Dog buscar."
          />

          <div className="grid gap-4 sm:grid-cols-[170px_1fr_120px]">
            <Field
              label="CEP"
              htmlFor="zipCode"
              hint={cepStatus === 'notfound' ? 'Não encontrado — preencha à mão.' : undefined}
            >
              {/*
                O "buscando…" mora no slot da direita do campo, e não na dica: como
                dica ele empurrava a linha inteira do endereço para cima e para baixo
                a cada consulta, e o salto chamava mais atenção que o próprio status.
              */}
              <span className="field-wrap">
                <span className="field-lead">
                  <MapPinIcon />
                </span>
                <input
                  id="zipCode"
                  className="field pr-10"
                  inputMode="numeric"
                  value={formatCEP(address.zipCode)}
                  onChange={(event) =>
                    setAddress({ ...address, zipCode: event.target.value.replace(/\D/g, '') })
                  }
                  onBlur={handleCepBlur}
                />
                {cepStatus === 'loading' && (
                  <span className="field-tail text-subtle" aria-label="Buscando endereço">
                    <SpinnerIcon />
                  </span>
                )}
              </span>
            </Field>

            <Field label="Logradouro" htmlFor="street">
              <input
                id="street"
                className="field"
                value={address.street}
                onChange={(event) => setAddress({ ...address, street: event.target.value })}
              />
            </Field>

            <Field label="Número" htmlFor="number">
              <input
                id="number"
                className="field"
                value={address.number}
                onChange={(event) => setAddress({ ...address, number: event.target.value })}
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
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
        <Card tone="soft" className="space-y-5">
          <SectionHead
            icon={<ShieldCheckIcon />}
            tone="icon-people"
            eyebrow="03 · Consentimento"
            title="O que ele autoriza"
            description="Sem o aceite registrado não há lembrete, campanha nem atendimento automático."
          />

          {/* `-mx-3.5` recupera o recuo interno das linhas: com ele os rótulos das
              escolhas alinham com os rótulos dos campos das outras seções, e o fundo
              da linha marcada continua respirando para fora desse alinhamento. */}
          <div className="-mx-3.5 space-y-2">
            <Choice
              label="Receber mensagens no WhatsApp"
              checked={consents.whatsapp}
              onChange={(value) => setConsents({ ...consents, whatsapp: value })}
            />
            <Choice
              label="Receber e-mails"
              checked={consents.email}
              onChange={(value) => setConsents({ ...consents, email: value })}
            />
            <Choice
              label="Autorizar uso de imagem do pet"
              description="Fotos do banho e da tosa em redes sociais e no portal."
              checked={consents.imageUse}
              onChange={(value) => setConsents({ ...consents, imageUse: value })}
            />
            <Choice
              label="Aceitou os termos de uso e a política de privacidade"
              checked={consents.terms}
              onChange={(value) => setConsents({ ...consents, terms: value })}
              error={fieldErrors['consents.terms']}
            />
          </div>
        </Card>
      )}

      <Card tone="soft" className="space-y-5">
        <SectionHead
          icon={<NoteIcon />}
          tone="icon-people"
          eyebrow={isEditing ? '02 · Observações' : '04 · Observações'}
          title="O que mais importa saber"
        />

        <Field
          label="Observações"
          htmlFor="notes"
          error={fieldErrors.notes}
          hint="Não registre dados de saúde do tutor aqui — este campo entra na exportação e na anonimização."
        >
          <textarea
            id="notes"
            className="field min-h-28 resize-y"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
        </Field>
      </Card>

      <FormActions>
        <ButtonLink href={isEditing ? `/tutores/${tutor.id}` : '/tutores'} variant="ghost">
          Cancelar
        </ButtonLink>
        <Button type="submit" busy={pending} busyLabel="Salvando…">
          {isEditing ? 'Salvar alterações' : 'Cadastrar tutor'}
        </Button>
      </FormActions>
    </form>
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
