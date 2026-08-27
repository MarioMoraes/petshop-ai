import { withTenant } from '@petshop/db'
import { randomUUID } from 'node:crypto'
import { recordAudit } from '../../lib/audit.js'
import { invalid } from '../../lib/errors.js'
import type { ActorContext } from '../catalog/actor.js'
import { assertBookable, resolveItems } from './booking.js'
import { totalDuration } from './duration.js'
import { checkOut } from './transitions.js'

/**
 * O encaixe — AC-03 de MOD-PRONT-01.
 *
 * O pet chegou sem hora marcada, foi atendido e vai embora. O registro clínico e o
 * débito precisam existir do mesmo jeito que existem para quem tinha horário; a
 * agenda também, senão o relatório do dia conta uma história e o caixa conta outra.
 *
 * A solução é fazer o agendamento **retroativo** nascer aqui, já concluído. Duas
 * consequências que valem explicitar:
 *
 * 1. **Nenhuma checagem de disponibilidade roda.** Nem jornada, nem capacidade, nem
 *    conflito de horário. Perguntar "cabia na agenda?" depois que o serviço foi
 *    executado é uma pergunta sem uso — o banho já aconteceu, e recusá-lo agora só
 *    produziria um atendimento sem registro. O que continua valendo é o que ainda
 *    tem consequência: pet vivo, tutor não anonimizado e profissional habilitado
 *    para o serviço (AC-04 do §01), tudo em `assertBookable`.
 * 2. **O prontuário não sabe que isto é diferente**, e não precisa saber. Ele consome
 *    o mesmo `atendimento.concluido` de sempre; o `origin: WALK_IN` viaja no evento e
 *    é a única marca que sobra depois.
 */

export interface WalkInInput {
  petId: string
  professionalId: string
  items: { serviceId: string }[]
  /** Convenção do MOD-LEDGER: todo POST que move dinheiro é idempotente. */
  idempotencyKey: string
  weightKg?: number | undefined
  notes?: string | undefined
}

export async function createWalkIn(
  actor: ActorContext,
  input: WalkInInput,
): Promise<{ id: string }> {
  if (input.items.length === 0) throw invalid('Informe ao menos um serviço executado')

  const appointmentId = await withTenant(actor.tenantId, async (tx) => {
    const { items, pet } = await resolveItems(tx, input.petId, input.items)
    const { tutorId } = await assertBookable(
      tx,
      {
        petId: input.petId,
        professionalId: input.professionalId,
        startsAt: new Date(),
        items: input.items,
      },
      pet,
    )

    // O intervalo é reconstruído a partir da duração estimada, terminando agora: é a
    // melhor aproximação disponível de quando o serviço aconteceu, e mantém o
    // encaixe na faixa certa do quadro do dia em vez de empilhado à meia-noite.
    const durationMin = totalDuration(items.map((item) => item.durationMin))
    const finishedAt = new Date()
    const startedAt = new Date(finishedAt.getTime() - durationMin * 60_000)
    const totalCents = items.reduce((sum, item) => sum + item.priceCents, 0)

    const appointment = await tx.appointment.create({
      data: {
        tenantId: actor.tenantId,
        petId: input.petId,
        tutorId,
        professionalId: input.professionalId,
        startsAt: startedAt,
        endsAt: finishedAt,
        status: 'CHECKED_IN',
        source: 'WALK_IN',
        totalCents: BigInt(totalCents),
        checkinAt: startedAt,
        createdBy: actor.actorUserId ?? null,
        items: {
          create: items.map((item) => ({
            tenantId: actor.tenantId,
            serviceId: item.serviceId,
            label: item.label,
            priceCents: BigInt(item.priceCents),
            durationMin: item.durationMin,
          })),
        },
      },
      select: { id: true },
    })

    // A trilha de estado precisa da linha de entrada: sem ela, o agendamento
    // apareceria em `CHECKED_IN` sem nada explicando de onde veio.
    await tx.appointmentStatusLog.create({
      data: {
        tenantId: actor.tenantId,
        appointmentId: appointment.id,
        fromStatus: 'CONFIRMED',
        toStatus: 'CHECKED_IN',
        changedBy: actor.actorUserId ?? null,
        reason: 'Encaixe',
      },
    })

    await recordAudit(tx, {
      tenantId: actor.tenantId,
      actorUserId: actor.actorUserId ?? null,
      action: 'appointment.walk_in',
      entity: 'appointment',
      entityId: appointment.id,
      after: {
        petId: input.petId,
        professionalId: input.professionalId,
        totalCents,
        items: items.map((item) => item.label),
      },
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
    })

    return appointment.id
  })

  // O check-out normal fecha a conta e publica o evento — nenhum caminho paralelo:
  // duplicar aqui a lógica de débito seria criar uma segunda forma de o dinheiro
  // nascer, e a segunda forma é sempre a que fica para trás.
  await checkOut(actor, appointmentId, {
    idempotencyKey: input.idempotencyKey || randomUUID(),
    ...(input.weightKg === undefined ? {} : { weightKg: input.weightKg }),
    ...(input.notes === undefined ? {} : { notes: input.notes }),
  })

  return { id: appointmentId }
}
