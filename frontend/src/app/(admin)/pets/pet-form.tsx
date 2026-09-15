'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type {
  Breed,
  Coat,
  PetResponse,
  PetSex,
  PetTutorRole,
  Size,
  Species,
} from '@petshop/shared-types'
import {
  Alert,
  Button,
  Card,
  Field,
  FormActions,
  FormError,
  SectionHead,
  Segmented,
} from '@/components/ui'
import {
  AlertTriangleIcon,
  CakeIcon,
  HeartPulseIcon,
  NoteIcon,
  PawPrintIcon,
  UsersIcon,
} from '@/components/icons'
import { ButtonLink } from '@/components/links'
import {
  createPetAction,
  listBreedsAction,
  updatePetAction,
  type ActionResult,
  type TutorOption,
} from './actions'
import { TutorPicker } from './tutor-picker'

/**
 * Formulário de cadastro e edição de pet.
 *
 * Três coisas o separam do formulário de tutor, e todas vêm de regra de negócio:
 *
 *   · RN-01 — espécie, raça, porte e pelagem são catálogo, nunca texto livre. A raça
 *     depende da espécie escolhida e é buscada quando ela muda;
 *   · AC-03 — pet resgatado não tem data de nascimento, tem idade estimada. São dois
 *     caminhos exclusivos, e a tela pergunta qual antes de pedir o valor;
 *   · AC-04 — peso fora da faixa do porte **avisa**, nunca bloqueia. O buldogue de
 *     32 kg existe, e recusá-lo faria a recepção inventar um porte errado só para
 *     salvar — o que estragaria o cálculo de duração do banho (RN-03).
 */

interface Props {
  species: Species[]
  sizes: Size[]
  coats: Coat[]
  /** Raças da espécie já selecionada; vazio no cadastro novo. */
  initialBreeds?: Breed[]
  pet?: PetResponse
}

/** Responsável em montagem, antes do pet existir. */
interface TutorDraft {
  tutorId: string
  displayName: string
  phoneMasked: string
  role: PetTutorRole
  relationship: string
}

type AgeMode = 'exact' | 'estimated' | 'unknown'

/**
 * `unknown` fica de fora do controle: é o estado de um pet já salvo sem idade
 * nenhuma, não uma escolha que alguém faça na tela. Oferecê-lo como terceiro botão
 * convidaria a recepção a não perguntar.
 */
const AGE_MODES = [
  { value: 'exact', label: 'Sei a data de nascimento' },
  { value: 'estimated', label: 'Sei a idade aproximada' },
] as const satisfies readonly { value: AgeMode; label: string }[]

export function PetForm({ species, sizes, coats, initialBreeds = [], pet }: Props) {
  const router = useRouter()
  const isEditing = pet !== undefined
  const [pending, startTransition] = useTransition()

  const [name, setName] = useState(pet?.name ?? '')
  const [speciesId, setSpeciesId] = useState(pet?.species.id ?? '')
  const [breeds, setBreeds] = useState<Breed[]>(initialBreeds)
  const [breedId, setBreedId] = useState(pet?.breed?.id ?? '')
  const [sizeId, setSizeId] = useState(pet?.size.id ?? '')
  const [coatId, setCoatId] = useState(pet?.coat?.id ?? '')
  const [sex, setSex] = useState<PetSex>(pet?.sex ?? 'UNKNOWN')
  const [color, setColor] = useState(pet?.color ?? '')

  const [ageMode, setAgeMode] = useState<AgeMode>(initialAgeMode(pet))
  const [birthDate, setBirthDate] = useState(pet?.birthDate ?? '')
  const [estimatedAgeMonths, setEstimatedAgeMonths] = useState(
    pet?.birthDatePrecision === 'ESTIMATED' ? String(pet.ageMonths ?? '') : '',
  )

  const [weightKg, setWeightKg] = useState(
    pet?.weightKg === null ? '' : String(pet?.weightKg ?? ''),
  )
  const [neutered, setNeutered] = useState<boolean | null>(pet?.neutered ?? null)
  const [microchip, setMicrochip] = useState('')
  const [notes, setNotes] = useState(pet?.notes ?? '')

  const [tutors, setTutors] = useState<TutorDraft[]>([])
  const [result, setResult] = useState<ActionResult<PetResponse> | null>(null)

  const fieldErrors = result?.ok === false ? result.fieldErrors : {}

  // ─── Catálogo encadeado ────────────────────────────────────────────────────

  function handleSpeciesChange(nextSpeciesId: string) {
    setSpeciesId(nextSpeciesId)
    // A raça anterior pertencia a outra espécie: mantê-la produziria o 422 do AC-02.
    setBreedId('')
    setBreeds([])
    if (!nextSpeciesId) return
    void listBreedsAction(nextSpeciesId).then(setBreeds)
  }

  /** A raça sugere o porte; a recepção pode trocar, e a escolha dela prevalece. */
  function handleBreedChange(nextBreedId: string) {
    setBreedId(nextBreedId)
    const breed = breeds.find((item) => item.id === nextBreedId)
    if (breed?.defaultSizeId && !sizeId) setSizeId(breed.defaultSizeId)
  }

  // ─── Aviso de peso (AC-04) ─────────────────────────────────────────────────

  const selectedSize = sizes.find((size) => size.id === sizeId)
  const weightValue = weightKg === '' ? null : Number(weightKg)
  const weightMismatch =
    selectedSize !== undefined &&
    weightValue !== null &&
    Number.isFinite(weightValue) &&
    (weightValue < selectedSize.weightMinKg || weightValue > selectedSize.weightMaxKg)

  // ─── Responsáveis ──────────────────────────────────────────────────────────

  function addTutor(option: TutorOption) {
    setTutors((current) => [
      ...current,
      {
        tutorId: option.id,
        displayName: option.displayName,
        phoneMasked: option.phoneMasked,
        // O primeiro escolhido é o principal: é para a conta dele que o débito vai
        // (RN-05), e alguém precisa ocupar o papel.
        role: current.length === 0 ? 'PRIMARY' : 'SECONDARY',
        relationship: '',
      },
    ])
  }

  function updateTutor(tutorId: string, patch: Partial<TutorDraft>) {
    setTutors((current) =>
      current.map((tutor) => (tutor.tutorId === tutorId ? { ...tutor, ...patch } : tutor)),
    )
  }

  /** Promover um a principal rebaixa o anterior: RN-04 admite exatamente um. */
  function makePrimary(tutorId: string) {
    setTutors((current) =>
      current.map((tutor) => ({
        ...tutor,
        role: tutor.tutorId === tutorId ? 'PRIMARY' : 'SECONDARY',
      })),
    )
  }

  function removeTutor(tutorId: string) {
    setTutors((current) => {
      const remaining = current.filter((tutor) => tutor.tutorId !== tutorId)
      // Tirar o principal deixaria o pet sem responsável; o próximo da fila assume.
      if (remaining.length > 0 && !remaining.some((tutor) => tutor.role === 'PRIMARY')) {
        remaining[0] = { ...remaining[0]!, role: 'PRIMARY' }
      }
      return remaining
    })
  }

  // ─── Envio ─────────────────────────────────────────────────────────────────

  const ageFields =
    ageMode === 'exact'
      ? { birthDate: birthDate || undefined }
      : ageMode === 'estimated'
        ? { estimatedAgeMonths: estimatedAgeMonths === '' ? undefined : Number(estimatedAgeMonths) }
        : {}

  const missingAge = ageMode === 'unknown' || Object.values(ageFields)[0] === undefined

  /**
   * O cadastro exige idade e ao menos um responsável; a edição, não. `UpdatePetSchema`
   * é inteiramente parcial, e travar o botão porque o pet foi cadastrado sem data de
   * nascimento impediria corrigir até o nome dele.
   */
  const canSubmit =
    name.trim().length > 0 &&
    speciesId !== '' &&
    sizeId !== '' &&
    (isEditing || (!missingAge && tutors.length > 0))

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setResult(null)

    startTransition(async () => {
      const response = isEditing
        ? await updatePetAction(pet.id, {
            name: name.trim(),
            speciesId,
            breedId: breedId || null,
            sizeId,
            coatId: coatId || null,
            sex,
            color: color.trim() || null,
            notes: notes.trim() || null,
            weightKg: weightValue,
            neutered,
            ...(microchip.replace(/\D/g, '') ? { microchip } : {}),
            ...(ageMode === 'exact'
              ? { birthDate: birthDate || null }
              : ageMode === 'estimated'
                ? {
                    estimatedAgeMonths:
                      estimatedAgeMonths === '' ? null : Number(estimatedAgeMonths),
                  }
                : { birthDate: null }),
          })
        : await createPetAction({
            name: name.trim(),
            speciesId,
            ...(breedId ? { breedId } : {}),
            sizeId,
            ...(coatId ? { coatId } : {}),
            sex,
            ...ageFields,
            ...(weightValue !== null ? { weightKg: weightValue } : {}),
            ...(neutered !== null ? { neutered } : {}),
            ...(microchip.replace(/\D/g, '') ? { microchip } : {}),
            ...(color.trim() ? { color: color.trim() } : {}),
            ...(notes.trim() ? { notes: notes.trim() } : {}),
            tutors: tutors.map((tutor) => ({
              tutorId: tutor.tutorId,
              role: tutor.role,
              ...(tutor.relationship.trim() ? { relationship: tutor.relationship.trim() } : {}),
              canAuthorizeProcedures: true,
            })),
          })

      setResult(response)
      // O aviso de peso do AC-04 vem no 201 e aparece na tela de detalhe, que é para
      // onde o cadastro leva — não há o que confirmar aqui.
      if (response.ok) router.push(`/pets/${response.data.id}`)
    })
  }

  const conflict = result?.ok === false ? result.existingPet : undefined

  return (
    <form onSubmit={handleSubmit} className="space-y-5" noValidate>
      {result?.ok === false && !conflict && <FormError message={result.message} />}

      {conflict && (
        <Alert
          tone="danger"
          icon={<AlertTriangleIcon />}
          title={result?.ok === false ? result.message : ''}
        >
          <p>
            Microchip já usado por <span className="font-medium">{conflict.name}</span>.
          </p>
          <ButtonLink href={`/pets/${conflict.id}`} className="mt-3">
            Abrir cadastro existente
          </ButtonLink>
        </Alert>
      )}

      <Card tone="soft" className="space-y-5">
        <SectionHead
          icon={<PawPrintIcon />}
          tone="icon-pet"
          eyebrow="01 · Identificação"
          title="Quem é o pet"
        />

        <Field label="Nome" htmlFor="name" error={fieldErrors.name}>
          <input
            id="name"
            className="field"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={60}
            aria-invalid={Boolean(fieldErrors.name)}
            required
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Espécie" htmlFor="speciesId" error={fieldErrors.speciesId}>
            <select
              id="speciesId"
              className="field"
              value={speciesId}
              onChange={(event) => handleSpeciesChange(event.target.value)}
              aria-invalid={Boolean(fieldErrors.speciesId)}
              required
            >
              <option value="">Selecione…</option>
              {species.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Raça"
            htmlFor="breedId"
            error={fieldErrors.breedId}
            hint={
              speciesId
                ? 'Opcional — nem todo cadastro sabe a raça.'
                : 'Escolha a espécie primeiro.'
            }
          >
            <select
              id="breedId"
              className="field"
              value={breedId}
              onChange={(event) => handleBreedChange(event.target.value)}
              disabled={!speciesId || breeds.length === 0}
              aria-invalid={Boolean(fieldErrors.breedId)}
            >
              <option value="">Não informada</option>
              {breeds.map((breed) => (
                <option key={breed.id} value={breed.id}>
                  {breed.label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Porte"
            htmlFor="sizeId"
            error={fieldErrors.sizeId}
            hint="Define o preço e a duração do banho."
          >
            <select
              id="sizeId"
              className="field"
              value={sizeId}
              onChange={(event) => setSizeId(event.target.value)}
              aria-invalid={Boolean(fieldErrors.sizeId)}
              required
            >
              <option value="">Selecione…</option>
              {sizes.map((size) => (
                <option key={size.id} value={size.id}>
                  {size.label} ({size.weightMinKg}–{size.weightMaxKg} kg)
                </option>
              ))}
            </select>
          </Field>

          <Field label="Pelagem" htmlFor="coatId" error={fieldErrors.coatId}>
            <select
              id="coatId"
              className="field"
              value={coatId}
              onChange={(event) => setCoatId(event.target.value)}
            >
              <option value="">Não informada</option>
              {coats.map((coat) => (
                <option key={coat.id} value={coat.id}>
                  {coat.label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Sexo" htmlFor="sex" error={fieldErrors.sex}>
            <select
              id="sex"
              className="field"
              value={sex}
              onChange={(event) => setSex(event.target.value as PetSex)}
            >
              <option value="UNKNOWN">Não informado</option>
              <option value="MALE">Macho</option>
              <option value="FEMALE">Fêmea</option>
            </select>
          </Field>

          <Field label="Cor / pelagem visível" htmlFor="color" error={fieldErrors.color}>
            <input
              id="color"
              className="field"
              value={color}
              onChange={(event) => setColor(event.target.value)}
              placeholder="Caramelo"
              maxLength={40}
            />
          </Field>
        </div>
      </Card>

      <Card tone="soft" className="space-y-5">
        <SectionHead
          icon={<CakeIcon />}
          tone="icon-pet"
          eyebrow="02 · Idade"
          title="Quantos anos ele tem"
          description="Pet resgatado costuma não ter data de nascimento. A idade aproximada serve, e as telas passam a exibir “≈” para o veterinário saber que é estimativa."
        />

        <Segmented
          ariaLabel="Como informar a idade"
          options={AGE_MODES}
          value={ageMode === 'unknown' ? 'exact' : ageMode}
          onChange={setAgeMode}
        />

        {ageMode === 'exact' ? (
          <Field label="Data de nascimento" htmlFor="birthDate" error={fieldErrors.birthDate}>
            <input
              id="birthDate"
              type="date"
              className="field"
              value={birthDate}
              onChange={(event) => setBirthDate(event.target.value)}
              max={new Date().toISOString().slice(0, 10)}
              aria-invalid={Boolean(fieldErrors.birthDate)}
            />
          </Field>
        ) : (
          <Field
            label="Idade aproximada"
            htmlFor="estimatedAgeMonths"
            error={fieldErrors.estimatedAgeMonths}
            hint="Em meses. Um pet de 2 anos são 24 meses."
          >
            <div className="flex items-center gap-2">
              <input
                id="estimatedAgeMonths"
                type="number"
                className="field w-32"
                min={0}
                max={360}
                value={estimatedAgeMonths}
                onChange={(event) => setEstimatedAgeMonths(event.target.value)}
              />
              <span className="hint">meses</span>
            </div>
          </Field>
        )}
      </Card>

      <Card tone="soft" className="space-y-5">
        <SectionHead
          icon={<HeartPulseIcon />}
          tone="icon-pet"
          eyebrow="03 · Saúde"
          title="Como ele está"
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Peso"
            htmlFor="weightKg"
            error={fieldErrors.weightKg}
            hint={
              isEditing
                ? 'Cada peso salvo entra no histórico de pesagens.'
                : 'Vira a primeira pesagem do histórico.'
            }
          >
            <div className="flex items-center gap-2">
              <input
                id="weightKg"
                type="number"
                step="0.01"
                className="field w-32"
                min={0.05}
                max={120}
                value={weightKg}
                onChange={(event) => setWeightKg(event.target.value)}
              />
              <span className="hint">kg</span>
            </div>
          </Field>

          <Field label="Castrado" htmlFor="neutered">
            <select
              id="neutered"
              className="field"
              value={neutered === null ? '' : String(neutered)}
              onChange={(event) =>
                setNeutered(event.target.value === '' ? null : event.target.value === 'true')
              }
            >
              <option value="">Não informado</option>
              <option value="true">Sim</option>
              <option value="false">Não</option>
            </select>
          </Field>
        </div>

        {weightMismatch && selectedSize && (
          <Alert
            tone="accent"
            role="status"
            icon={<AlertTriangleIcon />}
            title={`${weightKg} kg está fora da faixa de ${selectedSize.label}`}
          >
            <p>
              O porte prevê {selectedSize.weightMinKg}–{selectedSize.weightMaxKg} kg. É só um aviso
              — dá para salvar assim (AC-04).
            </p>
          </Alert>
        )}

        <Field
          label="Microchip"
          htmlFor="microchip"
          error={fieldErrors.microchip}
          hint={
            isEditing && pet.microchipMasked
              ? `Atual: ${pet.microchipMasked}. Preencha só para substituir.`
              : '15 dígitos. Guardado criptografado e único no estabelecimento.'
          }
        >
          <input
            id="microchip"
            className="field"
            inputMode="numeric"
            value={microchip}
            onChange={(event) => setMicrochip(event.target.value)}
            placeholder="000000000000000"
            aria-invalid={Boolean(fieldErrors.microchip)}
          />
        </Field>
      </Card>

      {!isEditing && (
        <Card tone="soft" className="space-y-5">
          <SectionHead
            icon={<UsersIcon />}
            tone="icon-pet"
            eyebrow="04 · Responsáveis"
            title="De quem ele é"
            description="Todo pet precisa de um responsável principal — é para a conta dele que os serviços são lançados. Um casal pode ter os dois vinculados."
          />

          {tutors.length > 0 && (
            <ul className="space-y-2">
              {tutors.map((tutor) => (
                <li
                  key={tutor.tutorId}
                  className="rounded-2xl border border-line px-4 py-3 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="font-medium">{tutor.displayName}</span>
                    <span className="hint">{tutor.phoneMasked}</span>

                    <button
                      type="button"
                      onClick={() => makePrimary(tutor.tutorId)}
                      aria-pressed={tutor.role === 'PRIMARY'}
                      className={`pill ml-auto px-3 py-1 text-xs font-medium ${
                        tutor.role === 'PRIMARY'
                          ? 'bg-shell text-white'
                          : 'bg-black/5 text-muted hover:bg-black/10'
                      }`}
                    >
                      {tutor.role === 'PRIMARY' ? 'Principal' : 'Tornar principal'}
                    </button>

                    <Button
                      type="button"
                      className="px-2 py-1 text-xs"
                      onClick={() => removeTutor(tutor.tutorId)}
                    >
                      Remover
                    </Button>
                  </div>

                  <input
                    className="field mt-2"
                    placeholder="Parentesco ou relação — ex.: Cônjuge, Filha"
                    value={tutor.relationship}
                    maxLength={40}
                    onChange={(event) =>
                      updateTutor(tutor.tutorId, { relationship: event.target.value })
                    }
                  />
                </li>
              ))}
            </ul>
          )}

          <TutorPicker
            label={tutors.length === 0 ? 'Responsável principal' : 'Adicionar outro responsável'}
            excludeIds={tutors.map((tutor) => tutor.tutorId)}
            onSelect={addTutor}
          />

          {fieldErrors.tutors && (
            <p className="error-text" role="alert">
              {fieldErrors.tutors}
            </p>
          )}
        </Card>
      )}

      <Card tone="soft" className="space-y-5">
        <SectionHead
          icon={<NoteIcon />}
          tone="icon-pet"
          eyebrow="05 · Observações"
          title="O que mais importa saber"
        />

        <Field
          label="Observações"
          htmlFor="notes"
          error={fieldErrors.notes}
          hint="Temperamento, manias, cuidados no manejo. Guardado criptografado."
        >
          <textarea
            id="notes"
            className="field min-h-24"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            maxLength={2000}
          />
        </Field>
      </Card>

      <FormActions>
        <ButtonLink href={isEditing ? `/pets/${pet.id}` : '/pets'} variant="ghost">
          Cancelar
        </ButtonLink>
        <Button type="submit" busy={pending} disabled={!canSubmit} busyLabel="Salvando…">
          {isEditing ? 'Salvar alterações' : 'Cadastrar pet'}
        </Button>
      </FormActions>
    </form>
  )
}

/** Na edição, o modo de idade vem da precisão que o servidor já gravou. */
function initialAgeMode(pet: PetResponse | undefined): AgeMode {
  if (!pet) return 'exact'
  if (pet.birthDatePrecision === 'ESTIMATED') return 'estimated'
  if (pet.birthDatePrecision === 'EXACT') return 'exact'
  return 'unknown'
}
