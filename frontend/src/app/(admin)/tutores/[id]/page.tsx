import { notFound } from 'next/navigation'
import { ApiError } from '@petshop/api-client'
import { Badge } from '@/components/ui'
import { ButtonLink } from '@/components/links'
import { RecordHero } from '@/components/record-hero'
import { InitialsAvatar } from '@/components/record-list'
import { temRecurso } from '@/components/plano-indisponivel'
import { carregarMe, serverApi } from '@/lib/api'
import { SaleButton } from '../../estoque/sale-dialog'
import { TutorDetailView, type CommsData, type FinanceData } from './tutor-detail'

/** Visão 360º do tutor (MOD-TUTOR-07). */

export const dynamic = 'force-dynamic'

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function TutorPage({ params }: PageProps) {
  const { id } = await params

  const [me, overview, consents, tags, pets] = await Promise.all([
    carregarMe(),
    serverApi()
      .getTutorOverview(id)
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 404) notFound()
        throw error
      }),
    serverApi().getConsents(id),
    serverApi().listTags(),
    // Os pets vêm do pet-service, não da visão 360º: a composição é aqui, e não no
    // tutor-service lendo tabela de outro módulo.
    serverApi()
      .listPets({ tutorId: id, limit: 50 })
      .then((page) => page.data)
      .catch(() => []),
  ])

  const [finance, comms] = await Promise.all([
    loadFinance(id, me.permissions),
    loadComms(id, me.permissions),
  ])

  const tutor = overview.tutor

  return (
    <div className="space-y-6">
      <RecordHero
        back={{ href: '/tutores', label: 'Tutores' }}
        avatar={<InitialsAvatar name={tutor.displayName} tone="icon-people" size="lg" />}
        title={tutor.displayName}
        badges={
          <>
            {tutor.status === 'INACTIVE' && <Badge>Inativo</Badge>}
            {tutor.status === 'ANONYMIZED' && <Badge tone="danger">Anonimizado</Badge>}
            {tutor.status === 'MERGED' && <Badge>Unificado a outro cadastro</Badge>}
            {tutor.dataCompleteness === 'PARTIAL' && (
              <Badge tone="accent">Cadastro incompleto</Badge>
            )}
          </>
        }
        meta={
          <span className="tabular-nums">
            {[tutor.phoneMasked, tutor.email].filter(Boolean).join(' · ')}
          </span>
        }
        chips={
          tutor.tags.length > 0 &&
          tutor.tags.map((tag) => (
            <span
              key={tag.key}
              className="pill px-2.5 py-0.5 text-xs font-medium"
              style={{ backgroundColor: `${tag.color}1a`, color: tag.color }}
            >
              {tag.label}
            </span>
          ))
        }
        actions={
          // Anonimizado e unificado não se editam nem compram: o cadastro terminou.
          tutor.status !== 'MERGED' &&
          tutor.status !== 'ANONYMIZED' && (
            <>
              <ButtonLink href={`/tutores/${tutor.id}/editar`}>Editar</ButtonLink>
              {/* MOD-ESTOQUE-05: a venda nasce aqui já com o comprador, e cai no extrato. */}
              {tutor.status === 'ACTIVE' &&
                temRecurso(me, 'INVENTORY') &&
                me.permissions.includes('inventory:sell') && (
                  <SaleButton
                    tutor={{
                      id: tutor.id,
                      name: tutor.displayName,
                      detail: tutor.phoneMasked ?? '',
                    }}
                    canOverrideCredit={me.permissions.includes('finance:credit')}
                  />
                )}
            </>
          )
        }
        facts={[
          {
            label: 'Saldo',
            value: formatCurrency(tutor.balance),
            tone: tutor.balance < 0 ? 'danger' : tutor.balance > 0 ? 'success' : undefined,
          },
          { label: 'Pets', value: pets.length },
          {
            label: 'Último atendimento',
            value: tutor.lastAttendanceAt ? formatDate(tutor.lastAttendanceAt) : 'Nenhum',
          },
          { label: 'Cliente desde', value: formatDate(tutor.createdAt) },
        ]}
      />

      <TutorDetailView
        overview={overview}
        consents={consents}
        tags={tags}
        pets={pets}
        finance={finance}
        comms={comms}
      />
    </div>
  )
}

/**
 * Carrega o histórico de comunicação para quem pode vê-lo (AC-02 de MOD-CRM-10).
 *
 * Mesma regra do financeiro: sem `crm:read` a aba não existe, em vez de existir e
 * devolver 403. O banhista não precisa saber que o petshop conversa com o tutor.
 *
 * O `catch` cobre o messaging-service fora do ar: a ficha do tutor não pode deixar de
 * abrir porque o motor de mensagens caiu. Sem ele, a aba some — que é o mesmo que
 * dizer "não sei", e é honesto.
 */
async function loadComms(tutorId: string, permissions: string[]): Promise<CommsData | null> {
  if (!permissions.includes('crm:read')) return null

  const messages = await serverApi()
    .listTutorMessages(tutorId, { page: 1, limit: 20 })
    .catch(() => null)
  if (!messages) return null

  return { messages, canSend: permissions.includes('crm:send') }
}

/**
 * Carrega a conta corrente para quem pode vê-la (§9 do PRD financeiro).
 *
 * Devolve `null` sem `finance:read` — e aí a aba nem aparece. Renderizá-la para
 * depois mostrar um 403 seria pior que não oferecê-la: o banhista não tem por que
 * saber que a informação existe e lhe é negada.
 *
 * O catálogo de pacotes é opcional: um tenant que nunca criou pacote nenhum não
 * precisa ver o botão de vender, e o `catch` cobre o caso de a permissão de catálogo
 * ser mais restrita que a de leitura.
 */
async function loadFinance(tutorId: string, permissions: string[]): Promise<FinanceData | null> {
  if (!permissions.includes('finance:read')) return null

  const api = serverApi()
  const [account, statement, packages, catalog] = await Promise.all([
    api.getLedgerAccount(tutorId),
    api.getStatement(tutorId, { limit: 20 }),
    api
      .listTutorPackages(tutorId)
      .then((result) => result.data)
      .catch(() => []),
    api
      .listServicePackages()
      .then((result) => result.data.filter((item) => item.active))
      .catch(() => []),
  ])

  return {
    account,
    statement,
    packages,
    catalog,
    can: {
      read: true,
      create: permissions.includes('finance:create'),
      refund: permissions.includes('finance:refund'),
      credit: permissions.includes('finance:credit'),
    },
  }
}

function formatCurrency(value: number): string {
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString('pt-BR', { timeZone: 'UTC' })
}
