import {
  PLAN_CATALOG,
  PLAN_FEATURE_LABELS,
  PlanSchema,
  minimumPlanFor,
  planIncludes,
  type MeResponse,
  type Plan,
  type PlanFeature,
} from '@petshop/shared-types'
import { SparkleIcon } from '@/components/icons'
import { ButtonLink } from '@/components/links'

/**
 * O que a tela mostra quando o plano do estabelecimento não inclui o recurso.
 *
 * **Um cartão, e não um erro.** O backend responde 402 (`ERR_PLAN_001`), mas a tela não
 * chega a pedir: o layout ou a página perguntam antes, pelo plano que já veio no `/me`, e
 * trocam o conteúdo por isto. Um 402 caindo no error boundary diria "algo deu errado" a
 * quem só abriu um item do menu.
 *
 * **Não tem botão de assinar**, porque ainda não há cobrança: quem muda o plano é a
 * equipe PetShop AI, pelo console. O cartão diz isso, e diz o que mais importa a quem
 * desceu de plano — os dados continuam onde estavam.
 */

/** O plano do estabelecimento aberto. Sem tenant, o menor — nunca um recurso a mais. */
export function planoDe(me: MeResponse): Plan {
  const parsed = PlanSchema.safeParse(me.currentTenant?.plan)
  return parsed.success ? parsed.data : 'STARTER'
}

export function temRecurso(me: MeResponse, feature: PlanFeature): boolean {
  return planIncludes(planoDe(me), feature)
}

export function PlanoIndisponivel({ me, feature }: { me: MeResponse; feature: PlanFeature }) {
  const atual = PLAN_CATALOG[planoDe(me)]
  const necessario = PLAN_CATALOG[minimumPlanFor(feature)]

  return (
    <div className="mx-auto max-w-lg py-16">
      <div className="card p-6 text-center sm:p-8">
        <span className="icon-chip icon-chip-sm icon-brand mx-auto">
          <SparkleIcon />
        </span>
        <h1 className="mt-4 text-xl font-semibold">
          {PLAN_FEATURE_LABELS[feature]} está no plano {necessario.name}
        </h1>
        <p className="hint mx-auto mt-2 max-w-sm">
          Seu estabelecimento está no plano {atual.name}. Para mudar de plano, fale com a equipe
          PetShop AI. Se o recurso já foi usado antes, os dados continuam guardados e voltam a
          aparecer com a troca.
        </p>
        <div className="mt-6 flex justify-center">
          <ButtonLink href="/dashboard" variant="ghost">
            Voltar ao início
          </ButtonLink>
        </div>
      </div>
    </div>
  )
}
