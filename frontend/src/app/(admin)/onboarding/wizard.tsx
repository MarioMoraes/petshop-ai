'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import {
  DEFAULT_BRANDING,
  DEFAULT_BUSINESS_HOURS,
  ONBOARDING_LAST_STEP,
  ONBOARDING_STEP_TITLES,
  type Branding,
  type BusinessHours,
  type Plan,
  type PlanPriceRow,
  type TenantResponse,
  type TenantSettings,
} from '@petshop/shared-types'
import { Button, FormError, StepProgress } from '@/components/ui'
import type { ActionResult } from './actions'
import { StepBusinessHours } from './steps/step-business-hours'
import { StepBranding } from './steps/step-branding'
import { StepIdentity } from './steps/step-identity'
import { StepPlan } from './steps/step-plan'

/**
 * MOD-IDENT-02 — o wizard de configuração do estabelecimento.
 *
 * O estado que importa vive no servidor: cada etapa persiste sozinha e a etapa
 * corrente vem de `tenant.onboardingStep`. O `useState` daqui é só o rascunho do
 * formulário aberto — fechar o navegador no meio não perde nada do que já foi salvo
 * (AC-03).
 */

export interface WizardProps {
  tenant: TenantResponse | null
  settings: TenantSettings | null
  /** `.meupetshop.com.br` — resolvido no servidor; ver `lib/domain.ts`. */
  hostSuffix: string
  /** O `?plan=` da landing, já validado. Entra na criação do estabelecimento. */
  initialPlan: Plan | null
  /** A tabela de preços vigente, lida no servidor (`lib/plan-prices.ts`). */
  prices: PlanPriceRow[]
}

export function Wizard({ tenant, settings, hostSuffix, initialPlan, prices }: WizardProps) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  // Sem tenant ainda, o wizard começa na etapa 1: criar o estabelecimento.
  const [currentTenant, setCurrentTenant] = useState(tenant)
  // Prende ao último passo vigente: o wizard já teve uma etapa de convite de equipe,
  // e tenant gravado naquele momento traz um número que não existe mais.
  const [step, setStep] = useState(Math.min(tenant?.onboardingStep ?? 1, ONBOARDING_LAST_STEP))
  const [formError, setFormError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  const branding: Branding = (settings?.branding as Branding | undefined) ?? DEFAULT_BRANDING
  const businessHours: BusinessHours =
    (settings?.businessHours as BusinessHours | undefined) ?? DEFAULT_BUSINESS_HOURS

  /** Executa uma ação de etapa e move o wizard conforme a resposta do servidor. */
  function run(action: () => Promise<ActionResult>) {
    setFormError(null)
    setFieldErrors({})

    startTransition(async () => {
      const result = await action()

      if (!result.ok) {
        setFormError(result.message)
        setFieldErrors(result.fieldErrors)
        return
      }

      setCurrentTenant(result.data)

      if (result.data.onboardingCompletedAt) {
        router.push('/dashboard')
        router.refresh()
        return
      }

      // A etapa seguinte é a que o servidor gravou — não um contador local.
      setStep(result.data.onboardingStep)
      router.refresh()
    })
  }

  const shared = { pending, fieldErrors, onSubmit: run }

  return (
    <div className="w-full max-w-2xl">
      <StepProgress current={step} total={ONBOARDING_LAST_STEP} titles={ONBOARDING_STEP_TITLES} />

      <div className="mt-6">
        <FormError message={formError} />
      </div>

      <div className="mt-6">
        {step === 1 && (
          <StepIdentity
            {...shared}
            tenant={currentTenant}
            hostSuffix={hostSuffix}
            initialPlan={initialPlan}
          />
        )}
        {step === 2 && (
          <StepPlan
            {...shared}
            plan={currentTenant?.plan ?? initialPlan ?? 'STARTER'}
            prices={prices}
          />
        )}
        {step === 3 && (
          <StepBusinessHours
            {...shared}
            businessHours={businessHours}
            timezone={settings?.timezone ?? 'America/Sao_Paulo'}
            cancellationWindowHours={settings?.cancellationWindowHours ?? 24}
            minBookingNoticeHours={settings?.minBookingNoticeHours ?? 2}
            noShowFeePercent={settings?.noShowFeePercent ?? 0}
          />
        )}
        {step === 4 && <StepBranding {...shared} branding={branding} />}
      </div>

      {step > 1 && (
        <Button
          type="button"
          variant="ghost"
          className="mt-6"
          onClick={() => setStep(step - 1)}
          disabled={pending}
        >
          ← Voltar
        </Button>
      )}
    </div>
  )
}

/** Contrato comum das etapas. */
export interface StepProps {
  pending: boolean
  fieldErrors: Record<string, string>
  onSubmit: (action: () => Promise<ActionResult>) => void
}
