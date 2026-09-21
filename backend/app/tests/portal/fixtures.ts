import { randomUUID } from 'node:crypto'
import {
  DEFAULT_TERM_VERSION,
  PLATFORM_TERM_SEEDS,
  TERM_KINDS,
  type ServiceCategory,
  type TaxiRideResponse,
} from '@petshop/shared-types'
import { AppError } from '@petshop/shared-types'
import {
  callApi as callCore,
  getApp,
  ownerPrisma,
  resetDatabase as resetCore,
} from '../harness.js'

/**
 * Cenário do MOD-PORTAL — a superfície do cliente final.
 *
 * O núcleo (`../harness.js`) guarda o que é do processo: app, banco e token. O que fica
 * aqui é o cenário deste módulo, e ele é o mais caro de todos — o Portal lê de **oito**
 * módulos (pets, prontuário, agenda, financeiro, mensageria, documentos, tutores e taxi),
 * e montar uma tela sua exige o cenário de cada um.
 *
 * **A identidade passou a entrar pela porta da produção na fatia 11.** Antes, o harness
 * assinava o contexto do gateway à mão e punha o `tutorId` nele — o que fazia toda asserção
 * de escopo `_own` provar apenas que o handler lê o campo que recebeu. Agora o token é do
 * Clerk, o petshop vem do header de host, e o `tutorId` sai de `resolvePortalSession`, que
 * procura a ficha por `tutors.portal_user_id`. O teste ficou mais caro de montar e passou a
 * provar também que a resolução de sessão faz o que o MOD-PORTAL-02 diz que faz.
 */

export * from '../harness.js'

const { clearTenantKeyCache, createTenantKey, withTenant, encryptWithKey, getTenantKey } =
  await import('@petshop/db')
const { hashTutorEmail, hashTutorPhone } = await import('../../src/modules/portal/crypto.js')
const { setMessagingPort } = await import('../../src/modules/portal/messaging-port.js')
const { setSchedulingPort } = await import('../../src/modules/portal/scheduling-port.js')
const { setTaxiPort } = await import('../../src/modules/portal/taxi-port.js')
const { setTutorPort } = await import('../../src/modules/portal/tutor-port.js')
const { setLedgerPort } = await import('../../src/modules/portal/ledger-port.js')
const { setPdfPort } = await import('../../src/modules/portal/pdf-port.js')
const { resetRateMemory } = await import('../../src/modules/portal/rate-limit.js')

/**
 * Reseta o banco, as cinco portas e o contador de rate limit em memória.
 *
 * Sobrescreve o `resetDatabase` do núcleo: os testes deste módulo chamam este, e os dos
 * outros continuam com o do núcleo, que não conhece porta nenhuma do Portal.
 *
 * `DISABLE_REDIS` não desliga o rate limit — troca o contador por um em memória (ver
 * `rate-limit.ts`). É de propósito: assim a suíte exercita a **contagem de verdade**,
 * incluindo o 429 do AC-01 de MOD-PORTAL-11, em vez de um dublê que sempre libera. E é por
 * isso que ele precisa ser zerado aqui.
 */
export async function resetDatabase(): Promise<void> {
  await resetCore()
  clearTenantKeyCache()
  resetRateMemory()
  setMessagingPort(null)
  setSchedulingPort(null)
  setTaxiPort(null)
  setTutorPort(null)
  setLedgerPort(null)
  setPdfPort(null)
}

// ─── Mensageria ──────────────────────────────────────────────────────────────

export interface SentCode {
  tutorId: string
  channel: 'EMAIL' | 'WHATSAPP'
  code: string
}

/** O código do MOD-PORTAL-09, com o endereço para onde ele realmente saiu. */
export interface SentContactCode extends SentCode {
  address: string
}

/**
 * Dublê da porta de mensageria.
 *
 * É por ele que o teste **lê o código**: o valor real nunca sai do processo — a tabela
 * guarda só o hash, e o corpo da mensagem é cifrado com a DEK do tenant. Sem o dublê, o
 * caminho feliz do vínculo não teria como ser exercitado.
 */
export function captureMessages(): {
  codes: SentCode[]
  contactCodes: SentContactCode[]
  welcomes: string[]
} {
  const codes: SentCode[] = []
  const contactCodes: SentContactCode[] = []
  const welcomes: string[] = []

  setMessagingPort({
    async sendAccessCode(request) {
      codes.push({ tutorId: request.tutorId, channel: request.channel, code: request.code })
      return true
    },
    /**
     * O código da troca de contato, com o **destino** junto.
     *
     * O `address` é o que os testes do AC-02 precisam afirmar: um código que saísse para o
     * contato antigo passaria por toda a suíte sem falhar nada, e teria destruído a única
     * prova que a reverificação existe para produzir.
     */
    async sendContactCode(request) {
      contactCodes.push({
        tutorId: request.tutorId,
        channel: request.channel,
        address: request.address,
        code: request.code,
      })
      return true
    },
    async sendWelcome(request) {
      welcomes.push(request.tutorId)
      return true
    },
  })

  return { codes, contactCodes, welcomes }
}

// ─── Cenário ─────────────────────────────────────────────────────────────────

export interface TenantFixture {
  tenantId: string
  slug: string
  userId: string
  clerkUserId: string
}

export interface TenantOptions {
  status?: 'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'SUSPENDED' | 'TRIAL_EXPIRED' | 'TERMINATED'
  portalEnabled?: boolean
  /** O plano decide o que responde — e `STARTER` não tem Portal. */
  plan?: 'STARTER' | 'PRO' | 'ENTERPRISE'
  name?: string
}

export async function givenTenant(options: TenantOptions = {}): Promise<TenantFixture> {
  const tenantId = randomUUID()
  const suffix = tenantId.slice(0, 8)
  const slug = `teste-${suffix}`

  await ownerPrisma.tenant.create({
    data: {
      id: tenantId,
      slug,
      name: options.name ?? 'Petshop do João',
      status: options.status ?? 'ACTIVE',
      plan: options.plan ?? 'PRO',
      provisioningKey: `prov-${suffix}`,
      onboardingStep: 4,
      onboardingCompletedAt: new Date(),
      settings: {
        create: {
          timezone: 'America/Sao_Paulo',
          branding: { primaryColor: '#2E7D32', logoUrl: 'https://cdn/logo.png' },
          businessHours: {
            monday: { closed: false, opensAt: '08:00', closesAt: '18:00' },
          },
          portalEnabled: options.portalEnabled ?? true,
        },
      },
    },
  })

  const user = await ownerPrisma.user.create({
    data: {
      clerkUserId: `user_${suffix}`,
      emailEncrypted: 'v1:x:x:x',
      emailHash: `hash-${suffix}`,
      fullName: 'Maria Souza',
    },
  })

  await withTenant(tenantId, (tx) => createTenantKey(tx, tenantId))

  /**
   * As três versões `1.0` da plataforma, como o provisionamento semeia (MOD-DOC-06).
   *
   * O tenant daqui nasce por INSERT e não pelo `seedTenantDomain` do MOD-IDENT,
   * então o fixture repete o seed. Sem ele, "Meus documentos" não teria termo nenhum a
   * apresentar e todo aceite seria recusado por versão inexistente.
   */
  await ownerPrisma.termVersion.createMany({
    data: TERM_KINDS.map((kind) => ({
      tenantId,
      kind,
      version: DEFAULT_TERM_VERSION,
      title: PLATFORM_TERM_SEEDS[kind].title,
      body: PLATFORM_TERM_SEEDS[kind].body,
    })),
  })

  return { tenantId, slug, userId: user.id, clerkUserId: user.clerkUserId }
}

export interface TutorOptions {
  name?: string
  phone?: string
  email?: string
  portalUserId?: string
  anonymized?: boolean
  /** A anotação da recepção. Fica fora da tela e **entra** na exportação do AC-04. */
  notes?: string
}

/**
 * Uma ficha de tutor, com os hashes calculados **pelo mesmo caminho do Portal**.
 *
 * Cravar um hash literal aqui esconderia justamente o defeito que este módulo mais
 * teme: o namespace divergente entre quem grava e quem procura.
 */
export async function givenTutor(
  fixture: TenantFixture,
  options: TutorOptions = {},
): Promise<string> {
  const phone = options.phone ?? '+5511987654321'

  return withTenant(fixture.tenantId, async (tx) => {
    const key = await getTenantKey(tx, fixture.tenantId)
    const tutor = await tx.tutor.create({
      data: {
        tenantId: fixture.tenantId,
        fullName: options.name ?? 'Maria Souza',
        phoneEncrypted: encryptWithKey(phone, key),
        phoneHash: hashTutorPhone(phone),
        ...(options.email
          ? {
              emailEncrypted: encryptWithKey(options.email, key),
              emailHash: hashTutorEmail(options.email),
            }
          : {}),
        ...(options.portalUserId ? { portalUserId: options.portalUserId } : {}),
        ...(options.anonymized ? { anonymizedAt: new Date() } : {}),
        ...(options.notes ? { notes: options.notes } : {}),
      },
      select: { id: true },
    })
    return tutor.id
  })
}

/**
 * Um segundo login do Clerk, para o caso da ficha já vinculada a outra conta.
 *
 * `clerkUserId` é opcional e existe para o teste que **chama** como esse login: o espelho
 * local precisa existir antes, senão `resolvePortalSession` sai sem `userId` e a rota
 * recusa por falta de ficha em vez de recusar pelo motivo sob teste.
 */
export async function givenUser(label: string, clerkUserId?: string): Promise<string> {
  const user = await ownerPrisma.user.create({
    data: {
      clerkUserId: clerkUserId ?? `user_${label}_${randomUUID().slice(0, 8)}`,
      emailEncrypted: 'v1:x:x:x',
      emailHash: `hash-${label}-${randomUUID().slice(0, 8)}`,
      fullName: 'Outro Usuário',
    },
    select: { id: true },
  })
  return user.id
}

// ─── Requisições ─────────────────────────────────────────────────────────────

/**
 * O header pelo qual o Next diz de que petshop o Portal está falando.
 *
 * O tutor não tem Organization no Clerk, então o tenant **não** sai do token: sai do host
 * que o Next serviu (`{slug}.{APP_DOMAIN}`). É o mesmo header que a produção usa, e usá-lo
 * aqui é o que faz o teste exercitar `resolvePortalRequest` em vez de contorná-lo.
 */
const SLUG_HEADER = 'x-petshop-tenant-slug'

export interface CallerOptions {
  clerkUserId: string
  slug: string
  /**
   * A ficha que esta sessão representa.
   *
   * **Não vai no token** — não teria como: o vínculo mora em `tutors.portal_user_id`, e é
   * de lá que `resolvePortalSession` o lê. O que o campo faz é dizer ao `callApi` qual
   * vínculo garantir antes de injetar, que é o mesmo que `POST /portal/v1/access/verify`
   * faria no produto.
   */
  tutorId?: string
  tenantId?: string
}

export interface InjectOptions extends CallerOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  url: string
  payload?: unknown
  /**
   * Cabeçalhos extras.
   *
   * Existe por causa do `x-forwarded-for`: o app sobe com `trustProxy`, e o IP que vira
   * **prova** do consentimento é o que chega por aí. Sem poder forjá-lo, o teste
   * verificaria o IP do próprio harness.
   */
  headers?: Record<string, string>
}

/**
 * Garante o vínculo da ficha com o login desta chamada.
 *
 * `resolveLinkedTutor` procura por `portalUserId`, e um login vinculado a duas fichas do
 * mesmo tenant resolveria para qualquer uma delas. Por isso `asTutor` dá a **cada ficha o
 * seu login**, derivado do id: um teste que chama como dois tutores diferentes tem dois
 * usuários do Clerk, que é o que a realidade tem.
 */
async function ensureLinked(tenantId: string, tutorId: string, clerkUserId: string) {
  const user = await ownerPrisma.user.upsert({
    where: { clerkUserId },
    update: {},
    create: {
      clerkUserId,
      emailEncrypted: 'v1:x:x:x',
      emailHash: `hash-${clerkUserId}`,
      fullName: 'Tutor de Teste',
    },
    select: { id: true },
  })

  await withTenant(tenantId, (tx) =>
    tx.tutor.updateMany({ where: { id: tutorId }, data: { portalUserId: user.id } }),
  )
}

export async function callApi(options: InjectOptions) {
  if (options.tutorId && options.tenantId) {
    await ensureLinked(options.tenantId, options.tutorId, options.clerkUserId)
  }

  return callCore({
    clerkUserId: options.clerkUserId,
    // O tutor não é membro de estabelecimento nenhum: o token vem **sem** Organization,
    // como o do Portal em produção.
    clerkOrgId: null,
    method: options.method,
    url: options.url,
    headers: { [SLUG_HEADER]: options.slug, ...options.headers },
    ...(options.payload !== undefined ? { payload: options.payload } : {}),
  })
}

/**
 * A chamada **anônima**, como o Next a faz ao renderizar a tela de login.
 *
 * `/portal/v1/tenant` é a única rota do Portal fora do hook de sessão: ela descreve a
 * identidade visual do petshop, e exigir login para saber a cor do cabeçalho da tela de
 * login seria um laço.
 */
export async function callPublic(options: {
  method: 'GET' | 'POST'
  url: string
  slug: string
  payload?: unknown
}) {
  const instance = await getApp()
  return instance.inject({
    method: options.method,
    url: options.url,
    headers: { [SLUG_HEADER]: options.slug },
    ...(options.payload !== undefined ? { payload: options.payload as object } : {}),
  })
}

/** Quem entrou no Clerk mas ainda não vinculou ficha nenhuma. */
export function asVisitor(fixture: TenantFixture): CallerOptions {
  return {
    clerkUserId: fixture.clerkUserId,
    slug: fixture.slug,
    tenantId: fixture.tenantId,
  }
}

/**
 * Quem já é tutor deste petshop.
 *
 * O login é **derivado do id da ficha**, e não o do fixture: um por tutor, como na vida
 * real. É o que mantém `resolveLinkedTutor` determinístico quando o teste chama como dois
 * tutores diferentes no mesmo tenant.
 */
export function asTutor(fixture: TenantFixture, tutorId: string): CallerOptions {
  return {
    clerkUserId: `user_tutor_${tutorId.replace(/-/g, '').slice(0, 24)}`,
    slug: fixture.slug,
    tenantId: fixture.tenantId,
    tutorId,
  }
}

// ─── Cenário da fatia 2 — pets, agenda e prontuário ──────────────────────────

/**
 * O catálogo global (`tenant_id IS NULL`) sobrevive ao truncate e é semeado pela
 * migration. Buscá-lo em vez de criá-lo é o que faz o teste exercitar as mesmas linhas
 * que o Admin usa — um porte inventado aqui teria faixa de peso diferente da real.
 */
export interface CatalogFixture {
  speciesDogId: string
  sizeSmallId: string
  breedId: string
  coatId: string | null
}

let catalog: CatalogFixture | null = null

export async function getCatalog(): Promise<CatalogFixture> {
  if (catalog) return catalog

  const [species, size] = await Promise.all([
    ownerPrisma.species.findFirstOrThrow({ where: { key: 'DOG', tenantId: null } }),
    ownerPrisma.size.findFirstOrThrow({ where: { key: 'SMALL', tenantId: null } }),
  ])
  const [breed, coat] = await Promise.all([
    ownerPrisma.breed.findFirstOrThrow({ where: { speciesId: species.id, tenantId: null } }),
    ownerPrisma.coat.findFirst({ where: { tenantId: null } }),
  ])

  catalog = {
    speciesDogId: species.id,
    sizeSmallId: size.id,
    breedId: breed.id,
    coatId: coat?.id ?? null,
  }
  return catalog
}

export interface PetOptions {
  name?: string
  status?: 'ACTIVE' | 'INACTIVE' | 'DECEASED' | 'TRANSFERRED_OUT'
  birthDate?: Date
  notes?: string
  /** Vínculo já encerrado — o pet transferido do AC-05. */
  unlinked?: boolean
  weightKg?: number
}

export async function givenPet(
  fixture: TenantFixture,
  tutorId: string,
  options: PetOptions = {},
): Promise<string> {
  const cat = await getCatalog()

  return withTenant(fixture.tenantId, async (tx) => {
    const key = await getTenantKey(tx, fixture.tenantId)
    const pet = await tx.pet.create({
      data: {
        tenantId: fixture.tenantId,
        name: options.name ?? 'Thor',
        speciesId: cat.speciesDogId,
        breedId: cat.breedId,
        sizeId: cat.sizeSmallId,
        ...(cat.coatId ? { coatId: cat.coatId } : {}),
        status: options.status ?? 'ACTIVE',
        ...(options.birthDate
          ? { birthDate: options.birthDate, birthDatePrecision: 'EXACT' as const }
          : {}),
        ...(options.notes ? { notesEncrypted: encryptWithKey(options.notes, key) } : {}),
        ...(options.weightKg !== undefined ? { weightKg: options.weightKg } : {}),
        petTutors: {
          create: {
            tenantId: fixture.tenantId,
            tutorId,
            role: 'PRIMARY',
            ...(options.unlinked ? { unlinkedAt: new Date() } : {}),
          },
        },
      },
      select: { id: true },
    })
    return pet.id
  })
}

export interface ServiceOptions {
  name?: string
  category?: ServiceCategory
  active?: boolean
  /** Sem preço para o porte do pet, o serviço não entra no cardápio do Portal. */
  priced?: boolean
  priceCents?: number
  durationMin?: number
  /** Quem executa. Sem ninguém habilitado, o serviço não é oferecido. */
  professionalId?: string
}

/**
 * Um serviço de catálogo — com preço para o porte pequeno e um executor, que é o que o
 * cardápio do Portal exige para oferecê-lo.
 *
 * Os dois são opcionais de propósito: os testes do AC-02 provam justamente que o
 * serviço sem preço e o serviço sem profissional **não** aparecem.
 */
export async function givenService(
  fixture: TenantFixture,
  nameOrOptions: string | ServiceOptions = 'Banho',
): Promise<string> {
  const options: ServiceOptions =
    typeof nameOrOptions === 'string' ? { name: nameOrOptions } : nameOrOptions
  const cat = await getCatalog()

  return withTenant(fixture.tenantId, async (tx) => {
    const service = await tx.service.create({
      data: {
        tenantId: fixture.tenantId,
        name: options.name ?? 'Banho',
        category: options.category ?? 'BATH',
        baseDurationMin: options.durationMin ?? 60,
        active: options.active ?? true,
        ...(options.priced === false
          ? {}
          : {
              pricing: {
                create: {
                  tenantId: fixture.tenantId,
                  sizeId: cat.sizeSmallId,
                  priceCents: BigInt(options.priceCents ?? 8000),
                  durationMin: options.durationMin ?? 60,
                },
              },
            }),
        ...(options.professionalId
          ? {
              professionals: {
                create: {
                  tenantId: fixture.tenantId,
                  professionalId: options.professionalId,
                },
              },
            }
          : {}),
      },
      select: { id: true },
    })
    return service.id
  })
}

/** Configuração do tenant que a fatia 3 lê: janela, taxa, antecedência e as chaves. */
export async function setSettings(
  fixture: TenantFixture,
  data: {
    onlineBookingEnabled?: boolean
    onlineBookingRequiresApproval?: boolean
    minBookingNoticeHours?: number
    cancellationWindowHours?: number
    noShowFeePercent?: number
    portalEnabled?: boolean
  },
): Promise<void> {
  await ownerPrisma.tenantSettings.update({ where: { tenantId: fixture.tenantId }, data })
}

export async function givenProfessional(fixture: TenantFixture, name = 'Ana Banhista'): Promise<string> {
  return withTenant(fixture.tenantId, async (tx) => {
    const professional = await tx.professional.create({
      data: { tenantId: fixture.tenantId, displayName: name, roleKey: 'GROOMER' },
      select: { id: true },
    })
    return professional.id
  })
}

export interface AppointmentOptions {
  startsAt: Date
  status?:
    | 'PENDING'
    | 'CONFIRMED'
    | 'CHECKED_IN'
    | 'IN_PROGRESS'
    | 'COMPLETED'
    | 'CANCELLED'
    | 'NO_SHOW'
  serviceLabel?: string
}

export async function givenAppointment(
  fixture: TenantFixture,
  tutorId: string,
  petId: string,
  professionalId: string,
  options: AppointmentOptions,
): Promise<string> {
  // Fora do `withTenant` de baixo de propósito: aninhar uma transação dentro da outra
  // trava o pool, e a falha apareceria como timeout sem relação aparente com o teste.
  const serviceId = await givenService(fixture, options.serviceLabel ?? 'Banho')

  return withTenant(fixture.tenantId, async (tx) => {
    const appointment = await tx.appointment.create({
      data: {
        tenantId: fixture.tenantId,
        petId,
        tutorId,
        professionalId,
        startsAt: options.startsAt,
        endsAt: new Date(options.startsAt.getTime() + 60 * 60 * 1000),
        status: options.status ?? 'CONFIRMED',
        source: 'STAFF',
        totalCents: 8000n,
        items: {
          create: {
            tenantId: fixture.tenantId,
            serviceId,
            label: options.serviceLabel ?? 'Banho',
            durationMin: 60,
            priceCents: 8000n,
          },
        },
      },
      select: { id: true },
    })
    return appointment.id
  })
}

export interface AttendanceOptions {
  startedAt: Date
  status?: 'DRAFT' | 'COMPLETED' | 'VOIDED'
  serviceLabel?: string
  /** Cada nota vira uma linha; a visibilidade é o que o AC-02 exercita. */
  notes?: { body: string; visibility: 'INTERNAL' | 'TUTOR_VISIBLE' }[]
  voided?: boolean
}

export async function givenAttendance(
  fixture: TenantFixture,
  tutorId: string,
  petId: string,
  professionalId: string,
  options: AttendanceOptions,
): Promise<string> {
  return withTenant(fixture.tenantId, async (tx) => {
    const key = await getTenantKey(tx, fixture.tenantId)
    const attendance = await tx.attendance.create({
      data: {
        tenantId: fixture.tenantId,
        petId,
        tutorId,
        type: 'BATH',
        origin: 'SCHEDULED',
        performedBy: professionalId,
        startedAt: options.startedAt,
        finishedAt: new Date(options.startedAt.getTime() + 60 * 60 * 1000),
        status: options.status ?? 'COMPLETED',
        ...(options.voided
          ? { voidReason: 'Lançado no pet errado', voidedAt: new Date(), status: 'VOIDED' as const }
          : {}),
        items: {
          create: {
            tenantId: fixture.tenantId,
            serviceId: randomUUID(),
            label: options.serviceLabel ?? 'Banho',
            executedBy: professionalId,
            unitPriceCents: 8000n,
            totalPriceCents: 8000n,
          },
        },
        ...(options.notes?.length
          ? {
              notes: {
                create: options.notes.map((note) => ({
                  tenantId: fixture.tenantId,
                  kind: 'OPERATIONAL' as const,
                  visibility: note.visibility,
                  bodyEncrypted: encryptWithKey(note.body, key),
                })),
              },
            }
          : {}),
      },
      select: { id: true },
    })
    return attendance.id
  })
}

export async function givenAllergy(
  fixture: TenantFixture,
  petId: string,
  label = 'Aveia',
): Promise<void> {
  await withTenant(fixture.tenantId, async (tx) => {
    await tx.allergy.create({
      data: {
        tenantId: fixture.tenantId,
        petId,
        type: 'FOOD',
        label,
        severity: 'HIGH',
      },
    })
  })
}

export async function givenTemperament(fixture: TenantFixture, petId: string): Promise<void> {
  await withTenant(fixture.tenantId, async (tx) => {
    await tx.temperament.create({
      data: {
        tenantId: fixture.tenantId,
        petId,
        classification: 'REACTIVE',
        contexts: ['STRANGERS'],
      },
    })
  })
}

// ─── Cenário da fatia 3 — o agendamento ──────────────────────────────────────

export interface SchedulingDouble {
  /** O que a porta devolveu como grade; o teste ajusta antes de chamar. */
  slots: { startsAt: Date; professionalId: string; professionalName: string }[]
  nextAvailable: string | null
  /** Erro que a próxima criação deve levantar — é como se exercita a tradução. */
  failCreateWith: AppError | null
  calls: {
    availability: { serviceIds: string[]; from: string; to: string }[]
    created: { petId: string; startsAt: string; source: 'PORTAL' }[]
    cancelled: string[]
    rescheduled: { appointmentId: string; startsAt: string }[]
  }
}

/**
 * Dublê da porta do scheduling-service que **escreve no banco de verdade**.
 *
 * Um dublê que só devolvesse um objeto deixaria de fora tudo o que vem depois da
 * criação: a lista, o detalhe, o reconhecimento do duplo toque, o cancelamento. O que
 * este dublê substitui é a regra de domínio — gates, grade, transação serializável —,
 * que tem suíte própria no scheduling-service. O efeito no banco continua real.
 */
export function fakeScheduling(fixture: TenantFixture): SchedulingDouble {
  const double: SchedulingDouble = {
    slots: [],
    nextAvailable: null,
    failCreateWith: null,
    calls: { availability: [], created: [], cancelled: [], rescheduled: [] },
  }

  async function insert(input: {
    petId: string
    professionalId: string
    startsAt: string
    serviceIds: string[]
    status: 'PENDING' | 'CONFIRMED'
  }) {
    return withTenant(fixture.tenantId, async (tx) => {
      const link = await tx.petTutor.findFirstOrThrow({
        where: { petId: input.petId, unlinkedAt: null },
        select: { tutorId: true },
      })
      const services = await tx.service.findMany({
        where: { id: { in: input.serviceIds } },
        select: { id: true, name: true },
      })
      const startsAt = new Date(input.startsAt)

      const appointment = await tx.appointment.create({
        data: {
          tenantId: fixture.tenantId,
          petId: input.petId,
          tutorId: link.tutorId,
          professionalId: input.professionalId,
          startsAt,
          endsAt: new Date(startsAt.getTime() + 60 * 60 * 1000),
          status: input.status,
          source: 'PORTAL',
          totalCents: BigInt(8000 * services.length),
          items: {
            create: services.map((service) => ({
              tenantId: fixture.tenantId,
              serviceId: service.id,
              label: service.name,
              durationMin: 60,
              priceCents: 8000n,
            })),
          },
        },
        select: {
          id: true,
          status: true,
          startsAt: true,
          endsAt: true,
          totalCents: true,
          pet: { select: { name: true } },
          professional: { select: { displayName: true } },
          items: { select: { serviceId: true, label: true, priceCents: true, durationMin: true } },
        },
      })

      return {
        id: appointment.id,
        status: appointment.status,
        source: 'PORTAL' as const,
        startsAt: appointment.startsAt.toISOString(),
        endsAt: appointment.endsAt.toISOString(),
        petId: input.petId,
        petName: appointment.pet.name,
        tutorId: link.tutorId,
        professionalId: input.professionalId,
        professionalName: appointment.professional.displayName,
        items: appointment.items.map((item) => ({
          serviceId: item.serviceId,
          label: item.label,
          priceCents: Number(item.priceCents),
          durationMin: item.durationMin,
          addedAtCheckout: false,
        })),
        totalCents: Number(appointment.totalCents),
        checkinAt: null,
        checkoutAt: null,
        cancelledAt: null,
        cancelledLate: null,
        notes: null,
        createdAt: new Date().toISOString(),
      }
    })
  }

  setSchedulingPort({
    async availability(_caller, input) {
      double.calls.availability.push({
        serviceIds: input.serviceIds,
        from: input.from,
        to: input.to,
      })
      return {
        slots: double.slots.map((slot) => ({
          professionalId: slot.professionalId,
          professionalName: slot.professionalName,
          startsAt: slot.startsAt.toISOString(),
          endsAt: new Date(slot.startsAt.getTime() + 60 * 60 * 1000).toISOString(),
          durationMin: 60,
          priceCents: 8000,
        })),
        nextAvailable: double.nextAvailable,
        durationMin: 60,
        priceCents: 8000,
        timezone: 'America/Sao_Paulo',
      }
    },

    async create(_caller, input) {
      if (double.failCreateWith) throw double.failCreateWith
      double.calls.created.push({
        petId: input.petId,
        startsAt: input.startsAt,
        source: 'PORTAL',
      })

      const settings = await ownerPrisma.tenantSettings.findUniqueOrThrow({
        where: { tenantId: fixture.tenantId },
        select: { onlineBookingRequiresApproval: true },
      })

      return insert({
        petId: input.petId,
        professionalId: input.professionalId,
        startsAt: input.startsAt,
        serviceIds: input.serviceIds,
        status: settings.onlineBookingRequiresApproval ? 'PENDING' : 'CONFIRMED',
      })
    },

    async cancel(_caller, appointmentId) {
      double.calls.cancelled.push(appointmentId)
      return withTenant(fixture.tenantId, async (tx) => {
        const updated = await tx.appointment.update({
          where: { id: appointmentId },
          data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledLate: true },
          select: { id: true, petId: true, professionalId: true },
        })
        return { id: updated.id } as never
      })
    },

    async reschedule(_caller, appointmentId, input) {
      double.calls.rescheduled.push({ appointmentId, startsAt: input.startsAt })
      const old = await withTenant(fixture.tenantId, (tx) =>
        tx.appointment.update({
          where: { id: appointmentId },
          data: { status: 'RESCHEDULED' },
          select: { petId: true, items: { select: { serviceId: true } } },
        }),
      )
      return insert({
        petId: old.petId,
        professionalId: input.professionalId,
        startsAt: input.startsAt,
        serviceIds: old.items.map((item) => item.serviceId),
        status: 'CONFIRMED',
      })
    },
  })

  return double
}

// ─── Cenário da fatia 4 — o leva-e-traz (MOD-PORTAL-07) ──────────────────────

export interface TaxiSettingsOptions {
  enabled?: boolean
  /** Sem ele o domínio recusaria com ERR_TAXI_010, e a oferta some da tela. */
  withService?: boolean
  defaultWindowMinutes?: number
}

export async function givenTaxiSettings(
  fixture: TenantFixture,
  options: TaxiSettingsOptions = {},
): Promise<void> {
  const serviceId =
    options.withService === false
      ? null
      : await givenService(fixture, { name: 'Taxi Dog', category: 'TAXI' })

  await ownerPrisma.taxiSettings.create({
    data: {
      tenantId: fixture.tenantId,
      enabled: options.enabled ?? true,
      taxiServiceId: serviceId,
      defaultPriceCents: 1500n,
      defaultWindowMinutes: options.defaultWindowMinutes ?? 60,
    },
  })
}

/** O endereço primário do tutor — o que a corrida copia (RN-11 do MOD-TAXI). */
export async function givenTutorAddress(
  fixture: TenantFixture,
  tutorId: string,
  zipCode = '01310100',
): Promise<void> {
  await withTenant(fixture.tenantId, async (tx) => {
    const key = await getTenantKey(tx, fixture.tenantId)
    await tx.tutorAddress.create({
      data: {
        tenantId: fixture.tenantId,
        tutorId,
        zipCode,
        streetEncrypted: encryptWithKey('Avenida Paulista', key),
        numberEncrypted: encryptWithKey('1000', key),
        district: 'Bela Vista',
        city: 'São Paulo',
        state: 'SP',
        isPrimary: true,
      },
    })
  })
}

export interface TaxiDouble {
  /** Preço devolvido pela cotação; `null` faz a cotação recusar por zona (RN-18). */
  quoteCents: number | null
  /** Quantas vagas a van tem na janela consultada. Zero é van cheia (AC-04). */
  remaining: number
  /** Erro que a próxima criação de corrida deve levantar. */
  failCreateWith: AppError | null
  calls: {
    quotes: string[]
    windows: { startsAt: string; endsAt: string }[]
    created: { appointmentId: string; legs: string[] }[]
  }
}

/**
 * Dublê da porta do taxidog-service que **escreve corridas de verdade**.
 *
 * Mesmo desenho do `fakeScheduling`, e pelo mesmo motivo: o que se substitui é a regra
 * de domínio — zona, capacidade, item de cobrança —, que tem suíte própria no
 * taxidog-service. O efeito no banco continua real, e é dele que o AC-05 depende: o
 * status que o tutor lê sai da tabela, não da resposta da criação.
 */
export function fakeTaxi(fixture: TenantFixture): TaxiDouble {
  const double: TaxiDouble = {
    quoteCents: 2500,
    remaining: 2,
    failCreateWith: null,
    calls: { quotes: [], windows: [], created: [] },
  }

  setTaxiPort({
    async quote(_caller, zipCode) {
      double.calls.quotes.push(zipCode)
      if (double.quoteCents === null) {
        throw new AppError('ERR_TAXI_011', `O CEP ${zipCode} está fora das zonas atendidas`)
      }
      return { zipCode, priceCents: double.quoteCents, priceSource: 'ZONE', zone: null }
    },

    async availableDrivers(_caller, window) {
      double.calls.windows.push(window)
      if (double.remaining <= 0) return []
      return [{ id: randomUUID(), displayName: 'Carlos Motorista', remaining: double.remaining }]
    },

    async createRides(_caller, input) {
      if (double.failCreateWith) throw double.failCreateWith
      double.calls.created.push({
        appointmentId: input.appointmentId,
        legs: input.legs.map((leg) => leg.leg),
      })

      return withTenant(fixture.tenantId, async (tx) => {
        const appointment = await tx.appointment.findFirstOrThrow({
          where: { id: input.appointmentId },
          select: { petId: true, tutorId: true },
        })
        const key = await getTenantKey(tx, fixture.tenantId)
        const created: TaxiRideResponse[] = []

        for (const leg of input.legs) {
          const ride = await tx.taxiRide.create({
            data: {
              tenantId: fixture.tenantId,
              appointmentId: input.appointmentId,
              petId: appointment.petId,
              tutorId: appointment.tutorId,
              leg: leg.leg,
              status: 'REQUESTED',
              windowStartsAt: new Date(leg.windowStartsAt),
              windowEndsAt: new Date(leg.windowEndsAt),
              zipCode: '01310100',
              streetEncrypted: encryptWithKey('Avenida Paulista', key),
              numberEncrypted: encryptWithKey('1000', key),
              district: 'Bela Vista',
              city: 'São Paulo',
              state: 'SP',
              priceCents: BigInt(double.quoteCents ?? 0),
              priceSource: 'ZONE',
            },
          })

          created.push({
            id: ride.id,
            appointmentId: ride.appointmentId,
            petId: ride.petId,
            tutorId: ride.tutorId,
            leg: ride.leg,
            legLabel: ride.leg === 'PICKUP' ? 'Buscar' : 'Levar',
            status: ride.status,
            statusLabel: 'Sem motorista',
            windowStartsAt: ride.windowStartsAt.toISOString(),
            windowEndsAt: ride.windowEndsAt.toISOString(),
            priceCents: Number(ride.priceCents),
          } as never)
        }

        return created
      })
    },
  })

  return double
}

// ─── Cenário da fatia 4 — a conta corrente ───────────────────────────────────

/**
 * A conta do tutor, criada como o `billing-ledger-service` a cria: preguiçosamente.
 *
 * O teste que **não** chama esta função está exercitando o caso do tutor sem
 * movimentação — saldo zero e extrato vazio, nunca 404 (RN-17 do MOD-LEDGER).
 */
export async function givenLedgerAccount(
  fixture: TenantFixture,
  tutorId: string,
  balanceCents: number,
): Promise<string> {
  return withTenant(fixture.tenantId, async (tx) => {
    const account = await tx.ledgerAccount.create({
      data: { tenantId: fixture.tenantId, tutorId, balanceCents: BigInt(balanceCents) },
      select: { id: true },
    })
    return account.id
  })
}

export interface EntryOptions {
  direction: 'DEBIT' | 'CREDIT'
  amountCents: number
  description: string
  occurredAt: Date
  category?:
    | 'SERVICE'
    | 'PRODUCT'
    | 'NO_SHOW_FEE'
    | 'PACKAGE_PURCHASE'
    | 'PACKAGE_REDEMPTION'
    | 'PAYMENT'
    | 'ADJUSTMENT'
  /** Quanto do débito já foi quitado. É o que separa "em aberto" de "pago". */
  settledCents?: number
  status?: 'POSTED' | 'REVERSED'
  petId?: string
  /** A anotação de balcão que o AC-02 proíbe de viajar até o Portal. */
  internalNotes?: string
  sourceType?: 'ATTENDANCE' | 'PAYMENT' | 'PACKAGE' | 'MANUAL' | 'SYSTEM'
  sourceId?: string
}

export async function givenEntry(
  fixture: TenantFixture,
  tutorId: string,
  accountId: string,
  options: EntryOptions,
): Promise<string> {
  return withTenant(fixture.tenantId, async (tx) => {
    const key = await getTenantKey(tx, fixture.tenantId)
    const entry = await tx.ledgerEntry.create({
      data: {
        tenantId: fixture.tenantId,
        accountId,
        tutorId,
        direction: options.direction,
        amountCents: BigInt(options.amountCents),
        balanceAfterCents: 0n,
        category: options.category ?? (options.direction === 'DEBIT' ? 'SERVICE' : 'PAYMENT'),
        description: options.description,
        occurredAt: options.occurredAt,
        settledCents: BigInt(options.settledCents ?? 0),
        status: options.status ?? 'POSTED',
        sourceType: options.sourceType ?? 'MANUAL',
        ...(options.sourceId ? { sourceId: options.sourceId } : {}),
        ...(options.petId ? { petId: options.petId } : {}),
        ...(options.internalNotes
          ? { internalNotesEncrypted: encryptWithKey(options.internalNotes, key) }
          : {}),
      },
      select: { id: true },
    })
    return entry.id
  })
}

/** Um pagamento com o lançamento de crédito que lhe corresponde 1:1. */
export async function givenPayment(
  fixture: TenantFixture,
  tutorId: string,
  accountId: string,
  options: { amountCents: number; receivedAt: Date; description?: string },
): Promise<{ paymentId: string; entryId: string }> {
  const entryId = await givenEntry(fixture, tutorId, accountId, {
    direction: 'CREDIT',
    amountCents: options.amountCents,
    description: options.description ?? 'Pagamento recebido',
    occurredAt: options.receivedAt,
    category: 'PAYMENT',
    sourceType: 'PAYMENT',
  })

  const paymentId = await withTenant(fixture.tenantId, async (tx) => {
    const payment = await tx.payment.create({
      data: {
        tenantId: fixture.tenantId,
        accountId,
        tutorId,
        amountCents: BigInt(options.amountCents),
        method: 'PIX_MANUAL',
        receivedAt: options.receivedAt,
        entryId,
      },
      select: { id: true },
    })
    return payment.id
  })

  // O `source_id` do lançamento é o que liga a linha do extrato ao recibo, e
  // `ledger_entries` é append-only por RULE: a atualização vai em SQL cru, como o
  // próprio serviço faria se precisasse.
  await withTenant(fixture.tenantId, (tx) =>
    tx.$executeRaw`UPDATE ledger_entries SET source_id = ${paymentId}::uuid WHERE id = ${entryId}::uuid`,
  )

  return { paymentId, entryId }
}

export interface PackagePurchaseOptions {
  name?: string
  creditsTotal?: number
  creditsUsed?: number
  expiresAt: Date
  petId?: string
  status?: 'ACTIVE' | 'CONSUMED' | 'EXPIRED' | 'SUSPENDED' | 'CANCELLED'
}

export async function givenPackagePurchase(
  fixture: TenantFixture,
  tutorId: string,
  accountId: string,
  options: PackagePurchaseOptions,
): Promise<string> {
  const name = options.name ?? 'Pacote 4 banhos'
  const credits = options.creditsTotal ?? 4

  const entryId = await givenEntry(fixture, tutorId, accountId, {
    direction: 'DEBIT',
    amountCents: 28000,
    description: name,
    occurredAt: new Date(options.expiresAt.getTime() - 90 * 86_400_000),
    category: 'PACKAGE_PURCHASE',
    settledCents: 28000,
    sourceType: 'PACKAGE',
  })

  return withTenant(fixture.tenantId, async (tx) => {
    const pkg = await tx.servicePackage.create({
      data: {
        tenantId: fixture.tenantId,
        name,
        serviceIds: [],
        credits,
        priceCents: 28000n,
      },
      select: { id: true },
    })

    const purchase = await tx.packagePurchase.create({
      data: {
        tenantId: fixture.tenantId,
        tutorId,
        packageId: pkg.id,
        // RN-05: o que o tutor viu no ato da compra, congelado.
        snapshot: { name, serviceIds: [], credits, priceCents: 28000, validityDays: 90 },
        creditsTotal: credits,
        creditsUsed: options.creditsUsed ?? 0,
        expiresAt: options.expiresAt,
        status: options.status ?? 'ACTIVE',
        entryId,
        ...(options.petId ? { petId: options.petId } : {}),
      },
      select: { id: true },
    })
    return purchase.id
  })
}

export interface LedgerDouble {
  /** O que a porta devolve; o teste ajusta antes de chamar. */
  receipt: { number: string; status: string; issuedAt: string | null; url: string | null }
  /** Os bytes que o extrato em papel devolve, e o nome do arquivo. */
  statement: { bytes: Buffer; filename: string }
  /** Erro que a próxima emissão deve levantar. */
  failWith: AppError | null
  calls: string[]
}

/**
 * Dublê da porta do `billing-ledger-service`.
 *
 * Aqui o dublê **não** escreve no banco, ao contrário do `fakeScheduling`: o que ele
 * substitui é a emissão do PDF — Gotenberg, bucket e numeração sequencial —, que não
 * deixa rastro que o Portal leia depois. O que este lado precisa provar é outra coisa:
 * que a posse é conferida antes da chamada, e que o acesso vai para a trilha.
 */
export async function fakeLedger(): Promise<LedgerDouble> {
  const double: LedgerDouble = {
    receipt: {
      number: '2026/000123',
      status: 'ISSUED',
      issuedAt: '2026-09-01T12:00:00.000Z',
      url: 'https://bucket.example/recibo.pdf?assinatura=x',
    },
    statement: { bytes: Buffer.from('%PDF-1.4 extrato'), filename: 'extrato-2026-09-07.pdf' },
    failWith: null,
    calls: [],
  }

  setLedgerPort({
    async receipt(_caller, paymentId) {
      double.calls.push(paymentId)
      if (double.failWith) throw double.failWith
      return double.receipt
    },
    async statementPdf(_caller, tutorId) {
      double.calls.push(tutorId)
      if (double.failWith) throw double.failWith
      return double.statement
    },
  })

  return double
}

// ─── Cenário da fatia 4 — a Central de Comunicação (MOD-PORTAL-10) ───────────

export interface MessageOptions {
  body: string
  subject?: string
  channel?: 'WHATSAPP' | 'EMAIL'
  category?: 'TRANSACTIONAL' | 'OPERATIONAL' | 'MARKETING'
  status?:
    | 'QUEUED'
    | 'SCHEDULED'
    | 'SENDING'
    | 'SENT'
    | 'DELIVERED'
    | 'READ'
    | 'FAILED'
    | 'DEAD'
    | 'BLOCKED'
    | 'CANCELLED'
    | 'MERGED'
  direction?: 'OUTBOUND' | 'INBOUND'
  templateKey?: string
  sentAt?: Date
  blockReason?: 'NO_CONSENT' | 'SUPPRESSED' | 'NO_CHANNEL' | 'PET_DECEASED' | 'QUIET_HOURS_EXPIRED'
  /** Corpo apagado pela retenção de 24 meses, com a linha de pé (AC-04 de MOD-CRM-10). */
  purged?: boolean
}

/**
 * Uma mensagem no histórico, cifrada com a **DEK do tenant**, como o messaging-service
 * a grava.
 *
 * Cifrar de verdade aqui não é preciosismo: o que a rota do Portal faz de mais delicado
 * é abrir a chave uma vez por página e decifrar corpo e assunto. Um texto em claro na
 * fixture faria a suíte passar com um decifrador quebrado.
 */
export async function givenMessage(
  fixture: TenantFixture,
  tutorId: string,
  options: MessageOptions,
): Promise<string> {
  const status = options.status ?? 'DELIVERED'
  const enviada = ['SENT', 'DELIVERED', 'READ'].includes(status)

  return withTenant(fixture.tenantId, async (tx) => {
    const key = await getTenantKey(tx, fixture.tenantId)
    const message = await tx.message.create({
      data: {
        tenantId: fixture.tenantId,
        tutorId,
        channel: options.channel ?? 'WHATSAPP',
        direction: options.direction ?? 'OUTBOUND',
        category: options.category ?? 'TRANSACTIONAL',
        templateKey: options.templateKey ?? 'agendamento_confirmado',
        toEncrypted: encryptWithKey('+5511987654321', key),
        toHash: `hash-${randomUUID().slice(0, 8)}`,
        ...(options.subject ? { subjectEncrypted: encryptWithKey(options.subject, key) } : {}),
        // O expurgo esvazia a coluna e mantém a linha; a coluna é NOT NULL.
        bodyEncrypted: options.purged ? '' : encryptWithKey(options.body, key),
        status,
        ...(options.blockReason ? { blockReason: options.blockReason } : {}),
        dedupeKey: `dedupe-${randomUUID()}`,
        ...(enviada ? { sentAt: options.sentAt ?? new Date() } : {}),
      },
      select: { id: true },
    })
    return message.id
  })
}

/**
 * Um documento já emitido, como o serviço de domínio o teria deixado.
 *
 * O que este harness **não** faz é emitir: renderizar o PDF, numerar a série e gravar no
 * bucket são do ledger, do prontuário e do tutor-service, e cada um tem suíte própria. O
 * que o Portal precisa provar é o recorte por titular e a entrega.
 */
export async function givenDocument(
  fixture: TenantFixture,
  options: {
    tutorId: string | null
    kind: 'RECEIPT' | 'PRESCRIPTION' | 'TERM_ACCEPTANCE' | 'IMAGE_CONSENT'
    number: string
    status?: 'PENDING' | 'ISSUED' | 'CANCELLED' | 'FAILED'
    petId?: string
    issuedAt?: Date
  },
): Promise<string> {
  return withTenant(fixture.tenantId, async (tx) => {
    const status = options.status ?? 'ISSUED'
    const document = await tx.document.create({
      data: {
        tenantId: fixture.tenantId,
        kind: options.kind,
        number: options.number,
        tutorId: options.tutorId,
        ...(options.petId ? { petId: options.petId } : {}),
        status,
        ...(status === 'ISSUED'
          ? {
              storageKey: `tenants/${fixture.tenantId}/documents/${options.number}.pdf`,
              issuedAt: options.issuedAt ?? new Date(),
            }
          : {}),
      },
      select: { id: true },
    })
    return document.id
  })
}

export interface ConsentOptions {
  channel: 'WHATSAPP' | 'EMAIL' | 'SMS' | 'TERMS' | 'SERVICE_LIABILITY' | 'IMAGE_USE'
  granted: boolean
  purpose?: 'TRANSACTIONAL' | 'MARKETING' | 'BOTH'
  source?: 'STAFF_FORM' | 'PORTAL' | 'SITE' | 'WHATSAPP' | 'IMPORT'
  /** A versão do termo citada. O padrão é a `1.0` que o fixture semeia. */
  version?: string
  createdAt?: Date
}

/**
 * Uma transição de consentimento já gravada — o que a recepção registrou no balcão.
 *
 * `createdAt` vai **no próprio insert**, e não num UPDATE depois: `app_user` não tem
 * grant de UPDATE em `tutor_consents`, e o append-only não é só o gatilho — é também a
 * ausência da permissão. Um `$executeRaw` aqui volta `42501 permission denied`, que
 * parece falha do teste e é a garantia funcionando.
 *
 * Controlar o instante importa porque a ordem entre transições é o que o AC-04
 * exercita: duas linhas criadas no mesmo teste empatam em `now()`, e a "última" vira
 * sorteio.
 */
export async function givenConsent(
  fixture: TenantFixture,
  tutorId: string,
  options: ConsentOptions,
): Promise<void> {
  await withTenant(fixture.tenantId, async (tx) => {
    await tx.tutorConsent.create({
      data: {
        tenantId: fixture.tenantId,
        tutorId,
        channel: options.channel,
        granted: options.granted,
        purpose: options.purpose ?? 'MARKETING',
        source: options.source ?? 'STAFF_FORM',
        version: options.version ?? DEFAULT_TERM_VERSION,
        ...(options.createdAt ? { createdAt: options.createdAt } : {}),
      },
      select: { id: true },
    })
  })
}

export interface TutorServiceDouble {
  /** Cada chamada da porta, para o teste provar o que foi assinado e o que não foi. */
  calls: {
    tutorId: string
    channel: 'WHATSAPP' | 'EMAIL'
    granted: boolean
    ipAddress?: string | undefined
    userAgent?: string | undefined
  }[]
  /**
   * As escritas de ficha do MOD-PORTAL-09, na ordem em que a porta as recebeu.
   *
   * Separadas das transições de consentimento porque respondem a outra pergunta: ali
   * interessa **o que foi assinado**; aqui, **que a porta foi chamada** — e, nos testes de
   * campo travado, que ela não foi.
   */
  writes: {
    kind: 'profile' | 'contact' | 'address' | 'deletion' | 'export' | 'term'
    tutorId: string
  }[]
  /** Os aceites de termo, com a origem que a porta fixou — é prova (MOD-DOC-07). */
  terms: {
    tutorId: string
    term: 'TERMS' | 'SERVICE_LIABILITY' | 'IMAGE_USE'
    source: string
    ipAddress?: string | undefined
  }[]
  /** Erro que a próxima gravação deve levantar — é como se exercita a tradução. */
  failWith: AppError | null
}

export interface PdfDouble {
  /** O HTML que foi mandado imprimir, na ordem. É o que os testes de folha leem. */
  htmls: string[]
  /** Falha do Gotenberg a simular na próxima impressão. */
  failWith: Error | null
}

/**
 * Dublê do Gotenberg.
 *
 * A suíte roda com `DISABLE_EVENTS`, e sem este dublê **toda** impressão já falharia por
 * falta de configuração — o que esconderia o defeito de verdade: o HTML que sai errado.
 * O que se guarda aqui é o documento antes de virar papel, porque é nele que se pode
 * afirmar o que o titular vai ler.
 */
export function fakePdf(): PdfDouble {
  const double: PdfDouble = { htmls: [], failWith: null }

  setPdfPort({
    async render(html) {
      if (double.failWith) throw double.failWith
      double.htmls.push(html)
      return Buffer.from('%PDF-1.4 folha de mentira')
    },
  })

  return double
}

/**
 * Dublê da porta do tutor-service que **grava a transição de verdade**.
 *
 * Mesmo desenho do `fakeScheduling` e do `fakeTaxi`: o que se substitui é o que o
 * serviço de domínio faz *além* da linha — derrubar cache, publicar evento, escrever a
 * trilha —, e isso tem suíte própria lá. O efeito no banco continua real, e é dele que
 * os testes de estado dependem: o que o Portal devolve depois de salvar sai da tabela,
 * não da resposta da porta.
 */
export function fakeTutorService(fixture: TenantFixture): TutorServiceDouble {
  const double: TutorServiceDouble = { calls: [], writes: [], terms: [], failWith: null }

  setTutorPort({
    async updateMarketingConsent(caller, tutorId, input) {
      if (double.failWith) throw double.failWith
      double.calls.push({
        tutorId,
        channel: input.channel,
        granted: input.granted,
        ipAddress: caller.ipAddress,
        userAgent: caller.userAgent,
      })

      await givenConsent(fixture, tutorId, {
        channel: input.channel,
        granted: input.granted,
        purpose: 'MARKETING',
        source: 'PORTAL',
      })

      return { current: [], history: [] }
    },

    /**
     * O aceite de termo, gravado de verdade — como a transição de consentimento.
     *
     * O que o dublê substitui é a emissão do papel, que tem suíte própria no
     * tutor-service. A linha de `tutor_consents` continua real, porque é dela que a
     * tela do Portal deriva o estado do termo.
     */
    async acceptTerm(caller, tutorId, kind) {
      if (double.failWith) throw double.failWith
      double.writes.push({ kind: 'term', tutorId })
      double.terms.push({ tutorId, term: kind, source: 'PORTAL', ipAddress: caller.ipAddress })

      await givenConsent(fixture, tutorId, {
        channel: kind,
        granted: true,
        purpose: 'BOTH',
        source: 'PORTAL',
      })
    },

    async updateOwnProfile(_caller, tutorId, patch) {
      if (double.failWith) throw double.failWith
      double.writes.push({ kind: 'profile', tutorId })

      await withTenant(fixture.tenantId, async (tx) => {
        await tx.tutor.update({
          where: { id: tutorId },
          data: {
            ...(patch.socialName !== undefined ? { socialName: patch.socialName } : {}),
            ...(patch.birthDate !== undefined
              ? { birthDate: patch.birthDate ? new Date(patch.birthDate) : null }
              : {}),
          },
        })
      })
    },

    /**
     * Grava o contato **e o hash de busca**, como o tutor-service faria.
     *
     * O hash não é detalhe do dublê: é por ele que o MOD-PORTAL-01 encontra a ficha, e um
     * teste que gravasse só o valor cifrado passaria enquanto o produto real deixaria o
     * tutor sem conseguir entrar com o telefone que acabou de cadastrar.
     */
    async applyContactChange(_caller, tutorId, patch) {
      if (double.failWith) throw double.failWith
      double.writes.push({ kind: 'contact', tutorId })

      await withTenant(fixture.tenantId, async (tx) => {
        const key = await getTenantKey(tx, fixture.tenantId)
        await tx.tutor.update({
          where: { id: tutorId },
          data:
            'email' in patch
              ? {
                  emailEncrypted: encryptWithKey(patch.email, key),
                  emailHash: hashTutorEmail(patch.email),
                }
              : {
                  phoneEncrypted: encryptWithKey(patch.phone, key),
                  phoneHash: hashTutorPhone(patch.phone),
                },
        })
      })
    },

    async addAddress(_caller, tutorId, input) {
      if (double.failWith) throw double.failWith
      double.writes.push({ kind: 'address', tutorId })

      return withTenant(fixture.tenantId, async (tx) => {
        const key = await getTenantKey(tx, fixture.tenantId)
        const row = await tx.tutorAddress.create({
          data: {
            tenantId: fixture.tenantId,
            tutorId,
            label: input.label,
            zipCode: input.zipCode,
            streetEncrypted: encryptWithKey(input.street, key),
            numberEncrypted: encryptWithKey(input.number, key),
            ...(input.complement
              ? { complementEncrypted: encryptWithKey(input.complement, key) }
              : {}),
            district: input.district,
            city: input.city,
            state: input.state,
            ...(input.accessNotes ? { accessNotes: input.accessNotes } : {}),
            isPrimary: input.isPrimary,
          },
        })

        return {
          id: row.id,
          label: row.label,
          zipCode: row.zipCode,
          street: input.street,
          number: input.number,
          complement: input.complement ?? null,
          district: row.district,
          city: row.city,
          state: row.state,
          latitude: null,
          longitude: null,
          accessNotes: row.accessNotes,
          isPrimary: row.isPrimary,
        }
      })
    },

    async updateAddress(_caller, tutorId, addressId, patch) {
      if (double.failWith) throw double.failWith
      double.writes.push({ kind: 'address', tutorId })

      return withTenant(fixture.tenantId, async (tx) => {
        const key = await getTenantKey(tx, fixture.tenantId)
        const row = await tx.tutorAddress.update({
          where: { id: addressId },
          data: {
            ...(patch.label !== undefined ? { label: patch.label } : {}),
            ...(patch.zipCode !== undefined ? { zipCode: patch.zipCode } : {}),
            ...(patch.street !== undefined
              ? { streetEncrypted: encryptWithKey(patch.street, key) }
              : {}),
            ...(patch.number !== undefined
              ? { numberEncrypted: encryptWithKey(patch.number, key) }
              : {}),
            ...(patch.district !== undefined ? { district: patch.district } : {}),
            ...(patch.city !== undefined ? { city: patch.city } : {}),
            ...(patch.state !== undefined ? { state: patch.state } : {}),
            ...(patch.accessNotes !== undefined ? { accessNotes: patch.accessNotes } : {}),
            ...(patch.isPrimary !== undefined ? { isPrimary: patch.isPrimary } : {}),
          },
        })

        return {
          id: row.id,
          label: row.label,
          zipCode: row.zipCode,
          street: patch.street ?? '',
          number: patch.number ?? '',
          complement: null,
          district: row.district,
          city: row.city,
          state: row.state,
          latitude: null,
          longitude: null,
          accessNotes: row.accessNotes,
          isPrimary: row.isPrimary,
        }
      })
    },

    /**
     * Registra o pedido de exclusão como o `privacy.ts` do tutor-service registraria.
     *
     * Inclusive o 409 do segundo pedido em aberto: sem ele, o teste do AC-05 provaria só
     * que a rota responde, e não que a fila da equipe conta uma decisão por ficha.
     */
    async requestDeletion(_caller, tutorId, input) {
      if (double.failWith) throw double.failWith
      double.writes.push({ kind: 'deletion', tutorId })

      return withTenant(fixture.tenantId, async (tx) => {
        const aberto = await tx.dataDeletionRequest.findFirst({
          where: { tutorId, status: 'OPEN' },
          select: { id: true },
        })
        if (aberto) {
          throw new AppError('ERR_TUTOR_010', 'Esta ficha já tem um pedido de exclusão em análise')
        }

        const now = new Date()
        const row = await tx.dataDeletionRequest.create({
          data: {
            tenantId: fixture.tenantId,
            tutorId,
            reason: input.reason ?? null,
            dueAt: new Date(now.getTime() + 15 * 24 * 60 * 60_000),
          },
        })

        return {
          id: row.id,
          tutorId,
          tutorName: 'Maria Souza',
          status: row.status,
          reason: row.reason,
          requestedAt: row.createdAt.toISOString(),
          dueAt: row.dueAt.toISOString(),
          respondedAt: null,
          resolution: null,
          balanceCents: 0,
        }
      })
    },

    /**
     * A exportação do AC-04.
     *
     * O dublê devolve o essencial e **marca a chamada**: o que os testes precisam afirmar é
     * que o Portal delegou ao tutor-service — é lá que a leitura vira `tutor.exported` na
     * trilha, e é essa linha que prova o exercício do direito de acesso.
     */
    async exportOwnData(_caller, tutorId) {
      if (double.failWith) throw double.failWith
      double.writes.push({ kind: 'export', tutorId })

      return withTenant(fixture.tenantId, async (tx) => {
        const tutor = await tx.tutor.findFirstOrThrow({
          where: { id: tutorId },
          select: { id: true, fullName: true, status: true, createdAt: true, notes: true },
        })

        return {
          exportedAt: new Date().toISOString(),
          tutor: {
            id: tutor.id,
            personType: 'PF' as const,
            fullName: tutor.fullName,
            socialName: null,
            legalName: null,
            cpf: null,
            cnpj: null,
            phone: null,
            phoneAlt: null,
            email: null,
            birthDate: null,
            notes: tutor.notes,
            status: tutor.status,
            createdAt: tutor.createdAt.toISOString(),
          },
          addresses: [],
          consents: [],
          tags: [],
        }
      })
    },
  })

  return double
}
