import { withTenant, type Tenant } from '@petshop/db'
import {
  IDENTITY_ROUTING_KEYS,
  ONBOARDING_LAST_STEP,
  SKIPPABLE_ONBOARDING_STEPS,
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
    await announceCompletion(row)
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
      // TODO(MOD-AGENDA): o AC-01 inclui serviços e profissionais nesta etapa; as
      // tabelas são de MOD-AGENDA e ainda não existem.
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

async function announceCompletion(row: Tenant): Promise<void> {
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
