'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  ATTENDANCE_STATUS_LABELS,
  SEVERITY_LABELS,
  type Attendance,
  type PetPhoto,
  type TimelineEntry,
  type TimelineKind,
  type TimelinePage,
} from '@petshop/shared-types'
import { Badge, EmptyState, Field, FormError } from '@/components/ui'
import {
  addAddendumAction,
  getAttendanceAction,
  loadTimelineAction,
  updateAttendanceAction,
  uploadPhotosAction,
  voidAttendanceAction,
} from '../actions'

/**
 * A linha do tempo do pet (MOD-PRONT-02).
 *
 * Uma coluna só, do mais recente para o mais antigo, misturando origens que hoje
 * moram em abas diferentes — atendimento, pesagem, alergia, temperamento, foto,
 * transferência. O ganho é a leitura em sequência: "engordou 2 kg, ficou reativo no
 * secador, o tutor mudou" é uma história que só aparece quando as três coisas estão
 * na mesma coluna.
 *
 * **O que chega aqui já veio filtrado pelo servidor** (AC-02). Quem não tem
 * `record:read` recebe menos eventos e menos detalhe dentro de cada um — não há
 * nada a esconder no cliente, e não deve haver: esconder na UI seria mandar o dado
 * clínico para o navegador do banhista e pedir que ele não olhasse.
 */

interface Props {
  petId: string
  page: TimelinePage
  /** `record:void` — anular estorna o débito, e é só do administrador. */
  canVoid: boolean
  /** `record:write_notes` — corrigir e adendar. */
  canWrite: boolean
  /** O álbum inteiro; o detalhe recorta o que está preso a cada atendimento. */
  photos: PetPhoto[]
  /** `pet:upload_photo` — a foto de antes e depois (MOD-PRONT-10). */
  canUploadPhoto: boolean
}

const KIND_LABEL: Record<TimelineKind, string> = {
  ATTENDANCE: 'Atendimento',
  WEIGHT: 'Pesagem',
  ALLERGY: 'Alergia',
  TEMPERAMENT: 'Temperamento',
  MEDICAL_ALERT: 'Alerta médico',
  PHOTO: 'Foto',
  TRANSFER: 'Titularidade',
}

/** A mesma família de cor que o módulo tem no resto do sistema. */
const KIND_TONE: Record<TimelineKind, string> = {
  ATTENDANCE: 'icon-time',
  WEIGHT: 'icon-pet',
  ALLERGY: 'icon-health',
  TEMPERAMENT: 'icon-health',
  MEDICAL_ALERT: 'icon-health',
  PHOTO: 'icon-brand',
  TRANSFER: 'icon-people',
}

function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  })
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

export function TimelineTab({ petId, page, canVoid, canWrite, photos, canUploadPhoto }: Props) {
  const [entries, setEntries] = useState(page.entries)
  const [cursor, setCursor] = useState(page.nextCursor)
  const [carregando, startCarga] = useTransition()
  const [aberto, setAberto] = useState<string | null>(null)

  function carregarMais() {
    if (!cursor) return
    startCarga(async () => {
      const next = await loadTimelineAction(petId, cursor)
      setEntries((current) => [...current, ...next.entries])
      setCursor(next.nextCursor)
    })
  }

  if (entries.length === 0) {
    return (
      <EmptyState
        title="Nada registrado ainda"
        description="O histórico começa no primeiro atendimento concluído. Pesagens, alergias e fotos entram aqui junto."
      />
    )
  }

  return (
    <div className="space-y-4">
      <ol className="space-y-2">
        {entries.map((entry, index) => {
          const primeiroDoDia =
            index === 0 ||
            dayLabel(entries[index - 1]!.occurredAt) !== dayLabel(entry.occurredAt)

          return (
            <li key={`${entry.kind}-${entry.id}`}>
              {primeiroDoDia && (
                <p className={`hint mb-1.5 ${index === 0 ? '' : 'mt-5'}`}>
                  {dayLabel(entry.occurredAt)}
                </p>
              )}
              <TimelineCard
                entry={entry}
                petId={petId}
                canVoid={canVoid}
                canWrite={canWrite}
                photos={photos}
                canUploadPhoto={canUploadPhoto}
                expanded={aberto === entry.id}
                onToggle={() => setAberto((current) => (current === entry.id ? null : entry.id))}
              />
            </li>
          )
        })}
      </ol>

      {cursor && (
        <button
          type="button"
          className="btn btn-ghost w-full"
          disabled={carregando}
          onClick={carregarMais}
        >
          {carregando ? 'Carregando…' : 'Carregar mais'}
        </button>
      )}
    </div>
  )
}

function TimelineCard({
  entry,
  petId,
  canVoid,
  canWrite,
  photos,
  canUploadPhoto,
  expanded,
  onToggle,
}: {
  entry: TimelineEntry
  petId: string
  canVoid: boolean
  canWrite: boolean
  photos: PetPhoto[]
  canUploadPhoto: boolean
  expanded: boolean
  onToggle: () => void
}) {
  const anulado = entry.status === 'VOIDED'
  const clicavel = entry.kind === 'ATTENDANCE'
  const adendos = Number(entry.meta.addendumCount ?? 0)

  return (
    <div className={`card px-4 py-3 ${anulado ? 'opacity-60' : ''}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {/* A pílula usa as variáveis que a classe de tom declara (§Tom do ícone
                de `globals.css`) — a mesma família de cor que o módulo tem no menu. */}
            <span
              className={`${KIND_TONE[entry.kind]} rounded-full px-2 py-0.5 text-xs font-medium`}
              style={{ color: 'var(--icon)', backgroundColor: 'var(--icon-soft)' }}
            >
              {KIND_LABEL[entry.kind]}
            </span>
            <span className={`font-medium ${anulado ? 'line-through' : ''}`}>{entry.title}</span>
            {entry.severity && (
              <Badge tone={entry.severity === 'CRITICAL' ? 'danger' : 'neutral'}>
                {SEVERITY_LABELS[entry.severity]}
              </Badge>
            )}
            {anulado && <Badge tone="danger">Anulado</Badge>}
            {adendos > 0 && <Badge>{adendos === 1 ? '1 adendo' : `${adendos} adendos`}</Badge>}
          </div>

          {entry.detail && <p className="hint mt-1">{entry.detail}</p>}

          {anulado && typeof entry.meta.voidReason === 'string' && (
            <p className="hint mt-1">Motivo: {entry.meta.voidReason}</p>
          )}
        </div>

        <span className="hint shrink-0">{timeLabel(entry.occurredAt)}</span>
      </div>

      {clicavel && (
        <button
          type="button"
          className="mt-2 text-sm underline decoration-line underline-offset-4 hover:decoration-fg"
          onClick={onToggle}
        >
          {expanded ? 'Fechar' : 'Ver atendimento'}
        </button>
      )}

      {expanded && clicavel && (
        <AttendanceDetail
          attendanceId={entry.id}
          petId={petId}
          canVoid={canVoid && !anulado}
          canWrite={canWrite && !anulado}
          photos={photos.filter((photo) => photo.attendanceId === entry.id)}
          canUploadPhoto={canUploadPhoto && !anulado}
        />
      )}
    </div>
  )
}

/**
 * O detalhe do atendimento, carregado sob demanda.
 *
 * A tela decide entre **corrigir** e **adendar** a partir do `editable` que o servidor
 * calcula — e não da data que ela mesma poderia comparar. A janela pode fechar
 * enquanto a aba está aberta, e a autoridade sobre isso é de quem vai recusar a
 * escrita, não de quem a propõe.
 */
function AttendanceDetail({
  attendanceId,
  petId,
  canVoid,
  canWrite,
  photos,
  canUploadPhoto,
}: {
  attendanceId: string
  petId: string
  canVoid: boolean
  canWrite: boolean
  photos: PetPhoto[]
  canUploadPhoto: boolean
}) {
  const router = useRouter()
  const [attendance, setAttendance] = useState<Attendance | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [texto, setTexto] = useState('')
  const [motivo, setMotivo] = useState('')
  const [anulando, setAnulando] = useState(false)
  const [carregando, startCarga] = useTransition()
  const [salvando, startSalvar] = useTransition()

  if (!attendance && !carregando && !erro) {
    startCarga(async () => {
      const result = await getAttendanceAction(attendanceId)
      if (result.ok) {
        setAttendance(result.data)
        setTexto(result.data.observations ?? '')
      } else setErro(result.message)
    })
  }

  if (carregando && !attendance) return <p className="hint mt-3">Carregando…</p>
  if (!attendance) return <FormError message={erro} />

  function salvar() {
    if (!attendance) return
    setErro(null)
    startSalvar(async () => {
      const result = attendance.editable
        ? await updateAttendanceAction(petId, attendance.id, texto)
        : await addAddendumAction(petId, attendance.id, texto)

      if (result.ok) {
        setAttendance(result.data)
        if (!attendance.editable) setTexto('')
        router.refresh()
      } else setErro(result.message)
    })
  }

  function anular() {
    if (!attendance) return
    setErro(null)
    startSalvar(async () => {
      const result = await voidAttendanceAction(petId, attendance.id, motivo)
      if (result.ok) {
        setAttendance(result.data)
        setAnulando(false)
        router.refresh()
      } else setErro(result.message)
    })
  }

  return (
    <div className="mt-3 space-y-3 border-t border-line pt-3">
      <dl className="space-y-1 text-sm">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="hint">Situação</dt>
          <dd>{ATTENDANCE_STATUS_LABELS[attendance.status]}</dd>
        </div>
        {attendance.weightKg !== null && (
          <div className="flex items-baseline justify-between gap-3">
            <dt className="hint">Peso aferido</dt>
            <dd>{attendance.weightKg.toFixed(2).replace('.', ',')} kg</dd>
          </div>
        )}
      </dl>

      <ul className="space-y-1 text-sm">
        {attendance.items.map((item) => (
          <li key={item.id} className="flex items-baseline justify-between gap-3">
            <span>{item.label}</span>
            {item.notes && <span className="hint">{item.notes}</span>}
          </li>
        ))}
      </ul>

      {attendance.observations && (
        <p className="text-sm">{attendance.observations}</p>
      )}

      <BeforeAfter
        petId={petId}
        attendanceId={attendance.id}
        photos={photos}
        canUpload={canUploadPhoto}
      />

      {attendance.notes.length > 0 && (
        <ol className="space-y-2 border-l-2 border-line pl-3">
          {attendance.notes.map((note) => (
            <li key={note.id}>
              <p className="hint">
                {note.kind === 'ADDENDUM' ? `Adendo · v${note.version}` : 'Observação da execução'}
                {' · '}
                {new Date(note.createdAt).toLocaleDateString('pt-BR')}
              </p>
              <p className="text-sm">{note.body}</p>
            </li>
          ))}
        </ol>
      )}

      {canWrite && (
        <Field
          label={attendance.editable ? 'Corrigir a observação' : 'Adicionar um adendo'}
          htmlFor={`nota-${attendance.id}`}
          hint={
            attendance.editable
              ? 'A janela de correção direta dura 24h a partir do fim do atendimento.'
              : 'Passadas as 24h o registro não é reescrito — a correção entra como adendo, embaixo do original.'
          }
        >
          <textarea
            id={`nota-${attendance.id}`}
            className="field min-h-20"
            value={texto}
            onChange={(event) => setTexto(event.target.value)}
          />
        </Field>
      )}

      <FormError message={erro} />

      <div className="flex flex-wrap gap-2">
        {canWrite && (
          <button type="button" className="btn btn-ghost" disabled={salvando} onClick={salvar}>
            {attendance.editable ? 'Salvar correção' : 'Adicionar adendo'}
          </button>
        )}

        {canVoid && !anulando && (
          <button
            type="button"
            className="btn btn-ghost text-danger"
            onClick={() => setAnulando(true)}
          >
            Anular atendimento
          </button>
        )}
      </div>

      {anulando && (
        <div className="space-y-2 rounded-xl border border-danger/40 bg-danger-soft px-3 py-3">
          <p className="text-sm font-medium">Anular este atendimento</p>
          <p className="hint">
            O registro não é apagado: fica riscado no histórico, e o débito
            correspondente é estornado na conta do tutor.
          </p>
          <textarea
            className="field min-h-16"
            placeholder="Por que este registro está errado?"
            value={motivo}
            onChange={(event) => setMotivo(event.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-accent" disabled={salvando} onClick={anular}>
              Confirmar anulação
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={salvando}
              onClick={() => setAnulando(false)}
            >
              Voltar
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * A foto de antes e depois (MOD-PRONT-10).
 *
 * Duas casas fixas, e não uma galeria: o par existe para ser **comparado**, e uma
 * lista solta de seis fotos de um banho não responde à pergunta que o tutor faz. O
 * arquivo continua sendo do álbum do pet — o que a fase acrescenta é a que momento
 * do atendimento ele pertence.
 */
function BeforeAfter({
  petId,
  attendanceId,
  photos,
  canUpload,
}: {
  petId: string
  attendanceId: string
  photos: PetPhoto[]
  canUpload: boolean
}) {
  const router = useRouter()
  const [erro, setErro] = useState<string | null>(null)
  const [enviando, startEnvio] = useTransition()

  const antes = photos.find((photo) => photo.attendancePhase === 'BEFORE')
  const depois = photos.find((photo) => photo.attendancePhase === 'AFTER')

  if (!canUpload && !antes && !depois) return null

  function enviar(phase: 'BEFORE' | 'AFTER', input: HTMLInputElement) {
    const file = input.files?.[0]
    if (!file) return
    setErro(null)

    const form = new FormData()
    form.append('files', file)
    form.append('attendanceId', attendanceId)
    form.append('attendancePhase', phase)
    form.append('source', 'GROOMING_RESULT')

    startEnvio(async () => {
      const result = await uploadPhotosAction(petId, form)
      // Limpo de qualquer jeito: senão escolher o mesmo arquivo depois de um erro
      // não dispararia `change` de novo.
      input.value = ''
      if (result.ok) router.refresh()
      else setErro(result.message)
    })
  }

  return (
    <div>
      <p className="hint mb-1.5">Antes e depois</p>
      <div className="grid grid-cols-2 gap-2">
        {(['BEFORE', 'AFTER'] as const).map((phase) => {
          const photo = phase === 'BEFORE' ? antes : depois
          const label = phase === 'BEFORE' ? 'Antes' : 'Depois'

          return (
            <div key={phase} className="space-y-1">
              {photo ? (
                // `<img>` e não `next/image`: a URL é assinada e vence em 15 minutos,
                // e o otimizador cacheia por URL — serviria endereço morto.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={photo.urls.medium}
                  alt={`${label} do atendimento`}
                  className="aspect-square w-full rounded-xl object-cover"
                />
              ) : (
                <div className="flex aspect-square w-full items-center justify-center rounded-xl border border-dashed border-line">
                  <span className="hint">{label}</span>
                </div>
              )}

              {canUpload && !photo && (
                <label className="btn btn-ghost w-full cursor-pointer text-sm">
                  {enviando ? 'Enviando…' : `Enviar ${label.toLowerCase()}`}
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    disabled={enviando}
                    onChange={(event) => enviar(phase, event.currentTarget)}
                  />
                </label>
              )}
            </div>
          )
        })}
      </div>
      <FormError message={erro} />
    </div>
  )
}
