'use client'

import { Badge, Card } from '@/components/ui'
import { skipStep4Action } from '../actions'
import type { StepProps } from '../wizard'

/**
 * Etapa 4 — convite de equipe.
 *
 * Nesta entrega a etapa só oferece "pular", que o AC-03 permite explicitamente: o
 * envio de convites é MOD-IDENT-06 e ainda não existe no backend. A tela é honesta
 * sobre isso em vez de mostrar um formulário que não salvaria nada.
 *
 * TODO(MOD-IDENT-06): trocar por formulário de e-mail + papel quando
 * POST /v1/invitations existir.
 */

export function StepTeam({ pending, onSubmit }: StepProps) {
  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold sm:text-3xl">Sua equipe</h1>
          <p className="hint mt-2">
            Recepção, banhistas, tosadores e veterinários entram cada um com seu acesso e só
            enxergam o que o papel permite.
          </p>
        </div>
        <Badge>Em breve</Badge>
      </div>

      <div className="mt-6 rounded-2xl border border-dashed border-line bg-surface px-5 py-6">
        <p className="text-sm text-muted">
          O convite por e-mail entra na próxima atualização. Você poderá adicionar a equipe a
          qualquer momento pelo menu <span className="font-medium text-ink">Equipe</span>, sem
          precisar refazer nada do que configurou aqui.
        </p>
      </div>

      <button
        type="button"
        className="btn btn-primary mt-8 w-full"
        disabled={pending}
        onClick={() => onSubmit(skipStep4Action)}
      >
        {pending ? 'Salvando…' : 'Continuar'}
      </button>
    </Card>
  )
}
