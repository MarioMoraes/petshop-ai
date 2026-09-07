'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  ACCEPTED_PHOTO_MIMES,
  MAX_PHOTOS_PER_UPLOAD,
  TRANSFER_CONFIRMATION,
  TRANSFER_REASON_LABELS,
  type PetAlbum,
  type PetPhoto,
  type PetResponse,
  type PetTransfer,
  type SafetyRecord,
  type TimelinePage,
  type PetTutorRole,
  type PetWeightRecord,
  type TransferReason,
} from '@petshop/shared-types'
import { Card, DataRow, Field, FormError, Tabs } from '@/components/ui'
import { SafetyRecordTab } from './safety-record'
import { TimelineTab } from './timeline'
import {
  deletePetAction,
  deletePhotoAction,
  linkTutorAction,
  recordWeightAction,
  updatePhotoAction,
  uploadPhotosAction,
  registerDeathAction,
  revealMicrochipAction,
  revertDeathAction,
  transferPetAction,
  unlinkTutorAction,
  updatePetTutorAction,
} from '../actions'
import { TutorPicker } from '../tutor-picker'

/**
 * Detalhe do pet em abas.
 *
 * A aba de prontuário existe e diz que o módulo ainda não chegou, em vez de sumir: o
 * atendente precisa saber que o dado *vai* estar ali, e uma aba vazia sem explicação
 * lê como "este pet não tem alergia nenhuma" — o que é perigoso de supor.
 */

interface Props {
  pet: PetResponse
  weights: PetWeightRecord[]
  transfers: PetTransfer[]
  album: PetAlbum
  safetyRecord: SafetyRecord
  /** MOD-PRONT-02: a primeira página do histórico, já filtrada pelo servidor. */
  timeline: TimelinePage
  canUpdate: boolean
  canDelete: boolean
  /** `pet:upload_photo` — o tosador manda a foto do banho pronto (§9). */
  canUploadPhoto: boolean
  /** `pet:weigh` — o banhista pesa sem poder editar o cadastro. */
  canWeigh: boolean
  /** `pet:manage_lifecycle` — transferir titularidade e reverter óbito. */
  canManageLifecycle: boolean
  /** `record:write_alerts` — recepção e veterinário registram alergia. */
  canWriteAlerts: boolean
  /** `record:write` — só o veterinário e o administrador desativam. */
  canManageRecord: boolean
  /** `record:write_notes` — quem manuseia o animal observa o comportamento. */
  canWriteNotes: boolean
  /** `record:void` — anular um atendimento estorna o débito do tutor. */
  canVoidAttendance: boolean
}

export function PetDetailView(props: Props) {
  const { pet, weights, album, safetyRecord, canWeigh } = props
  const [tab, setTab] = useState('dados')

  return (
    <div className="space-y-5">
      {/*
        AC-04: o aviso de peso acompanha o cadastro, não só o momento de salvar. Fica
        no topo das abas porque vale para o pet inteiro, não para uma seção.
      */}
      {pet.status === 'DECEASED' && (
        <div className="rounded-2xl border border-danger/20 bg-danger/5 px-5 py-4 text-sm" role="status">
          <strong>{pet.name} está registrado como falecido</strong>
          {pet.deceasedAt ? ` em ${formatDate(pet.deceasedAt)}` : ''}. As campanhas para os
          tutores foram suprimidas e o cadastro não aceita mais edição.
        </div>
      )}

      {/*
        RN-02: o alerta acompanha o pet em toda tela operacional, não só na aba de
        prontuário. Quem abre a ficha para conferir o telefone do tutor precisa ver
        que o cachorro morde.
      */}
      {pet.alerts.length > 0 && (
        <div
          className={`rounded-2xl px-5 py-4 text-sm ${
            pet.alerts.some((alert) => alert.severity === 'CRITICAL')
              ? 'border border-danger/20 bg-danger/5'
              : 'bg-accent-soft text-accent-ink'
          }`}
          role="status"
        >
          <strong>Atenção ao manuseio:</strong>{' '}
          {pet.alerts.map((alert) => alert.label).join(' · ')}
        </div>
      )}

      {pet.warnings.map((warning) => (
        <div
          key={warning.code}
          className="rounded-2xl bg-accent-soft px-5 py-4 text-sm text-accent-ink"
          role="status"
        >
          {warning.message} — {pet.weightKg} kg com porte {pet.size.label}. Ajuste o porte se
          foi engano; se estiver certo, pode ignorar.
        </div>
      ))}

      <Tabs
        tabs={[
          { id: 'dados', label: 'Dados' },
          { id: 'responsaveis', label: `Responsáveis (${pet.tutors.length})` },
          { id: 'peso', label: `Peso (${weights.length})` },
          { id: 'fotos', label: `Fotos (${album.photos.length})` },
          {
            id: 'prontuario',
            label: safetyRecord.alerts.length
              ? `Prontuário (${safetyRecord.alerts.length})`
              : 'Prontuário',
          },
          { id: 'historico', label: 'Histórico' },
        ]}
        active={tab}
        onSelect={setTab}
      />

      {tab === 'dados' && <DadosTab {...props} />}
      {tab === 'responsaveis' && <ResponsaveisTab {...props} />}
      {tab === 'peso' && (
        <PesoTab petId={pet.id} pet={pet} weights={weights} canWeigh={canWeigh} />
      )}
      {tab === 'fotos' && <FotosTab {...props} />}
      {tab === 'historico' && (
        <TimelineTab
          petId={pet.id}
          petName={pet.name}
          page={props.timeline}
          canVoid={props.canVoidAttendance}
          canWrite={props.canWriteNotes}
          canPrescribe={props.canManageRecord}
          photos={album.photos}
          canUploadPhoto={props.canUploadPhoto}
        />
      )}
      {tab === 'prontuario' && (
        <SafetyRecordTab
          petId={pet.id}
          record={safetyRecord}
          canWriteAlerts={props.canWriteAlerts}
          canManageRecord={props.canManageRecord}
          canWriteNotes={props.canWriteNotes}
        />
      )}
    </div>
  )
}

// ─── Dados ───────────────────────────────────────────────────────────────────

function DadosTab({ pet, canUpdate, canDelete, canManageLifecycle }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [microchip, setMicrochip] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const isTerminal = pet.status === 'DECEASED' || pet.status === 'TRANSFERRED_OUT'

  function reveal() {
    setError(null)
    startTransition(async () => {
      const result = await revealMicrochipAction(pet.id)
      if (result.ok) setMicrochip(result.data.microchip)
      else setError(result.message)
    })
  }

  function remove() {
    setError(null)
    startTransition(async () => {
      const result = await deletePetAction(pet.id)
      if (result.ok) router.push('/pets')
      else setError(result.message)
    })
  }

  return (
    <div className="space-y-5">
      <FormError message={error} />

      <Card>
        <dl>
          <DataRow label="Espécie">{pet.species.label}</DataRow>
          <DataRow label="Raça">{pet.breed?.label ?? '—'}</DataRow>
          <DataRow label="Porte">{pet.size.label}</DataRow>
          <DataRow label="Pelagem">{pet.coat?.label ?? '—'}</DataRow>
          <DataRow label="Sexo">{SEX_LABELS[pet.sex]}</DataRow>
          <DataRow label="Cor">{pet.color ?? '—'}</DataRow>
          <DataRow label="Nascimento">
            {pet.birthDate ? formatDate(pet.birthDate) : '—'}
            {pet.birthDatePrecision === 'ESTIMATED' && (
              <span className="hint"> · estimada</span>
            )}
          </DataRow>
          <DataRow label="Idade">{pet.ageLabel ?? 'Não informada'}</DataRow>
          <DataRow label="Peso">{pet.weightKg === null ? '—' : `${pet.weightKg} kg`}</DataRow>
          <DataRow label="Castrado">
            {pet.neutered === null ? 'Não informado' : pet.neutered ? 'Sim' : 'Não'}
          </DataRow>
          <DataRow label="Microchip">
            {pet.microchipMasked === null ? (
              '—'
            ) : microchip !== null ? (
              <span className="font-mono">{microchip}</span>
            ) : (
              <span className="flex items-center gap-3">
                <span className="font-mono">{pet.microchipMasked}</span>
                {canUpdate && (
                  <button
                    type="button"
                    className="btn btn-ghost px-3 py-1 text-xs"
                    disabled={pending}
                    onClick={reveal}
                  >
                    Ver completo
                  </button>
                )}
              </span>
            )}
          </DataRow>
          <DataRow label="Último atendimento">
            {pet.lastAttendanceAt ? formatDate(pet.lastAttendanceAt) : 'Nenhum ainda'}
          </DataRow>
        </dl>
      </Card>

      {pet.notes && (
        <Card>
          <h3 className="font-semibold">Observações</h3>
          <p className="hint mt-2 whitespace-pre-wrap">{pet.notes}</p>
        </Card>
      )}

      {!isTerminal && (
        <div className="flex flex-wrap items-center gap-3">
          {canUpdate && (
            <Link href={`/pets/${pet.id}/editar`} className="btn btn-primary">
              Editar
            </Link>
          )}
          {canUpdate && <DeathPanel pet={pet} />}
          {canDelete && (
            <button
              type="button"
              className="btn btn-ghost text-danger"
              disabled={pending}
              onClick={() => setConfirmingDelete((value) => !value)}
            >
              Excluir
            </button>
          )}
        </div>
      )}

      {pet.status === 'DECEASED' && canManageLifecycle && <DeathReversalPanel pet={pet} />}

      {confirmingDelete && (
        <Card className="space-y-3 border border-danger/20">
          <h3 className="font-semibold text-danger">Excluir {pet.name}?</h3>
          <p className="hint">
            O cadastro sai das listas e da agenda. O microchip volta a ficar livre, então o
            mesmo animal pode ser recadastrado se isto for um engano.
          </p>
          <div className="flex flex-wrap gap-3">
            <button type="button" className="btn btn-accent" disabled={pending} onClick={remove}>
              {pending ? 'Excluindo…' : 'Confirmar exclusão'}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setConfirmingDelete(false)}
            >
              Cancelar
            </button>
          </div>
        </Card>
      )}
    </div>
  )
}

// ─── Responsáveis (MOD-PET-02) ───────────────────────────────────────────────

function ResponsaveisTab({ pet, transfers, canUpdate, canDelete, canManageLifecycle }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function run(action: () => Promise<{ ok: boolean; message?: string }>) {
    setError(null)
    startTransition(async () => {
      const result = await action()
      if (result.ok) router.refresh()
      else setError(result.message ?? 'Não foi possível concluir a operação.')
    })
  }

  const hasPrimary = pet.tutors.some((tutor) => tutor.role === 'PRIMARY')

  return (
    <div className="space-y-5">
      <FormError message={error} />

      {!hasPrimary && (
        <div className="rounded-2xl bg-accent-soft px-5 py-4 text-sm text-accent-ink">
          Este pet está sem responsável principal. Promova alguém — é para a conta dele que
          os serviços são lançados.
        </div>
      )}

      {pet.tutors.length === 0 ? (
        <Card>
          <p className="hint">
            Nenhum responsável vinculado. Acontece quando o único tutor foi anonimizado a
            pedido do titular: o pet e o histórico dele permanecem.
          </p>
        </Card>
      ) : (
        <ul className="space-y-2">
          {pet.tutors.map((link) => (
            <li key={link.linkId}>
              <Card className="space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                  <Link href={`/tutores/${link.tutorId}`} className="font-semibold hover:underline">
                    {link.fullName}
                  </Link>
                  <span className="hint">{link.phoneMasked}</span>
                  <span
                    className={`pill ml-auto px-3 py-1 text-xs font-medium ${
                      link.role === 'PRIMARY' ? 'bg-shell text-white' : 'bg-black/5 text-muted'
                    }`}
                  >
                    {link.role === 'PRIMARY' ? 'Principal' : 'Secundário'}
                  </span>
                </div>

                <p className="hint">
                  {link.relationship ? `${link.relationship} · ` : ''}
                  {link.canAuthorizeProcedures
                    ? 'Pode autorizar procedimentos'
                    : 'Não autoriza procedimentos'}
                  {' · desde '}
                  {formatDate(link.linkedAt)}
                </p>

                {canUpdate && (
                  <div className="flex flex-wrap gap-2">
                    <RoleButton
                      link={link}
                      pending={pending}
                      hasPrimary={hasPrimary}
                      onChange={(role) =>
                        run(() => updatePetTutorAction(pet.id, link.linkId, { role }))
                      }
                    />

                    <button
                      type="button"
                      className="btn btn-ghost px-3 py-1 text-xs"
                      disabled={pending}
                      onClick={() =>
                        run(() =>
                          updatePetTutorAction(pet.id, link.linkId, {
                            canAuthorizeProcedures: !link.canAuthorizeProcedures,
                          }),
                        )
                      }
                    >
                      {link.canAuthorizeProcedures
                        ? 'Retirar autorização'
                        : 'Permitir autorizar'}
                    </button>

                    {canDelete && (
                      <button
                        type="button"
                        className="btn btn-ghost px-3 py-1 text-xs text-danger"
                        disabled={pending}
                        onClick={() => run(() => unlinkTutorAction(pet.id, link.linkId))}
                      >
                        Desvincular
                      </button>
                    )}
                  </div>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}

      {canUpdate && (
        <Card className="space-y-3">
          <h3 className="font-semibold">Vincular outro responsável</h3>
          <p className="hint">
            Ambos passam a ver o pet no portal e podem agendar. O débito continua indo para o
            principal.
          </p>
          <TutorPicker
            label="Buscar tutor"
            excludeIds={pet.tutors.map((link) => link.tutorId)}
            onSelect={(tutor) =>
              run(() =>
                linkTutorAction(pet.id, {
                  tutorId: tutor.id,
                  // Quem chega depois entra como secundário; a troca de principal é
                  // explícita e move o responsável financeiro (RN-05).
                  role: hasPrimary ? 'SECONDARY' : 'PRIMARY',
                  canAuthorizeProcedures: true,
                }),
              )
            }
          />
        </Card>
      )}

      {canManageLifecycle && pet.status !== 'DECEASED' && pet.status !== 'TRANSFERRED_OUT' && (
        <TransferPanel pet={pet} />
      )}

      {transfers.length > 0 && <TransferHistory transfers={transfers} />}
    </div>
  )
}

/**
 * A troca de principal é em dois passos, e o botão diz qual está disponível.
 *
 * Promover direto com outro principal ativo devolve 409: a ordem é rebaixar o atual e
 * então promover. Fazer as duas coisas em silêncio trocaria o responsável financeiro
 * do pet sem ninguém ter pedido.
 */
function RoleButton({
  link,
  pending,
  hasPrimary,
  onChange,
}: {
  link: { role: PetTutorRole }
  pending: boolean
  hasPrimary: boolean
  onChange: (role: PetTutorRole) => void
}) {
  if (link.role === 'PRIMARY') {
    return (
      <button
        type="button"
        className="btn btn-ghost px-3 py-1 text-xs"
        disabled={pending}
        onClick={() => onChange('SECONDARY')}
        title="Rebaixar antes de promover outro responsável"
      >
        Deixar de ser principal
      </button>
    )
  }

  return (
    <button
      type="button"
      className="btn btn-ghost px-3 py-1 text-xs"
      disabled={pending || hasPrimary}
      onClick={() => onChange('PRIMARY')}
      title={
        hasPrimary
          ? 'Rebaixe o responsável principal atual antes de promover este'
          : undefined
      }
    >
      Tornar principal
    </button>
  )
}

// ─── Peso (MOD-PET-07) ───────────────────────────────────────────────────────

/**
 * A série de pesagens e o formulário de registrar mais uma.
 *
 * A variação aparece ponto a ponto porque é ela que muda a conduta: 30 kg não diz
 * nada sozinho, "-20% em três semanas" diz. O destaque de RN-11 é do backend — a tela
 * não recalcula a regra, só a exibe.
 */
function PesoTab({
  petId,
  pet,
  weights,
  canWeigh,
}: {
  petId: string
  pet: PetResponse
  weights: PetWeightRecord[]
  canWeigh: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [weight, setWeight] = useState('')

  const isTerminal = pet.status === 'DECEASED' || pet.status === 'TRANSFERRED_OUT'

  function submit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    const parsed = Number(weight.replace(',', '.'))
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError('Informe o peso em quilos, como 12,4.')
      return
    }

    startTransition(async () => {
      const result = await recordWeightAction(petId, { weightKg: parsed })
      if (result.ok) {
        setWeight('')
        router.refresh()
      } else {
        setError(result.message)
      }
    })
  }

  return (
    <div className="space-y-5">
      <FormError message={error} />

      {canWeigh && !isTerminal && (
        <Card className="space-y-3">
          <h3 className="font-semibold">Registrar pesagem</h3>
          <p className="hint">
            Entra no histórico e vira o peso atual do pet. Se a variação for grande, o
            prontuário avisa o veterinário.
          </p>
          <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
            <Field label="Peso (kg)" htmlFor="weight">
              <input
                id="weight"
                inputMode="decimal"
                className="field w-32"
                value={weight}
                onChange={(event) => setWeight(event.target.value)}
                placeholder="12,4"
              />
            </Field>
            <button type="submit" className="btn btn-primary" disabled={pending}>
              {pending ? 'Registrando…' : 'Registrar'}
            </button>
          </form>
        </Card>
      )}

      {weights.length === 0 ? (
        <Card>
          <p className="hint">
            Nenhuma pesagem registrada. A primeira costuma sair no cadastro ou no check-in
            do banho.
          </p>
        </Card>
      ) : (
        <Card className="space-y-3">
          <h3 className="font-semibold">Histórico</h3>
          <ul className="divide-y divide-black/5">
            {weights.map((point) => (
              <li key={point.id} className="flex flex-wrap items-center gap-3 py-3">
                <span className="font-mono text-lg">{point.weightKg} kg</span>
                <span className="hint">{formatDateTime(point.measuredAt)}</span>
                {point.variationPercent !== null && (
                  <span
                    className={`pill ml-auto px-3 py-1 text-xs font-medium ${
                      point.alert ? 'bg-danger/10 text-danger' : 'bg-black/5 text-muted'
                    }`}
                    title={
                      point.alert
                        ? 'Variação relevante para a janela clínica de 60 dias'
                        : undefined
                    }
                  >
                    {point.variationPercent > 0 ? '+' : ''}
                    {point.variationPercent}%{point.alert ? ' · atenção' : ''}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}

// ─── Álbum de fotos (MOD-PET-04) ─────────────────────────────────────────────

/**
 * Galeria e envio.
 *
 * As URLs vêm assinadas e vencem em 15 minutos (RN-13), então nada aqui é guardado:
 * cada `router.refresh()` traz endereços novos. É também por isso que as imagens usam
 * `<img>` e não o `next/image` — o otimizador cacheia por URL e acabaria servindo um
 * endereço morto.
 */
function FotosTab({ pet, album, canUploadPhoto, canUpdate }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<PetPhoto | null>(null)

  const isTerminal = pet.status === 'DECEASED' || pet.status === 'TRANSFERRED_OUT'
  const quotaLeft =
    album.quota.limit === null ? null : Math.max(album.quota.limit - album.quota.used, 0)

  function send(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget
    const files = Array.from(input.files ?? [])
    if (files.length === 0) return

    setError(null)
    const form = new FormData()
    for (const file of files) form.append('files', file)

    startTransition(async () => {
      const result = await uploadPhotosAction(pet.id, form)
      // O input é limpo de qualquer jeito: senão, escolher o mesmo arquivo de novo
      // depois de um erro não dispararia `change`.
      input.value = ''
      if (result.ok) router.refresh()
      else setError(result.message)
    })
  }

  function run(action: () => Promise<{ ok: boolean; message?: string }>) {
    setError(null)
    startTransition(async () => {
      const result = await action()
      if (result.ok) router.refresh()
      else setError(result.message ?? 'Não foi possível concluir a operação.')
    })
  }

  return (
    <div className="space-y-5">
      <FormError message={error} />

      {canUploadPhoto && !isTerminal && (
        <Card className="space-y-3">
          <div className="flex flex-wrap items-baseline gap-3">
            <h3 className="font-semibold">Adicionar fotos</h3>
            <p className="hint">
              JPG, PNG, WEBP ou HEIC de até 10 MB · até {MAX_PHOTOS_PER_UPLOAD} por vez
              {quotaLeft !== null && ` · ${quotaLeft} restantes no plano`}
            </p>
          </div>

          <input
            type="file"
            multiple
            accept={ACCEPTED_PHOTO_MIMES.join(',')}
            className="field"
            disabled={pending}
            onChange={send}
            aria-label="Escolher fotos"
          />

          {pending && <p className="hint">Enviando…</p>}
          <p className="hint">
            A localização do celular é removida de toda foto antes de guardarmos.
          </p>
        </Card>
      )}

      {album.photos.length === 0 ? (
        <Card>
          <p className="hint">
            Nenhuma foto ainda. A primeira vira a capa e aparece na busca do balcão —
            é o jeito mais rápido de não confundir dois pets de mesmo nome.
          </p>
        </Card>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {album.photos.map((photo) => (
            <li key={photo.id}>
              <Card className="space-y-2 p-3">
                <button
                  type="button"
                  className="block w-full overflow-hidden rounded-xl"
                  onClick={() => setPreview(photo)}
                  aria-label={photo.caption ?? `Ampliar foto de ${pet.name}`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- URL assinada e efêmera */}
                  <img
                    src={photo.urls.thumb}
                    alt={photo.caption ?? `Foto de ${pet.name}`}
                    className="aspect-square w-full object-cover transition-transform hover:scale-105"
                    loading="lazy"
                  />
                </button>

                <div className="flex flex-wrap items-center gap-2">
                  {photo.isCover && (
                    <span className="pill bg-shell px-2 py-0.5 text-[11px] text-white">Capa</span>
                  )}
                  {photo.marketingUse && (
                    <span className="pill bg-accent-soft px-2 py-0.5 text-[11px] text-accent-ink">
                      Campanha
                    </span>
                  )}
                  {photo.source === 'GROOMING_RESULT' && (
                    <span className="pill bg-black/5 px-2 py-0.5 text-[11px] text-muted">Tosa</span>
                  )}
                </div>

                {photo.caption && <p className="hint">{photo.caption}</p>}

                {canUpdate && (
                  <div className="flex flex-wrap gap-1">
                    {!photo.isCover && (
                      <button
                        type="button"
                        className="btn btn-ghost px-2 py-1 text-[11px]"
                        disabled={pending}
                        onClick={() => run(() => updatePhotoAction(pet.id, photo.id, { isCover: true }))}
                      >
                        Tornar capa
                      </button>
                    )}

                    {/*
                      RN-14: a autorização é conferida no servidor, no momento da
                      marcação. O botão pede — quem responde "não" é o 403.
                    */}
                    <button
                      type="button"
                      className="btn btn-ghost px-2 py-1 text-[11px]"
                      disabled={pending}
                      onClick={() =>
                        run(() =>
                          updatePhotoAction(pet.id, photo.id, {
                            marketingUse: !photo.marketingUse,
                          }),
                        )
                      }
                    >
                      {photo.marketingUse ? 'Tirar da campanha' : 'Usar em campanha'}
                    </button>

                    <button
                      type="button"
                      className="btn btn-ghost px-2 py-1 text-[11px] text-danger"
                      disabled={pending}
                      onClick={() => run(() => deletePhotoAction(pet.id, photo.id))}
                    >
                      Excluir
                    </button>
                  </div>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}

      {preview && (
        <button
          type="button"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
          onClick={() => setPreview(null)}
          aria-label="Fechar a foto ampliada"
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- URL assinada e efêmera */}
          <img
            src={preview.urls.full}
            alt={preview.caption ?? `Foto de ${pet.name}`}
            className="max-h-full max-w-full rounded-2xl object-contain"
          />
        </button>
      )}
    </div>
  )
}

// ─── Transferência de titularidade (MOD-PET-05) ──────────────────────────────

/**
 * A transferência encerra todos os vínculos de uma vez e não tem desfazer — daí a
 * confirmação escrita, que é do contrato da API e não enfeite da tela.
 */
function TransferPanel({ pet }: { pet: PetResponse }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toTutor, setToTutor] = useState<{ id: string; displayName: string } | null>(null)
  const [reason, setReason] = useState<TransferReason>('ADOPTION')
  const [notes, setNotes] = useState('')
  const [confirmation, setConfirmation] = useState('')

  if (!open) {
    return (
      <Card className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold">Transferir titularidade</h3>
          <p className="hint">
            Adoção, venda ou falecimento do tutor. O prontuário continua com o pet.
          </p>
        </div>
        <button type="button" className="btn btn-ghost" onClick={() => setOpen(true)}>
          Transferir
        </button>
      </Card>
    )
  }

  function submit() {
    setError(null)
    if (!toTutor) {
      setError('Escolha para quem o pet vai.')
      return
    }

    startTransition(async () => {
      const result = await transferPetAction(pet.id, {
        toTutorId: toTutor.id,
        reason,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        confirmation,
      })
      if (result.ok) {
        setOpen(false)
        router.refresh()
      } else {
        setError(result.message)
      }
    })
  }

  return (
    <Card className="space-y-4 border border-accent/20">
      <div>
        <h3 className="font-semibold">Transferir {pet.name}</h3>
        <p className="hint">
          Os responsáveis atuais deixam de ver o pet e o novo tutor vira o principal. Os
          recibos de quem pagou continuam com quem pagou.
        </p>
      </div>

      <FormError message={error} />

      {toTutor ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-medium">{toTutor.displayName}</span>
          <button
            type="button"
            className="btn btn-ghost px-3 py-1 text-xs"
            onClick={() => setToTutor(null)}
          >
            Trocar
          </button>
        </div>
      ) : (
        <TutorPicker
          label="Novo responsável"
          excludeIds={pet.tutors.map((link) => link.tutorId)}
          onSelect={(tutor) => setToTutor({ id: tutor.id, displayName: tutor.displayName })}
        />
      )}

      <Field label="Motivo" htmlFor="transfer-reason">
        <select
          id="transfer-reason"
          className="field"
          value={reason}
          onChange={(event) => setReason(event.target.value as TransferReason)}
        >
          {Object.entries(TRANSFER_REASON_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Observação (opcional)" htmlFor="transfer-notes">
        <textarea
          id="transfer-notes"
          className="field"
          rows={2}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
      </Field>

      <Field
        label="Para confirmar, escreva CONFIRMO_A_TRANSFERENCIA"
        htmlFor="transfer-confirmation"
      >
        <input
          id="transfer-confirmation"
          className="field font-mono"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          autoComplete="off"
        />
      </Field>

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          className="btn btn-accent"
          disabled={pending || confirmation !== TRANSFER_CONFIRMATION || !toTutor}
          onClick={submit}
        >
          {pending ? 'Transferindo…' : 'Confirmar transferência'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
          Cancelar
        </button>
      </div>
    </Card>
  )
}

function TransferHistory({ transfers }: { transfers: PetTransfer[] }) {
  return (
    <Card className="space-y-3">
      <h3 className="font-semibold">Histórico de titularidade</h3>
      <ul className="divide-y divide-black/5">
        {transfers.map((transfer) => (
          <li key={transfer.id} className="py-3">
            <p className="text-sm">
              {transfer.fromTutorName ?? 'Sem responsável'} → {transfer.toTutorName}
            </p>
            <p className="hint">
              {TRANSFER_REASON_LABELS[transfer.reason]} ·{' '}
              {formatDate(transfer.effectiveDate ?? transfer.createdAt)}
              {transfer.notes ? ` · ${transfer.notes}` : ''}
            </p>
          </li>
        ))}
      </ul>
    </Card>
  )
}

// ─── Óbito (MOD-PET-08) ──────────────────────────────────────────────────────

/**
 * O óbito não entra pelo formulário de edição: ele suprime campanha e cancela
 * agendamento, e um efeito desses precisa de uma decisão explícita — não de um campo
 * "status" no meio de outros vinte.
 */
function DeathPanel({ pet }: { pet: PetResponse }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deceasedAt, setDeceasedAt] = useState(() => new Date().toISOString().slice(0, 10))
  const [notes, setNotes] = useState('')

  function submit() {
    setError(null)
    startTransition(async () => {
      const result = await registerDeathAction(pet.id, {
        deceasedAt,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      })
      if (result.ok) {
        setOpen(false)
        router.refresh()
      } else {
        setError(result.message)
      }
    })
  }

  if (!open) {
    return (
      <button type="button" className="btn btn-ghost" onClick={() => setOpen(true)}>
        Registrar óbito
      </button>
    )
  }

  return (
    <Card className="w-full space-y-4 border border-danger/20">
      <div>
        <h3 className="font-semibold">Registrar o óbito de {pet.name}</h3>
        <p className="hint">
          Os agendamentos futuros são cancelados sem cobrança e nenhuma campanha volta a
          citar o pet. Um administrador pode reverter em até 30 dias.
        </p>
      </div>

      <FormError message={error} />

      <Field label="Data do óbito" htmlFor="deceased-at">
        <input
          id="deceased-at"
          type="date"
          className="field"
          value={deceasedAt}
          max={new Date().toISOString().slice(0, 10)}
          onChange={(event) => setDeceasedAt(event.target.value)}
        />
      </Field>

      <Field label="Observação (opcional)" htmlFor="deceased-notes">
        <textarea
          id="deceased-notes"
          className="field"
          rows={2}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
      </Field>

      <div className="flex flex-wrap gap-3">
        <button type="button" className="btn btn-accent" disabled={pending} onClick={submit}>
          {pending ? 'Registrando…' : 'Confirmar óbito'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
          Cancelar
        </button>
      </div>
    </Card>
  )
}

function DeathReversalPanel({ pet }: { pet: PetResponse }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [justification, setJustification] = useState('')

  function submit() {
    setError(null)
    startTransition(async () => {
      const result = await revertDeathAction(pet.id, { justification: justification.trim() })
      if (result.ok) {
        setOpen(false)
        router.refresh()
      } else {
        setError(result.message)
      }
    })
  }

  if (!open) {
    return (
      <Card className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold">Registro feito por engano?</h3>
          <p className="hint">A reversão é permitida em até 30 dias, com justificativa.</p>
        </div>
        <button type="button" className="btn btn-ghost" onClick={() => setOpen(true)}>
          Reverter óbito
        </button>
      </Card>
    )
  }

  return (
    <Card className="space-y-4">
      <h3 className="font-semibold">Reverter o óbito de {pet.name}</h3>
      <FormError message={error} />

      <Field
        label="Justificativa"
        htmlFor="reversal-justification"
        hint="Fica na trilha de auditoria. Diga o que aconteceu, não apenas “engano”."
      >
        <textarea
          id="reversal-justification"
          className="field"
          rows={3}
          value={justification}
          onChange={(event) => setJustification(event.target.value)}
        />
      </Field>

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          className="btn btn-primary"
          disabled={pending || justification.trim().length < 10}
          onClick={submit}
        >
          {pending ? 'Revertendo…' : 'Confirmar reversão'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
          Cancelar
        </button>
      </div>
    </Card>
  )
}

const SEX_LABELS: Record<string, string> = {
  MALE: 'Macho',
  FEMALE: 'Fêmea',
  UNKNOWN: 'Não informado',
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString('pt-BR', { timeZone: 'UTC' })
}

/** A pesagem tem hora: duas do mesmo dia precisam se distinguir na lista. */
function formatDateTime(value: string): string {
  return new Date(value).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
}
