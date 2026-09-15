'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  ATTENDANCE_STATUS_LABELS,
  PRESCRIBABLE_ATTENDANCE_TYPES,
  SEVERITY_LABELS,
  type Attendance,
  type PetPhoto,
  type PrescriptionItem,
  type PrescriptionView,
  type TimelineEntry,
  type TimelineKind,
  type TimelinePage,
} from '@petshop/shared-types'
import { Badge, Button, EmptyState, Field, FormError } from '@/components/ui'
import { HeartPulseIcon } from '@/components/icons'
import { Modal } from '@/components/modal'
import {
  addAddendumAction,
  createPrescriptionAction,
  getAttendanceAction,
  getPrescriptionAction,
  listAttendancePrescriptionsAction,
  loadTimelineAction,
  updateAttendanceAction,
  uploadPhotosAction,
  voidAttendanceAction,
  voidPrescriptionAction,
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
  /** Linha de contexto do diálogo de receituário: de qual animal se está prescrevendo. */
  petName: string
  page: TimelinePage
  /** `record:void` — anular estorna o débito, e é só do administrador. */
  canVoid: boolean
  /** `record:write_notes` — corrigir e adendar. */
  canWrite: boolean
  /**
   * `record:write` — o pedido de emissão. O gate que decide de verdade é o CRMV do
   * profissional ligado ao usuário, e ele só existe no servidor: a tela oferece o
   * caminho, e a recusa vem com a mensagem que diz onde cadastrar o registro.
   */
  canPrescribe: boolean
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

export function TimelineTab({
  petId,
  petName,
  page,
  canVoid,
  canWrite,
  canPrescribe,
  photos,
  canUploadPhoto,
}: Props) {
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
            index === 0 || dayLabel(entries[index - 1]!.occurredAt) !== dayLabel(entry.occurredAt)

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
                petName={petName}
                canVoid={canVoid}
                canWrite={canWrite}
                canPrescribe={canPrescribe}
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
        <Button
          type="button"
          className="w-full"
          busy={carregando}
          onClick={carregarMais}
          busyLabel="Carregando…"
        >
          Carregar mais
        </Button>
      )}
    </div>
  )
}

function TimelineCard({
  entry,
  petId,
  petName,
  canVoid,
  canWrite,
  canPrescribe,
  photos,
  canUploadPhoto,
  expanded,
  onToggle,
}: {
  entry: TimelineEntry
  petId: string
  petName: string
  canVoid: boolean
  canWrite: boolean
  canPrescribe: boolean
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
          petName={petName}
          canVoid={canVoid && !anulado}
          canWrite={canWrite && !anulado}
          canPrescribe={canPrescribe && !anulado}
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
  petName,
  canVoid,
  canWrite,
  canPrescribe,
  photos,
  canUploadPhoto,
}: {
  attendanceId: string
  petId: string
  petName: string
  canVoid: boolean
  canWrite: boolean
  canPrescribe: boolean
  photos: PetPhoto[]
  canUploadPhoto: boolean
}) {
  const router = useRouter()
  const [attendance, setAttendance] = useState<Attendance | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [texto, setTexto] = useState('')
  const [motivo, setMotivo] = useState('')
  const [anulando, setAnulando] = useState(false)
  const [salvando, startSalvar] = useTransition()

  // A busca precisa nascer de um efeito, e não do corpo do componente: disparada
  // durante a renderização ela é uma atualização de estado no meio do render, que o
  // React descarta — o painel abria e ficava em branco para sempre.
  useEffect(() => {
    let ativo = true
    void getAttendanceAction(attendanceId).then((result) => {
      if (!ativo) return
      if (result.ok) {
        setAttendance(result.data)
        setTexto(result.data.observations ?? '')
      } else setErro(result.message)
    })
    return () => {
      ativo = false
    }
  }, [attendanceId])

  if (!attendance) {
    return erro ? (
      <div className="mt-3">
        <FormError message={erro} />
      </div>
    ) : (
      <p className="hint mt-3">Carregando…</p>
    )
  }

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

      {attendance.observations && <p className="text-sm">{attendance.observations}</p>}

      <BeforeAfter
        petId={petId}
        attendanceId={attendance.id}
        photos={photos}
        canUpload={canUploadPhoto}
      />

      {(PRESCRIBABLE_ATTENDANCE_TYPES as readonly string[]).includes(attendance.type) && (
        <Prescriptions
          petId={petId}
          petName={petName}
          attendanceId={attendance.id}
          canPrescribe={canPrescribe}
          canVoid={canVoid}
        />
      )}

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
          <Button type="button" busy={salvando} onClick={salvar} busyLabel="Salvando…">
            {attendance.editable ? 'Salvar correção' : 'Adicionar adendo'}
          </Button>
        )}

        {canVoid && !anulando && (
          <Button type="button" onClick={() => setAnulando(true)}>
            Anular atendimento
          </Button>
        )}
      </div>

      {anulando && (
        <div className="space-y-2 rounded-xl border border-danger/40 bg-danger-soft px-3 py-3">
          <p className="text-sm font-medium">Anular este atendimento</p>
          <p className="hint">
            O registro não é apagado: fica riscado no histórico, e o débito correspondente é
            estornado na conta do tutor.
          </p>
          <textarea
            className="field min-h-16"
            placeholder="Por que este registro está errado?"
            value={motivo}
            onChange={(event) => setMotivo(event.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="accent"
              busy={salvando}
              onClick={anular}
              busyLabel="Anulando…"
            >
              Confirmar anulação
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={salvando}
              onClick={() => setAnulando(false)}
            >
              Voltar
            </Button>
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
                <label className="btn btn-primary w-full cursor-pointer text-sm">
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

/**
 * O receituário do atendimento (MOD-DOC-04).
 *
 * Aparece só em atendimento veterinário, e por baixo do registro clínico — porque é
 * consequência dele: primeiro se anota o que se viu, depois se prescreve.
 *
 * Três coisas que a tela precisa dizer e não são óbvias:
 *
 * - **não há editar.** Receituário emitido é papel entregue, e a única correção é
 *   anular e emitir outro. O botão de anular fica ao lado do documento, e não escondido;
 * - **o PDF pode não estar pronto.** O arquivo nasce fora da transação, então a lista
 *   mostra "em preparo" em vez de um link morto;
 * - **abrir é baixar.** O endereço do arquivo só é pedido no clique — é essa chamada que
 *   entra na trilha de acesso ao documento.
 */
function Prescriptions({
  petId,
  petName,
  attendanceId,
  canPrescribe,
  canVoid,
}: {
  petId: string
  petName: string
  attendanceId: string
  canPrescribe: boolean
  canVoid: boolean
}) {
  const [prescriptions, setPrescriptions] = useState<PrescriptionView[] | null>(null)
  const [emitindo, setEmitindo] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [pendente, startTransicao] = useTransition()

  useEffect(() => {
    let ativo = true
    void listAttendancePrescriptionsAction(attendanceId).then((lista) => {
      if (ativo) setPrescriptions(lista)
    })
    return () => {
      ativo = false
    }
  }, [attendanceId])

  if (prescriptions === null) return <p className="hint">Carregando receituários…</p>

  function abrir(id: string) {
    setErro(null)
    startTransicao(async () => {
      const result = await getPrescriptionAction(id)
      if (!result.ok) {
        setErro(result.message)
        return
      }
      setPrescriptions((atual) =>
        (atual ?? []).map((item) => (item.id === id ? result.data : item)),
      )
      if (result.data.url) window.open(result.data.url, '_blank', 'noopener')
      else setErro('O arquivo ainda está sendo gerado. Tente de novo em instantes.')
    })
  }

  function anular(id: string, reason: string) {
    setErro(null)
    startTransicao(async () => {
      const result = await voidPrescriptionAction(petId, id, reason)
      if (result.ok) {
        setPrescriptions((atual) =>
          (atual ?? []).map((item) => (item.id === id ? result.data : item)),
        )
      } else setErro(result.message)
    })
  }

  return (
    <div className="space-y-2 border-t border-line pt-3">
      <p className="hint">Receituário</p>

      {prescriptions.length === 0 && (
        <p className="hint">Nenhum receituário emitido neste atendimento.</p>
      )}

      <ul className="space-y-2">
        {prescriptions.map((prescription) => (
          <PrescriptionRow
            key={prescription.id}
            prescription={prescription}
            canVoid={canVoid}
            pendente={pendente}
            onOpen={() => abrir(prescription.id)}
            onVoid={(reason) => anular(prescription.id, reason)}
          />
        ))}
      </ul>

      <FormError message={erro} />

      {canPrescribe && (
        <Button type="button" onClick={() => setEmitindo(true)}>
          Emitir receituário
        </Button>
      )}

      {emitindo && (
        <PrescriptionForm
          petId={petId}
          petName={petName}
          attendanceId={attendanceId}
          onCancel={() => setEmitindo(false)}
          onIssued={(prescription) => {
            setPrescriptions((atual) => [prescription, ...(atual ?? [])])
            setEmitindo(false)
          }}
        />
      )}
    </div>
  )
}

function PrescriptionRow({
  prescription,
  canVoid,
  pendente,
  onOpen,
  onVoid,
}: {
  prescription: PrescriptionView
  canVoid: boolean
  pendente: boolean
  onOpen: () => void
  onVoid: (reason: string) => void
}) {
  const [anulando, setAnulando] = useState(false)
  const [motivo, setMotivo] = useState('')
  const anulado = prescription.voidedAt !== null

  return (
    <li className={`rounded-xl border border-line px-3 py-2 ${anulado ? 'opacity-60' : ''}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className={`font-medium ${anulado ? 'line-through' : ''}`}>
          {prescription.number || 'Sem número'}
        </span>
        <span className="hint">
          {prescription.vetName} · CRMV {prescription.crmv}
        </span>
      </div>

      <ul className="hint mt-1 space-y-0.5">
        {prescription.items.map((item, index) => (
          <li key={`${item.drug}-${index}`}>
            {item.drug}
            {item.concentration ? ` ${item.concentration}` : ''} — {item.dosage} · {item.frequency}{' '}
            · {item.durationDays} {item.durationDays === 1 ? 'dia' : 'dias'}
          </li>
        ))}
      </ul>

      {anulado && prescription.voidReason && (
        <p className="hint mt-1">Anulado: {prescription.voidReason}</p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-3">
        {/* Depois de pedido, o endereço vira **link** e não botão: o `window.open` do
            `onOpen` acontece depois de um `await`, e o navegador pode bloqueá-lo como
            janela não pedida pelo usuário. O link é a saída quando isso acontece — é o
            mesmo par que o recibo usa na ficha do tutor. */}
        {prescription.url ? (
          <a
            href={prescription.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm underline decoration-line underline-offset-4 hover:decoration-fg"
          >
            Abrir PDF
          </a>
        ) : prescription.documentStatus === 'ISSUED' ? (
          <button
            type="button"
            className="text-sm underline decoration-line underline-offset-4 hover:decoration-fg"
            disabled={pendente}
            onClick={onOpen}
          >
            {pendente ? 'Buscando…' : 'Abrir PDF'}
          </button>
        ) : (
          <span className="hint">
            {prescription.documentStatus === 'FAILED'
              ? 'O arquivo não pôde ser gerado'
              : 'Arquivo em preparo'}
          </span>
        )}

        {canVoid && !anulado && !anulando && (
          <button
            type="button"
            className="text-sm text-danger underline decoration-line underline-offset-4"
            onClick={() => setAnulando(true)}
          >
            Anular
          </button>
        )}
      </div>

      {anulando && (
        <div className="mt-2 space-y-2 rounded-xl border border-danger/40 bg-danger-soft px-3 py-3">
          <p className="hint">
            O receituário continua no histórico, riscado e com o motivo. O tutor pode já ter levado
            o papel — anular não o traz de volta.
          </p>
          <textarea
            className="field min-h-16"
            placeholder="Por que este receituário está errado?"
            value={motivo}
            onChange={(event) => setMotivo(event.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="accent"
              busy={pendente}
              disabled={motivo.trim().length < 5}
              onClick={() => onVoid(motivo.trim())}
              busyLabel="Anulando…"
            >
              Confirmar anulação
            </Button>
            <Button type="button" variant="ghost" onClick={() => setAnulando(false)}>
              Voltar
            </Button>
          </div>
        </div>
      )}
    </li>
  )
}

interface ItemDraft extends PrescriptionItem {
  key: string
}

function novoItem(): ItemDraft {
  return { key: crypto.randomUUID(), drug: '', dosage: '', frequency: '', durationDays: 7 }
}

/**
 * O formulário de emissão.
 *
 * É `<Modal>`, e não um painel dentro do cartão: o formulário responde a **uma linha da
 * lista** — este atendimento —, e é a regra 8 de `docs/design-formularios.md`. Aberto no
 * cartão, ele ficaria espremido na largura de uma coluna e empurraria a linha do tempo
 * inteira para baixo, que foi exatamente o que aquela regra veio corrigir.
 *
 * Os itens são linhas estruturadas, e não um campo de texto, porque é o que permite ao
 * papel sair legível e ao sistema responder um dia "o que este pet já tomou". Um
 * receituário digitado como parágrafo é ilegível na farmácia e opaco para o histórico.
 */
function PrescriptionForm({
  petId,
  petName,
  attendanceId,
  onCancel,
  onIssued,
}: {
  petId: string
  petName: string
  attendanceId: string
  onCancel: () => void
  onIssued: (prescription: PrescriptionView) => void
}) {
  const [items, setItems] = useState<ItemDraft[]>(() => [novoItem()])
  const [instructions, setInstructions] = useState('')
  const [erro, setErro] = useState<string | null>(null)
  const [salvando, startSalvar] = useTransition()

  const incompleto = items.some(
    (item) => item.drug.trim().length < 2 || !item.dosage.trim() || !item.frequency.trim(),
  )

  function atualizar(key: string, patch: Partial<PrescriptionItem>) {
    setItems((atual) => atual.map((item) => (item.key === key ? { ...item, ...patch } : item)))
  }

  function emitir() {
    setErro(null)
    startSalvar(async () => {
      const result = await createPrescriptionAction(petId, attendanceId, {
        // Campo a campo, e não `...rest`: o `key` do rascunho é da tela, e o schema do
        // servidor é `strictObject` — mandá-lo junto derrubaria a emissão inteira.
        items: items.map((item) => ({
          drug: item.drug.trim(),
          dosage: item.dosage.trim(),
          frequency: item.frequency.trim(),
          durationDays: item.durationDays,
          ...(item.concentration?.trim() ? { concentration: item.concentration.trim() } : {}),
        })),
        ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
      })

      if (result.ok) onIssued(result.data)
      else setErro(result.message)
    })
  }

  return (
    <Modal
      open
      onClose={onCancel}
      busy={salvando}
      icon={<HeartPulseIcon />}
      tone="icon-health"
      eyebrow="Receituário"
      title={`Prescrever para ${petName}`}
      subtitle="Sai com o seu nome e o seu CRMV, e não pode ser editado depois de emitido — a correção é anular e emitir outro."
      footer={
        <>
          <Button type="button" variant="ghost" disabled={salvando} onClick={onCancel}>
            Cancelar
          </Button>
          <Button
            type="button"
            busy={salvando}
            disabled={incompleto}
            onClick={emitir}
            busyLabel="Emitindo…"
          >
            Emitir receituário
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <FormError message={erro} />

        {items.map((item, index) => (
          <fieldset key={item.key}>
            <div className="mb-2 flex items-baseline justify-between">
              <legend className="label">Medicamento {index + 1}</legend>
              {items.length > 1 && (
                <button
                  type="button"
                  className="hint underline decoration-line underline-offset-4"
                  onClick={() => setItems((atual) => atual.filter((row) => row.key !== item.key))}
                >
                  Remover
                </button>
              )}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Princípio ativo" htmlFor={`drug-${item.key}`}>
                <input
                  id={`drug-${item.key}`}
                  className="field"
                  maxLength={120}
                  value={item.drug}
                  onChange={(event) => atualizar(item.key, { drug: event.target.value })}
                />
              </Field>

              <Field label="Concentração" htmlFor={`conc-${item.key}`} hint="Opcional.">
                <input
                  id={`conc-${item.key}`}
                  className="field"
                  maxLength={60}
                  placeholder="50 mg/mL"
                  value={item.concentration ?? ''}
                  onChange={(event) => atualizar(item.key, { concentration: event.target.value })}
                />
              </Field>

              <Field label="Dose" htmlFor={`dose-${item.key}`}>
                <input
                  id={`dose-${item.key}`}
                  className="field"
                  maxLength={120}
                  placeholder="1 comprimido"
                  value={item.dosage}
                  onChange={(event) => atualizar(item.key, { dosage: event.target.value })}
                />
              </Field>

              <Field label="Frequência" htmlFor={`freq-${item.key}`}>
                <input
                  id={`freq-${item.key}`}
                  className="field"
                  maxLength={120}
                  placeholder="a cada 12 horas"
                  value={item.frequency}
                  onChange={(event) => atualizar(item.key, { frequency: event.target.value })}
                />
              </Field>

              <Field label="Duração (dias)" htmlFor={`dur-${item.key}`}>
                <input
                  id={`dur-${item.key}`}
                  type="number"
                  className="field w-28"
                  min={1}
                  max={365}
                  value={item.durationDays}
                  onChange={(event) =>
                    atualizar(item.key, {
                      durationDays: Math.max(1, Number(event.target.value) || 1),
                    })
                  }
                />
              </Field>
            </div>
          </fieldset>
        ))}

        {items.length < 20 && (
          <div>
            <Button type="button" onClick={() => setItems((atual) => [...atual, novoItem()])}>
              Adicionar medicamento
            </Button>
          </div>
        )}

        <Field
          label="Orientações ao tutor"
          htmlFor={`orientacoes-${attendanceId}`}
          hint="O que vai impresso embaixo da prescrição. Quem lê é quem dá o remédio em casa."
        >
          <textarea
            id={`orientacoes-${attendanceId}`}
            className="field min-h-20"
            maxLength={2000}
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
          />
        </Field>
      </div>
    </Modal>
  )
}
