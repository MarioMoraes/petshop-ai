import { Prisma, withTenant, type TenantTransaction } from '@petshop/db'
import { AppError, NON_ATTENDING_ROLE_KEYS } from '@petshop/shared-types'
import { recordAudit } from '../../shared/audit.js'
import { publishEvent } from '../../shared/events.js'
import { invalid, notFound, professionalUnavailable } from './errors.js'
import { tenantOptions, type ActorContext } from '../schedule-catalog/actor.js'
import { openCipher } from './crypto.js'
import { checkWindow, findAvailability } from './availability.js'
import { countOverlapping, isSerializationError } from './conflicts.js'
import { resolveItemDuration, totalDuration } from './duration.js'
import {
  assertAlertsAcknowledged,
  assertCreditAllowed,
  assertMinimumNotice,
  billing,
  findBlockingAlerts,
  loadNoticeHours,
} from './gates.js'

/**
 * O caminho de escrita do agendamento (MOD-AGENDA-04).
 *
 * **Escopo desta fatia:** o modelo de dados e o algoritmo. Os três gates do
 * MOD-AGENDA-10 — alerta clínico, inadimplência e antecedência mínima — ainda não
 * estão aqui; entram entre `assertBookable` e a reserva, e o ponto está marcado.
 *
 * O que já está fechado é a parte que não dá para consertar depois sem reescrever:
 * a duração calculada, o preço congelado e a corrida do último lugar.
 */

export interface BookingItemInput {
  serviceId: string
}

export interface CreateBookingInput {
  petId: string
  professionalId: string
  startsAt: Date
  items: BookingItemInput[]
  notes?: string | undefined
  source?: 'STAFF' | 'PORTAL' | 'RECURRENCE' | 'AI_AGENT'
  /** AC-01 de MOD-AGENDA-10: reconhecimento consciente do alerta clínico crítico. */
  acknowledgedAlerts?: boolean
  /** AC-02: libera o gate de inadimplência; exige `schedule:override_credit`. */
  override?: { reason: string } | undefined
}

/** O que o chamador pode fazer, vindo da matriz de permissão e não do papel. */
export interface BookingCapabilities {
  canOverrideCredit: boolean
}

/** Quantas sugestões acompanham um 409 de conflito (AC-02 e AC-04). */
const SUGGESTION_COUNT = 3

// ─── Montagem do pedido ──────────────────────────────────────────────────────

export interface ResolvedItem {
  serviceId: string
  label: string
  priceCents: number
  durationMin: number
}

/**
 * Traduz "este pet, estes serviços" em itens com preço e duração concretos.
 *
 * É aqui que o RN-03 vive: porte sem preço cadastrado **recusa** o agendamento com
 * 422, em vez de interpolar. Um valor inventado no fechamento vira discussão no
 * balcão, e a discussão é com quem não errou.
 */
export async function resolveItems(
  tx: TenantTransaction,
  petId: string,
  items: BookingItemInput[],
): Promise<{ items: ResolvedItem[]; pet: { id: string; name: string; status: string } }> {
  const pet = await tx.pet.findFirst({
    where: { id: petId },
    select: {
      id: true,
      name: true,
      status: true,
      sizeId: true,
      coat: { select: { groomingTimeFactor: true } },
    },
  })
  if (!pet) throw notFound('Pet não encontrado')

  const coatFactor = pet.coat ? Number(pet.coat.groomingTimeFactor) : null
  const resolved: ResolvedItem[] = []

  for (const item of items) {
    const service = await tx.service.findFirst({
      where: { id: item.serviceId, deletedAt: null },
      select: { id: true, name: true, category: true, active: true },
    })
    if (!service) throw notFound('Serviço não encontrado')
    if (!service.active) throw invalid(`O serviço "${service.name}" está desativado`)

    const pricing = await tx.servicePricing.findFirst({
      where: { serviceId: service.id, sizeId: pet.sizeId },
      select: { priceCents: true, durationMin: true },
    })
    if (!pricing) {
      const size = await tx.size.findFirst({
        where: { id: pet.sizeId },
        select: { label: true },
      })
      throw invalid(
        `O serviço "${service.name}" não tem preço definido para o porte ${size?.label ?? 'deste pet'}`,
        [{ field: 'items', message: 'Porte sem preço cadastrado neste serviço' }],
      )
    }

    resolved.push({
      serviceId: service.id,
      label: service.name,
      priceCents: Number(pricing.priceCents),
      durationMin: resolveItemDuration({
        sizeDurationMin: pricing.durationMin,
        coatFactor,
        category: service.category,
      }),
    })
  }

  return { items: resolved, pet: { id: pet.id, name: pet.name, status: pet.status } }
}

/**
 * As checagens que não dependem de concorrência.
 *
 * Rodam antes da transação serializável de propósito: falhar aqui é barato, e manter
 * a janela serializável curta reduz a chance de dois pedidos legítimos se abortarem.
 */
export async function assertBookable(
  tx: TenantTransaction,
  input: CreateBookingInput,
  pet: { status: string; name: string },
): Promise<{ tutorId: string }> {
  // AC-06: a agenda é o último lugar onde um óbito não registrado vira constrangimento.
  if (pet.status !== 'ACTIVE' && pet.status !== 'INACTIVE') {
    throw new AppError(
      'ERR_AGENDA_010',
      `${pet.name} não está disponível para agendamento (${pet.status.toLowerCase()})`,
      undefined,
      { petStatus: pet.status },
    )
  }

  const link = await tx.petTutor.findFirst({
    where: { petId: input.petId, role: 'PRIMARY' },
    select: { tutorId: true, tutor: { select: { status: true } } },
  })
  if (!link) throw invalid('Este pet não tem responsável principal')
  if (link.tutor.status === 'ANONYMIZED') {
    throw new AppError('ERR_AGENDA_010', 'O responsável por este pet foi anonimizado')
  }

  const professional = await tx.professional.findFirst({
    where: { id: input.professionalId, deletedAt: null },
    select: { id: true, displayName: true, active: true, roleKey: true },
  })
  if (!professional) throw notFound('Profissional não encontrado')
  if (!professional.active) {
    throw professionalUnavailable(`${professional.displayName} não está mais atendendo`)
  }

  /**
   * Motorista não atende pet, e a regra é do **papel**.
   *
   * A habilitação por serviço, logo abaixo, já barraria o caso normal — mas ela é
   * dado que alguém digita, e um clique errado na tela de profissionais devolveria o
   * motorista para a agenda de banho. O papel não se marca por engano.
   */
  if ((NON_ATTENDING_ROLE_KEYS as readonly string[]).includes(professional.roleKey)) {
    throw professionalUnavailable(
      `${professional.displayName} é motorista e não executa atendimento`,
    )
  }

  // AC-03: habilitação por serviço.
  for (const item of input.items) {
    const enabled = await tx.professionalService.findFirst({
      where: { professionalId: input.professionalId, serviceId: item.serviceId },
    })
    if (!enabled) {
      const service = await tx.service.findFirst({
        where: { id: item.serviceId },
        select: { name: true },
      })
      throw professionalUnavailable(
        `${professional.displayName} não executa ${service?.name ?? 'este serviço'}`,
        { professionalId: professional.id, serviceId: item.serviceId },
      )
    }
  }

  return { tutorId: link.tutorId }
}

/**
 * A janela cabe na jornada e está fora de bloqueio? (AC-04)
 *
 * `checkWindow` verifica só jornada e bloqueio — capacidade é checada depois, em
 * separado. Os dois motivos de recusa dizem coisas diferentes a quem está no balcão,
 * e o erro precisa distinguir "não trabalha nesse horário" de "está cheio".
 */
async function assertWithinShift(
  tx: TenantTransaction,
  input: CreateBookingInput,
  durationMin: number,
  professionalName: string,
): Promise<void> {
  const endsAt = new Date(input.startsAt.getTime() + durationMin * 60_000)
  const window = await checkWindow(tx, input.professionalId, input.startsAt, endsAt)
  if (window.ok) return

  const detail =
    window.reason === 'BLOCKED'
      ? `A agenda de ${professionalName} está bloqueada neste horário`
      : `${professionalName} não atende neste horário`

  throw professionalUnavailable(detail, {
    reason: window.reason,
    suggestions: await suggest(tx, input, durationMin),
  })
}

/** Os horários livres mais próximos do que foi pedido (AC-02 e AC-04). */
async function suggest(
  tx: TenantTransaction,
  input: CreateBookingInput,
  durationMin: number,
): Promise<{ startsAt: string; endsAt: string }[]> {
  const from = input.startsAt
  const to = new Date(from.getTime() + 7 * 24 * 60 * 60_000)
  const { slots } = await findAvailability(tx, {
    professionalIds: [input.professionalId],
    durationMin,
    from,
    to,
  })
  return slots.slice(0, SUGGESTION_COUNT).map((slot) => ({
    startsAt: slot.startsAt.toISOString(),
    endsAt: slot.endsAt.toISOString(),
  }))
}

// ─── Criação ─────────────────────────────────────────────────────────────────

export interface CreatedBooking {
  id: string
  startsAt: Date
  endsAt: Date
  totalCents: number
  durationMin: number
  status: 'PENDING' | 'CONFIRMED'
  petId: string
  tutorId: string
  professionalId: string
}

/**
 * Cria o agendamento.
 *
 * A transação roda em `SERIALIZABLE` **inteira**, e não só a contagem: sob esse nível
 * o Postgres detecta que duas transações leram o mesmo conjunto de linhas e uma delas
 * o invalidou, o que é exatamente a corrida do AC-05. Uma das duas é abortada com
 * 40001, e aqui isso vira 409 `ERR_AGENDA_004` — o pedido não estava errado, só
 * chegou em segundo lugar.
 *
 * Os gates do MOD-AGENDA-10 rodam **antes**, em `runGates`, com transação de leitura
 * própria: manter a janela serializável curta reduz a chance de dois pedidos
 * legítimos se abortarem por contenção.
 */
export async function createBooking(
  actor: ActorContext,
  input: CreateBookingInput,
  capabilities: BookingCapabilities = { canOverrideCredit: false },
): Promise<CreatedBooking> {
  const gates = await runGates(actor, input, capabilities)

  let created: CreatedBooking
  try {
    created = await withTenant(
      actor.tenantId,
      async (tx) => {
        const { items, pet } = await resolveItems(tx, input.petId, input.items)
        const { tutorId } = await assertBookable(tx, input, pet)

        const durationMin = totalDuration(items.map((item) => item.durationMin))
        const endsAt = new Date(input.startsAt.getTime() + durationMin * 60_000)

        const professional = await tx.professional.findFirstOrThrow({
          where: { id: input.professionalId },
          select: { displayName: true, maxConcurrentPets: true },
        })

        // A observação é campo livre e vai cifrada (§9). A DEK é do tenant e a
        // transação já está no contexto dele.
        const cipher = input.notes ? await openCipher(tx, actor.tenantId) : null

        await assertWithinShift(tx, input, durationMin, professional.displayName)

        // RN-02: conflito é contagem, não existência.
        const concurrent = await countOverlapping(
          tx,
          input.professionalId,
          input.startsAt,
          endsAt,
        )
        if (concurrent >= professional.maxConcurrentPets) {
          throw new AppError(
            'ERR_AGENDA_004',
            `${professional.displayName} já tem ${concurrent} ${concurrent === 1 ? 'pet' : 'pets'} neste horário`,
            undefined,
            { suggestions: await suggest(tx, input, durationMin) },
          )
        }

        const totalCents = items.reduce((sum, item) => sum + item.priceCents, 0)

        // AC-03 de MOD-AGENDA-06: o tenant que quer triar recebe PENDING. O horário
        // já fica **reservado** — PENDING ocupa lugar na agenda —, e é isso que
        // impede o balcão de vender por baixo o horário que o tutor ainda espera.
        const status = gates.requiresApproval ? 'PENDING' : 'CONFIRMED'

        const appointment = await tx.appointment.create({
          data: {
            tenantId: actor.tenantId,
            petId: input.petId,
            tutorId,
            professionalId: input.professionalId,
            startsAt: input.startsAt,
            endsAt,
            status,
            source: input.source ?? 'STAFF',
            totalCents: BigInt(totalCents),
            createdBy: actor.actorUserId ?? null,
            ...(cipher && input.notes ? { notesEncrypted: cipher.encrypt(input.notes) } : {}),
            // Quem assumiu o risco clínico, e quando. É esta linha que responde à
            // pergunta meses depois.
            ...(gates.acknowledgedAlerts.length > 0
              ? {
                  acknowledgedAlertsBy: actor.actorUserId ?? null,
                  acknowledgedAlertsAt: new Date(),
                }
              : {}),
            ...(input.override
              ? {
                  creditOverrideBy: actor.actorUserId ?? null,
                  creditOverrideReason: input.override.reason,
                }
              : {}),
            items: {
              create: items.map((item) => ({
                tenantId: actor.tenantId,
                serviceId: item.serviceId,
                label: item.label,
                priceCents: BigInt(item.priceCents),
                durationMin: item.durationMin,
              })),
            },
            statusLog: {
              create: {
                tenantId: actor.tenantId,
                toStatus: status,
                changedBy: actor.actorUserId ?? null,
              },
            },
          },
        })

        await recordAudit(tx, {
          tenantId: actor.tenantId,
          actorUserId: actor.actorUserId ?? null,
          action: 'appointment.created',
          entity: 'appointment',
          entityId: appointment.id,
          after: {
            petId: input.petId,
            professionalId: input.professionalId,
            startsAt: input.startsAt.toISOString(),
            endsAt: endsAt.toISOString(),
            totalCents,
            items: items.map((item) => item.label),
            ...(gates.acknowledgedAlerts.length > 0
              ? { acknowledgedAlerts: gates.acknowledgedAlerts.map((alert) => alert.label) }
              : {}),
            ...(input.override ? { creditOverrideReason: input.override.reason } : {}),
          },
          ipAddress: actor.ipAddress ?? null,
          userAgent: actor.userAgent ?? null,
        })

        return {
          id: appointment.id,
          startsAt: appointment.startsAt,
          endsAt: appointment.endsAt,
          totalCents,
          durationMin,
          status,
          petId: input.petId,
          tutorId,
          professionalId: input.professionalId,
        }
      },
      { ...tenantOptions(actor), isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    )
  } catch (error) {
    if (isSerializationError(error)) {
      // O banco decidiu a corrida. Não é erro de servidor: é o último lugar tendo
      // sido levado por outro atendente entre a leitura e a escrita.
      throw new AppError(
        'ERR_AGENDA_004',
        'Este horário acabou de ser preenchido. Escolha outro.',
      )
    }
    throw error
  }

  // Pós-commit e best-effort: o evento sai depois que a transação fechou, e falha de
  // broker não desfaz o agendamento.
  //
  // Solicitação pendente publica `agendamento.solicitado`, não `criado`: quem consome
  // `criado` manda a confirmação ao tutor, e confirmar algo que ainda pode ser
  // recusado é pior que não avisar. O `criado` sai na aprovação.
  if (created.status === 'PENDING') {
    await publishEvent('agendamento.solicitado', {
      tenantId: actor.tenantId,
      appointmentId: created.id,
      petId: created.petId,
      tutorId: created.tutorId,
      startsAt: created.startsAt.toISOString(),
    })
    return created
  }

  await publishEvent('agendamento.criado', {
    tenantId: actor.tenantId,
    appointmentId: created.id,
    petId: created.petId,
    tutorId: created.tutorId,
    professionalId: created.professionalId,
    startsAt: created.startsAt.toISOString(),
    endsAt: created.endsAt.toISOString(),
    totalCents: created.totalCents,
    source: input.source ?? 'STAFF',
  })

  return created
}

/**
 * Os três gates do MOD-AGENDA-10, em transação de leitura própria.
 *
 * A ordem não é acidental. A antecedência mínima é aritmética pura e falha sem tocar
 * o banco. O alerta clínico vem antes do crédito porque segurança do animal precede
 * cobrança — e porque um tutor que vai ouvir "seu pet tem alergia crítica" não deve
 * ouvir antes "você está devendo".
 */
async function runGates(
  actor: ActorContext,
  input: CreateBookingInput,
  capabilities: BookingCapabilities,
): Promise<{
  acknowledgedAlerts: { id: string; label: string }[]
  requiresApproval: boolean
}> {
  return withTenant(actor.tenantId, async (tx) => {
    // RN-07: só o Portal tem antecedência mínima.
    assertMinimumNotice(
      input.startsAt,
      input.source ?? 'STAFF',
      await loadNoticeHours(tx, actor.tenantId),
    )

    // RN-09: bloqueio suave por alerta clínico crítico.
    const alerts = await findBlockingAlerts(
      tx,
      input.petId,
      input.items.map((item) => item.serviceId),
    )
    assertAlertsAcknowledged(alerts, input.acknowledgedAlerts ?? false)

    // RN-11: inadimplência. Só chega aqui se houver responsável — a ausência dele é
    // erro de cadastro e `assertBookable` a reporta com mensagem melhor.
    const link = await tx.petTutor.findFirst({
      where: { petId: input.petId, role: 'PRIMARY' },
      select: { tutorId: true },
    })
    if (link) {
      const status = await billing().creditStatus(tx, link.tutorId)
      assertCreditAllowed(status, input.override, capabilities.canOverrideCredit)
    }

    // RN-08: só o Portal passa por aprovação. Agendamento de balcão nunca fica
    // pendente — a recepção é a própria aprovação.
    const settings = await tx.tenantSettings.findFirst({
      where: { tenantId: actor.tenantId },
      select: { onlineBookingRequiresApproval: true },
    })
    const requiresApproval =
      (input.source ?? 'STAFF') === 'PORTAL' && (settings?.onlineBookingRequiresApproval ?? false)

    return {
      acknowledgedAlerts: alerts.map((alert) => ({ id: alert.id, label: alert.label })),
      requiresApproval,
    }
  })
}
