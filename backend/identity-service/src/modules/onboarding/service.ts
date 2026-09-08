import { withTenant, type Tenant, type TenantTransaction } from '@petshop/db'
import {
  IDENTITY_ROUTING_KEYS,
  ONBOARDING_LAST_STEP,
  SKIPPABLE_ONBOARDING_STEPS,
  WEEKDAYS,
  type BusinessHours,
  type Weekday,
  type OnboardingProfessionalInput,
  type OnboardingStepInput,
  type TenantResponse,
} from '@petshop/shared-types'
import { recordAudit } from '../../lib/audit.js'
import { notFound } from '../../lib/errors.js'
import { publishEvent } from '../../lib/events.js'
import { recordMetric } from '../../lib/logger.js'
import { CACHE_KEYS, cacheDelete } from '../../lib/redis.js'
import { clampOnboardingStep, toTenantResponse } from '../tenants/service.js'

/**
 * MOD-IDENT-02 — Onboarding Wizard.
 *
 * Cada etapa persiste sozinha. É o que sustenta o AC-03: o admin que abandona na
 * etapa 2 e volta três dias depois reencontra tudo o que já preencheu, porque nada
 * ficou pendurado em estado de sessão.
 *
 * `onboarding_step` guarda a **próxima** etapa a exibir, e só avança — reenviar uma
 * etapa anterior corrige os dados sem fazer o usuário refazer o caminho para a frente.
 */

export interface AdvanceOnboardingParams {
  tenantId: string
  actorUserId?: string | undefined
  payload: OnboardingStepInput
}

export async function advanceOnboarding(
  params: AdvanceOnboardingParams,
): Promise<TenantResponse> {
  const { tenantId, payload } = params

  const row = await withTenant(
    tenantId,
    async (tx) => {
      const before = await tx.tenant.findUnique({ where: { id: tenantId } })
      if (!before) throw notFound('Estabelecimento não encontrado')

      await applyStep(tx, tenantId, payload)

      const skipped = new Set(before.onboardingStepsSkipped)
      const wasSkipped = 'skipped' in payload && payload.skipped === true
      if (wasSkipped && isSkippable(payload.step)) skipped.add(payload.step)
      else skipped.delete(payload.step)

      const nextStep = Math.min(
        Math.max(before.onboardingStep, payload.step + 1),
        ONBOARDING_LAST_STEP,
      )
      const completing =
        payload.step === ONBOARDING_LAST_STEP && before.onboardingCompletedAt === null

      const updated = await tx.tenant.update({
        where: { id: tenantId },
        data: {
          onboardingStep: nextStep,
          onboardingStepsSkipped: [...skipped].sort((a, b) => a - b),
          ...(completing ? { onboardingCompletedAt: new Date() } : {}),
        },
      })

      await recordAudit(tx, {
        tenantId,
        actorUserId: params.actorUserId ?? null,
        action: completing ? 'tenant.onboarding_completed' : 'tenant.onboarding_step_saved',
        entity: 'tenant',
        entityId: tenantId,
        before: { onboardingStep: before.onboardingStep },
        after: { onboardingStep: updated.onboardingStep, step: payload.step, skipped: wasSkipped },
      })

      return updated
    },
    params.actorUserId ? { userId: params.actorUserId } : {},
  )

  if (payload.step === 3 || payload.step === ONBOARDING_LAST_STEP) {
    await cacheDelete(CACHE_KEYS.tenantSettings(tenantId))
  }

  if (row.onboardingCompletedAt && payload.step === ONBOARDING_LAST_STEP) {
    await announceCompletion(row, params.actorUserId ?? null)
  }

  return toTenantResponse(row, null)
}

async function applyStep(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  tenantId: string,
  payload: OnboardingStepInput,
): Promise<void> {
  switch (payload.step) {
    case 1: {
      // O CNPJ da etapa 1 é gravado por `PATCH /v1/tenants/me`, que tem acesso à DEK
      // do tenant; aqui ficam apenas os campos em claro.
      await tx.tenant.update({
        where: { id: tenantId },
        data: {
          name: payload.data.name,
          ...(payload.data.legalName !== undefined
            ? { legalName: payload.data.legalName ?? null }
            : {}),
        },
      })
      return
    }

    case 2: {
      await tx.tenant.update({ where: { id: tenantId }, data: { plan: payload.data.plan } })
      return
    }

    case 3: {
      await tx.tenantSettings.update({
        where: { tenantId },
        data: {
          timezone: payload.data.timezone,
          businessHours: payload.data.businessHours,
          cancellationWindowHours: payload.data.cancellationWindowHours,
          minBookingNoticeHours: payload.data.minBookingNoticeHours,
          ...(payload.data.noShowFeePercent !== undefined
            ? { noShowFeePercent: payload.data.noShowFeePercent }
            : {}),
        },
      })
      await saveOnboardingProfessionals(
        tx,
        tenantId,
        payload.data.professionals,
        payload.data.businessHours,
      )
      return
    }

    case 4: {
      if (payload.data?.branding) {
        await tx.tenantSettings.update({
          where: { tenantId },
          data: { branding: payload.data.branding },
        })
      }
      return
    }
  }
}

function isSkippable(step: number): boolean {
  return (SKIPPABLE_ONBOARDING_STEPS as readonly number[]).includes(step)
}

async function announceCompletion(row: Tenant, adminUserId: string | null): Promise<void> {
  const durationSeconds = Math.max(
    0,
    Math.round(
      ((row.onboardingCompletedAt?.getTime() ?? Date.now()) - row.onboardingStartedAt.getTime()) /
        1000,
    ),
  )

  recordMetric({
    metric: 'tenant_onboarding_completed',
    tenantId: row.id,
    value: durationSeconds,
    unit: 'seconds',
  })

  await publishEvent(IDENTITY_ROUTING_KEYS.tenantOnboardingConcluido, {
    tenantId: row.id,
    durationSeconds,
    stepsSkipped: row.onboardingStepsSkipped,
    /**
     * Quem terminou o wizard, para as boas-vindas do MOD-NOTIF-08.
     *
     * O evento existe desde o MOD-IDENT-02 e ninguém o consumia, então nunca precisou
     * dizer a quem se dirigia. Nulo só no caminho de reprocesso do provisionamento, que
     * chega aqui sem ator — e nesse caso o consumidor não manda nada, em vez de
     * adivinhar um destinatário.
     */
    adminUserId,
  })
}

/** Estado do wizard, para o middleware do frontend decidir o redirecionamento. */
export async function getOnboardingState(tenantId: string) {
  const row = await withTenant(tenantId, (tx) =>
    tx.tenant.findUnique({
      where: { id: tenantId },
      select: {
        onboardingStep: true,
        onboardingCompletedAt: true,
        onboardingStepsSkipped: true,
      },
    }),
  )
  if (!row) throw notFound('Estabelecimento não encontrado')
  return {
    onboardingStep: clampOnboardingStep(row.onboardingStep),
    onboardingCompletedAt: row.onboardingCompletedAt?.toISOString() ?? null,
    stepsSkipped: row.onboardingStepsSkipped,
  }
}

/**
 * Cria os profissionais do AC-01 e dá a cada um a jornada do estabelecimento.
 *
 * Os serviços não aparecem aqui porque já foram semeados no provisionamento
 * (`seedTenantDomain`): o wizard só pergunta o que não dá para adivinhar.
 *
 * A jornada herdada é uma **decisão de produto**, não um atalho. Quem acaba de
 * definir que abre 08:00–18:00 não quer redigitar isso por pessoa; quem trabalha em
 * horário diferente é a exceção, e a exceção se ajusta em `/profissionais`. Todos
 * saem habilitados em todos os serviços pela mesma razão — restringir é o caso raro.
 *
 * Reenviar a etapa 3 substitui a lista inteira, como o resto do wizard: o AC-03
 * permite voltar e reenviar um passo anterior, e um `create` cego duplicaria a
 * equipe a cada volta.
 */
async function saveOnboardingProfessionals(
  tx: TenantTransaction,
  tenantId: string,
  professionals: OnboardingProfessionalInput[],
  businessHours: BusinessHours,
): Promise<void> {
  const existing = await tx.professional.findMany({
    where: { deletedAt: null },
    select: { id: true },
  })
  if (existing.length > 0) {
    await tx.professional.deleteMany({ where: { id: { in: existing.map((row) => row.id) } } })
  }

  if (professionals.length === 0) return

  const services = await tx.service.findMany({
    where: { deletedAt: null, active: true },
    select: { id: true },
  })
  const windows = businessHoursToWindows(businessHours)

  for (const person of professionals) {
    await tx.professional.create({
      data: {
        tenantId,
        displayName: person.displayName,
        roleKey: person.roleKey,
        maxConcurrentPets: person.maxConcurrentPets,
        services: {
          create: services.map((service) => ({ tenantId, serviceId: service.id })),
        },
        schedules: {
          create: windows.map((window) => ({ tenantId, ...window })),
        },
      },
    })
  }
}

/**
 * `WEEKDAYS` começa na segunda, porque é assim que a semana é lida na tela; a coluna
 * `professional_schedules.weekday` é 0 = domingo, a convenção do Postgres e do
 * `Date.getDay()`. O índice do array **não** serve como dia da semana — usá-lo
 * deslocaria a jornada de todo mundo em um dia, calado.
 */
const ISO_WEEKDAY: Record<Weekday, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
}

/**
 * Horário de funcionamento → faixas de jornada.
 *
 * `business_hours` fala em "HH:MM" e a jornada em minutos desde a meia-noite; a
 * conversão mora aqui porque é o único ponto do sistema em que os dois formatos se
 * encontram. Dia fechado simplesmente não gera faixa.
 */
function businessHoursToWindows(
  businessHours: BusinessHours,
): { weekday: number; startsAtMin: number; endsAtMin: number }[] {
  return WEEKDAYS.flatMap((day) => {
    const weekday = ISO_WEEKDAY[day]
    const hours = businessHours[day]
    if (hours.closed) return []

    const startsAtMin = timeToMinutes(hours.opensAt)
    const endsAtMin = timeToMinutes(hours.closesAt)
    if (startsAtMin === null || endsAtMin === null || endsAtMin <= startsAtMin) return []

    return [{ weekday, startsAtMin, endsAtMin }]
  })
}

function timeToMinutes(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value)
  if (!match) return null
  return Number(match[1]) * 60 + Number(match[2])
}
