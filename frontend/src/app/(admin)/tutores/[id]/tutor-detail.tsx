'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  TERM_KIND_LABELS,
  type ConsentChannel,
  type ConsentsResponse,
  type PetResponse,
  type Tag,
  type TermKind,
  type TermVersionView,
  type TutorOverview,
} from '@petshop/shared-types'
import type {
  LedgerAccount,
  PackagePurchase,
  PaginatedMessages,
  ServicePackage,
  Statement,
} from '@petshop/shared-types'
import { PetAvatar } from '@/components/pet-avatar'
import { Modal } from '@/components/modal'
import { DocumentIcon } from '@/components/icons'
import { Alert, Badge, Button, Card, DataRow, FormError, Tabs } from '@/components/ui'
import { TextoDoTermo } from '@/components/term-text'
import { ButtonLink } from '@/components/links'
import { ComunicacaoTab } from './comunicacao-tab'
import { FinanceiroTab } from './financeiro-tab'
import {
  acceptTermAction,
  anonymizeTutorAction,
  assignTagAction,
  deleteTutorAction,
  getCurrentTermAction,
  getTutorDocumentAction,
  reactivateTutorAction,
  removeTagAction,
  updateConsentsAction,
} from '../actions'

/**
 * Detalhe do tutor em abas.
 *
 * Pets e financeiro são compostos **pela página**, não pela visão 360º do
 * tutor-service: um vem do pet-service, o outro do billing-ledger-service, e nenhum
 * dos dois é dado que o serviço de tutores deva ler de tabela alheia.
 *
 * O `PendingTab` que anunciava "chega com o MOD-LEDGER" saiu junto com a chegada do
 * módulo — era o último uso dele.
 */

/** O que a página carregou do billing-ledger-service para a aba Financeiro. */
export interface FinanceData {
  account: LedgerAccount
  statement: Statement
  packages: PackagePurchase[]
  catalog: ServicePackage[]
  can: { read: boolean; create: boolean; refund: boolean; credit: boolean }
}

/** O que a página carregou do messaging-service para a aba Mensagens. */
export interface CommsData {
  messages: PaginatedMessages
  /** `crm:send` — quem pode reenviar uma mensagem morta. */
  canSend: boolean
}

interface Props {
  overview: TutorOverview
  consents: ConsentsResponse
  tags: Tag[]
  pets: PetResponse[]
  finance: FinanceData | null
  comms: CommsData | null
}

export function TutorDetailView({ overview, consents, tags, pets, finance, comms }: Props) {
  const tutor = overview.tutor
  const [tab, setTab] = useState('dados')

  return (
    <div className="space-y-5">
      <Tabs
        tabs={[
          { id: 'dados', label: 'Dados' },
          { id: 'enderecos', label: `Endereços (${tutor.addresses.length})` },
          { id: 'consentimentos', label: 'Consentimento' },
          { id: 'tags', label: 'Tags' },
          { id: 'pets', label: `Pets (${pets.length})` },
          // A aba só existe para quem pode ver o financeiro (§9). Escondê-la é mais
          // honesto que abri-la para um 403.
          ...(finance ? [{ id: 'financeiro', label: 'Financeiro' }] : []),
          // Última porque é consulta, não operação: o balcão vem aqui responder "o
          // lembrete chegou?", e não é por onde a ficha começa a ser lida.
          ...(comms ? [{ id: 'mensagens', label: 'Mensagens' }] : []),
        ]}
        active={tab}
        onSelect={setTab}
      />

      {tab === 'dados' && <DadosTab overview={overview} />}
      {tab === 'enderecos' && <EnderecosTab overview={overview} />}
      {tab === 'consentimentos' && <ConsentimentosTab tutorId={tutor.id} consents={consents} />}
      {tab === 'tags' && <TagsTab tutorId={tutor.id} tutorTags={tutor.tags} allTags={tags} />}
      {tab === 'pets' && <PetsTab tutorId={tutor.id} pets={pets} />}
      {tab === 'mensagens' && comms && (
        <ComunicacaoTab tutorId={tutor.id} initial={comms.messages} canSend={comms.canSend} />
      )}
      {tab === 'financeiro' && finance && (
        <FinanceiroTab
          tutorId={tutor.id}
          account={finance.account}
          statement={finance.statement}
          packages={finance.packages}
          catalog={finance.catalog}
          pets={pets}
          can={finance.can}
        />
      )}
    </div>
  )
}

// ─── Dados ───────────────────────────────────────────────────────────────────

function DadosTab({ overview }: { overview: TutorOverview }) {
  const tutor = overview.tutor
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [anonymizing, setAnonymizing] = useState(false)
  const [reason, setReason] = useState('')

  const isTerminal = tutor.status === 'MERGED' || tutor.status === 'ANONYMIZED'

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

      <Card>
        <dl>
          <DataRow label="Tipo">
            {tutor.personType === 'PF' ? 'Pessoa física' : 'Pessoa jurídica'}
          </DataRow>
          <DataRow label="Nome civil">{tutor.fullName}</DataRow>
          {tutor.legalName && <DataRow label="Razão social">{tutor.legalName}</DataRow>}
          <DataRow label={tutor.personType === 'PF' ? 'CPF' : 'CNPJ'}>
            {tutor.cpfMasked ?? tutor.cnpjMasked ?? '—'}
          </DataRow>
          <DataRow label="Telefone">{tutor.phoneMasked}</DataRow>
          {tutor.phoneAltMasked && (
            <DataRow label="Telefone secundário">{tutor.phoneAltMasked}</DataRow>
          )}
          <DataRow label="E-mail">{tutor.email ?? '—'}</DataRow>
          <DataRow label="Nascimento">
            {tutor.birthDate ? formatDate(tutor.birthDate) : '—'}
          </DataRow>
          <DataRow label="Último atendimento">
            {tutor.lastAttendanceAt ? formatDate(tutor.lastAttendanceAt) : 'Nenhum ainda'}
          </DataRow>
          <DataRow label="Saldo">
            <span className={tutor.balance < 0 ? 'text-danger' : undefined}>
              {tutor.balance.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
            </span>
          </DataRow>
        </dl>
      </Card>

      {tutor.notes && (
        <Card>
          <h3 className="font-semibold">Observações</h3>
          <p className="hint mt-2 whitespace-pre-wrap">{tutor.notes}</p>
        </Card>
      )}

      {!isTerminal && (
        <div className="flex flex-wrap items-center gap-3">
          <ButtonLink href={`/tutores/${tutor.id}/editar`}>Editar</ButtonLink>

          {tutor.status === 'INACTIVE' && (
            <Button
              type="button"
              variant="ghost"
              busy={pending}
              onClick={() => run(() => reactivateTutorAction(tutor.id))}
              busyLabel="Reativando…"
            >
              Reativar cadastro
            </Button>
          )}

          <Button
            type="button"
            variant="ghost"
            className="text-danger"
            busy={pending}
            onClick={() => run(() => deleteTutorAction(tutor.id))}
            busyLabel="Excluindo…"
          >
            Excluir
          </Button>

          <Button
            type="button"
            variant="ghost"
            className="text-danger"
            onClick={() => setAnonymizing((value) => !value)}
          >
            Anonimizar (LGPD)
          </Button>
        </div>
      )}

      {anonymizing && (
        <Card className="space-y-3 border border-danger/20">
          <h3 className="font-semibold text-danger">Anonimização irreversível</h3>
          <p className="hint">
            Nome, documento, contato e endereço são apagados — não mascarados. O histórico
            financeiro permanece, referenciando este cadastro. Não há como desfazer.
          </p>
          <textarea
            className="field min-h-20"
            placeholder="Justificativa (mínimo 10 caracteres) — ex.: pedido do titular por e-mail em 20/08/2026"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <Button
            type="button"
            variant="accent"
            busy={pending}
            disabled={reason.trim().length < 10}
            onClick={() =>
              run(() =>
                anonymizeTutorAction(tutor.id, { confirmation: 'CONFIRMO_A_ANONIMIZACAO', reason }),
              )
            }
            busyLabel="Anonimizando…"
          >
            Confirmo a anonimização
          </Button>
        </Card>
      )}
    </div>
  )
}

// ─── Endereços ───────────────────────────────────────────────────────────────

function EnderecosTab({ overview }: { overview: TutorOverview }) {
  const addresses = overview.tutor.addresses

  if (addresses.length === 0) {
    return (
      <Card>
        <p className="hint">Nenhum endereço cadastrado.</p>
      </Card>
    )
  }

  return (
    <div className="space-y-3">
      {addresses.map((address) => (
        <Card key={address.id}>
          <div className="flex items-center justify-between gap-3">
            <h3 className="font-semibold">{address.label}</h3>
            {address.isPrimary && (
              <span className="pill bg-black/5 px-2.5 py-0.5 text-xs">Principal</span>
            )}
          </div>
          <p className="hint mt-2">
            {address.street}, {address.number}
            {address.complement ? ` — ${address.complement}` : ''}
            <br />
            {address.district} · {address.city}/{address.state} · {address.zipCode}
          </p>
          {address.accessNotes && <p className="hint mt-2">“{address.accessNotes}”</p>}
        </Card>
      ))}
    </div>
  )
}

// ─── Consentimento ───────────────────────────────────────────────────────────

const CHANNEL_LABELS: Record<ConsentChannel, string> = {
  WHATSAPP: 'WhatsApp',
  EMAIL: 'E-mail',
  SMS: 'SMS',
  TERMS: 'Termos de uso',
  SERVICE_LIABILITY: 'Termo de responsabilidade',
  IMAGE_USE: 'Uso de imagem',
}

/** Os dois termos que a recepção apresenta e que rendem papel (MOD-DOC-07 e 08). */
const TERMOS_COM_PAPEL: TermKind[] = ['SERVICE_LIABILITY', 'IMAGE_USE']

function ConsentimentosTab({ tutorId, consents }: { tutorId: string; consents: ConsentsResponse }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function toggle(channel: ConsentChannel, granted: boolean) {
    setError(null)
    startTransition(async () => {
      const result = await updateConsentsAction(tutorId, {
        transitions: [
          {
            channel,
            granted,
            purpose: channel === 'TERMS' ? 'BOTH' : 'MARKETING',
            source: 'STAFF_FORM',
            // A versão não vai daqui: quem sabe qual termo está vigente é o servidor,
            // que lê o que o estabelecimento publicou (MOD-DOC-06).
          },
        ],
      })
      if (result.ok) router.refresh()
      else setError(result.message)
    })
  }

  return (
    <div className="space-y-5">
      <FormError message={error} />

      <Card className="space-y-1">
        <h3 className="font-semibold">Estado atual</h3>
        <p className="hint pb-2">
          Mensagens de confirmação e lembrete de um serviço contratado continuam saindo mesmo sem
          opt-in de marketing.
        </p>
        <dl>
          {consents.current.map((state) => (
            <DataRow key={state.channel} label={CHANNEL_LABELS[state.channel]}>
              <span className="flex items-center gap-3">
                <span
                  className={
                    state.state === 'GRANTED'
                      ? 'text-success'
                      : state.state === 'PENDING_RENEWAL'
                        ? 'text-accent-ink'
                        : 'text-danger'
                  }
                >
                  {state.state === 'GRANTED'
                    ? 'Autorizado'
                    : state.state === 'PENDING_RENEWAL'
                      ? 'Aguardando novo aceite'
                      : 'Revogado'}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  className="px-3 py-1 text-xs"
                  busy={pending}
                  onClick={() => toggle(state.channel, !state.granted)}
                  busyLabel="Salvando…"
                >
                  {state.granted ? 'Revogar' : 'Autorizar'}
                </Button>
              </span>
            </DataRow>
          ))}
        </dl>
      </Card>

      <Card className="space-y-1">
        <h3 className="font-semibold">Termos e autorizações</h3>
        <p className="hint pb-2">
          Apresente o texto ao tutor e registre o aceite. O papel do aceite fica arquivado com data,
          hora e origem — é ele que prova o que foi apresentado.
        </p>
        <div className="flex flex-col gap-3 pt-1">
          {TERMOS_COM_PAPEL.map((kind) => (
            <TermoLinha key={kind} tutorId={tutorId} kind={kind} consents={consents} />
          ))}
        </div>
      </Card>

      <Card>
        <h3 className="font-semibold">Histórico</h3>
        <p className="hint mt-1 pb-2">
          Registro imutável: nada aqui é sobrescrito. É a prova perante a ANPD.
        </p>
        <ul className="space-y-2">
          {[...consents.history].reverse().map((record) => (
            <li
              key={record.id}
              className="flex flex-wrap gap-2 border-b border-line py-2 text-sm last:border-b-0"
            >
              <span className="font-medium">{CHANNEL_LABELS[record.channel]}</span>
              <span className={record.granted ? 'text-success' : 'text-danger'}>
                {record.granted ? 'autorizado' : 'revogado'}
              </span>
              <span className="hint ml-auto flex items-center gap-2">
                {formatDateTime(record.createdAt)} · {record.source} · v{record.version}
                {record.documentId && (
                  <BaixarPapel tutorId={tutorId} documentId={record.documentId} />
                )}
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}

/**
 * Um termo, o estado dele e o botão que colhe o aceite (MOD-DOC-07 e 08).
 *
 * O texto **não** vem carregado com a página: são dois documentos longos que quase nunca
 * são abertos, e trazê-los em toda visita à ficha custaria mais que buscá-los no clique.
 * O que a linha mostra sem pedir nada é o que decide a ação — aceito, pendente de
 * renovação ou nunca apresentado.
 */
function TermoLinha({
  tutorId,
  kind,
  consents,
}: {
  tutorId: string
  kind: TermKind
  consents: ConsentsResponse
}) {
  const router = useRouter()
  const [termo, setTermo] = useState<TermVersionView | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const estado = consents.current.find((item) => item.channel === kind)
  const aceito = estado?.state === 'GRANTED'
  const pendente = estado?.state === 'PENDING_RENEWAL'

  function apresentar() {
    setErro(null)
    startTransition(async () => {
      const resultado = await getCurrentTermAction(kind)
      if (resultado.ok) setTermo(resultado.data)
      else setErro(resultado.message)
    })
  }

  function registrar() {
    setErro(null)
    startTransition(async () => {
      const resultado = await acceptTermAction(tutorId, kind)
      if (!resultado.ok) {
        setErro(resultado.message)
        return
      }
      setTermo(null)
      router.refresh()
    })
  }

  return (
    <div className="rounded-xl border border-line p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">{TERM_KIND_LABELS[kind]}</p>
          <p className="hint">
            {aceito
              ? `Aceito na versão ${estado?.version}`
              : pendente
                ? `Aceitou a versão ${estado?.version}; o estabelecimento já publicou outra`
                : estado
                  ? 'Revogado'
                  : 'Nunca apresentado'}
          </p>
        </div>

        <Button
          type="button"
          variant={aceito ? 'ghost' : 'primary'}
          className="h-9"
          onClick={apresentar}
          busy={pending}
          busyLabel="Carregando…"
        >
          {aceito ? 'Ler o termo' : 'Apresentar e aceitar'}
        </Button>
      </div>

      {erro && (
        <p className="mt-3 text-sm text-danger" role="status">
          {erro}
        </p>
      )}

      <Modal
        open={termo !== null}
        onClose={() => setTermo(null)}
        busy={pending}
        icon={<DocumentIcon />}
        tone="icon-people"
        eyebrow="Consentimento"
        title={termo?.title ?? ''}
        subtitle={termo ? `Versão ${termo.version}` : ''}
        footer={
          <>
            <Button type="button" variant="ghost" disabled={pending} onClick={() => setTermo(null)}>
              Fechar
            </Button>
            {!aceito && (
              <Button type="button" busy={pending} onClick={registrar} busyLabel="Registrando…">
                O tutor aceitou
              </Button>
            )}
          </>
        }
      >
        <div className="flex flex-col gap-5">
          {!aceito && (
            <Alert
              tone="accent"
              icon={<DocumentIcon />}
              title="Leia o texto com o tutor antes de registrar"
              role="status"
            >
              O aceite é gravado com data, hora, endereço de origem e identificação do dispositivo.
              É essa a prova, e ela vale pelo que foi apresentado agora.
            </Alert>
          )}
          {termo && <TextoDoTermo body={termo.body} />}
        </div>
      </Modal>
    </div>
  )
}

/**
 * O papel de um aceite.
 *
 * A URL assinada dura quinze minutos e é pedida **no clique**, nunca na listagem: emiti-la
 * é o que a trilha de auditoria registra como download, e assinar dez arquivos que
 * ninguém abriu afogaria as linhas que importam.
 */
function BaixarPapel({ tutorId, documentId }: { tutorId: string; documentId: string }) {
  const [pending, startTransition] = useTransition()

  function abrir() {
    startTransition(async () => {
      const resultado = await getTutorDocumentAction(tutorId, documentId)
      if (resultado.ok && resultado.data.url) window.open(resultado.data.url, '_blank')
    })
  }

  return (
    <button type="button" className="underline" onClick={abrir} disabled={pending}>
      {pending ? 'abrindo…' : 'papel'}
    </button>
  )
}

// ─── Tags ────────────────────────────────────────────────────────────────────

function TagsTab({
  tutorId,
  tutorTags,
  allTags,
}: {
  tutorId: string
  tutorTags: { key: string; label: string; color: string; isSystem: boolean }[]
  allTags: Tag[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const assignedKeys = new Set(tutorTags.map((tag) => tag.key))

  function toggle(tag: Tag) {
    setError(null)
    startTransition(async () => {
      const result = assignedKeys.has(tag.key)
        ? await removeTagAction(tutorId, tag.id)
        : await assignTagAction(tag.id, [tutorId])
      if (result.ok) router.refresh()
      else setError(result.message)
    })
  }

  return (
    <div className="space-y-5">
      <FormError message={error} />

      <Card>
        <h3 className="font-semibold">Tags manuais</h3>
        <p className="hint mt-1">
          Tags automáticas — inativo, inadimplente, aniversariante — são mantidas pelo sistema e não
          podem ser aplicadas à mão.
        </p>

        <div className="mt-4 flex flex-wrap gap-2">
          {allTags.length === 0 && <p className="hint">Nenhuma tag criada ainda.</p>}
          {allTags.map((tag) => {
            const assigned = assignedKeys.has(tag.key)
            return (
              <button
                key={tag.id}
                type="button"
                disabled={pending || tag.isSystem}
                onClick={() => toggle(tag)}
                aria-pressed={assigned}
                title={tag.isSystem ? 'Mantida automaticamente pelo sistema' : undefined}
                className={`pill px-3 py-1 text-xs font-medium transition-colors ${
                  assigned ? 'text-white' : 'bg-black/5 text-muted'
                } ${tag.isSystem ? 'cursor-not-allowed opacity-60' : 'hover:opacity-90'}`}
                style={assigned ? { backgroundColor: tag.color } : undefined}
              >
                {tag.label}
                {tag.isSystem && ' ·  automática'}
              </button>
            )
          })}
        </div>
      </Card>
    </div>
  )
}

// ─── Pets (MOD-PET) ──────────────────────────────────────────────────────────

function PetsTab({ tutorId, pets }: { tutorId: string; pets: PetResponse[] }) {
  if (pets.length === 0) {
    return (
      <Card className="flex flex-col items-start gap-4">
        <p className="hint">
          Nenhum pet vinculado a este tutor. Todo pet nasce com um responsável, então o cadastro do
          animal começa por aqui.
        </p>
        <ButtonLink href="/pets/novo">Cadastrar pet</ButtonLink>
      </Card>
    )
  }

  return (
    <div className="space-y-3">
      <ul className="space-y-2">
        {pets.map((pet) => {
          const link = pet.tutors.find((item) => item.tutorId === tutorId)

          return (
            <li key={pet.id}>
              <Link
                href={`/pets/${pet.id}`}
                className="card flex flex-wrap items-center gap-4 px-5 py-4 transition-transform hover:-translate-y-0.5"
              >
                {/* Mesma marca visual de `/pets`: quem vê o pet aqui e lá tem de
                    reconhecê-lo pela mesma cara. */}
                <PetAvatar
                  coverPhotoUrl={pet.coverPhotoUrl}
                  speciesKey={pet.species.key}
                  petName={pet.name}
                  size="sm"
                />

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{pet.name}</span>
                    {pet.status === 'INACTIVE' && <Badge>Inativo</Badge>}
                    {pet.status === 'DECEASED' && <Badge tone="danger">Falecido</Badge>}
                  </div>
                  <p className="hint mt-1">
                    {[pet.species.label, pet.breed?.label, pet.size.label, pet.ageLabel]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
                {/* Quem responde pelo animal muda o que este tutor pode fazer com ele. */}
                <span className="hint">
                  {link?.role === 'PRIMARY' ? 'Responsável principal' : 'Responsável secundário'}
                </span>
              </Link>
            </li>
          )
        })}
      </ul>

      <ButtonLink href="/pets/novo" variant="ghost">
        Cadastrar outro pet
      </ButtonLink>
    </div>
  )
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString('pt-BR', { timeZone: 'UTC' })
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString('pt-BR')
}
