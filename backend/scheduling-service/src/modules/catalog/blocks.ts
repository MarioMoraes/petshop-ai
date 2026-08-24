import { withTenant } from '@petshop/db'
import type { CreateCalendarBlockInput } from '@petshop/shared-types'
import { recordAudit } from '../../lib/audit.js'
import { futureAppointmentsBlock, notFound } from '../../lib/errors.js'
import { publishEvent } from '../../lib/events.js'
import { tenantOptions, type ActorContext } from './actor.js'
import { toCalendarBlockResponse } from './mapper.js'
import { appointments } from './port.js'

/** MOD-AGENDA-03 — bloqueios e folgas. */

/**
 * AC-01/AC-02/AC-03.
 *
 * `professionalId` nulo é o feriado do tenant inteiro: o dia some da oferta de todo
 * mundo sem precisar de uma linha por pessoa.
 *
 * Quando o bloqueio cai sobre agendamentos existentes, o padrão é **falhar** com a
 * lista dos afetados — quem decide entre reatribuir e cancelar é quem está na tela,
 * não o servidor. O cliente reenvia com `onConflict: 'CANCEL'` para cancelar em
 * lote, e esse cancelamento **não** gera taxa de no-show (RN-12): a falta é nossa.
 */
export async function createBlock(actor: ActorContext, input: CreateCalendarBlockInput) {
  const startsAt = new Date(input.startsAt)
  const endsAt = new Date(input.endsAt)

  const result = await withTenant(
    actor.tenantId,
    async (tx) => {
      if (input.professionalId) {
        const professional = await tx.professional.findFirst({
          where: { id: input.professionalId, deletedAt: null },
        })
        if (!professional) throw notFound('Profissional não encontrado')
      }

      const affected = await appointments().listInWindow(
        tx,
        input.professionalId ?? null,
        startsAt,
        endsAt,
      )

      if (affected.length > 0 && input.onConflict === 'FAIL') {
        throw futureAppointmentsBlock(
          `Há ${affected.length} agendamento(s) nesta janela. Reatribua-os ou reenvie confirmando o cancelamento em lote.`,
          {
            professionalId: input.professionalId ?? null,
            appointments: affected.map((item) => ({
              id: item.id,
              startsAt: item.startsAt.toISOString(),
              petName: item.petName,
            })),
          },
        )
      }

      const block = await tx.calendarBlock.create({
        data: {
          tenantId: actor.tenantId,
          professionalId: input.professionalId ?? null,
          startsAt,
          endsAt,
          reason: input.reason ?? null,
          createdBy: actor.actorUserId ?? null,
        },
      })

      if (affected.length > 0) {
        await appointments().cancelBatch(
          tx,
          affected.map((item) => item.id),
          input.reason ?? 'Bloqueio na agenda',
        )
      }

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'calendar_block.created',
        entity: 'calendar_block',
        entityId: block.id,
        after: {
          professionalId: block.professionalId,
          startsAt: block.startsAt.toISOString(),
          endsAt: block.endsAt.toISOString(),
          cancelledAppointments: affected.map((item) => item.id),
        },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })

      return { block, cancelled: affected.map((item) => item.id) }
    },
    tenantOptions(actor),
  )

  await publishEvent('agenda.bloqueio.criado', {
    tenantId: actor.tenantId,
    blockId: result.block.id,
    professionalId: result.block.professionalId,
    startsAt: result.block.startsAt.toISOString(),
    endsAt: result.block.endsAt.toISOString(),
    cancelledAppointmentIds: result.cancelled,
  })

  return {
    ...toCalendarBlockResponse(result.block),
    cancelledAppointmentIds: result.cancelled,
  }
}

export async function listBlocks(
  actor: ActorContext,
  query: { from: string; to: string; professionalId?: string },
) {
  const rows = await withTenant(actor.tenantId, (tx) =>
    tx.calendarBlock.findMany({
      where: {
        // Sobreposição com a janela pedida, não contenção: um bloqueio de uma semana
        // precisa aparecer na consulta de qualquer dia dela.
        startsAt: { lt: new Date(query.to) },
        endsAt: { gt: new Date(query.from) },
        ...(query.professionalId
          ? // O feriado do tenant entra junto: ele bloqueia este profissional também.
            { OR: [{ professionalId: query.professionalId }, { professionalId: null }] }
          : {}),
      },
      orderBy: { startsAt: 'asc' },
    }),
  )
  return rows.map(toCalendarBlockResponse)
}

export async function deleteBlock(actor: ActorContext, blockId: string) {
  await withTenant(
    actor.tenantId,
    async (tx) => {
      const block = await tx.calendarBlock.findFirst({ where: { id: blockId } })
      if (!block) throw notFound('Bloqueio não encontrado')

      await tx.calendarBlock.delete({ where: { id: blockId } })

      await recordAudit(tx, {
        tenantId: actor.tenantId,
        actorUserId: actor.actorUserId ?? null,
        action: 'calendar_block.deleted',
        entity: 'calendar_block',
        entityId: blockId,
        before: {
          professionalId: block.professionalId,
          startsAt: block.startsAt.toISOString(),
          endsAt: block.endsAt.toISOString(),
        },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      })
    },
    tenantOptions(actor),
  )
}
